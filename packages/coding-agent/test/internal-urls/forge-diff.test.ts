import { expect, test } from "bun:test";
import { resolveCwd } from "@oh-my-pi/pi-coding-agent/internal-urls/forge-diff";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createHubAuthorityFixture } from "../tools/hub-fixtures";

test("short forge URLs use the supplied isolated registry's session directory", async () => {
	const registry = new AgentRegistry();
	const fixture = await createHubAuthorityFixture(registry, "Main");
	try {
		const caller = fixture.createToolSession("Main");
		expect(resolveCwd({ agentRegistry: registry })).toBe(caller.cwd);
	} finally {
		await fixture.dispose();
	}
});
