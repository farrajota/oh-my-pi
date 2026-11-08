/**
 * P6: collab snapshots carry each subagent's permission provenance (requested and effective
 * profiles, display summary), so a guest's Agent Hub shows the same scope as the host's. The guest
 * re-owns the summary: a malformed one is dropped and an oversized one is bounded.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fsp from "node:fs/promises";
import { generateRoomKey, importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabGuestLink } from "@oh-my-pi/pi-coding-agent/collab/guest";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import {
	type AgentSnapshot,
	COLLAB_PROTO,
	type CollabFrame,
	formatCollabLink,
	parseCollabLink,
} from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { buildPermissionSummary } from "@oh-my-pi/pi-coding-agent/task/permissions/summary";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { enforceScope } from "../task/permissions/scope-fixtures";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

const SUMMARY = buildPermissionSummary(
	enforceScope({
		profiles: ["read-only", "no-network", "focused-edit"],
		tools: ["read", "edit"],
		guardrails: { noNetwork: true, secretsBlind: false },
	}),
);

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	installInMemoryRelay();
});

afterEach(() => {
	uninstallInMemoryRelay();
	AgentRegistry.resetGlobalForTests();
});

function hostContext(): InteractiveModeContext {
	return {
		settings: Settings.isolated(),
		sessionManager: SessionManager.inMemory(),
		session: {
			isStreaming: false,
			isAborting: false,
			queuedMessageCount: 0,
			sessionName: "host session",
			model: undefined,
			thinkingLevel: undefined,
			subscribe: () => () => {},
			emitNotice: () => {},
			promptCustomMessage: () => Promise.resolve(),
			abort: () => Promise.resolve(),
		},
		eventBus: new EventBus(),
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
}

describe("collab permission provenance", () => {
	it("publishes the registry's permission profiles and summary in host snapshots", async () => {
		AgentRegistry.global().register({
			id: "ScopedWorker",
			displayName: "Scoped Worker",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "parked",
			history: {
				requestedPermissionProfiles: ["no-network", "focused-edit"],
				effectivePermissionProfiles: ["read-only", "no-network", "focused-edit"],
				permissionSummary: SUMMARY,
			},
		});
		AgentRegistry.global().register({
			id: "OpenWorker",
			displayName: "Open Worker",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "parked",
		});
		const host = new CollabHost(hostContext());
		await host.start("ws://localhost:8788");
		const parsed = parseCollabLink(host.link);
		if ("error" in parsed) throw new Error(parsed.error);
		const guestSocket = new CollabSocket({
			wsUrl: parsed.wsUrl,
			role: "guest",
			key: await importRoomKey(parsed.key),
		});
		const welcomed = Promise.withResolvers<Extract<CollabFrame, { t: "welcome" }>>();
		guestSocket.onFrame = frame => {
			if (frame.t === "welcome") welcomed.resolve(frame);
		};
		guestSocket.onOpen = () => {
			guestSocket.send({
				t: "hello",
				proto: COLLAB_PROTO,
				name: "provenance-probe",
				writeToken: parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined,
			});
		};
		guestSocket.connect();

		try {
			const agents = (await welcomed.promise).agents;
			expect(agents.find(agent => agent.id === "ScopedWorker")).toMatchObject({
				requestedPermissionProfiles: ["no-network", "focused-edit"],
				effectivePermissionProfiles: ["read-only", "no-network", "focused-edit"],
				permissionSummary: SUMMARY,
			});
			const open = agents.find(agent => agent.id === "OpenWorker");
			expect(open?.permissionSummary).toBeUndefined();
			expect(open?.effectivePermissionProfiles).toBeUndefined();
		} finally {
			guestSocket.close();
			await host.stop("test cleanup").catch(() => {});
		}
	}, 20000);

	it("mirrors the provenance into the guest registry, re-owning the summary", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
		const roomId = "provenance-room";
		const roomKey = generateRoomKey();
		const link = formatCollabLink("ws://localhost:8788", roomId, roomKey);
		const hostSocket = new CollabSocket({
			wsUrl: `ws://localhost:8788/r/${roomId}`,
			role: "host",
			key: await importRoomKey(roomKey),
		});
		const hostOpen = Promise.withResolvers<void>();
		const oversized = {
			...SUMMARY,
			profiles: { items: Array.from({ length: 20 }, (_, index) => `profile-${index}`), omittedCount: 1 },
		};
		const agents: AgentSnapshot[] = [
			{
				id: "Scoped",
				displayName: "Scoped",
				kind: "sub",
				parentId: "Main",
				status: "running",
				hasSessionFile: true,
				createdAt: 1,
				lastActivity: 2,
				requestedPermissionProfiles: ["no-network"],
				effectivePermissionProfiles: ["read-only", "no-network"],
				permissionSummary: oversized,
			},
			{
				id: "Malformed",
				displayName: "Malformed",
				kind: "sub",
				parentId: "Main",
				status: "running",
				hasSessionFile: true,
				createdAt: 1,
				lastActivity: 2,
				permissionSummary: { mode: "enforce" } as never,
			},
		];
		hostSocket.onOpen = () => hostOpen.resolve();
		hostSocket.onFrame = frame => {
			if (frame.t !== "hello") return;
			hostSocket.send({
				t: "welcome",
				proto: COLLAB_PROTO,
				header: { type: "session", id: "remote-session", timestamp: "2026-11-08T00:00:00Z", cwd: "/tmp" },
				state: {
					isStreaming: false,
					queuedMessageCount: 0,
					sessionName: "host session",
					cwd: "/tmp",
					participants: [{ name: "Host", role: "host" }],
				},
				agents,
				entryCount: 0,
			});
		};
		hostSocket.connect();
		await hostOpen.promise;
		const ctx = guestContext();
		const guest = new CollabGuestLink(ctx);

		try {
			await guest.join(link);
			const scoped = guest.agentRegistry.get("Scoped")?.history;
			expect(scoped?.requestedPermissionProfiles).toEqual(["no-network"]);
			expect(scoped?.effectivePermissionProfiles).toEqual(["read-only", "no-network"]);
			expect(scoped?.permissionSummary?.profiles.items).toHaveLength(16);
			expect(scoped?.permissionSummary?.profiles.omittedCount).toBe(5);
			expect(guest.agentRegistry.get("Malformed")?.history?.permissionSummary).toBeUndefined();
		} finally {
			hostSocket.close();
			await guest.leave("test cleanup").catch(() => {});
			writeSpy.mockRestore();
			renameSpy.mockRestore();
		}
	});
});

function guestContext(): InteractiveModeContext {
	const ctx = {
		collabGuest: undefined as CollabGuestLink | undefined,
		settings: Settings.isolated(),
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
		pendingShellContainer: { clear: () => {} },
		pendingMessagesContainer: { clear: () => {} },
		compactionQueuedMessages: [],
		streamingComponent: undefined,
		streamingMessage: undefined,
		transcriptMessageComponents: new WeakMap(),
		pendingTools: new Map(),
		loadingAnimation: undefined,
		statusLine: {
			setRunningSubagents: () => {},
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
		eventController: {
			dispatchSessionEvent: () => Promise.resolve(),
			takeDisplaceableComponents: () => [],
			resetTranscriptAnchors: () => {},
		},
		syncRunningSubagentBadge: () => {},
		setCollabGuest: (guest: InteractiveModeContext["collabGuest"]) => {
			Object.assign(ctx, { collabGuest: guest });
		},
	} as unknown as InteractiveModeContext;
	return ctx;
}
