import { afterEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactManager } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

describe("ArtifactManager tool-type sanitization", () => {
	const dirs: string[] = [];

	function freshDir(): string {
		const dir = path.join(os.tmpdir(), `omp-artifacts-${crypto.randomUUID()}`, "session");
		dirs.push(path.dirname(dir));
		return dir;
	}

	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			removeSyncWithRetries(dir);
		}
	});

	it("confines published artifacts for path-hostile tool names", async () => {
		const dir = freshDir();
		const mgr = new ArtifactManager(dir);
		const cases = [
			["../../etc/passwd", "etc_passwd"],
			["mcp__srv/peek", "mcp__srv_peek"],
			["a\\b\\c", "a_b_c"],
			["..", "tool"],
			["./escape", "escape"],
			["tool name", "tool_name"],
		] as const;
		for (const [index, [hostile, suffix]] of cases.entries()) {
			const content = `content-${index}`;
			const id = await mgr.save(content, hostile);
			const filePath = await mgr.getPath(id);
			expect(filePath).not.toBeNull();
			expect(path.dirname(filePath as string)).toBe(dir);
			expect(path.basename(filePath as string)).toBe(`${id}.${suffix}.log`);
			expect(await Bun.file(filePath as string).text()).toBe(content);
			expect(await mgr.listFiles()).toContain(`${id}.${suffix}.log`);
		}
	});

	it("caps the published logical tool suffix within filesystem limits", async () => {
		const mgr = new ArtifactManager(freshDir());
		const id = await mgr.save("content", "x".repeat(500));
		const filePath = await mgr.getPath(id);
		expect(filePath).not.toBeNull();
		const segment = path
			.basename(filePath as string)
			.replace(new RegExp(`^${id}\\.`), "")
			.replace(/\.log$/, "");
		expect(segment.length).toBeLessThanOrEqual(64);
	});

	it("publishes a stable fallback suffix when sanitization removes everything", async () => {
		const mgr = new ArtifactManager(freshDir());
		const id = await mgr.save("content", "/../");
		const filePath = await mgr.getPath(id);
		expect(filePath).not.toBeNull();
		expect(path.basename(filePath as string)).toBe(`${id}.tool.log`);
		expect(await mgr.listFiles()).toEqual([`${id}.tool.log`]);
	});

	it("round-trips full content through governed publication despite a hostile name", async () => {
		const dir = freshDir();
		const mgr = new ArtifactManager(dir);
		const id = await mgr.save("FULL-ORIGINAL-CONTENT", "mcp__srv/peek_topic");
		const filePath = await mgr.getPath(id);
		expect(filePath).not.toBeNull();
		expect(path.dirname(filePath as string)).toBe(dir);
		expect(await Bun.file(filePath as string).text()).toBe("FULL-ORIGINAL-CONTENT");
	});
});
