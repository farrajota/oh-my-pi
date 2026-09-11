import { afterEach, describe, expect, it } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import {
	registryDurableStateForSession,
	type RegistryDurableStateStore,
} from "@oh-my-pi/pi-coding-agent/registry/durable-state";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const priorRegistry = AgentRegistry.global();

afterEach(() => {
	AgentRegistry.installGlobal(priorRegistry);
});

async function captureMainRootOptions(noSession: boolean): Promise<{
	options: CreateAgentSessionOptions;
	installedRegistry: AgentRegistry;
	expectedDurableState: RegistryDurableStateStore | undefined;
}> {
	using tempDir = TempDir.createSync("@omp-main-durable-registry-");
	const previousAgentDir = getAgentDir();
	setAgentDir(tempDir.path());
	const authStorage = await AuthStorage.create(":memory:");
	const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
	const rawArgs = noSession ? ["--no-session", "--print", "hello"] : ["--print", "hello"];
	const parsed = parseArgs(rawArgs);
	parsed.noExtensions = true;
	parsed.noSkills = true;
	parsed.noRules = true;
	parsed.noTools = true;
	parsed.noLsp = true;
	let captured: CreateAgentSessionOptions | undefined;
	let installedRegistry: AgentRegistry | undefined;
	let expectedDurableState: RegistryDurableStateStore | undefined;
	const stop = new Error("stop after root options");

	try {
		await runRootCommand(parsed, rawArgs, {
			discoverAuthStorage: async () => authStorage,
			settings,
			createAgentSession: async options => {
				if (!options) throw new Error("Expected root session options");
				captured = options;
				installedRegistry = AgentRegistry.global();
				const sessionFile = options.sessionManager?.getSessionFile();
				expectedDurableState = sessionFile ? registryDurableStateForSession(sessionFile) : undefined;
				throw stop;
			},
		});
	} catch (error) {
		if (error !== stop) throw error;
	} finally {
		authStorage.close();
		await captured?.sessionManager?.close();
		setAgentDir(previousAgentDir);
	}

	if (!captured || !installedRegistry) {
		throw new Error("Main root creation was not reached");
	}
	return { options: captured, installedRegistry, expectedDurableState };
}

describe("Main durable registry startup", () => {
	it("installs the registry backed by the resolved persisted session before root creation", async () => {
		const { options, installedRegistry, expectedDurableState } = await captureMainRootOptions(false);
		if (!options.sessionManager?.getSessionFile()) throw new Error("Expected a persisted Main session file");

		expect(options.agentRegistry).toBe(installedRegistry);
		expect(installedRegistry.getDurableStateStore()).toBe(expectedDurableState);
	});

	it("uses a storeless unrestricted projection for --no-session", async () => {
		const { options, installedRegistry } = await captureMainRootOptions(true);

		expect(options.sessionManager?.getSessionFile()).toBeUndefined();
		expect(options.agentRegistry).toBe(installedRegistry);
		expect(installedRegistry.getDurableStateStore()).toBeUndefined();
	});
});
