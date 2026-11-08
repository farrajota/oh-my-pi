/**
 * A call the session's permission scope denies is refused before extension `tool_call` handlers see
 * it, on the loop's arg-prep emission as on the wrapper's.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { type Api, clearCustomApis, type Model, type ModelSpec, registerCustomApi } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { encodePermissionScope } from "@oh-my-pi/pi-coding-agent/task/permissions/snapshot";
import type { PermissionScope } from "@oh-my-pi/pi-coding-agent/task/permissions/types";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "../../helpers/agent-session-setup";

const readOnlyScope: PermissionScope = {
	v: 2,
	mode: "enforce",
	toolsEnabled: true,
	pathsEnabled: true,
	actorId: "GuardedChild",
	actorKind: "sub",
	profiles: ["read-only"],
	tools: ["read"],
	denyTools: [],
	allowPathGroups: [],
	denyPathGroups: [],
	guardrails: { noNetwork: false, secretsBlind: false },
	restricted: true,
	inherited: false,
	provenance: { profiles: [] },
};

afterEach(() => clearCustomApis());

describe("session tool_call emission under a permission scope", () => {
	it("never shows a denied call to tool_call handlers and returns the scope's reason", async () => {
		using tempDir = TempDir.createSync("@omp-scope-tool-call-");
		const api = "test-scope-tool-call";
		let requests = 0;
		registerCustomApi(api, () => {
			requests++;
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				if (requests === 1) {
					const message = createAssistantMessage("");
					const toolCall = {
						type: "toolCall",
						id: "call-denied-1",
						name: "bash",
						arguments: { command: "echo hi" },
					} as const;
					message.content = [toolCall];
					message.stopReason = "toolUse";
					stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: toolCall as never, partial: message });
					stream.push({ type: "done", reason: "toolUse", message });
				} else {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
				}
			});
			return stream;
		});
		const model = buildModel({
			id: "local-scope-model",
			name: "Local Scope Model",
			api,
			provider: "ollama",
			baseUrl: "http://127.0.0.1:11434",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		const seen: string[] = [];
		const observer: ExtensionFactory = pi => {
			pi.on("tool_call", async event => {
				seen.push(event.toolName);
				return undefined;
			});
		};
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"bash.autoBackground.enabled": false,
				"bashInterceptor.enabled": false,
				"task.permissions.activeScope": encodePermissionScope(readOnlyScope),
			}),
			model,
			disableExtensionDiscovery: true,
			extensions: [observer],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			toolNames: ["bash", "read"],
		});
		try {
			await session.sendUserMessage("run it");

			expect(seen).toEqual([]);
			const toolResult = session.agent.state.messages.find(message => message.role === "toolResult") as
				| { isError?: boolean; content: Array<{ type: string; text?: string }> }
				| undefined;
			expect(toolResult?.isError).toBe(true);
			expect(toolResult?.content.find(block => block.type === "text")?.text).toContain(
				"BLOCKED: Subagent permission profile does not allow tool 'bash'.",
			);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});
});
