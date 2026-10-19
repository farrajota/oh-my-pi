import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { GrepTool } from "@oh-my-pi/pi-coding-agent/tools/grep";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { writeArchive } from "@oh-my-pi/pi-utils/ar";

const testDirs: string[] = [];

afterEach(async () => {
	await Promise.all(testDirs.splice(0).map(dir => removeWithRetries(dir)));
});

async function makeTempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	testDirs.push(dir);
	return dir;
}

function makeSession(cwd: string, pathScope?: ToolSession["pathScope"]): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "tools.xdev": false }),
		...(pathScope ? { pathScope } : {}),
	};
}

function textOutput(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

describe("path-scoped tool reads", () => {
	it("denies an archive before its contents can be materialized for grep", async () => {
		const cwd = await makeTempDir("grep-scoped-archive-");
		const archivePath = path.join(cwd, "bundle.zip");
		await writeArchive(archivePath, "zip", [["private.txt", "archive-secret-needle\n"]]);
		let archiveReadAttempts = 0;
		const operation = {
			authorize: async () => {
				throw new Error("archive path denied");
			},
			openRead: async () => {
				archiveReadAttempts++;
				return fs.open(archivePath, "r");
			},
		};
		const pathScope = { currentOperation: () => operation } as unknown as ToolSession["pathScope"];
		const tool = new GrepTool(makeSession(cwd, pathScope));

		await expect(
			tool.execute("denied-archive-grep", { pattern: "archive-secret-needle", path: "bundle.zip:private.txt" }),
		).rejects.toThrow(/archive path denied/);
		expect(archiveReadAttempts).toBe(0);
	});

	it("streams a large scoped read from the authorized handle after the path is replaced", async () => {
		const cwd = await makeTempDir("read-scoped-stream-");
		const filePath = path.join(cwd, "large.txt");
		const authorizedPath = path.join(cwd, "authorized-original.txt");
		const originalContents = `${"authorized-handle-line\n"}${"a".repeat(4_194_304)}`;
		const replacementContents = `${"replacement-path-line\n"}${"b".repeat(4_194_304)}`;
		await fs.writeFile(filePath, originalContents);
		let authorizedTarget: { canonicalTarget: string; approvedPath: string } | undefined;
		let openedTarget: unknown;
		let replaced = false;
		const operation = {
			authorize: async (targetPath: string, access: string) => {
				const target = { canonicalTarget: targetPath, approvedPath: authorizedPath };
				if (access === "read") {
					authorizedTarget = target;
					if (!replaced) {
						replaced = true;
						await fs.writeFile(authorizedPath, originalContents);
						await fs.writeFile(filePath, replacementContents);
					}
				}
				return target;
			},
			openRead: async (target: unknown) => {
				openedTarget = target;
				if (!target || typeof target !== "object" || !("approvedPath" in target)) {
					throw new Error("missing approved read path");
				}
				const approvedPath = target.approvedPath;
				if (typeof approvedPath !== "string") throw new Error("invalid approved read path");
				return fs.open(approvedPath, "r");
			},
		};
		const pathScope = { currentOperation: () => operation } as unknown as ToolSession["pathScope"];
		const tool = new ReadTool(makeSession(cwd, pathScope));

		const result = await tool.execute("authorized-large-read", { path: "large.txt" });
		const output = textOutput(result);

		expect(authorizedTarget).toBeDefined();
		expect(openedTarget).toBe(authorizedTarget);
		expect(output).toContain("authorized-handle-line");
		expect(output).not.toContain("replacement-path-line");
	});

	it("rejects a denied streamed multi-range read", async () => {
		const cwd = await makeTempDir("read-scoped-multirange-denied-");
		await fs.writeFile(path.join(cwd, "large.txt"), `first line\n${"x".repeat(4_194_304)}\nthird line\n`);
		const operation = {
			authorize: async (targetPath: string) => ({ canonicalTarget: targetPath }),
			openRead: async () => {
				throw new Error("streamed read denied");
			},
		};
		const pathScope = { currentOperation: () => operation } as unknown as ToolSession["pathScope"];
		const tool = new ReadTool(makeSession(cwd, pathScope));

		await expect(tool.execute("denied-streamed-multirange-read", { path: "large.txt:raw:1-1,3-3" })).rejects.toThrow(
			"streamed read denied",
		);
	});

	it("opens a large scoped raw-tail window through the authorized operation", async () => {
		const cwd = await makeTempDir("read-scoped-tail-window-");
		const filePath = path.join(cwd, "large.txt");
		await fs.writeFile(filePath, `${"line\n".repeat(900_000)}tail\n`);
		let authorizedOpens = 0;
		const operation = {
			authorize: async (targetPath: string) => ({ canonicalTarget: targetPath }),
			openRead: async () => {
				authorizedOpens++;
				if (authorizedOpens === 1) return fs.open(filePath, "r");
				throw new Error("streamed tail window denied");
			},
		};
		const pathScope = { currentOperation: () => operation } as unknown as ToolSession["pathScope"];
		const tool = new ReadTool(makeSession(cwd, pathScope));

		await expect(tool.execute("denied-scoped-raw-tail-window", { path: "large.txt:raw:-2" })).rejects.toThrow(
			"streamed tail window denied",
		);
	});
});
