import { afterEach, describe, expect, it } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { disposeAllVmContexts } from "../../src/eval/js/context-manager";
import { executeJs } from "../../src/eval/js/executor";
import type { JsExecutorOptions } from "../../src/eval/js/executor";
import { resolveJsPackageEnvironment } from "../../src/eval/js/package-installer";
import type { Tool, ToolSession } from "../../src/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";

function makeSession(cwd: string, evalSessionId: string, options?: { autoProvision?: boolean }): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({
			"async.enabled": false,
			"eval.autoProvision": options?.autoProvision ?? true,
			"task.isolation.enabled": false,
			"task.enableLsp": true,
		}),
		taskDepth: 0,
		enableLsp: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getActiveModelString: () => "p/active",
		getModelString: () => "p/fallback",
		getArtifactsDir: () => null,
		getSessionId: () => evalSessionId,
		getEvalSessionId: () => evalSessionId,
	};
}

function executorOptions(session: ToolSession, sessionId: string): JsExecutorOptions {
	return { cwd: session.cwd, sessionId, session };
}

function canResolve(specifier: string, fromDir: string): boolean {
	try {
		Bun.resolveSync(specifier, fromDir);
		return true;
	} catch {
		return false;
	}
}

/**
 * Picks a package OMP itself resolves but the workspace cannot. Prefers `@babel/parser`; a stray
 * `node_modules` above the temp dir (e.g. `npm i` run in the Windows profile dir) legitimately puts
 * it in the workspace's ancestry, so fall back to any other package installed for OMP.
 */
function ompOnlyPackage(workspaceDir: string): string {
	const ompDir = path.resolve(import.meta.dir, "../..");
	const repoModules = path.resolve(ompDir, "../../node_modules");
	const candidates = [
		"@babel/parser",
		...fsSync.readdirSync(repoModules).filter(name => !name.startsWith(".") && !name.startsWith("@")),
	];
	const picked = candidates.find(name => canResolve(name, ompDir) && !canResolve(name, workspaceDir));
	if (!picked) throw new Error(`Every OMP dependency is also resolvable from ${workspaceDir}`);
	return picked;
}

describe("persistent JavaScript package environments", () => {
	const managedRoots: string[] = [];

	afterEach(async () => {
		await disposeAllVmContexts();
		await Promise.all(
			managedRoots
				.splice(0)
				.flatMap(root => [
					fs.rm(root, { recursive: true, force: true }),
					fs.rm(`${root}.install.lock`, { force: true }),
				]),
		);
	});

	it("refuses an implicit managed environment bootstrap when auto-provisioning is disabled", async () => {
		using workspace = TempDir.createSync("@omp-js-package-policy-");
		const sessionId = `js-package-policy:${crypto.randomUUID()}`;
		const session = makeSession(workspace.path(), sessionId, { autoProvision: false });
		const environment = resolveJsPackageEnvironment(workspace.path());
		managedRoots.push(environment.root);

		const result = await executeJs("", {
			...executorOptions(session, sessionId),
			packages: ["package-that-must-not-be-fetched"],
		});
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("eval.autoProvision is disabled");
		await expect(fs.access(path.join(environment.root, "package.json"))).rejects.toBeDefined();
	});

	it("resolves file imports from the filename while preserving cwd and repeat execution", async () => {
		using workspace = TempDir.createSync("@omp-js-file-workspace-");
		using scriptDir = TempDir.createSync("@omp-js-file-script-");
		const filename = path.join(scriptDir.path(), "loaded.ts");
		const source = [
			'import { amount } from "./sibling.ts";',
			"globalThis.fileLoadCount = (globalThis.fileLoadCount ?? 0) + 1;",
			"var fileLoadedValue = fileSeed + amount;",
			"function fileAnswer() { return fileLoadedValue; }",
			"var fileObservedCwd = process.cwd();",
		].join("\n");
		await Bun.write(path.join(scriptDir.path(), "sibling.ts"), "export const amount = 2;\n");
		await Bun.write(filename, source);

		const sessionId = `js-file:${crypto.randomUUID()}`;
		const session = makeSession(workspace.path(), sessionId);
		const options = executorOptions(session, sessionId);
		await executeJs("var fileSeed = 10;", options);
		const first = await executeJs(source, { ...options, filename });
		const second = await executeJs(source, { ...options, filename });
		expect(first.exitCode).toBe(0);
		expect(second.exitCode).toBe(0);
		expect(first.output).not.toContain(source);
		expect(second.output).not.toContain(source);

		const reloadSource = "fileLoadedValue += 1; fileLoadedValue;";
		await Bun.write(filename, reloadSource);
		const reloaded = await executeJs(reloadSource, { ...options, filename });
		expect(reloaded.output.trim()).toBe("13");

		const retained = await executeJs("JSON.stringify([fileAnswer(), fileObservedCwd, fileLoadCount])", options);
		expect(JSON.parse(retained.output.trim())).toEqual([13, await fs.realpath(workspace.path()), 2]);
	});

	it("filters inherited credentials from the real JS worker while preserving safe env and bridges", async () => {
		using workspace = TempDir.createSync("@omp-js-worker-env-");
		const sessionId = `js-worker-env:${crypto.randomUUID()}`;
		const envKeys = ["PI_TOKEN", "OPENAI_API_KEY", "PI_RUNTIME_SMOKE"] as const;
		const previous: Record<string, string | undefined> = Object.fromEntries(
			envKeys.map(key => [key, process.env[key]]),
		);
		process.env.PI_TOKEN = "dummy-pi-token-sentinel";
		process.env.OPENAI_API_KEY = "dummy-openai-key-sentinel";
		process.env.PI_RUNTIME_SMOKE = "safe";

		await Bun.write(path.join(workspace.path(), "fixture.txt"), "bridge-ok");
		const baseSession = makeSession(workspace.path(), sessionId);
		const readTool = new ReadTool(baseSession);
		const tools: Tool[] = [readTool];
		const session: ToolSession = {
			...baseSession,
			getToolByName: name => tools.find(tool => tool.name === name),
		};
		const code = [
			"console.log(JSON.stringify({",
			'safe: process.env.PI_RUNTIME_SMOKE === "safe",',
			"credentialsAbsent: process.env.PI_TOKEN === undefined && process.env.OPENAI_API_KEY === undefined,",
			'bridged: await tool.read({ path: "fixture.txt" }),',
			"}));",
		].join("\n");
		const chunks: string[] = [];
		try {
			const result = await executeJs(code, {
				...executorOptions(session, sessionId),
				onChunk: chunk => {
					chunks.push(chunk);
				},
			});
			expect(result.exitCode).toBe(0);
			expect(chunks.join("")).toBe(result.output);
			expect(result.output).not.toContain("dummy-pi-token-sentinel");
			expect(result.output).not.toContain("dummy-openai-key-sentinel");
			expect(JSON.parse(result.output.trim())).toMatchObject({
				safe: true,
				credentialsAbsent: true,
				bridged: {
					text: expect.stringContaining("bridge-ok"),
					details: {
						displayContent: { text: "bridge-ok" },
					},
				},
			});
		} finally {
			for (const key of envKeys) {
				const value = previous[key];
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	it("does not resolve a missing project package from OMP's own dependencies", async () => {
		// Dynamic import is the behavior under test: a static import would be
		// resolved by this test module's own dependency graph.
		using workspace = TempDir.createSync("@omp-js-package-missing-");
		const sessionId = `js-package-missing:${crypto.randomUUID()}`;
		const session = makeSession(workspace.path(), sessionId);
		const specifier = ompOnlyPackage(workspace.path());
		const result = await executeJs(`await import(${JSON.stringify(specifier)})`, executorOptions(session, sessionId));
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("JS package environment fallback");
	});
});
