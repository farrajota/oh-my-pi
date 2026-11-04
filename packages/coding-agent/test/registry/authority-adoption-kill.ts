// Preload for authority-adoption.test.ts crash cuts: SIGKILL this process right after an atomic
// rename publishes the named durable state, i.e. at a real power-cut boundary of the protocol.
//   ADOPTION_KILL_MANIFEST_PHASE=<phase>  after a migration manifest reaches that phase
//   ADOPTION_KILL_DESCRIPTOR_STATE=<state> after the authority descriptor reaches that state
import * as fs from "node:fs";
import type * as FsPromises from "node:fs/promises";

// The ESM namespace is immutable; the CommonJS module object is the shared binding every importer calls.
const fsp = require("node:fs/promises") as typeof FsPromises;

const manifestPhase = process.env.ADOPTION_KILL_MANIFEST_PHASE;
const descriptorState = process.env.ADOPTION_KILL_DESCRIPTOR_STATE;
const rename = fsp.rename;
const patched: typeof fsp.rename = async (from, to) => {
	await rename(from, to);
	const target = String(to);
	const watched =
		(manifestPhase && target.includes(".authority.migration.") && target.endsWith(".json")) ||
		(descriptorState && target.endsWith(".authority.json"));
	if (!watched) return;
	const value = JSON.parse(fs.readFileSync(target, "utf8")) as { phase?: string; state?: string };
	if ((manifestPhase && value.phase === manifestPhase) || (descriptorState && value.state === descriptorState)) {
		process.kill(process.pid, "SIGKILL");
	}
};
fsp.rename = patched;
