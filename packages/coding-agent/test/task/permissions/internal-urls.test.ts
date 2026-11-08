/**
 * P7: the path rules of a subagent scope apply to the file an internal URL resolves to, and a
 * secrets-blind subagent cannot read another agent's `history://`. A restricted child keeps its own
 * `local://` scratch space.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { resolveLocalRoot } from "@oh-my-pi/pi-coding-agent/internal-urls/local-protocol";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import type { InternalUrl, ProtocolHandler, ResolveContext } from "@oh-my-pi/pi-coding-agent/internal-urls/types";
import type { PermissionScope } from "@oh-my-pi/pi-coding-agent/task/permissions/types";
import { TempDir } from "@oh-my-pi/pi-utils";
import { enforceScope, scopedSettings } from "./scope-fixtures";
import { createScopedSession, type ScriptedCall } from "./scoped-session";

let tempDir: TempDir;

beforeEach(() => {
	tempDir = TempDir.createSync("@omp-scope-internal-urls-");
});
afterEach(() => {
	tempDir.removeSync();
});

async function runCalls(scope: PermissionScope, calls: ScriptedCall[]) {
	const scoped = await createScopedSession({ tempDir, scope, toolNames: ["read", "write", "grep"], calls });
	try {
		await scoped.session.sendUserMessage("go");
		return scoped.toolResults();
	} finally {
		await scoped.dispose();
	}
}

describe("history:// under secrets-blind", () => {
	it("refuses another agent's transcript", async () => {
		const [other] = await runCalls(enforceScope({ guardrails: { noNetwork: false, secretsBlind: true } }), [
			{ name: "read", arguments: { path: "history://OtherAgent" } },
		]);
		expect(other?.isError).toBe(true);
		expect(other?.text).toContain(
			"BLOCKED: secrets-blind guardrail denied another agent's history 'history://OtherAgent'.",
		);
	});

	it("does not refuse the index or the agent's own transcript", async () => {
		const results = await runCalls(enforceScope({ guardrails: { noNetwork: false, secretsBlind: true } }), [
			{ name: "read", arguments: { path: "history://" } },
			{ name: "read", arguments: { path: "history://ScopedChild" } },
		]);
		for (const result of results) expect(result.text).not.toContain("BLOCKED");
	});
});

describe("agent:// outputs under secrets-blind", () => {
	const blind = () => enforceScope({ guardrails: { noNetwork: false, secretsBlind: true } });

	it("refuses another agent's output", async () => {
		const [other, nested] = await runCalls(blind(), [
			{ name: "read", arguments: { path: "agent://OtherAgent" } },
			{ name: "read", arguments: { path: "agent://OtherAgent.Worker/reports/0" } },
		]);
		for (const result of [other, nested]) {
			expect(result?.isError).toBe(true);
			expect(result?.text).toContain("BLOCKED: secrets-blind guardrail denied another agent's output");
		}
	});

	it("does not refuse the agent's own output or its descendants' outputs and transcripts", async () => {
		const results = await runCalls(blind(), [
			{ name: "read", arguments: { path: "agent://ScopedChild" } },
			{ name: "read", arguments: { path: "agent://ScopedChild.Worker" } },
			{ name: "read", arguments: { path: "history://ScopedChild.Worker" } },
		]);
		for (const result of results) expect(result.text).not.toContain("BLOCKED");
	});

	it("does not refuse a message to another agent", async () => {
		const [message] = await runCalls(blind(), [
			{ name: "write", arguments: { path: "agent://Main", content: "status update" } },
		]);
		expect(message?.text).not.toContain("BLOCKED");
	});

	it("leaves an allowlist's refusal of agent:// reads unchanged", async () => {
		const [read] = await runCalls(enforceScope({ tools: ["read"], allowPathGroups: [["src"]] }), [
			{ name: "read", arguments: { path: "agent://OtherAgent" } },
		]);
		expect(read?.text).toContain("BLOCKED: Subagent permission profile does not allow path 'agent://OtherAgent'.");
	});
});

describe("local:// files", () => {
	it("applies deny paths to the file a local:// URL names, and keeps the rest writable and readable", async () => {
		const [denied, written, read] = await runCalls(
			enforceScope({ tools: ["read", "write"], denyPathGroups: [["**/*.key"]] }),
			[
				{ name: "write", arguments: { path: "local://notes.key", content: "hidden" } },
				{ name: "write", arguments: { path: "local://notes.md", content: "visible" } },
				{ name: "read", arguments: { path: "local://notes.md" } },
			],
		);
		expect(denied?.isError).toBe(true);
		expect(denied?.text).toContain("BLOCKED: Subagent permission profile denied path 'local://notes.key'.");
		expect(written?.isError).toBe(false);
		expect(read?.text).toContain("visible");
	});

	it("keeps local:// writable and readable under an allowlist that does not cover it", async () => {
		const [written, read] = await runCalls(enforceScope({ tools: ["read", "write"], allowPathGroups: [["src"]] }), [
			{ name: "write", arguments: { path: "local://scratch.md", content: "scratch notes" } },
			{ name: "read", arguments: { path: "local://scratch.md" } },
		]);
		expect(written?.isError).toBe(false);
		expect(read?.text).toContain("scratch notes");
	});

	it("drops a denied local:// file from a search of the scratch space", async () => {
		const scoped = await createScopedSession({
			tempDir,
			scope: enforceScope({ tools: ["read", "write", "grep"], denyPathGroups: [["**/*.key"]] }),
			toolNames: ["read", "write", "grep"],
			calls: [{ name: "grep", arguments: { pattern: "needle", path: "local://" } }],
		});
		try {
			const localRoot = resolveLocalRoot({
				getArtifactsDir: () => scoped.session.sessionManager.getArtifactsDir(),
				getSessionId: () => scoped.session.sessionManager.getSessionId(),
			});
			fs.mkdirSync(localRoot, { recursive: true });
			fs.writeFileSync(`${localRoot}/open.md`, "needle in the open\n");
			fs.writeFileSync(`${localRoot}/hidden.key`, "needle in the key\n");

			await scoped.session.sendUserMessage("go");
			const [result] = scoped.toolResults();
			expect(result?.text).toContain("needle in the open");
			expect(result?.text).not.toContain("needle in the key");
		} finally {
			await scoped.dispose();
		}
	});
});

describe("any file-backed scheme", () => {
	const scheme = "p7test";
	const handler: ProtocolHandler = {
		scheme,
		spec: { backing: "file", selectors: "none", immutable: true },
		async resolve(url: InternalUrl) {
			return {
				url: url.href,
				content: "data",
				contentType: "text/plain",
				sourcePath: tempDir.join("restricted", "data.txt"),
			};
		},
		async locate() {
			return tempDir.join("restricted", "data.txt");
		},
	};

	beforeEach(() => {
		fs.mkdirSync(tempDir.join("restricted"));
		fs.writeFileSync(tempDir.join("restricted", "data.txt"), "data");
		InternalUrlRouter.instance().register(handler);
	});
	afterEach(() => {
		InternalUrlRouter.instance().unregister(scheme);
	});

	it("refuses to locate, target or resolve a URL whose file a deny path covers", async () => {
		const router = InternalUrlRouter.instance();
		const context: ResolveContext = {
			cwd: tempDir.path(),
			settings: scopedSettings(enforceScope({ denyPathGroups: [["restricted"]] })),
		};
		const reason = "BLOCKED: Subagent permission profile denied path 'p7test://data'.";

		await expect(router.locate("p7test://data", context)).rejects.toThrow(reason);
		await expect(router.target("p7test://data", context)).rejects.toThrow(reason);
		await expect(router.resolve("p7test://data", context)).rejects.toThrow(reason);
	});

	it("resolves the same URL for a session without a scope", async () => {
		const router = InternalUrlRouter.instance();
		const context: ResolveContext = { cwd: tempDir.path() };

		expect(await router.locate("p7test://data", context)).toBe(tempDir.join("restricted", "data.txt"));
		expect((await router.resolve("p7test://data", context)).content).toBe("data");
	});
});
