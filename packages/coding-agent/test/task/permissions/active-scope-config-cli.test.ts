/**
 * `omp config` neither lists nor writes the runtime-only `task.permissions.activeScope`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { runConfigCommand } from "@oh-my-pi/pi-coding-agent/cli/config-cli";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { getConfigRootDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const ACTIVE_SCOPE = "task.permissions.activeScope";
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let agentDir: TempDir;

beforeEach(() => {
	resetSettingsForTest();
	agentDir = TempDir.createSync("@omp-active-scope-cli-");
	setAgentDir(agentDir.path());
});

afterEach(async () => {
	vi.restoreAllMocks();
	AgentStorage.close();
	resetSettingsForTest();
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
	} else {
		setAgentDir(path.join(getConfigRootDir(), "agent"));
		delete process.env.PI_CODING_AGENT_DIR;
	}
	await agentDir.remove();
});

describe("config CLI and the active permission scope", () => {
	it("leaves it out of the listing", async () => {
		let written = "";
		vi.spyOn(process.stdout, "write").mockImplementation(((text: string, cb?: (error?: Error | null) => void) => {
			written += text;
			cb?.();
			return true;
		}) as typeof process.stdout.write);
		await runConfigCommand({ action: "list", flags: { json: true } });
		const listed = JSON.parse(written) as Record<string, unknown>;
		expect(Object.keys(listed)).toContain("task.isolation.enabled");
		expect(Object.keys(listed)).not.toContain(ACTIVE_SCOPE);
	});

	it("refuses to get or set it as an unknown setting", async () => {
		const errors: string[] = [];
		vi.spyOn(console, "error").mockImplementation((message: unknown) => {
			errors.push(Bun.stripANSI(String(message)));
		});
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("process.exit");
		}) as typeof process.exit);

		await expect(runConfigCommand({ action: "set", key: ACTIVE_SCOPE, value: "{}", flags: {} })).rejects.toThrow(
			"process.exit",
		);
		await expect(runConfigCommand({ action: "get", key: ACTIVE_SCOPE, flags: {} })).rejects.toThrow("process.exit");
		expect(errors.filter(line => line === `Unknown setting: ${ACTIVE_SCOPE}`)).toHaveLength(2);
	});
});
