/**
 * P6: the Agent Hub inspector shows the active permission scope of the selected subagent (mode,
 * profiles, guardrails) from its registry history, and nothing for an unscoped one. Ports the
 * history half of the fork's "renders canonical permission facts" hub test; the denial-history
 * line and the progress-carried summary are gone.
 */
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { createAgentHubRuntime } from "@oh-my-pi/pi-coding-agent/modes/agent-hub-runtime";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { buildPermissionSummary } from "@oh-my-pi/pi-coding-agent/task/permissions/summary";
import { AgentHubOverlayComponent } from "@oh-my-pi/pi-tui/overlays/agent-hub";
import { SessionObserverRegistry } from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { enforceScope } from "./scope-fixtures";

const restores: Array<() => void> = [];

function stubStdout(cols: number, rows: number): void {
	for (const [key, value] of [
		["columns", cols],
		["rows", rows],
	] as const) {
		const previous = Object.getOwnPropertyDescriptor(process.stdout, key);
		Object.defineProperty(process.stdout, key, { configurable: true, get: () => value, set: () => {} });
		restores.push(() => {
			if (previous) Object.defineProperty(process.stdout, key, previous);
			else Object.defineProperty(process.stdout, key, { configurable: true, value: undefined, writable: true });
		});
	}
}

function makeHub(agents: AgentRegistry): AgentHubOverlayComponent {
	return new AgentHubOverlayComponent({
		...createAgentHubRuntime({ settings: Settings.isolated(), registry: agents }),
		observers: new SessionObserverRegistry(),
		hubKeys: [],
		onDone: () => {},
		requestRender: () => {},
		registry: agents,
		irc: new IrcBus(agents),
		focusAgent: async () => {},
		manageActivityLive: true,
	});
}

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	for (const restore of restores.splice(0).reverse()) restore();
});

describe("Agent Hub permission facts", () => {
	it("shows the selected subagent's mode, profiles and guardrails from its history", () => {
		stubStdout(160, 48);
		const profiles = Array.from({ length: 18 }, (_, index) => `p${index}`);
		const agents = new AgentRegistry();
		agents.register({
			id: "Scoped",
			displayName: "Scoped",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "idle",
			lastActivity: 2_000,
			history: {
				permissionSummary: buildPermissionSummary(
					enforceScope({ profiles, guardrails: { noNetwork: true, secretsBlind: true } }),
				),
			},
		});
		const hub = makeHub(agents);

		try {
			const detail = Bun.stripANSI(hub.render(160).join("\n"));
			expect(detail).toContain("Permissions: mode enforce");
			// A long profile list wraps in the details pane; the omitted count follows the 16 shown.
			const detailPane = detail
				.split("\n")
				.map(line => line.split("│")[2]?.trim() ?? "")
				.filter(Boolean)
				.join(" ");
			expect(detailPane).toContain(`Profiles: ${profiles.slice(0, 16).join(", ")} (+2 omitted)`);
			expect(detail).toContain("Guardrails: no network, secrets blind");
			expect(detail).not.toContain("denial");
		} finally {
			hub.dispose();
		}
	});

	it("shows no permission facts for an unscoped subagent", () => {
		stubStdout(160, 48);
		const agents = new AgentRegistry();
		agents.register({
			id: "Open",
			displayName: "Open",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "idle",
			lastActivity: 2_000,
		});
		const hub = makeHub(agents);

		try {
			expect(Bun.stripANSI(hub.render(160).join("\n"))).not.toContain("Permissions: mode");
		} finally {
			hub.dispose();
		}
	});
});
