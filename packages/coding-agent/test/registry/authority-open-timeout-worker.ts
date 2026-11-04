import { spyOn } from "bun:test";
import * as fs from "node:fs";
import { parentPort } from "node:worker_threads";
import { authorityWorkerThreadId } from "../../src/registry/authority/thread-lifetime";
import { runAuthorityWorker } from "../../src/registry/authority/worker";

// The production worker, made to work synchronously forever at one point of its open, as a large replay or a long
// rotation does. Only termination ends it. The mode is the last argv entry:
// - "block-replay": at the open's first read of the store, before any write;
// - "block-after-link": in a rotation, right after the active segment is hard-linked to its sealed name, after the
//   sealed index and next snapshot are published and before the next header commits the rotation;
// - "block-after-header": in a rotation, right after the next segment's header is renamed over the active name.
if (!parentPort) throw new Error("Open-timeout fixture requires a worker parent port");
const mode = process.argv.at(-1);

function spin(phase: string): never {
	parentPort!.postMessage({ kind: "open-timeout-fixture", phase, tid: authorityWorkerThreadId() });
	let turns = 0;
	for (;;) turns++;
}

const readSync = fs.readSync;
const linkSync = fs.linkSync;
const renameSync = fs.renameSync;
let blocked = false;
const blockOnce = (phase: string): void => {
	if (blocked) return;
	blocked = true;
	spin(phase);
};
if (mode === "block-replay") {
	spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof readSync>) => {
		blockOnce("replay");
		return readSync(...args);
	}) as typeof readSync);
} else if (mode === "block-after-link") {
	spyOn(fs, "linkSync").mockImplementation(((...args: Parameters<typeof linkSync>) => {
		linkSync(...args);
		blockOnce("after-link");
	}) as typeof linkSync);
} else if (mode === "block-after-header") {
	spyOn(fs, "renameSync").mockImplementation(((...args: Parameters<typeof renameSync>) => {
		renameSync(...args);
		if (String(args[1]).endsWith(".authority.jsonl")) blockOnce("after-header");
	}) as typeof renameSync);
} else throw new Error(`Unknown open-timeout fixture mode: ${String(mode)}`);

void runAuthorityWorker();
