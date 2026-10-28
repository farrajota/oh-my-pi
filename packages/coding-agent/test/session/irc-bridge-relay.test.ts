import { describe, expect, it } from "bun:test";
import type { Agent, AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { IrcDeliveryContext, IrcMessage } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { IrcBridge, type IrcBridgeHost } from "@oh-my-pi/pi-coding-agent/session/irc-bridge";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

function makeBridge(
	options: {
		autoReplyIrc?: IrcBridgeHost["autoReplyIrc"];
		autoReplyIrcEnabled?: boolean;
		isStreaming?: boolean;
		isParentSender?: IrcBridgeHost["isParentSender"];
	} = {},
) {
	const woken: AgentMessage[][] = [];
	const persisted: Array<{ type: string; message: AgentMessage }> = [];
	const observations: CustomMessage[] = [];
	const host: IrcBridgeHost = {
		agent: {
			emitExternalEvent: (event: { type: string; message: AgentMessage }) => {
				persisted.push(event);
			},
		} as unknown as Agent,
		sessionManager: SessionManager.inMemory(),
		isDisposed: () => false,
		isParentSender: options.isParentSender ?? (() => false),
		isDescendantSender: () => false,
		isSubagent: () => false,
		isStreaming: () => options.isStreaming ?? false,
		planModeEnabled: () => false,
		emitSessionEvent: async event => {
			if (event.type === "irc_message") observations.push(event.message);
		},
		wakeForIrc: (records: AgentMessage[]) => {
			woken.push(records);
		},
		autoReplyIrcEnabled: () => options.autoReplyIrcEnabled ?? true,
		autoReplyIrc: options.autoReplyIrc ?? (async () => {}),
	};
	return { bridge: new IrcBridge(host), woken, persisted, observations };
}
describe("IrcBridge awaited auto-replies", () => {
	it("forwards only awaited streaming deliveries to auto-reply with their context", async () => {
		const replyBodies: string[] = [];
		const context: IrcDeliveryContext = {
			sendReply: async body => {
				replyBodies.push(body);
				return { to: "B", outcome: "injected" };
			},
		};
		const awaitedMessage: IrcMessage = {
			id: "irc-awaited",
			from: "B",
			to: "A",
			body: "status?",
			ts: 1,
			wakeRelay: false,
		};
		const replies: string[] = [];
		let forwardedContext: IrcDeliveryContext | undefined;
		const awaited = makeBridge({
			isStreaming: true,
			autoReplyIrc: async (message, deliveryContext) => {
				replies.push(message.id);
				forwardedContext = deliveryContext;
				await deliveryContext.sendReply("answer");
			},
		});

		await awaited.bridge.deliver(awaitedMessage, context);
		await awaited.bridge.waitForReplies();
		expect(replies).toEqual([awaitedMessage.id]);
		expect(forwardedContext).toBe(context);
		expect(replyBodies).toEqual(["answer"]);

		const nonAwaitedReplies: string[] = [];
		const nonAwaited = makeBridge({
			isStreaming: true,
			autoReplyIrc: async message => {
				nonAwaitedReplies.push(message.id);
			},
		});
		await nonAwaited.bridge.deliver({ ...awaitedMessage, id: "irc-non-awaited" });
		await nonAwaited.bridge.waitForReplies();

		const asyncEnabledReplies: string[] = [];
		const asyncEnabled = makeBridge({
			isStreaming: true,
			autoReplyIrcEnabled: false,
			autoReplyIrc: async message => {
				asyncEnabledReplies.push(message.id);
			},
		});
		await asyncEnabled.bridge.deliver({ ...awaitedMessage, id: "irc-async-enabled" }, context);
		await asyncEnabled.bridge.waitForReplies();

		expect(nonAwaitedReplies).toEqual([]);
		expect(asyncEnabledReplies).toEqual([]);
	});
});

describe("IrcBridge wake-relay marking", () => {
	it("marks relay messages so the peer never relays them back", async () => {
		const { bridge, woken } = makeBridge();
		const outcome = await bridge.deliver({
			id: "irc-1",
			from: "B",
			to: "A",
			body: "You hang up",
			ts: Date.now(),
			wakeRelay: true,
		});

		expect(outcome).toBe("woken");
		expect(woken).toHaveLength(1);
		const record = woken[0][0] as CustomMessage;
		expect(record.details).toMatchObject({ from: "B", wakeRelay: true });
		// The model-facing card must not promise a relay that will never come.
		expect(record.content).toContain("No one replies on your behalf");
	});

	it("still advertises the stop relay for genuine messages", async () => {
		const { bridge, woken } = makeBridge();
		await bridge.deliver({ id: "irc-2", from: "B", to: "A", body: "status?", ts: Date.now(), wakeRelay: false });

		const record = woken[0][0] as CustomMessage;
		expect(record.details).not.toHaveProperty("wakeRelay");
		expect(record.content).toContain("is delivered to");
	});
});

describe("IrcBridge aside persistence", () => {
	it("restores an in-flight auto-reply and persists it through flush", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const replyBodies: string[] = [];
		const reply: CustomMessage = {
			role: "custom",
			customType: "irc:autoreply",
			content: "answer",
			display: true,
			details: { to: "B", body: "answer", replyTo: "irc-incoming" },
			attribution: "agent",
			timestamp: 1,
		};
		const { bridge, persisted, observations } = makeBridge({
			isStreaming: true,
			autoReplyIrc: async (_message, deliveryContext) => {
				started.resolve();
				await release.promise;
				await deliveryContext.sendReply("answer");
				bridge.queueAside([reply]);
				bridge.emitRelayObservation(reply);
			},
		});
		const context: IrcDeliveryContext = {
			sendReply: async body => {
				replyBodies.push(body);
				return { to: "B", outcome: "injected" };
			},
		};
		const delivery = bridge.deliver(
			{
				id: "irc-incoming",
				from: "B",
				to: "A",
				body: "question",
				ts: 1,
				replyTo: "prior-message",
				wakeRelay: false,
			},
			context,
		);
		await started.promise;
		const snapshot = bridge.clearPending();
		release.resolve();
		await delivery;
		await bridge.waitForReplies();
		bridge.restorePending(snapshot);
		bridge.flushPending();

		expect(observations.filter(record => record.customType === "irc:autoreply")).toEqual([reply]);
		const incoming = observations.find(record => record.customType === "irc:incoming");
		expect(incoming?.details).toMatchObject({
			id: "irc-incoming",
			from: "B",
			message: "question",
			replyTo: "prior-message",
		});
		expect(replyBodies).toEqual(["answer"]);
		expect(persisted.filter(event => event.message === reply).map(event => event.type)).toEqual([
			"message_start",
			"message_end",
		]);
	});
});

describe("IrcBridge broadcast legs reaching a streaming recipient", () => {
	function makeStreamingChild(options: { registry?: AgentRegistry } = {}) {
		const steered: AgentMessage[] = [];
		const host: IrcBridgeHost = {
			agent: { steer: (message: AgentMessage) => steered.push(message) } as unknown as Agent,
			sessionManager: SessionManager.inMemory(),
			isDisposed: () => false,
			isParentSender: (recipientId: string, senderId: string) => recipientId === "Child" && senderId === "Main",
			isDescendantSender: (recipientId: string, senderId: string) => {
				const registry = options.registry;
				if (!registry) return false;
				let ref = registry.get(senderId);
				while (ref?.parentId) {
					if (ref.parentId === recipientId) return true;
					ref = registry.get(ref.parentId);
				}
				return false;
			},
			isSubagent: agentId => agentId === "Child",
			isStreaming: () => true,
			planModeEnabled: () => false,
			emitSessionEvent: async () => {},
			wakeForIrc: () => {},
			autoReplyIrcEnabled: () => false,
			autoReplyIrc: async () => {},
		};
		return { bridge: new IrcBridge(host), steered };
	}

	it("never steers a parent's broadcast leg; only a direct parent message is a parent request", async () => {
		const { bridge, steered } = makeStreamingChild();
		await bridge.deliver({ id: "b1", from: "Main", to: "Child", body: "everyone: status", ts: 1, broadcast: true });
		await bridge.deliver({ id: "d1", from: "Main", to: "Child", body: "you: status", ts: 2 });

		expect(steered.map(message => bridge.isParentSteer(message))).toEqual([true]);
		expect(bridge.drainPending().map(record => (record as CustomMessage).details)).toMatchObject([
			{ id: "b1", broadcast: true },
		]);
	});

	it("leaves non-parent messages queued at a stop boundary and drains them after work", async () => {
		const { bridge } = makeStreamingChild();
		await bridge.deliver({ id: "p1", from: "Peer", to: "Child", body: "question?", ts: 3 });
		await bridge.deliver({ id: "b3", from: "Main", to: "Child", body: "everyone: status", ts: 4, broadcast: true });
		bridge.queueAside([{ role: "custom", customType: "note", content: "aside", display: false, timestamp: 5 }]);

		expect(bridge.drainPending({ keepPeerMessages: true }).map(record => record.timestamp)).toEqual([5]);
		expect(bridge.drainPending().map(record => record.timestamp)).toEqual([3, 4]);
	});

	it("drains a message from the recipient's own descendant at a stop boundary, since its run may wait on it", async () => {
		const registry = new AgentRegistry();
		const { bridge } = makeStreamingChild({ registry });
		registry.register({ id: "Child.Kid", displayName: "kid", kind: "sub", parentId: "Child", session: null });
		registry.register({
			id: "Child.Kid.Grand",
			displayName: "grand",
			kind: "sub",
			parentId: "Child.Kid",
			session: null,
		});
		await bridge.deliver({ id: "k1", from: "Child.Kid", to: "Child", body: "question?", ts: 6 });
		await bridge.deliver({ id: "g1", from: "Child.Kid.Grand", to: "Child", body: "question?", ts: 7 });

		expect(bridge.drainPending({ keepPeerMessages: true }).map(record => record.timestamp)).toEqual([6, 7]);
	});

	it("counts only queued IRC messages as a sender's question still waiting for a turn", async () => {
		const { bridge } = makeStreamingChild();
		bridge.queueAside([
			{
				role: "custom",
				customType: "note",
				content: "aside",
				display: false,
				details: { from: "Peer" },
				timestamp: 8,
			},
		]);
		expect(bridge.hasQueuedFrom("Peer")).toBe(false);
		await bridge.deliver({ id: "p2", from: "Peer", to: "Child", body: "question?", ts: 9 });
		expect(bridge.hasQueuedFrom("Peer")).toBe(true);
	});

	it("keeps the broadcast flag on a message drained from the inbox", async () => {
		const { bridge } = makeStreamingChild();
		await bridge.deliver({ id: "b2", from: "Peer", to: "Child", body: "everyone: rebase", ts: 3, broadcast: true });

		expect(bridge.drainInboxMessages("Child")).toMatchObject([{ id: "b2", from: "Peer", broadcast: true }]);
	});
});
