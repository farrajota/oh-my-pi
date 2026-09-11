import { type CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { registerToolSessionLifecycleAuthority } from "../../src/internal/agent-lifecycle-bridge";
import {
	bindInternalAgentAuthoritySession,
	createAgentRootSession,
	lookupAgentRef,
} from "../../src/internal/agent-registry-bridge";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

export interface HubAuthorityFixture {
	readonly registry: AgentRegistry;
	createChild(id: string, parentId?: string): Promise<CreateAgentSessionResult>;
	createToolSession(id: string): ToolSession;
	dispose(): Promise<void>;
}

export async function createHubAuthorityFixture(registry: AgentRegistry, rootId: string): Promise<HubAuthorityFixture> {
	const tempDir = TempDir.createSync("@omp-hub-authority-");
	const sessionOptions = {
		cwd: tempDir.path(),
		agentDir: tempDir.path(),
		settings: Settings.isolated(),
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableLsp: false,
	};
	const root = await createAgentRootSession(registry, {
		...sessionOptions,
		agentId: rootId,
		agentDisplayName: rootId,
	});
	const owned = new Map<string, CreateAgentSessionResult>([[rootId, root]]);
	return {
		registry,
		async createChild(id: string, parentId = rootId): Promise<CreateAgentSessionResult> {
			const existing = owned.get(id);
			if (existing) return existing;
			const parent = owned.get(parentId)?.session;
			if (!parent) throw new Error(`Expected an owned parent session for ${parentId}.`);
			const authority = bindInternalAgentAuthoritySession(registry, parent);
			if (!authority) throw new Error("Expected a live parent authority session.");
			const child = await authority.create({
				...sessionOptions,
				agentId: id,
				agentDisplayName: id,
			});
			owned.set(id, child);
			return child;
		},
		createToolSession(id: string): ToolSession {
			const ref = lookupAgentRef(registry, id);
			const owner = ref?.session;
			if (!ref || !owner) throw new Error(`Expected an authority-owned session for ${id}.`);
			const toolSession: ToolSession = {
				cwd: tempDir.path(),
				hasUI: false,
				getSessionFile: () => ref.sessionFile,
				getSessionSpawns: () => "*",
				settings: Settings.isolated(),
				agentRegistry: registry,
				getAgentId: () => id,
			};
			registerToolSessionLifecycleAuthority(toolSession, registry, owner);
			return toolSession;
		},
		async dispose(): Promise<void> {
			for (const session of [...owned.values()].reverse()) {
				if (!session.session.isDisposed) await session.session.dispose();
			}
			tempDir.removeSync();
		},
	};
}
type IrcControlMessage = { id: string; from: string; to: string; body: string; ts: number; replyTo?: string };

type IrcControllableSession = AgentSession & {
	deliverIrcMessage(message: IrcControlMessage): Promise<"injected" | "woken">;
	emitIrcRelayObservation(message: unknown): void;
};

export function installHubIrcControls(session: AgentSession): {
	delivered: IrcControlMessage[];
	relayed: unknown[];
	setOutcome(outcome: "injected" | "woken"): void;
	setError(error: Error): void;
	onDeliver(callback: (message: IrcControlMessage) => void): void;
} {
	let outcome: "injected" | "woken" = "injected";
	let nextError: Error | undefined;
	let onDeliver: ((message: IrcControlMessage) => void) | undefined;
	const delivered: IrcControlMessage[] = [];
	const relayed: unknown[] = [];
	const controlled = session as unknown as IrcControllableSession;
	controlled.deliverIrcMessage = async message => {
		if (nextError) {
			const error = nextError;
			nextError = undefined;
			throw error;
		}
		delivered.push(message);
		onDeliver?.(message);
		return outcome;
	};
	controlled.emitIrcRelayObservation = message => {
		relayed.push(message);
	};
	return {
		delivered,
		relayed,
		setOutcome(value) {
			outcome = value;
		},
		setError(error) {
			nextError = error;
		},
		onDeliver(callback) {
			onDeliver = callback;
		},
	};
}
