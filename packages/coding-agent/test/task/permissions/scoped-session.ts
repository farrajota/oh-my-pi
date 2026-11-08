/**
 * A real `AgentSession` running under a subagent permission scope, driven by a scripted model that
 * issues the given tool calls in its first turn and stops in its second.
 */
import * as fs from "node:fs";
import { type Api, clearCustomApis, type Model, type ModelSpec, registerCustomApi } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resolveLocalRoot } from "@oh-my-pi/pi-coding-agent/internal-urls/local-protocol";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { PermissionScope } from "@oh-my-pi/pi-coding-agent/task/permissions/types";
import type { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "../../helpers/agent-session-setup";
import { scopedSettings } from "./scope-fixtures";

export interface ScriptedCall {
	readonly name: string;
	readonly arguments: Record<string, unknown>;
}

export interface ScopedSession {
	readonly session: AgentSession;
	/** Text of each tool result, in order, with its error flag. */
	toolResults(): { text: string; isError: boolean }[];
	dispose(): Promise<void>;
}

let apiCounter = 0;

export async function createScopedSession(options: {
	readonly tempDir: TempDir;
	readonly scope: PermissionScope;
	readonly toolNames: string[];
	readonly calls?: readonly ScriptedCall[];
	readonly settings?: Record<string, unknown>;
}): Promise<ScopedSession> {
	const api = `test-scoped-session-${++apiCounter}`;
	let requests = 0;
	registerCustomApi(api, () => {
		requests++;
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => {
			if (requests === 1 && options.calls && options.calls.length > 0) {
				const message = createAssistantMessage("");
				const toolCalls = options.calls.map((call, index) => ({
					type: "toolCall" as const,
					id: `call-${index + 1}`,
					name: call.name,
					arguments: call.arguments,
				}));
				message.content = toolCalls;
				message.stopReason = "toolUse";
				toolCalls.forEach((toolCall, index) => {
					stream.push({ type: "toolcall_start", contentIndex: index, partial: message });
					stream.push({
						type: "toolcall_end",
						contentIndex: index,
						toolCall: toolCall as never,
						partial: message,
					});
				});
				stream.push({ type: "done", reason: "toolUse", message });
			} else {
				stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
			}
		});
		return stream;
	});
	const model = buildModel({
		id: "local-scoped-model",
		name: "Local Scoped Model",
		api,
		provider: "ollama",
		baseUrl: "http://127.0.0.1:11434",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
	} as ModelSpec<Api>) as Model<Api>;
	const { tempDir } = options;
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	const { session } = await createAgentSession({
		cwd: tempDir.path(),
		agentDir: tempDir.join("agent"),
		sessionManager: SessionManager.inMemory(tempDir.path()),
		authStorage,
		modelRegistry,
		settings: scopedSettings(options.scope, {
			"compaction.enabled": false,
			"bash.autoBackground.enabled": false,
			"bashInterceptor.enabled": false,
			...options.settings,
		}),
		model,
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		toolNames: options.toolNames,
	});
	return {
		session,
		toolResults: () =>
			session.agent.state.messages
				.filter(message => message.role === "toolResult")
				.map(message => {
					const result = message as { isError?: boolean; content: Array<{ type: string; text?: string }> };
					return {
						text: result.content
							.filter(block => block.type === "text")
							.map(block => block.text ?? "")
							.join("\n"),
						isError: result.isError === true,
					};
				}),
		dispose: async () => {
			// An in-memory session keeps its `local://` scratch space under the OS temp dir.
			const localRoot = resolveLocalRoot({
				getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
				getSessionId: () => session.sessionManager.getSessionId(),
			});
			await session.dispose();
			authStorage.close();
			clearCustomApis();
			fs.rmSync(localRoot, { recursive: true, force: true });
		},
	};
}
