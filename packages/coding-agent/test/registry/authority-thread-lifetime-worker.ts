import { parentPort } from "node:worker_threads";
import { Database } from "bun:sqlite";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { AuthorityEngine } from "../../src/registry/authority/engine";
import { runAuthorityWorker } from "../../src/registry/authority/worker";
import { authorityFailureEvidence, authorityWorkerThreadId } from "../../src/registry/authority/thread-lifetime";

const libc = dlopen("libc.so.6", {
	read: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
	write: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
});
if (!parentPort) throw new Error("Native lifetime fixture requires a worker parent port");
const start = (message: unknown): void => {
	if (
		typeof message !== "object" ||
		message === null ||
		!("kind" in message) ||
		message.kind !== "native-lifetime-fixture-start" ||
		!("mode" in message) ||
		typeof message.mode !== "string"
	)
		return;
	const cleanupExitDescriptor =
		"cleanupExitDescriptor" in message && typeof message.cleanupExitDescriptor === "number"
			? message.cleanupExitDescriptor
			: undefined;
	parentPort!.removeListener("message", start);
	if (message.mode === "sqlite-construction-failure") {
		const originalClose = Database.prototype.close;
		const closeFailure = new Error("injected physical close boundary failure");
		let initialCloseFailed = false;
		let failedDatabase: Database | undefined;
		Database.prototype.close = new Proxy(originalClose, {
			apply(target, database, args) {
				if (database instanceof Database && !initialCloseFailed) {
					initialCloseFailed = true;
					failedDatabase = database;
					parentPort!.postMessage({
						kind: "native-lifetime-fixture",
						phase: "sqlite-close",
						attempt: "initial",
						force: args[0] === true,
					});
					throw closeFailure;
				}
				const result = Reflect.apply(target, database, args);
				if (database === failedDatabase)
					parentPort!.postMessage({
						kind: "native-lifetime-fixture",
						phase: "sqlite-close",
						attempt: "retry",
						sameHandle: true,
						force: args[0] === true,
					});
				return result;
			},
		});
	}
	if (message.mode === "post-commit-open-failure" || message.mode === "post-commit-open-failure-with-retries") {
		const originalExec = Database.prototype.exec;
		let commits = 0;
		let openingCommitted = false;
		Database.prototype.exec = new Proxy(originalExec, {
			apply(target, database, args) {
				const sql = typeof args[0] === "string" ? args[0].trim().toUpperCase() : undefined;
				try {
					const result = Reflect.apply(target, database, args);
					if (sql === "COMMIT" && ++commits === 2) {
						openingCommitted = true;
						parentPort!.postMessage({
							kind: "native-lifetime-fixture",
							phase: "opening-committed",
							tid: authorityWorkerThreadId(),
						});
						const cause = new TypeError("injected opening storage boundary failure", {
							cause: new RangeError("injected nested opening cause"),
						});
						throw new AggregateError(
							[cause, new Error("injected distinct opening evidence")],
							"injected failure after real opening COMMIT",
							{ cause },
						);
					}
					return result;
				} catch (error) {
					if (openingCommitted && sql === "ROLLBACK")
						parentPort!.postMessage({
							kind: "native-lifetime-fixture",
							phase: "opening-rollback-failed",
							failure: authorityFailureEvidence(error),
						});
					throw error;
				}
			},
		});
		if (message.mode === "post-commit-open-failure-with-retries" && cleanupExitDescriptor === undefined)
			throw new Error("Native cleanup retry fixture requires its prearmed read descriptor");
	}
	if (message.mode === "unknown-open" || message.mode === "unknown-open-close-failure") {
		const recover = AuthorityEngine.prototype.recover;
		AuthorityEngine.prototype.recover = function () {
			const result = recover.call(this);
			parentPort!.postMessage({
				kind: "native-lifetime-fixture",
				phase: "recovered-before-unknown",
				tid: authorityWorkerThreadId(),
			});
			throw Object.assign(new Error("injected failure after real recovery"), {
				unknownOutcome: true,
				recovery: result,
			});
		};
	}
	if (message.mode === "unknown-open-close-failure" || message.mode === "post-commit-open-failure-with-retries") {
		const originalClose = Database.prototype.close;
		let failedDatabase: Database | undefined;
		let attempts = 0;
		Database.prototype.close = new Proxy(originalClose, {
			apply(target, database, args) {
				failedDatabase ??= database;
				const attempt = ++attempts;
				if (attempt <= 2) {
					parentPort!.postMessage({
						kind: "native-lifetime-fixture",
						phase: "unknown-open-close",
						attempt,
						sameHandle: database === failedDatabase,
						force: args[0] === true,
						physicallyClosed: false,
					});
					throw new Error(`injected unknown-open physical close failure ${attempt}`);
				}
				const result = Reflect.apply(target, database, args);
				parentPort!.postMessage({
					kind: "native-lifetime-fixture",
					phase: "unknown-open-close",
					attempt,
					sameHandle: database === failedDatabase,
					force: args[0] === true,
					physicallyClosed: true,
				});
				if (message.mode === "post-commit-open-failure-with-retries" && attempt === 3) {
					if (cleanupExitDescriptor === undefined)
						throw new Error("Native cleanup retry fixture lost its prearmed read descriptor");
					queueMicrotask(() => {
						const tid = authorityWorkerThreadId();
						parentPort!.postMessage({ kind: "native-lifetime-fixture", phase: "cleanup-block-started", tid });
						const result = libc.symbols.read(cleanupExitDescriptor, ptr(new Uint8Array(1)), 1);
						parentPort!.postMessage({
							kind: "native-lifetime-fixture",
							phase: "cleanup-block-returned",
							tid,
							result: String(result),
						});
					});
				}
				return result;
			},
		});
	}
	if (
		message.mode === "wrong-tid" ||
		message.mode === "stale-proof" ||
		message.mode === "duplicate-ready" ||
		message.mode === "malformed-ready"
	) {
		if (message.mode === "malformed-ready")
			parentPort!.postMessage({ kind: "authority-thread-lifetime", phase: "ready", tid: "invalid" });
		else
			parentPort!.postMessage({
				kind: "authority-thread-lifetime",
				phase: "ready",
				tid: message.mode === "wrong-tid" ? process.pid : authorityWorkerThreadId(),
			});
		parentPort!.on("message", (incoming: unknown) => {
			if (typeof incoming !== "object" || incoming === null) return;
			if (
				"kind" in incoming &&
				incoming.kind === "authority-thread-lifetime" &&
				"phase" in incoming &&
				incoming.phase === "challenge" &&
				"nonce" in incoming &&
				typeof incoming.nonce === "string"
			) {
				if (message.mode === "duplicate-ready")
					parentPort!.postMessage({
						kind: "authority-thread-lifetime",
						phase: "ready",
						tid: authorityWorkerThreadId(),
					});
				if (message.mode === "stale-proof") {
					parentPort!.postMessage({
						kind: "authority-thread-lifetime",
						phase: "proof",
						nonce: `${incoming.nonce}-stale`,
						tid: authorityWorkerThreadId(),
					});
					parentPort!.postMessage({
						kind: "authority-thread-lifetime",
						phase: "proof",
						nonce: incoming.nonce,
						tid: authorityWorkerThreadId(),
					});
				} else
					parentPort!.postMessage({
						kind: "authority-thread-lifetime",
						phase: "proof",
						nonce: incoming.nonce,
						tid: authorityWorkerThreadId(),
					});
				return;
			}
			if ("kind" in incoming && incoming.kind === "open")
				parentPort!.postMessage({ kind: "native-lifetime-fixture", phase: "open-received" });
		});
		return;
	}
	const originalTransition = AuthorityEngine.prototype.transition;
	AuthorityEngine.prototype.transition = function (record, options) {
		parentPort!.postMessage({
			kind: "native-lifetime-fixture",
			phase: "transition",
			operationId: record.kind === "operation" ? record.operationId : undefined,
		});
		return originalTransition.call(this, record, options);
	};
	parentPort!.on("message", (incoming: unknown) => {
		if (typeof incoming !== "object" || incoming === null || !("kind" in incoming)) return;
		if (incoming.kind === "block-native-read" && "fd" in incoming && typeof incoming.fd === "number") {
			parentPort!.postMessage({
				kind: "native-lifetime-fixture",
				phase: "block-started",
				tid: authorityWorkerThreadId(),
			});
			const result = libc.symbols.read(incoming.fd, ptr(new Uint8Array(1)), 1);
			parentPort!.postMessage({ kind: "native-lifetime-fixture", phase: "block-returned", result: String(result) });
		}
		if (incoming.kind === "release-native-read" && "fd" in incoming && typeof incoming.fd === "number") {
			const result = libc.symbols.write(incoming.fd, ptr(new Uint8Array([1])), 1);
			parentPort!.postMessage({
				kind: "native-lifetime-fixture",
				phase: "release-returned",
				result: String(result),
			});
		}
	});
	void runAuthorityWorker();
};
parentPort.on("message", start);
