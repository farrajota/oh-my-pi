import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { executeList } from "@oh-my-pi/pi-coding-agent/tools/hub/messaging";

describe("IRC roster activity", () => {
	let registry: AgentRegistry;
	beforeEach(() => {
		registry = new AgentRegistry();
	});
	afterEach(() => {
		mock.restore();
	});

	async function listText(senderId: string): Promise<string> {
		const result = await executeList(registry, senderId);
		return result.content.map(item => (item.type === "text" ? item.text : "")).join("\n");
	}

	it("surfaces a peer's role and current activity in the list", async () => {
		registry.register({ id: "Main", displayName: "main", kind: "main", session: null, status: "running" });
		registry.register({
			id: "AuthScout",
			displayName: "Auth-flow security reviewer",
			kind: "sub",
			session: null,
			status: "running",
		});
		registry.setActivity("AuthScout", "auditing the token refresh path");

		const text = await listText("Main");
		expect(text).toContain("Auth-flow security reviewer");
		expect(text).toContain("auditing the token refresh path");
	});

	it("renders a peer with no activity without a dangling clause", async () => {
		registry.register({ id: "Main", displayName: "main", kind: "main", session: null, status: "running" });
		registry.register({ id: "Quiet", displayName: "task", kind: "sub", session: null, status: "running" });

		const text = await listText("Main");
		expect(text).toContain("Quiet [task · sub · running]");
		expect(text).not.toContain("undefined");
		expect(text).not.toMatch(/running\] —\s*,/);
	});
	it("setActivity refreshes lastActivity so a working agent is not shown as stale", () => {
		// irc list renders "active <lastActivity> ago" and both list views sort by
		// lastActivity, so an activity update must refresh it or live work looks idle.
		const now = spyOn(Date, "now");
		now.mockReturnValue(1_000);
		registry.register({ id: "Worker", displayName: "task", kind: "sub", session: null, status: "running" });
		now.mockReturnValue(60_000);
		registry.setActivity("Worker", "running bash");
		expect(registry.get("Worker")?.lastActivity).toBe(60_000);
		// A repeated identical gist is still a heartbeat: recency must refresh even
		// though the activity text did not change.
		now.mockReturnValue(90_000);
		registry.setActivity("Worker", "running bash");
		expect(registry.get("Worker")?.lastActivity).toBe(90_000);
	});

	it("clears activity when a peer leaves running so finished work is not shown as current", () => {
		registry.register({ id: "Done", displayName: "task", kind: "sub", session: null, status: "running" });
		registry.setActivity("Done", "running bash");
		expect(registry.get("Done")?.activity).toBe("running bash");
		registry.setStatus("Done", "idle");
		expect(registry.get("Done")?.activity).toBeUndefined();
	});

	it("ignores activity heartbeats for an agent that is no longer running", () => {
		registry.register({ id: "Stopped", displayName: "task", kind: "sub", session: null, status: "idle" });
		registry.setActivity("Stopped", "running bash");
		expect(registry.get("Stopped")?.activity).toBeUndefined();
	});

	it("normalizes a multi-line activity gist to one bounded line", () => {
		// A model-authored intent with newlines/tabs must not break out of its one
		// roster row; setActivity collapses it centrally so every caller is safe.
		registry.register({ id: "Noisy", displayName: "task", kind: "sub", session: null, status: "running" });
		registry.setActivity("Noisy", "editing\n- fake roster line\twith tabs");
		expect(registry.get("Noisy")?.activity).toBe("editing - fake roster line with tabs");
	});

	it("setActivity is a no-op for an unknown agent id (registers no phantom ref)", () => {
		const before = registry.list().length;
		registry.setActivity("Ghost", "noop");
		expect(registry.get("Ghost")).toBeUndefined();
		expect(registry.list().length).toBe(before);
	});
});
