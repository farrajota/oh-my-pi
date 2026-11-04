// Runs one offline authority conversion (`omp session authority <session> --to <backend> --apply`) in a fresh
// process and prints its resident set just before the conversion and its peak resident set, a kernel high-water
// mark that also records peaks reached inside synchronous stretches a timer could not sample. On Linux that is
// VmHWM of this process's own address space: getrusage's maxRSS also counts the parent's high-water mark when
// the spawn shares the parent's memory until exec (posix_spawn), which would charge this conversion with the
// test process's history building. Used by authority-conversion-memory.test.ts.
import * as fs from "node:fs";
import { migrateAuthority } from "../../../src/registry/authority/migration";

function peakResidentKiB(): number {
	try {
		const match = /^VmHWM:\s+(\d+) kB$/m.exec(fs.readFileSync("/proc/self/status", "utf8"));
		if (match) return Number(match[1]);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return process.resourceUsage().maxRSS;
}

const [sessionFile, target] = process.argv.slice(2);
if (!sessionFile || (target !== "jsonl" && target !== "sqlite"))
	throw new Error("usage: authority-conversion-peak.ts <session> <jsonl|sqlite>");
Bun.gc(true);
const beforeKiB = Math.round(process.memoryUsage().rss / 1024);
const result = await migrateAuthority(sessionFile, target, { apply: true });
const peakKiB = peakResidentKiB();
console.log(JSON.stringify({ status: result.status, beforeKiB, peakKiB }));
