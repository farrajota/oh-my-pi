/**
 * Directory listings under a subagent scope leave out the entries the scope refuses, like the
 * search result filter: `read` of a directory, internal-URL directory listings, and the workspace
 * tree in a scoped session's system prompt.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { resolveLocalRoot } from "@oh-my-pi/pi-coding-agent/internal-urls/local-protocol";
import type { PermissionScope } from "@oh-my-pi/pi-coding-agent/task/permissions/types";
import { TempDir } from "@oh-my-pi/pi-utils";
import { enforceScope } from "./scope-fixtures";
import { createScopedSession, type ScriptedCall } from "./scoped-session";

let tempDir: TempDir;

beforeEach(() => {
	tempDir = TempDir.createSync("@omp-scope-listings-");
	const files: Record<string, string> = {
		"src/app.ts": "export const app = 1;\n",
		"restricted/keys.ts": "export const keys = 2;\n",
		"credentials/db.ts": "export const db = 3;\n",
		".env": "TOKEN=4\n",
		"notes-secret.md": "hidden\n",
	};
	for (const [name, content] of Object.entries(files)) {
		fs.mkdirSync(tempDir.join(...name.split("/").slice(0, -1)), { recursive: true });
		fs.writeFileSync(tempDir.join(...name.split("/")), content);
	}
});
afterEach(() => {
	tempDir.removeSync();
});

const denyRestricted = () => enforceScope({ tools: ["read"], denyPathGroups: [["restricted"]] });
const secretsBlind = () => enforceScope({ tools: ["read"], guardrails: { noNetwork: false, secretsBlind: true } });

async function readResult(scope: PermissionScope, calls: ScriptedCall[]) {
	const scoped = await createScopedSession({ tempDir, scope, toolNames: ["read"], calls });
	try {
		await scoped.session.sendUserMessage("go");
		return scoped.toolResults();
	} finally {
		await scoped.dispose();
	}
}

describe("read of a directory", () => {
	it("leaves out a denied subtree and keeps the rest", async () => {
		const [listing] = await readResult(denyRestricted(), [{ name: "read", arguments: { path: "." } }]);
		expect(listing?.isError).toBe(false);
		expect(listing?.text).toContain("src");
		expect(listing?.text).toContain("credentials");
		expect(listing?.text).not.toContain("restricted");
		expect(listing?.text).not.toContain("keys.ts");
	});

	it("leaves out secret-like names under secrets-blind", async () => {
		const [listing] = await readResult(secretsBlind(), [{ name: "read", arguments: { path: "." } }]);
		expect(listing?.isError).toBe(false);
		expect(listing?.text).toContain("src");
		expect(listing?.text).toContain("restricted");
		for (const name of [".env", "credentials", "db.ts", "notes-secret.md"]) expect(listing?.text).not.toContain(name);
	});
});

describe("internal-URL directory listing", () => {
	it("leaves out a denied file from a local:// listing", async () => {
		const scoped = await createScopedSession({
			tempDir,
			scope: enforceScope({ tools: ["read"], denyPathGroups: [["**/*.key"]] }),
			toolNames: ["read"],
			calls: [{ name: "read", arguments: { path: "local://" } }],
		});
		try {
			const localRoot = resolveLocalRoot({
				getArtifactsDir: () => scoped.session.sessionManager.getArtifactsDir(),
				getSessionId: () => scoped.session.sessionManager.getSessionId(),
			});
			fs.mkdirSync(localRoot, { recursive: true });
			fs.writeFileSync(`${localRoot}/open.md`, "open\n");
			fs.writeFileSync(`${localRoot}/hidden.key`, "key\n");

			await scoped.session.sendUserMessage("go");
			const [listing] = scoped.toolResults();
			expect(listing?.text).toContain("open.md");
			expect(listing?.text).not.toContain("hidden.key");
		} finally {
			await scoped.dispose();
		}
	});
});

describe("glob over an internal URL", () => {
	it("leaves out a denied file when listing local://", async () => {
		const scoped = await createScopedSession({
			tempDir,
			scope: enforceScope({ tools: ["read", "glob"], denyPathGroups: [["**/*.key"]] }),
			toolNames: ["read", "glob"],
			calls: [{ name: "glob", arguments: { path: "local://**/*" } }],
		});
		try {
			const localRoot = resolveLocalRoot({
				getArtifactsDir: () => scoped.session.sessionManager.getArtifactsDir(),
				getSessionId: () => scoped.session.sessionManager.getSessionId(),
			});
			fs.mkdirSync(localRoot, { recursive: true });
			fs.writeFileSync(`${localRoot}/open.md`, "open\n");
			fs.writeFileSync(`${localRoot}/hidden.key`, "key\n");

			await scoped.session.sendUserMessage("go");
			const [listing] = scoped.toolResults();
			expect(listing?.text).toContain("open.md");
			expect(listing?.text).not.toContain("hidden.key");
		} finally {
			await scoped.dispose();
		}
	});
});

describe("workspace tree in the system prompt", () => {
	it("leaves out refused entries from a scoped session's workspace tree", async () => {
		const scoped = await createScopedSession({
			tempDir,
			scope: enforceScope({
				tools: ["read"],
				denyPathGroups: [["restricted"]],
				guardrails: { noNetwork: false, secretsBlind: true },
			}),
			toolNames: ["read"],
			settings: { includeWorkspaceTree: true },
		});
		try {
			const prompt = scoped.session.agent.state.systemPrompt.join("\n");
			expect(prompt).toContain("app.ts");
			for (const name of ["restricted", "keys.ts", "credentials", "db.ts", "notes-secret.md"]) {
				expect(prompt).not.toContain(name);
			}
		} finally {
			await scoped.dispose();
		}
	});
});
