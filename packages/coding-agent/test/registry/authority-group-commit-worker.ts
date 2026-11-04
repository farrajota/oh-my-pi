// Group-commit observation and fault worker. It streams, in worker order, every RPC arrival, every grouped
// member (a SQLite SAVEPOINT or a JSONL grouped transaction) and every group sync (a SQLite COMMIT or the JSONL
// group fdatasync) to the host on the same port that carries RPC responses, so the host
// timeline orders each response against the COMMITs before it. It injects faults at the first COMMIT that
// covers two or more grouped members. Messages use kind "group-commit-test"; the host fixture intercepts
// them before the authority client sees them.
import * as fs from "node:fs";
import { parentPort } from "node:worker_threads";
import { Database } from "bun:sqlite";
import { spyOn } from "bun:test";
import { JsonlAuthorityPersistence } from "../../src/registry/authority/jsonl-driver";
import {
	AuthorityCapacityAdmission,
	AuthorityCapacityRefusedError,
} from "../../src/registry/authority/capacity-sqlite";
import { runAuthorityWorker } from "../../src/registry/authority/worker";

type FaultMode =
	| "observe"
	// Stall the next COMMIT (as a slow fsync would) so concurrent commands queue behind it.
	| "stall"
	// Stall the next COMMIT, then throw before the following multi-member group COMMIT executes.
	| "stall-then-fail-before-group-commit"
	// Stall the next COMMIT, then throw after the following multi-member group COMMIT executed.
	| "stall-then-fail-after-group-commit"
	// Stall the next COMMIT, then write a marker and block forever just before / after the group COMMIT.
	| "stall-then-cut-before-group-commit"
	| "stall-then-cut-after-group-commit"
	// Stall the next COMMIT, then refuse capacity for the second member of the following group once.
	| "stall-then-refuse-second-member";

interface GroupCommitEvent {
	readonly type: "arrive" | "member" | "commit-start" | "commit-end" | "commit-failed" | "boundary-refusal";
	readonly id?: string;
	readonly method?: string;
	readonly members?: number;
	readonly ok?: boolean;
	readonly unknownOutcome?: boolean;
}

if (!parentPort) throw new Error("Authority group-commit test worker requires a parent port");
const port = parentPort;
const markerPath = Bun.argv
	.find(argument => argument.startsWith("--group-commit-marker="))
	?.slice("--group-commit-marker=".length);
// Bun's parentPort.postMessage is a non-writable own property, so the worker's own responses cannot be
// wrapped; streaming events on the same ordered port gives the host the same ordering evidence.
const events = {
	push(event: GroupCommitEvent): void {
		port.postMessage({ kind: "group-commit-test", event: "trace", trace: event });
	},
};
let mode: FaultMode = "observe";
let stallPending = false;
let groupFaultArmed = false;
let currentCall: string | undefined;
let membersSinceBegin = 0;

function sleepSync(milliseconds: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function cut(phase: "before" | "after"): never {
	if (!markerPath) throw new Error("Crash-cut mode requires a marker path");
	fs.writeFileSync(markerPath, JSON.stringify({ phase, members: membersSinceBegin }));
	// Wait for the parent to SIGKILL this process at exactly this cut.
	for (;;) sleepSync(1_000);
}

/** One group sync (SQLite COMMIT or JSONL fdatasync) with the mode's stall, failure and cut injections. */
function groupSync<T>(execute: () => T): T {
	const members = membersSinceBegin;
	events.push({ type: "commit-start", members });
	if (stallPending) {
		stallPending = false;
		groupFaultArmed = mode !== "stall";
		// The host sends its burst only after this notice, so the burst queues behind this sync.
		port.postMessage({ kind: "group-commit-test", event: "stalling" });
		sleepSync(400);
	} else if (groupFaultArmed && members >= 2) {
		groupFaultArmed = false;
		if (mode === "stall-then-fail-before-group-commit") {
			events.push({ type: "commit-failed", members });
			throw new Error("Injected group COMMIT failure before execution");
		}
		if (mode === "stall-then-cut-before-group-commit") cut("before");
		const result = execute();
		if (mode === "stall-then-cut-after-group-commit") cut("after");
		if (mode === "stall-then-fail-after-group-commit") {
			events.push({ type: "commit-failed", members });
			throw new Error("Injected group COMMIT failure after execution");
		}
		events.push({ type: "commit-end", members });
		return result;
	}
	const result = execute();
	events.push({ type: "commit-end", members });
	return result;
}

const originalExec = Database.prototype.exec;
Database.prototype.exec = new Proxy(originalExec, {
	apply(target, database, args) {
		const sql = typeof args[0] === "string" ? args[0].trim().toUpperCase() : "";
		if (sql.startsWith("BEGIN")) membersSinceBegin = 0;
		// Staged members: a refused member's savepoint is rolled back and no longer counts.
		if (sql.startsWith("SAVEPOINT")) {
			membersSinceBegin++;
			events.push({ type: "member", id: currentCall });
		}
		if (sql.startsWith("ROLLBACK TO")) membersSinceBegin--;
		if (sql !== "COMMIT") return Reflect.apply(target, database, args);
		return groupSync(() => Reflect.apply(target, database, args));
	},
});

// JSONL: a grouped transaction is a member (a refused one leaves no line and no longer counts), and the
// group sync is the fsync of an append descriptor of the payload while a group has members. Ungrouped JSONL
// commits fsync the same way outside any group; capacity funding fsyncs non-append descriptors.
const originalTransaction = JsonlAuthorityPersistence.prototype.transaction;
JsonlAuthorityPersistence.prototype.transaction = function <T>(this: JsonlAuthorityPersistence, run: () => T): T {
	const grouped = this.groupCommit.open;
	if (grouped) {
		membersSinceBegin++;
		events.push({ type: "member", id: currentCall });
	}
	try {
		return Reflect.apply(originalTransaction, this, [run]) as T;
	} catch (error) {
		if (grouped) membersSinceBegin--;
		throw error;
	}
};
const appendDescriptors = new Set<number>();
const originalOpen = fs.openSync;
spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode) => {
	const descriptor = originalOpen(file, flags ?? "r", mode);
	if (typeof flags === "number" && (flags & fs.constants.O_APPEND) !== 0 && String(file).endsWith(".authority.jsonl"))
		appendDescriptors.add(descriptor);
	return descriptor;
}) as typeof fs.openSync);
const originalClose = fs.closeSync;
spyOn(fs, "closeSync").mockImplementation((descriptor: number) => {
	appendDescriptors.delete(descriptor);
	originalClose(descriptor);
});
const originalFsync = fs.fsyncSync;
spyOn(fs, "fsyncSync").mockImplementation((descriptor: number) => {
	if (!appendDescriptors.has(descriptor) || membersSinceBegin === 0) return originalFsync(descriptor);
	try {
		groupSync(() => originalFsync(descriptor));
	} finally {
		membersSinceBegin = 0;
	}
});

const originalPrepare = AuthorityCapacityAdmission.prototype.prepare;
AuthorityCapacityAdmission.prototype.prepare = function (
	this: AuthorityCapacityAdmission,
	...args: Parameters<typeof originalPrepare>
) {
	if (mode === "stall-then-refuse-second-member" && groupFaultArmed && membersSinceBegin >= 2) {
		groupFaultArmed = false;
		events.push({ type: "boundary-refusal", id: currentCall });
		throw new AuthorityCapacityRefusedError(new Error("Injected capacity refusal of a later group member"));
	}
	return Reflect.apply(originalPrepare, this, args);
};

// Registered before runAuthorityWorker, so it observes each call before the worker dispatches it.
port.on("message", (message: unknown) => {
	if (typeof message !== "object" || message === null || !("kind" in message)) return;
	if (message.kind === "call" && "id" in message && typeof message.id === "string") {
		currentCall = message.id;
		events.push({ type: "arrive", id: message.id, method: "method" in message ? String(message.method) : undefined });
		return;
	}
	if (message.kind !== "group-commit-test" || !("id" in message) || typeof message.id !== "string") return;
	if ("mode" in message && typeof message.mode === "string") {
		mode = message.mode as FaultMode;
		stallPending = mode !== "observe";
		groupFaultArmed = false;
	}
	// Port order makes this reply a barrier: every earlier trace event reaches the host first.
	port.postMessage({ kind: "group-commit-test", id: message.id });
});

void runAuthorityWorker();
