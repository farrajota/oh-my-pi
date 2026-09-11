/**
 * Regression coverage for transactional task-result generations. Output and
 * optional structured sidecar advance one CAS head, failed competing updates
 * disclose neither member, and schema-invalid parsed data remains recoverable
 * without changing the public SingleResult payload.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { ArtifactManager } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { createSessionDefaults } from "../helpers/session-defaults";

function createAuthorityFixture() {
	const agentRegistry = new AgentRegistry();
	const createAuthoritySession = (options: Parameters<typeof sdkModule.createAgentSession>[0]) =>
		sdkModule.createAgentSession({ ...options, agentRegistry });
	return { agentRegistry, createAuthoritySession };
}

function createMockSession(onPrompt: (params: { emit: (event: AgentSessionEvent) => void }) => void): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};
	const session = {
		...createSessionDefaults(),
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (_text: string, _options?: PromptOptions) => {
			onPrompt({ emit });
		},
	};
	return session as unknown as AgentSession;
}

function yieldEmittingSession(data: unknown): AgentSession {
	return createMockSession(({ emit }) => {
		emit({
			type: "tool_execution_end",
			toolCallId: "tool-sidecar",
			toolName: "yield",
			result: {
				content: [{ type: "text", text: "Result submitted." }],
				details: { status: "success", data },
			},
			isError: false,
		});
	});
}

const baseAgent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

describe("structured output sidecar lifecycle", () => {
	let artifactsDir: string | undefined;

	afterEach(async () => {
		vi.restoreAllMocks();
		if (artifactsDir) await fs.rm(artifactsDir, { recursive: true, force: true });
		artifactsDir = undefined;
	});

	it("keeps the prior generation authoritative when a competing head advance loses CAS", async () => {
		const id = "SidecarProbe";
		artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sidecar-test-"));
		const manager = new ArtifactManager(artifactsDir);
		await manager.publishAgentArtifacts(id, "old output", JSON.stringify({ summary: "prior generation" }));

		const session = yieldEmittingSession({ ok: true });
		const authority = createAuthorityFixture();
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({ session } as CreateAgentSessionResult);

		const result = await runSubprocess({
			cwd: "/tmp",
			agent: baseAgent,
			task: "do work",
			index: 0,
			id,
			settings: Settings.isolated(),
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			createAuthoritySession: authority.createAuthoritySession,
			enableLsp: false,
			agentRegistry: authority.agentRegistry,
			artifactsDir,
			parentArtifactManager: manager,
			outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
		});

		expect(result.exitCode).toBe(0);
		expect(result.structuredOutput).toMatchObject({ status: "valid", data: { ok: true } });
		expect(result.outputPath).toBeUndefined();
		const outputPath = await manager.getNamedPath("agent-output", id);
		const sidecarPath = await manager.getNamedPath("agent-sidecar", id);
		expect(await fs.readFile(outputPath as string, "utf8")).toBe("old output");
		expect(JSON.parse(await fs.readFile(sidecarPath as string, "utf8"))).toEqual({ summary: "prior generation" });
	});

	it("removes a stale sidecar instead of leaving it when the serialized data is undefined", async () => {
		// Regression: `Object.hasOwn(structured, "data")` can be true while
		// `JSON.stringify(structured.data, null, 2)` itself returns
		// `undefined` (e.g. `structured.data === undefined`) — previously
		// neither a write nor a removal happened, leaving a stale sidecar
		// from an earlier turn behind (PR #10625 review).
		artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sidecar-test-"));
		const id = "UndefinedDataProbe";
		const manager = new ArtifactManager(artifactsDir);
		const sidecarPath = path.join(artifactsDir, `${id}.json`);
		await fs.writeFile(sidecarPath, JSON.stringify({ summary: "stale from an earlier turn" }));

		const session = yieldEmittingSession({ ok: true });
		const authority = createAuthorityFixture();
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({ session } as CreateAgentSessionResult);

		const originalStringify = JSON.stringify.bind(JSON);
		vi.spyOn(JSON, "stringify").mockImplementation(((value: unknown, ...rest: unknown[]) => {
			// Narrowly target only the yielded `{ ok: true }` payload so other
			// concurrent JSON.stringify calls in the pipeline are unaffected.
			if (
				value !== null &&
				typeof value === "object" &&
				!Array.isArray(value) &&
				Object.keys(value).length === 1 &&
				"ok" in value &&
				value.ok === true
			) {
				return undefined as unknown as string;
			}
			return (originalStringify as (...args: unknown[]) => unknown)(value, ...rest) as string;
		}) as typeof JSON.stringify);

		const result = await runSubprocess({
			cwd: "/tmp",
			agent: baseAgent,
			task: "do work",
			index: 0,
			id,
			settings: Settings.isolated(),
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			createAuthoritySession: authority.createAuthoritySession,
			agentRegistry: authority.agentRegistry,
			enableLsp: false,
			artifactsDir,
			parentArtifactManager: manager,
			outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
		});

		expect(result.structuredOutput?.data).toEqual({ ok: true });
		expect(result.outputPath).toBe(path.join(artifactsDir, `${id}.md`));
		expect(await manager.getNamedPath("agent-sidecar", id)).toBeNull();
		await expect(fs.stat(sidecarPath)).rejects.toThrow();
	});

	it("persists the sidecar for a schema-invalid yield that still carries parsed data", async () => {
		// Regression: previously the sidecar was written only for
		// `status === "valid"`, so an oversized invalid payload had no
		// recovery path beyond the truncated inline preview.
		artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sidecar-test-"));
		const id = "InvalidSidecarProbe";
		const manager = new ArtifactManager(artifactsDir);

		// `ok` is a string, not a boolean — violates the schema below, but the
		// data still parses and must be preserved.
		const session = yieldEmittingSession({ ok: "not-a-boolean" });
		const authority = createAuthorityFixture();
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({ session } as CreateAgentSessionResult);

		const result = await runSubprocess({
			cwd: "/tmp",
			agent: baseAgent,
			task: "do work",
			index: 0,
			id,
			createAuthoritySession: authority.createAuthoritySession,
			agentRegistry: authority.agentRegistry,
			settings: Settings.isolated(),
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
			artifactsDir,
			parentArtifactManager: manager,
			outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
		});

		expect(result.structuredOutput?.status).toBe("invalid");
		expect(result.outputPath).toBe(path.join(artifactsDir, `${id}.md`));
		const sidecarPath = await manager.getNamedPath("agent-sidecar", id);
		expect(sidecarPath).toBe(path.join(artifactsDir, `${id}.json`));
		const sidecar = JSON.parse(await fs.readFile(sidecarPath as string, "utf-8"));
		expect(sidecar).toEqual({ ok: "not-a-boolean" });
	});
});
