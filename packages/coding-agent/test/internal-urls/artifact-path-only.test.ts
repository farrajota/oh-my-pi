import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactManager } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import { ArtifactProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/artifact-protocol";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import {
	registerArtifactsDir,
	resetRegisteredArtifactDirsForTests,
} from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import { InternalUrlFilesystem } from "@oh-my-pi/pi-coding-agent/internal-urls/url-filesystem";
import { resolveToolSearchScope } from "@oh-my-pi/pi-coding-agent/tools/path-utils";

/**
 * Path consumers (search/grep, the bash shell filesystem) only need the artifact's
 * filesystem path. Blocking them for large artifacts would break `search`
 * against MCP results and `bash` commands that reference the file — the very
 * workflows the read-tool guidance points users toward.
 */
describe("artifact:// locate vs content resolution", () => {
	let testDir: string;
	let artifactDir: string;
	let artifactId: string;
	let artifactPath: string;
	let unregister: (() => void) | undefined;
	const handler = new ArtifactProtocolHandler();

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-path-only-"));
		artifactDir = path.join(testDir, "session");
		const manager = new ArtifactManager(artifactDir);
		// 9 MiB — larger than the 8 MiB inline cap so `resolve` refuses to
		// materialize while `locate` still returns the published path.
		artifactId = await manager.save("A".repeat(9 * 1024 * 1024), "mcp");
		artifactPath = (await manager.getPath(artifactId)) as string;
		resetRegisteredArtifactDirsForTests();
		unregister = registerArtifactsDir(artifactDir);
	});

	afterEach(async () => {
		unregister?.();
		resetRegisteredArtifactDirsForTests();
		await fs.rm(testDir, { recursive: true, force: true });
	});

	it("locates large manager-published artifacts without resolving their content", async () => {
		const url = parseInternalUrl(`artifact://${artifactId}`);
		const context = { localProtocolOptions: { getArtifactsDir: () => artifactDir } };

		expect(await handler.locate(url, context)).toBe(artifactPath);
	});
	it("still rejects full content resolution for large artifacts (existing OOM guard)", async () => {
		const url = parseInternalUrl(`artifact://${artifactId}`);
		await expect(handler.resolve(url)).rejects.toThrow(/full internal resolution is blocked/);
	});

	it("materializes only manager-published small artifacts on ordinary resolution", async () => {
		const smallArtifactDir = path.join(testDir, "small-session");
		const manager = new ArtifactManager(smallArtifactDir);
		const id = await manager.save("hello world\n", "mcp");
		const publishedPath = await manager.getPath(id);
		if (!publishedPath) throw new Error("Expected published artifact path");
		await Bun.write(path.join(smallArtifactDir, "999.mcp.log"), "unpublished\n");
		const unregisterSmall = registerArtifactsDir(smallArtifactDir);
		try {
			const resource = await handler.resolve(parseInternalUrl(`artifact://${id}`));
			expect(resource.content).toBe("hello world\n");
			expect(resource.sourcePath).toBe(publishedPath);
			await expect(handler.resolve(parseInternalUrl("artifact://999"))).rejects.toThrow(/not found/);
			await fs.writeFile(publishedPath, "tampered\n");
			await expect(handler.resolve(parseInternalUrl(`artifact://${id}`))).rejects.toThrow(/not found/);
		} finally {
			unregisterSmall();
		}
	});
});

describe("artifact:// caller-root isolation", () => {
	it("uses the bound artifact root and fails closed after a caller-root miss", async () => {
		const handler = new ArtifactProtocolHandler();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-root-isolation-"));
		const rootA = path.join(dir, "a");
		const rootB = path.join(dir, "b");
		try {
			const managerA = new ArtifactManager(rootA);
			const managerB = new ArtifactManager(rootB);
			const id = await managerA.save("caller A", "mcp");
			await managerB.save("caller A", "mcp");
			const unregister = registerArtifactsDir(rootB);
			try {
				const context = {
					localProtocolOptions: {
						getArtifactsDir: () => rootA,
						getSessionId: () => "caller-a",
					},
				};
				const resource = await handler.resolve(parseInternalUrl(`artifact://${id}`), context);
				expect(resource.content).toBe("caller A");

				const callerPath = await managerA.getPath(id);
				if (!callerPath) throw new Error("Expected caller artifact path");
				await fs.rm(callerPath);
				await expect(handler.resolve(parseInternalUrl(`artifact://${id}`), context)).rejects.toThrow(
					`Artifact ${id} not found`,
				);
			} finally {
				unregister();
			}
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("resolveToolSearchScope locates large artifacts", () => {
	let testDir: string;
	let artifactDir: string;
	let unregister: (() => void) | undefined;
	let artifactId: string;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-scope-"));
		artifactDir = path.join(testDir, "session");
		const manager = new ArtifactManager(artifactDir);
		artifactId = await manager.save("A".repeat(9 * 1024 * 1024), "mcp");
		resetRegisteredArtifactDirsForTests();
		unregister = registerArtifactsDir(artifactDir);
		InternalUrlRouter.resetForTests();
	});

	afterEach(async () => {
		unregister?.();
		resetRegisteredArtifactDirsForTests();
		InternalUrlRouter.resetForTests();
		await fs.rm(testDir, { recursive: true, force: true });
	});

	it("resolves ast_grep/ast_edit search scope for large artifacts without the inline-content cap", async () => {
		// The URL stays the search root; its stat must reach the backing file, not
		// InternalUrlRouter's capped content resolution.
		const scope = await resolveToolSearchScope({
			rawPaths: [`artifact://${artifactId}`],
			cwd: testDir,
			internalUrlAction: "search",
			filesystem: new InternalUrlFilesystem({ context: {}, tier: "read" }),
		});
		expect(scope.searchPath).toBe(`artifact://${artifactId}`);
		expect(scope.isDirectory).toBe(false);
	});
});
