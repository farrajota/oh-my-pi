import { afterEach, beforeEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "../src/async";
import { Settings } from "../src/config/settings";
import type { ToolSession } from "../src/tools";
import { BashTool } from "../src/tools/bash";
import { WriteTool } from "../src/tools/write";
import { registerToolSessionLifecycleAuthority } from "../src/internal/agent-lifecycle-bridge";
import { lookupAgentRef } from "../src/internal/agent-registry-bridge";
import { AgentRegistry } from "../src/registry/agent-registry";
import { SessionManager } from "../src/session/session-manager";
import { createHubAuthorityFixture, type HubAuthorityFixture } from "./tools/hub-fixtures";

let cwd: string;
let manager: AsyncJobManager;
let tool: BashTool;
let write: WriteTool;
let sessionManager: SessionManager;
let authority: HubAuthorityFixture;

beforeEach(async () => {
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-job-lifecycle-"));
	manager = new AsyncJobManager({});
	authority = await createHubAuthorityFixture(new AgentRegistry(), "Main");
	const owner = lookupAgentRef(authority.registry, "Main")?.session;
	if (!owner) throw new Error("Expected the genuine Bash lifecycle fixture owner.");
	sessionManager = owner.sessionManager;
	await sessionManager.ensureOnDisk();
	const session: ToolSession = {
		cwd,
		hasUI: false,
		getSessionFile: () => sessionManager.getSessionFile() ?? null,
		getAgentId: () => "Main",
		getSessionId: () => sessionManager.getSessionId(),
		sessionManager,
		agentRegistry: authority.registry,
		getSessionSpawns: () => "*",
		asyncJobManager: manager,
		settings: Settings.isolated({}),
	};
	registerToolSessionLifecycleAuthority(session, authority.registry, owner);
	tool = new BashTool(session);
	write = new WriteTool(session);
});

afterEach(async () => {
	await manager.dispose();
	await authority.dispose();
	await sessionManager.close();
	await fs.rm(cwd, { recursive: true, force: true });
});

it.skipIf(process.platform === "win32")(
	"allows a cancelled bash job to run its TERM cleanup",
	async () => {
		const script = path.join(cwd, "cleanup.sh");
		await Bun.write(
			script,
			"trap 'sleep 0.2; printf cleaned >> cleaned; exit 0' TERM\nprintf 'ready %s\\n' \"$$\"\nwhile :; do :; done\n",
		);
		const ready = Promise.withResolvers<number>();
		// `$$` identifies the actual `sh` process; verify it is the PID the job exposes.
		const result = await tool.execute(
			"term-cleanup",
			{ command: `sh ${JSON.stringify(script)}`, async: true, timeout: 0 },
			undefined,
			update => {
				for (const block of update.content ?? []) {
					if (block.type !== "text") continue;
					const match = /(?:^|\n)ready (\d+)(?:\n|$)/.exec(block.text);
					if (match) {
						ready.resolve(Number(match[1]));
						break;
					}
				}
			},
		);
		const commandPid = await ready.promise;
		const id = result.details?.async?.jobId;
		if (!id) throw new Error("expected background job");
		expect(manager.getJob(id)?.process?.pids()).toContain(commandPid);
		const watchAbort = new AbortController();
		const watcher = fs.watch(cwd, { signal: watchAbort.signal });
		const cleaned = (async () => {
			for await (const event of watcher) {
				if (event.filename === "cleaned") return true;
			}
			return false;
		})();
		// A real subprocess handles TERM; fake timers cannot bound its OS-level cleanup.
		const deadline = Promise.withResolvers<false>();
		const watchdog = setTimeout(() => deadline.resolve(false), 3_000);
		try {
			const completion = (async () => {
				const cancelled = await write.execute("cancel-cleanup", { path: `proc://${id}/kill` });
				expect(cancelled.details?.proc).toMatchObject({ cancelled: [{ id, status: "cancelled" }] });
				await manager.waitForAll();
				expect(await cleaned).toBe(true);
				return await Bun.file(path.join(cwd, "cleaned")).text();
			})();
			expect(await Promise.race([completion, deadline.promise])).toBe("cleaned");
		} finally {
			clearTimeout(watchdog);
			watchAbort.abort();
			await cleaned.catch(() => {});
		}
	},
	10_000,
);

it.skipIf(process.platform === "win32")("gives a background job the session identity", async () => {
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a persisted background-job fixture session.");
	const sessionId = sessionManager.getSessionId();
	const result = await tool.execute("bg-env", {
		command: `printf '%s|%s' "$PI_SESSION_ID" "$PI_SESSION_FILE" > env.txt`,
		async: true,
	});
	if (!result.details?.async?.jobId) throw new Error("expected background job");
	await manager.waitForAll();
	const [id, file] = (await Bun.file(path.join(cwd, "env.txt")).text()).split("|");
	expect(id).toBe(sessionId);
	expect(file).toBe(sessionFile);
});
