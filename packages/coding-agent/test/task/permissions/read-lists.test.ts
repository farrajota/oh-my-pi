/**
 * The read tool splits a path list (`a;b`, `a,b`, `a b`, a URL followed by paths) and resolves a
 * missing path by its unique suffix. The scope must judge every file a read really opens, not the
 * unsplit string the call names: a list whose first entry is exempt or allowed cannot carry a
 * denied entry along with it.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { PermissionScope } from "@oh-my-pi/pi-coding-agent/task/permissions/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { Database } from "bun:sqlite";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as ar from "@oh-my-pi/pi-utils/ar";
import { enforceScope, scopedSettings } from "./scope-fixtures";
import { createScopedSession, type ScriptedCall } from "./scoped-session";

let tempDir: TempDir;

const SECRET = "API_KEY=sk-live-secret-value";
const OTHER = "other repository configuration";

beforeEach(() => {
	tempDir = TempDir.createSync("@omp-scope-read-lists-");
	fs.mkdirSync(tempDir.join("src"));
	fs.mkdirSync(tempDir.join("lib"));
	fs.mkdirSync(tempDir.join("secret"));
	fs.writeFileSync(tempDir.join(".env"), `${SECRET}\n`);
	fs.writeFileSync(tempDir.join("src", "a.ts"), "export const a = 1;\n");
	fs.writeFileSync(tempDir.join("src", "b.ts"), "export const b = 2;\n");
	fs.writeFileSync(tempDir.join("lib", "c.ts"), `// ${OTHER}\n`);
	fs.writeFileSync(tempDir.join("secret", "settings.yml"), `token: ${SECRET}\n`);
});

afterEach(() => {
	tempDir.removeSync();
});

async function read(scope: PermissionScope, ...paths: string[]) {
	const calls: ScriptedCall[] = paths.map(target => ({ name: "read", arguments: { path: target } }));
	const scoped = await createScopedSession({ tempDir, scope, toolNames: ["read"], calls });
	try {
		await scoped.session.sendUserMessage("go");
		return scoped.toolResults();
	} finally {
		await scoped.dispose();
	}
}

const blindReader = enforceScope({
	tools: ["read"],
	allowPathGroups: [["src"]],
	guardrails: { noNetwork: false, secretsBlind: true },
});
const denyEnv = enforceScope({ tools: ["read"], denyPathGroups: [["**/.env"]] });
const srcOnly = enforceScope({ tools: ["read"], allowPathGroups: [["src"]] });

describe("read of a path list under a permission scope", () => {
	it("refuses a list whose first entry is a local:// URL and whose next entry is a secret", async () => {
		const results = await read(blindReader, "local://x;.env", "local://x;../outside/config.yml");
		for (const result of results) {
			expect(result.text).not.toContain(SECRET);
			expect(result.text).toStartWith("BLOCKED:");
			expect(result.isError).toBe(true);
		}
	});

	it("refuses a plain list that carries a denied path after an allowed one", async () => {
		const [semicolon, comma] = await read(denyEnv, "src/a.ts;.env", "src/a.ts,.env");
		for (const result of [semicolon, comma]) {
			expect(result?.text).not.toContain(SECRET);
			expect(result?.text).toStartWith("BLOCKED:");
			expect(result?.isError).toBe(true);
		}
	});

	it("refuses a list that reaches outside the allowlist from an allowed first entry", async () => {
		const results = await read(srcOnly, "src/a.ts;lib/c.ts", "src/a.ts lib/c.ts", "local://x;lib/c.ts");
		for (const result of results) {
			expect(result.text).not.toContain(OTHER);
			expect(result.text).toStartWith("BLOCKED:");
			expect(result.isError).toBe(true);
		}
	});

	it("still reads a list whose every entry the scope allows, local:// entries included", async () => {
		const [plain, mixed] = await read(srcOnly, "src/a.ts;src/b.ts", "local://notes.md;src/b.ts");
		expect(plain?.text).not.toContain("BLOCKED");
		expect(plain?.text).toContain("export const a = 1;");
		expect(plain?.text).toContain("export const b = 2;");
		expect(mixed?.text).not.toContain("BLOCKED");
		expect(mixed?.text).toContain("export const b = 2;");
	});

	it("does not resolve a missing path to a denied file by its unique suffix", async () => {
		const scope = enforceScope({ tools: ["read"], denyPathGroups: [["secret"]] });
		const [result] = await read(scope, "settings.yml");
		expect(result?.text).not.toContain(SECRET);
		expect(result?.isError).toBe(true);
	});

	it("judges a file:// URL by the file it names", async () => {
		const [result] = await read(denyEnv, `file://${path.join(tempDir.path(), ".env")}`);
		expect(result?.isError).toBe(true);
		expect(result?.text).toStartWith("BLOCKED:");
		expect(result?.text).not.toContain(SECRET);
	});

	it("refuses a denied entry as the list is read, whatever approval saw before the split", async () => {
		// The bare tool, as if approval had judged a different split: each entry answers to the scope
		// again when the read opens it.
		const session: ToolSession = {
			cwd: tempDir.path(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: scopedSettings(denyEnv),
		};
		const result = await new ReadTool(session).execute("call", { path: "src/a.ts;.env" });
		const text = result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
		expect(text).not.toContain(SECRET);
		expect(text).toContain("export const a = 1;");
		expect(text).toContain("Could not read .env: BLOCKED: Subagent permission profile denied path '.env'.");
	});

	it("judges an archive member or a database table by the file that holds it", async () => {
		await ar.writeArchive(tempDir.join("vault.tar"), "tar", [["notes.txt", SECRET]]);
		const db = new Database(tempDir.join("vault.sqlite"));
		db.run("CREATE TABLE tokens (value TEXT)");
		db.run("INSERT INTO tokens VALUES (?)", [SECRET]);
		db.close();
		const scope = enforceScope({ tools: ["read"], denyPathGroups: [["vault.tar", "vault.sqlite"]] });
		const results = await read(scope, "vault.tar:notes.txt", "vault.sqlite:tokens");
		for (const result of results) {
			expect(result.text).not.toContain(SECRET);
			expect(result.isError).toBe(true);
		}
	});

	it("judges a grep over an archive member, or over a list holding an archive, by the archive", async () => {
		await ar.writeArchive(tempDir.join("vault.tar"), "tar", [["notes.txt", SECRET]]);
		const scope = enforceScope({ tools: ["grep"], denyPathGroups: [["vault.tar"]] });
		const targets = ["vault.tar:notes.txt", "src;vault.tar", "src,vault.tar", "local://x;vault.tar"];
		const scoped = await createScopedSession({
			tempDir,
			scope,
			toolNames: ["grep"],
			calls: targets.map(target => ({ name: "grep", arguments: { pattern: "API_KEY", path: target } })),
		});
		try {
			await scoped.session.sendUserMessage("go");
			const results = scoped.toolResults().map((result, index) => `${targets[index]} -> ${result.text}`);
			for (const result of results) expect(result).not.toContain("sk-live");
		} finally {
			await scoped.dispose();
		}
	});
});
