import { expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

// Only the interactive TUI moves stats syncs into a subprocess (to keep them off its UI
// thread). A one-shot command such as `omp stats --summary` syncs in-process, as upstream
// does, instead of spawning a stats worker for every sync it requests.

const cliEntry = path.resolve(import.meta.dir, "../src/cli.ts");
const STATS_WORKER_SELECTOR = "__omp_worker_stats_activity";

// Records every command line the CLI process spawns, so the test can count stats workers.
const SPAWN_RECORDER = `
import * as fs from "node:fs";
const log = process.env.OMP_TEST_SPAWN_LOG;
const spawn = Bun.spawn;
Bun.spawn = ((...args: unknown[]) => {
	const first = args[0] as string[] | { cmd: string[] };
	const cmd = Array.isArray(first) ? first : first.cmd;
	if (log) fs.appendFileSync(log, JSON.stringify(cmd) + "\\n");
	return (spawn as (...a: unknown[]) => unknown)(...args);
}) as typeof Bun.spawn;
`;

function writeSession(sessionsDir: string, name: string, entries: number): void {
	const file = path.join(sessionsDir, "--tmp--stats-cli", `${name}.jsonl`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const lines: string[] = [];
	for (let i = 0; i < entries; i++) {
		lines.push(
			JSON.stringify({
				type: "message",
				id: `${name}-${i}`,
				parentId: null,
				timestamp: new Date().toISOString(),
				message: {
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					api: "openai-responses",
					provider: "openai",
					model: "gpt-5.4",
					usage: {
						input: 1,
						output: 2,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 3,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
					duration: 10,
					ttft: 5,
				},
			}),
		);
	}
	fs.writeFileSync(file, `${lines.join("\n")}\n`);
}

it("syncs sessions in-process for `omp stats --summary` without spawning a stats worker", async () => {
	using tempDir = TempDir.createSync("@omp-cli-stats-inline-");
	const home = tempDir.join("home");
	writeSession(path.join(home, ".omp", "agent", "sessions"), "first", 3);
	writeSession(path.join(home, ".omp", "agent", "sessions"), "second", 2);
	const recorder = tempDir.join("spawn-recorder.ts");
	await Bun.write(recorder, SPAWN_RECORDER);
	const spawnLog = tempDir.join("spawns.log");

	// The child must resolve its agent dir and stats.db from the isolated home.
	const env: Record<string, string | undefined> = {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		NO_COLOR: "1",
		OMP_TEST_SPAWN_LOG: spawnLog,
	};
	for (const key of [
		"PI_CODING_AGENT_DIR",
		"PI_CONFIG_DIR",
		"OMP_PROFILE",
		"PI_PROFILE",
		"XDG_CACHE_HOME",
		"XDG_CONFIG_HOME",
		"XDG_DATA_HOME",
		"XDG_STATE_HOME",
	]) {
		delete env[key];
	}
	const proc = Bun.spawn([process.execPath, "--preload", recorder, cliEntry, "stats", "--summary"], {
		cwd: home,
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);

	expect(exitCode, stderr).toBe(0);
	expect(stderr).toContain("Synced 5 new entries from 2 files (5 total)");
	const spawned = fs.existsSync(spawnLog) ? fs.readFileSync(spawnLog, "utf8") : "";
	expect(spawned).not.toContain(STATS_WORKER_SELECTOR);
}, 60_000);
