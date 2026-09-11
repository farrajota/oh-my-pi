import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { generateRoomKey, importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabGuestLink } from "@oh-my-pi/pi-coding-agent/collab/guest";
import {
	COLLAB_PROTO,
	type AgentSnapshot,
	type CollabFrame,
	formatCollabLink,
} from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentRootSession } from "../../src/internal/agent-registry-bridge";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

// The guest mirrors host EventBus traffic onto the local session and
// observability buses. When an SDK embedder wires the SAME EventBus into both
// slots, the mirror must emit each frame exactly once.
function permissionSummaryFixture() {
	return {
		mode: "enforce" as const,
		profiles: { items: ["focused-edit", "no-network"], omittedCount: 2 },
		clauses: {
			items: [
				{
					tools: { items: ["read", "edit"], omittedCount: 1 },
					allowPathSets: {
						items: [
							{ items: ["src/**", "test/**"], omittedCount: 1 },
							{ items: ["docs/**"], omittedCount: 0 },
						],
						omittedCount: 1,
					},
				},
			],
			omittedCount: 2,
		},
		denyTools: { items: ["bash"], omittedCount: 1 },
		denyPaths: { items: ["**/.env"], omittedCount: 2 },
		guardrails: { noNetwork: true, secretsBlind: false },
		intrinsicTools: { yield: true as const, reportToolIssue: true },
		recentDenials: {
			items: [
				{
					kind: "subagent_permission_denial" as const,
					code: "tool-deny" as const,
					tool: "bash",
					targets: { items: [{ kind: "process" as const, display: "shell command" }], omittedCount: 1 },
					matched: "bash",
					reason: "denied by fixture",
				},
				{
					kind: "subagent_permission_denial" as const,
					code: "path-not-allowed" as const,
					tool: "read",
					targets: { items: [{ kind: "path" as const, display: "private file" }], omittedCount: 0 },
					matched: "src/private.ts",
					reason: "outside allowed paths",
				},
			],
			omittedCount: 3,
		},
	};
}

function makeState(): Extract<CollabFrame, { t: "welcome" }>["state"] {
	return {
		isStreaming: false,
		queuedMessageCount: 0,
		sessionName: "host session",
		cwd: "/tmp",
		participants: [{ name: "Host", role: "host" }],
	};
}

function makeGuestContext(eventBus: EventBus): InteractiveModeContext {
	const ctx = {
		collabGuest: undefined as CollabGuestLink | undefined,
		settings: { get: () => "" },
		sessionManager: {
			getSessionFile: () => null,
			getSessionName: () => "local session",
			getCwd: () => "/local",
		},
		session: {
			messages: [],
			switchSession: () => Promise.resolve(),
			newSession: () => Promise.resolve(),
			agent: {
				state: { model: undefined },
				setModel: () => {},
				setThinkingLevel: () => {},
				setDisableReasoning: () => {},
			},
		},
		statusContainer: { clear: () => {} },
		pendingMessagesContainer: { clear: () => {} },
		compactionQueuedMessages: [],
		streamingComponent: undefined,
		streamingMessage: undefined,
		transcriptMessageComponents: new WeakMap(),
		pendingTools: new Map(),
		loadingAnimation: undefined,
		statusLine: {
			setSubagentCount: () => {},
			get subagentCount() {
				return 0;
			},
			setCollabStatus: () => {},
			invalidate: () => {},
			resetActiveTime: () => {},
			markActivityStart: () => {},
			markActivityEnd: () => {},
		},
		ui: { requestRender: () => {} },
		chatContainer: { clear: () => {}, disposeChildren: () => {} },
		resetObserverRegistry: () => {},
		renderInitialMessages: () => {},
		reloadTodos: () => Promise.resolve(),
		showStatus: () => {},
		showError: () => {},
		updateEditorTopBorder: () => {},
		updateEditorBorderColor: () => {},
		eventController: { handleEvent: () => Promise.resolve() },
		syncRunningSubagentBadge: () => {},
		eventBus,
		subagentEventBus: eventBus,
	} as unknown as InteractiveModeContext;
	return ctx;
}

function makeAuthoritySession(): AgentSession {
	let disposed = false;
	return {
		get isDisposed() {
			return disposed;
		},
		sessionManager: { getSessionFile: () => null },
		getPermissionScope: () => undefined,
		beginDispose: () => {},
		dispose: async () => {
			disposed = true;
		},
	} as unknown as AgentSession;
}

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	installInMemoryRelay();
});

afterEach(() => {
	uninstallInMemoryRelay();
	AgentRegistry.resetGlobalForTests();
});

describe("collab guest bus mirror", () => {
	it("emits an aliased bus frame exactly once", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const roomId = "bus-mirror-room-1";
		const roomKey = generateRoomKey();
		const cryptoKey = await importRoomKey(roomKey);
		const link = formatCollabLink("ws://localhost:8788", roomId, roomKey);
		const hostSocket = new CollabSocket({ wsUrl: `ws://localhost:8788/r/${roomId}`, role: "host", key: cryptoKey });
		const hostOpen = Promise.withResolvers<void>();
		hostSocket.onOpen = () => hostOpen.resolve();
		hostSocket.onFrame = frame => {
			if (frame.t === "hello") {
				hostSocket.send({
					t: "welcome",
					proto: COLLAB_PROTO,
					header: { type: "session", id: "remote-session", timestamp: "2026-06-26T00:00:00Z", cwd: "/tmp" },
					state: makeState(),
					agents: [],
					entryCount: 0,
				} as CollabFrame);
			}
		};
		hostSocket.connect();
		await hostOpen.promise;

		const sharedBus = new EventBus();
		const mirrored: Array<{ id?: string; status?: string }> = [];
		const firstFrame = Promise.withResolvers<void>();
		sharedBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, frame => {
			const payload = frame as { id?: string; status?: string };
			mirrored.push(payload);
			if (mirrored.length === 1) firstFrame.resolve();
		});

		const ctx = makeGuestContext(sharedBus);
		const guest = new CollabGuestLink(ctx);

		try {
			await guest.join(link);

			hostSocket.send({
				t: "bus",
				channel: TASK_SUBAGENT_LIFECYCLE_CHANNEL,
				data: {
					id: "MirroredScout",
					agent: "task",
					agentSource: "bundled",
					status: "started",
					parentToolCallId: "call-mirror",
					index: 1,
				},
			} as CollabFrame);
			await firstFrame.promise;
			// Give any duplicate emit a tick to land before counting.
			await Bun.sleep(25);

			expect(mirrored.length).toBe(1);
			expect(mirrored[0]?.id).toBe("MirroredScout");
			expect(mirrored[0]?.status).toBe("started");
		} finally {
			hostSocket.close();
			writeSpy.mockRestore();
			await guest.leave("test cleanup").catch(() => {});
		}
	});

	it("reconciles frozen legacy observations and rejects reentrant replacement and authority collisions", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const roomId = "snapshot-metadata-room-1";
		const roomKey = generateRoomKey();
		const cryptoKey = await importRoomKey(roomKey);
		const link = formatCollabLink("ws://localhost:8788", roomId, roomKey);
		const hostSocket = new CollabSocket({ wsUrl: `ws://localhost:8788/r/${roomId}`, role: "host", key: cryptoKey });
		const hostOpen = Promise.withResolvers<void>();
		const permissionSummary = permissionSummaryFixture();
		const initial: AgentSnapshot = {
			id: "MirroredWorker",
			displayName: "Initial host name",
			kind: "sub",
			parentId: "Main",
			status: "running",
			hasSessionFile: true,
			createdAt: 100,
			lastActivity: 200,
			modelRole: "initial-host-role",
			resolvedModel: "initial-host-model",
			resolvedModelIsFallback: false,
			permissionSummary,
		};
		hostSocket.onOpen = () => hostOpen.resolve();
		hostSocket.onFrame = frame => {
			if (frame.t === "hello") {
				hostSocket.send({
					t: "welcome",
					proto: COLLAB_PROTO,
					header: { type: "session", id: "remote-session", timestamp: "2026-06-26T00:00:00Z", cwd: "/tmp" },
					state: makeState(),
					agents: [initial],
					entryCount: 0,
				} as CollabFrame);
			}
		};
		hostSocket.connect();
		await hostOpen.promise;

		const ctx = makeGuestContext(new EventBus());
		const guest = new CollabGuestLink(ctx);
		const authoritySession = makeAuthoritySession();
		const createSession = spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session: authoritySession,
		} as CreateAgentSessionResult);

		try {
			await guest.join(link);
			expect(guest.agentRegistry.get(initial.id)).toMatchObject({
				displayName: initial.displayName,
				createdAt: initial.createdAt,
				lastActivity: initial.lastActivity,
				history: {
					modelRole: initial.modelRole,
					resolvedModel: initial.resolvedModel,
					resolvedModelIsFallback: initial.resolvedModelIsFallback,
				},
			});
			const mirroredPermissionSummary = guest.agentRegistry.get(initial.id)?.history?.permissionSummary;
			expect(mirroredPermissionSummary).toEqual(permissionSummary);
			expect(mirroredPermissionSummary).not.toBe(permissionSummary);
			expect(Object.isFrozen(mirroredPermissionSummary)).toBe(true);
			expect(Object.isFrozen(mirroredPermissionSummary?.clauses.items[0]?.allowPathSets.items[0])).toBe(true);
			permissionSummary.profiles.items[0] = "hostile-mutation";
			permissionSummary.clauses.items[0]!.allowPathSets.items[0]!.items[0] = "hostile/private";
			expect(mirroredPermissionSummary?.profiles.items[0]).toBe("focused-edit");
			expect(mirroredPermissionSummary?.clauses.items[0]?.allowPathSets.items[0]?.items[0]).toBe("src/**");

			const updated: AgentSnapshot = {
				...initial,
				displayName: "Updated host name",
				createdAt: 300,
				lastActivity: 400,
				modelRole: "updated-host-role",
				resolvedModel: "updated-host-model",
				resolvedModelIsFallback: true,
			};
			const metadataChanged = Promise.withResolvers<void>();
			const metadataEvents: Array<{ ref: unknown }> = [];
			const unsubscribe = guest.agentRegistry.onChange(event => {
				if (event.type === "metadata_changed" && event.ref.id === initial.id) {
					metadataEvents.push(event);
					metadataChanged.resolve();
				}
			});
			hostSocket.send({ t: "agents", agents: [updated] } as CollabFrame);
			await metadataChanged.promise;
			unsubscribe();
			expect(guest.agentRegistry.get(initial.id)).toMatchObject({
				displayName: updated.displayName,
				createdAt: updated.createdAt,
				lastActivity: updated.lastActivity,
				history: {
					modelRole: updated.modelRole,
					resolvedModel: updated.resolvedModel,
					resolvedModelIsFallback: updated.resolvedModelIsFallback,
				},
			});
			expect(metadataEvents).toHaveLength(2);
			expect(metadataEvents.every(event => Object.isFrozen(event.ref))).toBe(true);

			const racedUpdate: AgentSnapshot = {
				...updated,
				displayName: "Stale host name",
				status: "idle",
				createdAt: 500,
				lastActivity: 600,
				modelRole: "stale-host-role",
				resolvedModel: "stale-host-model",
				resolvedModelIsFallback: true,
			};
			const replacementInstalled = Promise.withResolvers<void>();
			const staleMetadataEvents: Array<{ ref: unknown }> = [];
			let removedObservedRow = false;
			let registeredReplacement = false;
			let replacing = false;
			const stopRaceListener = guest.agentRegistry.onChange(event => {
				if (event.ref.id !== initial.id) return;
				if (event.type === "metadata_changed") staleMetadataEvents.push(event);
				if (event.type !== "status_changed" || replacing) return;
				replacing = true;
				removedObservedRow = guest.agentRegistry.unregister(initial.id, event.ref);
				registeredReplacement =
					guest.agentRegistry.register({
						id: initial.id,
						displayName: "Local replacement",
						kind: "sub",
						session: null,
						status: "running",
						createdAt: 700,
						lastActivity: 800,
						history: {
							modelRole: "replacement-role",
							resolvedModel: "replacement-model",
							resolvedModelIsFallback: false,
						},
					}).id === initial.id;
				replacementInstalled.resolve();
			});
			hostSocket.send({ t: "agents", agents: [racedUpdate] } as CollabFrame);
			await replacementInstalled.promise;
			stopRaceListener();
			expect(removedObservedRow).toBe(true);
			expect(registeredReplacement).toBe(true);
			expect(guest.agentRegistry.get(initial.id)).toMatchObject({
				displayName: "Local replacement",
				status: "running",
				createdAt: 700,
				lastActivity: 800,
				history: {
					modelRole: "replacement-role",
					resolvedModel: "replacement-model",
					resolvedModelIsFallback: false,
				},
			});
			expect(staleMetadataEvents).toHaveLength(0);

			await createAgentRootSession(guest.agentRegistry, {
				agentId: "AuthorityMirror",
				agentDisplayName: "Local authority",
			});
			const authorityBefore = guest.agentRegistry.get("AuthorityMirror");
			if (!authorityBefore) throw new Error("Expected authority collision row");
			const legacyUpdatedAgain = { ...updated, lastActivity: 500 };
			const appliedAgain = Promise.withResolvers<void>();
			const stopListening = guest.agentRegistry.onChange(event => {
				if (event.type === "metadata_changed" && event.ref.id === initial.id) appliedAgain.resolve();
			});
			hostSocket.send({
				t: "agents",
				agents: [
					legacyUpdatedAgain,
					{
						id: "AuthorityMirror",
						displayName: "Host collision",
						kind: "main",
						status: "aborted",
						hasSessionFile: false,
						createdAt: 1,
						lastActivity: 2,
					},
				],
			} as CollabFrame);
			await appliedAgain.promise;
			stopListening();
			expect(guest.agentRegistry.get("AuthorityMirror")).toEqual(authorityBefore);
		} finally {
			hostSocket.close();
			writeSpy.mockRestore();
			createSession.mockRestore();
			await guest.leave("test cleanup").catch(() => {});
			await authoritySession.dispose();
		}
	});
});
