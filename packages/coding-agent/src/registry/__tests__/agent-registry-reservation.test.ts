import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../config/settings";
import { ExtensionRuntime } from "../../extensibility/extensions/loader";
import * as sdk from "../../sdk";
import {
	bindInternalAgentAuthoritySession,
	createAgentRootSession,
	detachAgentSession,
	lookupAgentRef,
	setAgentStatus,
} from "../../internal/agent-registry-bridge";
import type { AgentSession } from "../../session/agent-session";
import { EventBus } from "../../utils/event-bus";
import { installSessionOperationLedger } from "../operation-lease";
import { AgentRegistry } from "../agent-registry";
import { RegistryDurableStateStore, registryDurableJournalPath } from "../durable-state";

const temporaryDirectories: string[] = [];
function fakeSession(file: string): AgentSession {
	const sessionManager = { getSessionFile: () => file };
	installSessionOperationLedger(sessionManager);
	return { sessionManager, dispose: vi.fn(async () => {}) } as unknown as AgentSession;
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

describe("AgentRegistry authority session creation", () => {
	test("claims a reserved root after SDK assembly", async () => {
		const session = fakeSession("/main.jsonl");
		vi.spyOn(sdk, "createAgentSession").mockResolvedValue({ session } as sdk.CreateAgentSessionResult);
		const registry = new AgentRegistry();
		await createAgentRootSession(registry, { agentId: "Main", agentDisplayName: "main" });
		expect(registry.get("Main")?.lineage).toMatchObject({ rootId: "Main" });
	});
	test("rejects restricted authority startup before SDK assembly without a durable store", async () => {
		const createSession = vi.spyOn(sdk, "createAgentSession");
		const registry = new AgentRegistry();
		await expect(
			createAgentRootSession(registry, {
				agentId: "Restricted",
				restrictToolNames: true,
				toolNames: [],
			}),
		).rejects.toThrow("durable registry state store");
		expect(createSession).not.toHaveBeenCalled();
	});

	test("returns fresh recursively frozen observations without exposing mutable registry state", () => {
		const registry = new AgentRegistry();
		registry.register({
			id: "Worker",
			displayName: "worker",
			kind: "sub",
			status: "running",
			session: null,
			parentId: "Main",
			history: {
				requestedPermissionProfiles: ["default"],
				metrics: { tokens: 1, requests: 2, tools: 3, cost: 4, durationMs: 5 },
			},
		});
		const first = registry.get("Worker")!;
		const second = registry.get("Worker")!;
		expect(second).not.toBe(first);
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(first.lineage)).toBe(true);
		expect(Object.isFrozen(first.history)).toBe(true);
		expect(Object.isFrozen(first.history?.requestedPermissionProfiles)).toBe(true);
		expect(Object.isFrozen(first.history?.metrics)).toBe(true);
		expect(Reflect.set(first, "status", "aborted")).toBe(false);
		expect(Reflect.set(first.lineage!, "parentId", "forged")).toBe(false);
		expect(Reflect.set(first, "parentId", "forged")).toBe(false);
		expect("session" in first).toBe(false);
		expect(Reflect.set(first, "history", {})).toBe(false);
		expect(() => {
			first.history!.requestedPermissionProfiles!.push("forged");
		}).toThrow();
		expect(registry.get("Worker")).toMatchObject({ status: "running", parentId: "Main" });
	});

	test("consumes one construction callback against an immutable canonical snapshot", async () => {
		const session = fakeSession("/snapshot.jsonl");
		const gate = Promise.withResolvers<void>();
		let captured: sdk.CreateAgentSessionOptions | undefined;
		const createSession = vi.spyOn(sdk, "createAgentSession").mockImplementation(async options => {
			captured = options;
			await gate.promise;
			return { session } as sdk.CreateAgentSessionResult;
		});
		const settings = Settings.isolated();
		const outputSchema = { type: "object", properties: { answer: { type: "string" } } };
		const modelPattern = ["provider/model", "provider/fallback"];
		const registry = new AgentRegistry();
		const creation = createAgentRootSession(registry, { agentId: "Main", outputSchema, modelPattern, settings });
		await Promise.resolve();
		outputSchema.properties.answer.type = "number";
		modelPattern[0] = "forged/model";
		expect(captured?.outputSchema).toEqual({ type: "object", properties: { answer: { type: "string" } } });
		expect(captured?.modelPattern).toEqual(["provider/model", "provider/fallback"]);
		expect(captured?.settings).not.toBe(settings);
		expect(Object.isFrozen(captured)).toBe(true);
		expect(Object.isFrozen(captured?.outputSchema)).toBe(true);
		expect(Object.isFrozen(captured?.modelPattern)).toBe(true);
		gate.resolve();
		await creation;
		expect(createSession).toHaveBeenCalledTimes(1);
		expect(registry.get("Main")?.lineage).toMatchObject({ rootId: "Main" });
	});
	test("allows child creation only from the exact current live parent session", async () => {
		const main = fakeSession("/main.jsonl");
		const child = fakeSession("/worker.jsonl");
		vi.spyOn(sdk, "createAgentSession")
			.mockResolvedValueOnce({ session: main } as sdk.CreateAgentSessionResult)
			.mockResolvedValueOnce({ session: child } as sdk.CreateAgentSessionResult);
		const registry = new AgentRegistry();
		await createAgentRootSession(registry, { agentId: "Main" });
		const mainBinding = bindInternalAgentAuthoritySession(registry, main)!;
		await mainBinding.create({ agentId: "Main/worker", agentDisplayName: "worker" });
	});

	test("revives only the exact parked ref under the same live root", async () => {
		const main = fakeSession("/main.jsonl");
		const first = fakeSession("/worker.jsonl");
		const revived = fakeSession("/worker.jsonl");
		const createSession = vi
			.spyOn(sdk, "createAgentSession")
			.mockResolvedValueOnce({ session: main } as sdk.CreateAgentSessionResult)
			.mockResolvedValueOnce({ session: first } as sdk.CreateAgentSessionResult)
			.mockResolvedValueOnce({ session: revived } as sdk.CreateAgentSessionResult);
		const registry = new AgentRegistry();
		await createAgentRootSession(registry, { agentId: "Main" });
		const mainBinding = bindInternalAgentAuthoritySession(registry, main)!;
		await mainBinding.create({ agentId: "Main/worker", agentDisplayName: "worker" });
		const ref = registry.get("Main/worker")!;
		expect(registry.setStatus(ref.id, "parked", first)).toBe(false);
		expect(registry.detachSession(ref.id, first)).toBe(false);
		expect(bindInternalAgentAuthoritySession(registry, fakeSession("/forged.jsonl"))).toBeUndefined();
		expect(setAgentStatus(registry, ref.id, "parked", first)).toBe(true);
		expect(detachAgentSession(registry, ref.id, first)).toBe(true);
		await mainBinding.create({ agentId: ref.id, agentDisplayName: ref.displayName }, ref);
		const observed = registry.get(ref.id)!;
		expect(observed).not.toBe(ref);
		expect(observed).toMatchObject({ id: ref.id, lineage: ref.lineage, status: "running" });
		expect("session" in observed).toBe(false);
		expect(registry.setStatus(ref.id, "aborted", first)).toBe(false);
		expect(registry.detachSession(ref.id, first)).toBe(false);
		expect(setAgentStatus(registry, ref.id, "idle", revived)).toBe(true);
		await expect(mainBinding.create({ agentId: ref.id }, { ...ref })).rejects.toBeInstanceOf(Error);
		expect(createSession).toHaveBeenCalledTimes(3);
		expect(registry.get(ref.id)).toMatchObject({
			id: observed.id,
			lineage: observed.lineage,
			status: "idle",
		});
		expect(lookupAgentRef(registry, ref.id)?.session).toBe(revived);
	});

	test("revives the exact durable root generation despite an ephemeral deadline change", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-registry-restart-"));
		temporaryDirectories.push(directory);
		const sessionFile = path.join(directory, "main.jsonl");
		const journalPath = registryDurableJournalPath(sessionFile);
		const createSession = vi.spyOn(sdk, "createAgentSession").mockImplementation(async options => {
			const manager = options?.sessionManager;
			if (!manager) throw new Error("Expected explicit session manager");
			return {
				session: { sessionManager: manager, dispose: vi.fn(async () => {}) } as unknown as AgentSession,
				extensionsResult: { extensions: [], errors: [], runtime: new ExtensionRuntime() },
				setToolUIContext: () => {},
				eventBus: new EventBus(),
			} satisfies sdk.CreateAgentSessionResult;
		});

		const firstManager = Object.assign(Object.create({ manager: true }), { getSessionFile: () => sessionFile });
		installSessionOperationLedger(firstManager);
		const firstRegistry = new AgentRegistry({ durableState: new RegistryDurableStateStore(journalPath) });
		await createAgentRootSession(firstRegistry, {
			agentId: "Main",
			agentDisplayName: "main",
			sessionManager: firstManager as never,
			deadline: 1,
		});
		const generation = firstRegistry.get("Main")?.lineage?.generation;
		expect(generation).toBeDefined();

		const durableBytes = await fs.readFile(journalPath, "utf8");
		expect(durableBytes).not.toContain(sessionFile);
		expect(durableBytes).not.toContain("agentRegistry");
		const restartedManager = Object.assign(Object.create({ manager: true }), { getSessionFile: () => sessionFile });
		installSessionOperationLedger(restartedManager);
		const restartedStore = new RegistryDurableStateStore(journalPath);
		const restartedRegistry = new AgentRegistry({ durableState: restartedStore });
		await createAgentRootSession(restartedRegistry, {
			agentId: "Main",
			agentDisplayName: "main",
			sessionManager: restartedManager as never,
			deadline: 2,
		});

		expect(restartedRegistry.get("Main")?.lineage?.generation).toBe(generation);
		expect(restartedStore.recover().actors.get("Main")).toMatchObject({ generation, state: "active" });
		expect(createSession).toHaveBeenCalledTimes(2);
	});
});
