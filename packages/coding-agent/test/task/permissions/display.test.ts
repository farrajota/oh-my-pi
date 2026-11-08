/**
 * P6: the Agent Hub shows the permission scope a subagent runs under, from a display-only summary
 * that the registry history, the collab snapshots and the pi-wire types carry. The summary is
 * derived from the verified scope; it is bounded and sanitized, and the fork's recent-denial
 * history is gone. Ports the fork's display tests without the denial-history ones.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { registerPersistedSubagents } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { freezePermissionScope } from "@oh-my-pi/pi-coding-agent/task/permissions/snapshot";
import { buildPermissionSummary, normalizePermissionSummary } from "@oh-my-pi/pi-coding-agent/task/permissions/summary";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createSessionDefaults } from "../../helpers/session-defaults";
import { enforceScope } from "./scope-fixtures";

afterEach(() => {
	vi.restoreAllMocks();
	AgentRegistry.resetGlobalForTests();
});

describe("the permission summary", () => {
	it("projects the scope's profiles, tools, paths and guardrails, with messaging named as such", () => {
		const summary = buildPermissionSummary(
			enforceScope({
				profiles: ["read-only", "secrets-blind"],
				tools: ["read", "grep", "hub"],
				denyTools: ["web_search"],
				allowPathGroups: [["src/**", "test/**"]],
				denyPathGroups: [["**/.env"], ["secret", "**/*.pem"]],
				guardrails: { noNetwork: true, secretsBlind: true },
			}),
		);

		expect(summary).toEqual({
			mode: "enforce",
			profiles: { items: ["read-only", "secrets-blind"], omittedCount: 0 },
			tools: { items: ["read", "grep", "messaging"], omittedCount: 0 },
			denyTools: { items: ["web_search"], omittedCount: 0 },
			allowPathSets: { items: [{ items: ["src/**", "test/**"], omittedCount: 0 }], omittedCount: 0 },
			denyPaths: { items: ["**/.env", "secret", "**/*.pem"], omittedCount: 0 },
			guardrails: { noNetwork: true, secretsBlind: true },
		});
		expect(Object.isFrozen(summary)).toBe(true);
		expect(Object.isFrozen(summary.profiles.items)).toBe(true);
	});

	it("leaves the tool list out for a scope without an allowlist", () => {
		expect(buildPermissionSummary(enforceScope()).tools).toBeUndefined();
	});

	it("bounds long lists and strips control characters", () => {
		const profiles = Array.from({ length: 19 }, (_, index) => `profile-${index}`);
		const summary = buildPermissionSummary(
			enforceScope({ profiles, denyPathGroups: [[`evil\u001b[2Jpath\nnext/${"x".repeat(600)}`]] }),
		);

		expect(summary.profiles.items).toEqual(profiles.slice(0, 16));
		expect(summary.profiles.omittedCount).toBe(3);
		const denied = summary.denyPaths.items[0] ?? "";
		expect(denied).not.toMatch(/[\u0000-\u001f]/u);
		expect(denied.startsWith("evil")).toBe(true);
		expect(new TextEncoder().encode(denied).byteLength).toBeLessThanOrEqual(512);
	});

	it("re-owns untrusted summaries: malformed ones are refused, denial history is dropped", () => {
		const valid = buildPermissionSummary(enforceScope({ profiles: ["read-only"] }));
		const forkShaped = {
			...valid,
			recentDenials: { items: [{ kind: "subagent_permission_denial", code: "tool-deny" }], omittedCount: 0 },
			clauses: { items: [], omittedCount: 0 },
		};

		expect(normalizePermissionSummary(forkShaped)).toEqual(valid);
		expect(normalizePermissionSummary({ ...valid, mode: "maybe" })).toBeUndefined();
		expect(normalizePermissionSummary({ ...valid, profiles: ["read-only"] })).toBeUndefined();
		expect(normalizePermissionSummary("enforce")).toBeUndefined();
	});
});

describe("registry history of a parked subagent", () => {
	function transcript(init: Record<string, unknown>): string[] {
		return [
			JSON.stringify({ type: "session", id: "s0", parentId: null, timestamp: "2026-11-08T10:00:00.000Z" }),
			JSON.stringify({
				type: "session_init",
				id: "si",
				parentId: "s0",
				timestamp: "2026-11-08T10:00:01.000Z",
				agent: "task",
				task: "scoped work",
				...init,
			}),
		];
	}

	async function historyOf(id: string, init: Record<string, unknown>) {
		using dir = TempDir.createSync("@omp-permission-history-");
		await Bun.write(path.join(dir.path(), "main.jsonl"), "");
		await Bun.write(path.join(dir.path(), "main", `${id}.jsonl`), `${transcript(init).join("\n")}\n`);
		const registry = new AgentRegistry();
		await registerPersistedSubagents(registry, path.join(dir.path(), "main.jsonl"));
		return registry.get(id)?.history;
	}

	it("restores the profiles and a summary derived from the verified snapshot", async () => {
		const scope = enforceScope({ actorId: "Scoped", profiles: ["read-only", "no-network"], tools: ["read"] });
		const history = await historyOf("Scoped", {
			requestedPermissionProfiles: ["no-network"],
			effectivePermissionProfiles: ["read-only", "no-network"],
			permissionSnapshot: freezePermissionScope(scope),
		});

		expect(history?.requestedPermissionProfiles).toEqual(["no-network"]);
		expect(history?.effectivePermissionProfiles).toEqual(["read-only", "no-network"]);
		expect(history?.permissionSummary).toEqual(buildPermissionSummary(scope));
	});

	it("shows no summary for a snapshot that does not verify, and ignores a persisted fork summary", async () => {
		const scope = enforceScope({ actorId: "Tampered", tools: ["read"] });
		const snapshot = structuredClone(freezePermissionScope(scope)) as unknown as { scope: { tools: string[] } };
		snapshot.scope.tools = ["read", "write"];
		const history = await historyOf("Tampered", {
			effectivePermissionProfiles: [],
			permissionSnapshot: snapshot,
			permissionSummary: buildPermissionSummary(enforceScope({ tools: ["read", "write"] })),
		});

		expect(history?.effectivePermissionProfiles).toEqual([]);
		expect(history?.permissionSummary).toBeUndefined();
	});
});

describe("registry history of a live subagent", () => {
	function yieldingSession(): AgentSession {
		const listeners: Array<(event: AgentSessionEvent) => void> = [];
		return {
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
				return () => listeners.splice(listeners.indexOf(listener), 1);
			},
			prompt: async () => {
				for (const listener of listeners) {
					listener({
						type: "tool_execution_end",
						toolCallId: "yield-1",
						toolName: "yield",
						result: {
							content: [{ type: "text", text: "done" }],
							details: { status: "success", data: { ok: true } },
						},
						isError: false,
					});
				}
				return true;
			},
		} as unknown as AgentSession;
	}

	it("records the spawn's profiles and summary as soon as the child starts", async () => {
		const result: CreateAgentSessionResult = {
			session: yieldingSession(),
			extensionsResult: { extensions: [], errors: [], runtime: {} as unknown } as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		};
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async () => {
			// The SDK registers the child before the executor records its contract.
			AgentRegistry.global().register({
				id: "LiveScoped",
				displayName: "LiveScoped",
				kind: "sub",
				parentId: "Main",
				session: null,
				status: "running",
			});
			return result;
		});
		const scope = enforceScope({ actorId: "LiveScoped", profiles: ["read-only"], tools: ["read", "grep"] });
		await executorModule.runSubprocess({
			cwd: process.cwd(),
			agent: { name: "synthetic", description: "test", systemPrompt: "Do the work.", source: "project" },
			task: "do work",
			index: 0,
			id: "LiveScoped",
			settings: Settings.isolated(),
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
			permissionScope: scope,
			requestedPermissionProfiles: ["read-only"],
		});

		const history = AgentRegistry.global().get("LiveScoped")?.history;
		expect(history?.requestedPermissionProfiles).toEqual(["read-only"]);
		expect(history?.effectivePermissionProfiles).toEqual(["read-only"]);
		expect(history?.permissionSummary).toEqual(buildPermissionSummary(scope));
	});
});
