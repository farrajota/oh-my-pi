import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import {
	bindInternalAgentAuthoritySession,
	createAgentRootSession,
	lookupAgentRef,
	parkAgentRef,
	setAgentHistory,
} from "../../src/internal/agent-registry-bridge";
import * as registryBridge from "../../src/internal/agent-registry-bridge";
import { ensurePersistedRoster, registerPersistedSubagents } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import * as sessionLoader from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { TempDir } from "@oh-my-pi/pi-utils";

function sessionHeader(id: string): string {
	return JSON.stringify({
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id,
		timestamp: "2026-08-13T17:14:48.125Z",
		cwd: "/tmp",
	});
}

function makeAuthoritySession(sessionFile: string): AgentSession {
	let disposed = false;
	return {
		get isDisposed() {
			return disposed;
		},
		sessionManager: { getSessionFile: () => sessionFile },
		getPermissionScope: () => undefined,
		beginDispose: () => {},
		dispose: async () => {
			disposed = true;
		},
	} as unknown as AgentSession;
}

async function registerFrom(dir: string): Promise<AgentRegistry> {
	const registry = new AgentRegistry();
	await registerPersistedSubagents(registry, path.join(dir, "main.jsonl"));
	return registry;
}

describe("registerPersistedSubagents mid-spawn stubs", () => {
	it("ignores empty and traversal actor names without recursing into their directories", async () => {
		using tempDir = TempDir.createSync("@omp-malformed-roster-");
		const dir = tempDir.path();
		await Bun.write(path.join(dir, "main.jsonl"), `${sessionHeader("main")}\n`);
		for (const name of [".jsonl", "..jsonl", "...jsonl"]) {
			await Bun.write(path.join(dir, "main", name), `${sessionHeader(name)}\n`);
		}
		const registry = await registerFrom(dir);
		for (const id of ["", ".", ".."]) expect(registry.get(id)).toBeUndefined();
	});

	it("does not park a child that only has the SessionManager header", async () => {
		using tempDir = TempDir.createSync("@omp-mid-spawn-stub-");
		const dir = tempDir.path();
		await Bun.write(path.join(dir, "main.jsonl"), `${sessionHeader("main")}\n`);
		await Bun.write(
			path.join(dir, "main", "Adversary.jsonl"),
			`${JSON.stringify({ type: "title", v: 1, title: "", updatedAt: "2026-08-13T17:14:48.125Z", pad: " " })}\n${sessionHeader("adversary")}\n`,
		);

		const registry = await registerFrom(dir);
		expect(registry.get("Adversary")).toBeUndefined();
	});

	it("still parks a finished child that recorded session_init", async () => {
		using tempDir = TempDir.createSync("@omp-mid-spawn-init-");
		const dir = tempDir.path();
		await Bun.write(path.join(dir, "main.jsonl"), `${sessionHeader("main")}\n`);
		await Bun.write(
			path.join(dir, "main", "Worker.jsonl"),
			`${[
				sessionHeader("worker"),
				JSON.stringify({
					type: "session_init",
					id: "si",
					parentId: null,
					timestamp: "2026-08-13T17:14:49.000Z",
					systemPrompt: "review",
					task: "review the diff",
					tools: ["read"],
					agent: "adversarial-reviewer",
				}),
			].join("\n")}\n`,
		);

		const registry = await registerFrom(dir);
		expect(registry.get("Worker")?.status).toBe("parked");
		expect(registry.get("Worker")?.sessionFile).toBe(path.join(dir, "main", "Worker.jsonl"));
	});

	it("still parks a legacy child that has messages but no session_init", async () => {
		using tempDir = TempDir.createSync("@omp-mid-spawn-legacy-");
		const dir = tempDir.path();
		await Bun.write(path.join(dir, "main.jsonl"), `${sessionHeader("main")}\n`);
		await Bun.write(
			path.join(dir, "main", "Legacy.jsonl"),
			`${[
				sessionHeader("legacy"),
				JSON.stringify({
					type: "message",
					id: "m1",
					parentId: null,
					timestamp: "2026-08-13T17:14:49.000Z",
					message: { role: "user", content: "hello", timestamp: 1 },
				}),
			].join("\n")}\n`,
		);

		const registry = await registerFrom(dir);
		expect(registry.get("Legacy")?.status).toBe("parked");
	});

	it("does not replace a live generation claimed while metadata is being read", async () => {
		using tempDir = TempDir.createSync("@omp-mid-spawn-claim-");
		const dir = tempDir.path();
		const childFile = path.join(dir, "main", "Worker.jsonl");
		await Bun.write(path.join(dir, "main.jsonl"), `${sessionHeader("main")}\n`);
		await Bun.write(
			childFile,
			`${[
				sessionHeader("worker"),
				JSON.stringify({
					type: "session_init",
					id: "si",
					parentId: null,
					timestamp: "2026-08-13T17:14:49.000Z",
					systemPrompt: "review",
					task: "review the diff",
					tools: ["read"],
				}),
			].join("\n")}\n`,
		);

		const registry = new AgentRegistry();
		const liveSession = {} as AgentSession;
		const replaceInternal = registryBridge.replaceInternalAgentIfAvailable;
		let injectClaim = true;
		const replace = vi
			.spyOn(registryBridge, "replaceInternalAgentIfAvailable")
			.mockImplementation((target, input, expected) => {
				if (input.id === "Worker" && injectClaim) {
					injectClaim = false;
					target.register({
						id: input.id,
						displayName: input.id,
						kind: "sub",
						parentId: "main",
						session: liveSession,
						sessionFile: childFile,
						status: "running",
					});
				}
				return replaceInternal(target, input, expected);
			});
		try {
			await registerPersistedSubagents(registry, path.join(dir, "main.jsonl"));
		} finally {
			replace.mockRestore();
		}

		expect(registry.get("Worker")?.status).toBe("running");
		expect(lookupAgentRef(registry, "Worker")?.session).toBe(liveSession);
	});

	it("rejects delayed history hydration after same-path generation replacement", async () => {
		using tempDir = TempDir.createSync("@omp-persisted-history-generation-");
		const dir = tempDir.path();
		const childFile = path.join(dir, "main", "Worker.jsonl");
		await Bun.write(path.join(dir, "main.jsonl"), `${sessionHeader("main")}\n`);
		await Bun.write(
			childFile,
			`${[
				sessionHeader("worker"),
				JSON.stringify({
					type: "session_init",
					id: "si",
					parentId: null,
					timestamp: "2026-08-13T17:14:49.000Z",
					systemPrompt: "review",
					task: "review the diff",
					tools: ["read"],
					resolvedModel: "metadata/model",
				}),
				JSON.stringify({
					type: "message",
					id: "m1",
					parentId: "si",
					timestamp: "2026-08-13T17:14:50.000Z",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "done" }],
						provider: "provider",
						model: "hydrated",
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
						timestamp: 1,
						stopReason: "stop",
					},
				}),
			].join("\n")}\n`,
		);

		const hydrationStarted = Promise.withResolvers<void>();
		const releaseHydration = Promise.withResolvers<void>();
		const realVisit = sessionLoader.visitEntriesFromFileStream;
		let childReads = 0;
		const visit = vi.spyOn(sessionLoader, "visitEntriesFromFileStream").mockImplementation(async (...args) => {
			if (args[0] === childFile && ++childReads === 2) {
				hydrationStarted.resolve();
				await releaseHydration.promise;
			}
			return realVisit(...args);
		});
		const registry = new AgentRegistry();
		try {
			const scan = registerPersistedSubagents(registry, path.join(dir, "main.jsonl"));
			await hydrationStarted.promise;
			const original = lookupAgentRef(registry, "Worker");
			expect(original).toBeDefined();
			const replacement = registryBridge.replaceInternalAgentIfAvailable(
				registry,
				{
					id: "Worker",
					displayName: "Worker",
					kind: "sub",
					parentId: "Main",
					session: null,
					sessionFile: childFile,
					status: "parked",
					history: { resolvedModel: "replacement/model" },
				},
				original ?? null,
			);
			expect(replacement).toBeDefined();
			const metadataEvents: unknown[] = [];
			registry.onChange(event => {
				if (event.type === "metadata_changed") metadataEvents.push(event);
			});

			releaseHydration.resolve();
			await scan;

			expect(lookupAgentRef(registry, "Worker")).toBe(replacement);
			expect(registry.get("Worker")?.history?.resolvedModel).toBe("replacement/model");
			expect(metadataEvents).toEqual([]);
		} finally {
			releaseHydration.resolve();
			visit.mockRestore();
		}
	});

	it("rejects delayed history hydration after the same parked ref is revived into authority", async () => {
		using tempDir = TempDir.createSync("@omp-persisted-history-same-ref-revival-");
		const dir = tempDir.path();
		const rootFile = path.join(dir, "main.jsonl");
		const childFile = path.join(dir, "main", "Worker.jsonl");
		await Bun.write(rootFile, `${sessionHeader("main")}\n`);
		await Bun.write(
			childFile,
			`${[
				sessionHeader("worker"),
				JSON.stringify({
					type: "session_init",
					id: "si",
					parentId: null,
					timestamp: "2026-08-13T17:14:49.000Z",
					systemPrompt: "review",
					task: "review the diff",
					tools: ["read"],
					resolvedModel: "metadata/model",
				}),
				JSON.stringify({
					type: "message",
					id: "m1",
					parentId: "si",
					timestamp: "2026-08-13T17:14:50.000Z",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "done" }],
						provider: "provider",
						model: "hydrated",
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
						timestamp: 1,
						stopReason: "stop",
					},
				}),
			].join("\n")}\n`,
		);

		const rootSession = makeAuthoritySession(rootFile);
		const revivedSession = makeAuthoritySession(childFile);
		const createSession = vi.spyOn(sdkModule, "createAgentSession").mockImplementation(
			async options =>
				({
					session: options?.agentId === "Main" ? rootSession : revivedSession,
				}) as CreateAgentSessionResult,
		);
		const hydrationStarted = Promise.withResolvers<void>();
		const releaseHydration = Promise.withResolvers<void>();
		const realVisit = sessionLoader.visitEntriesFromFileStream;
		let childReads = 0;
		const visit = vi.spyOn(sessionLoader, "visitEntriesFromFileStream").mockImplementation(async (...args) => {
			if (args[0] === childFile && ++childReads === 2) {
				hydrationStarted.resolve();
				await releaseHydration.promise;
			}
			return realVisit(...args);
		});
		const registry = new AgentRegistry();
		try {
			const root = await createAgentRootSession(registry, { agentId: "Main", agentDisplayName: "main" });
			const scan = registerPersistedSubagents(registry, rootFile);
			await hydrationStarted.promise;
			const parked = registry.get("Worker");
			const parkedRef = lookupAgentRef(registry, "Worker");
			if (!parked || !parkedRef) throw new Error("Expected parked worker observation");
			const authority = bindInternalAgentAuthoritySession(registry, root.session);
			if (!authority) throw new Error("Expected root authority binding");
			const revived = await authority.create({ agentId: "Worker", agentDisplayName: "Worker" }, parked);
			expect(lookupAgentRef(registry, "Worker")).toBe(parkedRef);
			expect(setAgentHistory(registry, revived.session, { resolvedModel: "revived/model" })).toBe(true);
			const metadataEvents: unknown[] = [];
			registry.onChange(event => {
				if (event.type === "metadata_changed") metadataEvents.push(event);
			});

			releaseHydration.resolve();
			await scan;

			expect(registry.get("Worker")?.history?.resolvedModel).toBe("revived/model");
			expect(metadataEvents).toEqual([]);
			await revived.session.dispose();
			await root.session.dispose();
		} finally {
			releaseHydration.resolve();
			visit.mockRestore();
			createSession.mockRestore();
		}
	});

	it("invalidates a settled roster latch after same-path exact-ref replacement", async () => {
		using tempDir = TempDir.createSync("@omp-persisted-latch-same-path-ref-");
		const dir = tempDir.path();
		const rootFile = path.join(dir, "main.jsonl");
		const childFile = path.join(dir, "main", "Worker.jsonl");
		await Bun.write(rootFile, `${sessionHeader("main")}\n`);
		await Bun.write(
			childFile,
			`${sessionHeader("worker")}\n${JSON.stringify({
				type: "session_init",
				id: "si",
				parentId: null,
				timestamp: "2026-08-13T17:14:49.000Z",
				systemPrompt: "review",
				task: "review",
				tools: ["read"],
			})}\n`,
		);
		const registry = new AgentRegistry();
		const readdir = vi.spyOn(fs.promises, "readdir");
		try {
			await ensurePersistedRoster(registry, rootFile);
			const firstScanReads = readdir.mock.calls.filter(([candidate]) => candidate === path.join(dir, "main")).length;
			const original = lookupAgentRef(registry, "Worker");
			if (!original) throw new Error("Expected restored worker");
			const replacement = registryBridge.replaceInternalAgentIfAvailable(
				registry,
				{
					id: "Worker",
					displayName: "Worker",
					kind: "sub",
					parentId: "Main",
					session: null,
					sessionFile: childFile,
					status: "parked",
				},
				original,
			);
			expect(replacement).toBeDefined();

			await ensurePersistedRoster(registry, rootFile);

			const secondScanReads = readdir.mock.calls.filter(
				([candidate]) => candidate === path.join(dir, "main"),
			).length;
			expect(secondScanReads).toBeGreaterThan(firstScanReads);
		} finally {
			readdir.mockRestore();
		}
	});

	it("invalidates a settled roster latch after same-ref authority revival and re-park", async () => {
		using tempDir = TempDir.createSync("@omp-persisted-latch-same-ref-revival-");
		const dir = tempDir.path();
		const rootFile = path.join(dir, "main.jsonl");
		const childFile = path.join(dir, "main", "Worker.jsonl");
		await Bun.write(rootFile, `${sessionHeader("main")}\n`);
		await Bun.write(
			childFile,
			`${sessionHeader("worker")}\n${JSON.stringify({
				type: "session_init",
				id: "si",
				parentId: null,
				timestamp: "2026-08-13T17:14:49.000Z",
				systemPrompt: "review",
				task: "review",
				tools: ["read"],
			})}\n`,
		);
		const rootSession = makeAuthoritySession(rootFile);
		const revivedSession = makeAuthoritySession(childFile);
		const createSession = vi.spyOn(sdkModule, "createAgentSession").mockImplementation(
			async options =>
				({
					session: options?.agentId === "Main" ? rootSession : revivedSession,
				}) as CreateAgentSessionResult,
		);
		const registry = new AgentRegistry();
		const readdir = vi.spyOn(fs.promises, "readdir");
		try {
			const root = await createAgentRootSession(registry, { agentId: "Main", agentDisplayName: "main" });
			await ensurePersistedRoster(registry, rootFile);
			const firstScanReads = readdir.mock.calls.filter(([candidate]) => candidate === path.join(dir, "main")).length;
			const parked = registry.get("Worker");
			const parkedRef = lookupAgentRef(registry, "Worker");
			if (!parked || !parkedRef) throw new Error("Expected restored worker");
			const authority = bindInternalAgentAuthoritySession(registry, root.session);
			if (!authority) throw new Error("Expected root authority binding");
			const revived = await authority.create({ agentId: "Worker", agentDisplayName: "Worker" }, parked);
			expect(lookupAgentRef(registry, "Worker")).toBe(parkedRef);
			expect(parkAgentRef(registry, parkedRef, revived.session)).toBe(true);

			await ensurePersistedRoster(registry, rootFile);

			const secondScanReads = readdir.mock.calls.filter(
				([candidate]) => candidate === path.join(dir, "main"),
			).length;
			expect(secondScanReads).toBeGreaterThan(firstScanReads);
			await revived.session.dispose();
			await root.session.dispose();
		} finally {
			readdir.mockRestore();
			createSession.mockRestore();
		}
	});
});
