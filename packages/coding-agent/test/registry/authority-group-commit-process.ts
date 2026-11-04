// Crash-cut child for group commit: acknowledges one command, stalls the next sync, then sends a burst that
// the fault worker groups and freezes at a COMMIT cut. The parent SIGKILLs this whole process at that cut.
// Usage: bun authority-group-commit-process.ts <session> <marker> <progress> <mode> [sqlite|jsonl]
import * as fs from "node:fs";
import { AuthorityRpcClient } from "../../src/registry/authority/client";
import { acquireAuthorityOwnership } from "../../src/registry/authority/ownership";
import type { DurableOperationRecord } from "../../src/registry/durable-state";

const [session, marker, progress, mode, backendArgument = "sqlite"] = process.argv.slice(2);
if (backendArgument !== "sqlite" && backendArgument !== "jsonl")
	throw new Error("Group-commit crash child backend must be sqlite or jsonl");
const backend: "sqlite" | "jsonl" = backendArgument;
if (
	!session ||
	!marker ||
	!progress ||
	(mode !== "stall-then-cut-before-group-commit" && mode !== "stall-then-cut-after-group-commit")
)
	throw new Error("Group-commit crash child requires session, marker, progress and a cut mode");

function record(event: Record<string, unknown>): void {
	fs.appendFileSync(progress, `${JSON.stringify(event)}\n`);
}

function operation(operationId: string): DurableOperationRecord {
	return {
		kind: "operation",
		at: 1,
		operationId,
		effectClass: "session",
		ownerId: "root-uuid",
		classOwnerId: "root-uuid",
		acquiredAt: 1,
		expiresAt: 1_000,
		phase: "intent",
	};
}

const control = new Map<string, () => void>();
const stalling = Promise.withResolvers<void>();
let worker: Worker | undefined;
const factory = (): Worker => {
	const created = new Worker(new URL("./authority-group-commit-worker.ts", import.meta.url).href, {
		type: "module",
		argv: [`--group-commit-marker=${marker}`],
	});
	created.addEventListener("message", event => {
		const value = event.data as { kind?: unknown; id?: unknown; event?: unknown };
		if (value?.kind !== "group-commit-test") return;
		event.stopImmediatePropagation();
		if (value.event === "stalling") stalling.resolve();
		if (typeof value.id === "string") control.get(value.id)?.();
	});
	worker = created;
	return created;
};

const identity = { backend, owningSessionId: "root-uuid", incarnation: crypto.randomUUID(), format: 2 as const };
const ownership = await acquireAuthorityOwnership(session, { owningSessionId: identity.owningSessionId, create: true });
const payload = backend === "sqlite" ? ownership.paths.sqlite : ownership.paths.jsonl;
const client = await AuthorityRpcClient.open({ path: payload, identity, create: true }, ownership, factory, "xfs");
record({ event: "opened", identity, path: payload });
const acknowledged = await client.transition(operation("acked-before-cut"), { requestId: "acked-before-cut" });
record({ event: "ack", requestId: acknowledged.requestId, revision: acknowledged.revision });
const armed = Promise.withResolvers<void>();
const controlId = crypto.randomUUID();
control.set(controlId, armed.resolve);
worker!.postMessage({ kind: "group-commit-test", id: controlId, mode });
await armed.promise;
const stalled = client.transition(operation("stalled-single"), { requestId: "stalled-single" });
void stalled.then(
	receipt => record({ event: "ack", requestId: receipt.requestId, revision: receipt.revision }),
	() => undefined,
);
await stalling.promise;
for (let index = 0; index < 6; index++) {
	const requestId = `burst-${index}`;
	void client.transition(operation(requestId), { requestId }).then(
		receipt => record({ event: "ack", requestId: receipt.requestId, revision: receipt.revision }),
		error =>
			record({
				event: "rejected",
				requestId,
				unknownOutcome: (error as { unknownOutcome?: unknown }).unknownOutcome,
			}),
	);
}
record({ event: "burst-sent" });
// Stay alive until the parent kills this process at the cut.
setInterval(() => undefined, 1_000);
