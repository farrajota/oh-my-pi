/**
 * Cursor frames that act without a registry tool (the native `delete`, a `read_mcp_resource`
 * download or read) answer to the session's subagent permission scope like every wrapped tool.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { DeleteArgsSchema } from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CursorExecHandlers } from "@oh-my-pi/pi-coding-agent/cursor";
import type { MCPResourceReadResult } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { enforceScope, scopedSettings } from "./scope-fixtures";

type ResourceReader = (server: string, uri: string) => Promise<MCPResourceReadResult | undefined>;

function handlersFor(cwd: string, settings: Settings, readServerResource: ResourceReader = async () => undefined) {
	return new CursorExecHandlers({
		cwd,
		tools: new Map(),
		allowDirectFileMutation: true,
		getToolContext: () => ({ settings }) as AgentToolContext,
		mcpResources: {
			serverNames: () => ["docs"],
			getServerResources: async () => ({ resources: [] }),
			readServerResource,
		},
	});
}

describe("Cursor direct frames under a permission scope", () => {
	let cwd: string;
	beforeEach(async () => {
		cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cursor-scope-frames-")));
	});
	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	it("refuses a native delete the scope's allowlist does not name", async () => {
		const target = path.join(cwd, "keep.txt");
		await Bun.write(target, "keep me\n");
		const handlers = handlersFor(cwd, scopedSettings(enforceScope({ tools: ["read"] })));

		const result = await handlers.delete(create(DeleteArgsSchema, { toolCallId: "call-scope", path: "keep.txt" }));

		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain(
			"BLOCKED: Subagent permission profile does not allow tool 'delete'.",
		);
		expect(await Bun.file(target).exists()).toBe(true);
	});

	it("refuses a native delete even when a user policy allows delete", async () => {
		const target = path.join(cwd, "keep.txt");
		await Bun.write(target, "keep me\n");
		const handlers = handlersFor(
			cwd,
			scopedSettings(enforceScope({ denyTools: ["delete"] }), { "tools.approval": { delete: "allow" } }),
		);

		const result = await handlers.delete(create(DeleteArgsSchema, { toolCallId: "call-deny", path: "keep.txt" }));

		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain("BLOCKED: Subagent permission profile denied tool 'delete'.");
		expect(await Bun.file(target).exists()).toBe(true);
	});

	it("still deletes when the scope allows it", async () => {
		const target = path.join(cwd, "gone.txt");
		await Bun.write(target, "remove me\n");
		const handlers = handlersFor(cwd, scopedSettings(enforceScope({ tools: ["read", "delete"] })));

		const result = await handlers.delete(create(DeleteArgsSchema, { toolCallId: "call-ok", path: "gone.txt" }));

		expect(result.isError).toBe(false);
		expect(await Bun.file(target).exists()).toBe(false);
	});

	it("refuses a resource download into a denied path before reading the resource", async () => {
		let reads = 0;
		const handlers = handlersFor(
			cwd,
			scopedSettings(enforceScope({ tools: ["read", "write"], denyPathGroups: [["secret"]] })),
			async () => {
				reads++;
				return { contents: [{ uri: "docs://readme", text: "body" }] };
			},
		);

		await expect(
			handlers.readMcpResource({ server: "docs", uri: "docs://readme", downloadPath: "secret/readme.md" }),
		).rejects.toThrow("BLOCKED: Subagent permission profile denied path");
		expect(reads).toBe(0);
		expect(await Bun.file(path.join(cwd, "secret", "readme.md")).exists()).toBe(false);
	});

	it("refuses a resource read under the no-network guardrail", async () => {
		let reads = 0;
		const handlers = handlersFor(
			cwd,
			scopedSettings(enforceScope({ tools: ["read"], guardrails: { noNetwork: true, secretsBlind: false } })),
			async () => {
				reads++;
				return { contents: [{ uri: "docs://readme", text: "body" }] };
			},
		);

		await expect(handlers.readMcpResource({ server: "docs", uri: "docs://readme" })).rejects.toThrow(
			"no-network guardrail",
		);
		expect(reads).toBe(0);
	});
});
