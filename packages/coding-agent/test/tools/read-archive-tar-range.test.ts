import { afterEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as ar from "@oh-my-pi/pi-utils/ar";

afterEach(() => vi.restoreAllMocks());

function makeSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
	};
}

it("lists a plain TAR past the in-memory ceiling and reads only its selected small member", async () => {
	await using temp = await TempDir.create("@read-tar-range-");
	const archivePath = temp.join("large.tar");
	await ar.writeArchive(archivePath, "tar", [
		["fill.bin", new Uint8Array(6000)],
		["identity.json", '{"ok":true}'],
	]);
	const openArchive = ar.openArchive;
	vi.spyOn(ar, "openArchive").mockImplementation(source => openArchive(source, { limits: { maxInMemorySize: 512 } }));
	const tool = new ReadTool(makeSession(temp.path()));
	const listing = await tool.execute("list-tar", { path: archivePath });
	expect(listing.details?.isDirectory).toBe(true);
	expect(listing.content).toEqual([{ type: "text", text: expect.stringContaining("fill.bin") }]);
	expect(listing.content[0]).toMatchObject({ text: expect.stringContaining("identity.json") });
	const selected = await tool.execute("read-identity", { path: `${archivePath}:identity.json:raw` });
	expect(selected.content).toEqual([{ type: "text", text: '{"ok":true}' }]);
	expect(await Bun.file(temp.join("identity.json")).exists()).toBe(false);
});

it("reuses a plain TAR index across member reads while its file-backed source remains readable", async () => {
	await using temp = await TempDir.create("@read-tar-cache-");
	const archivePath = temp.join("members.tar");
	await ar.writeArchive(archivePath, "tar", [
		["first.txt", "first"],
		["second.txt", "second"],
	]);
	const reads: [number, number][] = [];
	const openArchive = ar.openArchive;
	const open = vi.spyOn(ar, "openArchive").mockImplementation(input => {
		if (typeof input !== "string" && !("source" in input)) throw new Error("Expected a file-backed TAR read");
		const file = typeof input === "string" ? ar.fileByteSource(input) : input.source;
		return openArchive({
			format: "tar",
			path: typeof input === "string" ? input : input.path,
			source: {
				size: file.size,
				async read(start, end) {
					reads.push([start, end]);
					return file.read(start, end);
				},
			},
		});
	});
	const first = await new ReadTool(makeSession(temp.path())).execute("first-member", {
		path: `${archivePath}:first.txt:raw`,
	});
	expect(first.content).toEqual([{ type: "text", text: "first" }]);
	const readsBeforeSecondMember = reads.length;
	const second = await new ReadTool(makeSession(temp.path())).execute("second-member", {
		path: `${archivePath}:second.txt:raw`,
	});
	expect(second.content).toEqual([{ type: "text", text: "second" }]);
	expect(open).toHaveBeenCalledTimes(1);
	expect(reads.slice(readsBeforeSecondMember)).toEqual([[1536, 1542]]);
});

it("refreshes a cached TAR after a rewrite between index construction and cache admission", async () => {
	await using temp = await TempDir.create("@read-tar-cache-binding-");
	const archivePath = temp.join("members.tar");
	await ar.writeArchive(
		archivePath,
		"tar",
		Array.from({ length: 20 }, (_, i) => [`member-${String(i).padStart(2, "0")}.txt`, `data-${i}`] as const),
	);
	const rewrittenBytes = Buffer.from(await fs.readFile(archivePath));
	const oldName = "member-10.txt";
	const newName = "edited-10.txt";
	const nameOffset = rewrittenBytes.indexOf(oldName);
	if (nameOffset < 0) throw new Error("Missing TAR fixture member");
	rewrittenBytes.write(newName, nameOffset, "utf8");
	const headerOffset = Math.floor(nameOffset / 512) * 512;
	const header = rewrittenBytes.subarray(headerOffset, headerOffset + 512);
	header.fill(32, 148, 156);
	let checksum = 0;
	for (const byte of header) checksum += byte;
	header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");

	const originalFile = Bun.file;
	const pinnedStat = await originalFile(archivePath).stat();
	// Metadata equality is possible after an in-place rewrite; model it without timing-dependent assertions.
	vi.spyOn(Bun, "file").mockImplementation((input, options) => {
		const file: ReturnType<typeof Bun.file> = Reflect.apply(originalFile, Bun, [input, options]);
		if (input === archivePath) Object.defineProperty(file, "stat", { value: async () => pinnedStat });
		return file;
	});
	const openArchive = ar.openArchive;
	let rewritten = false;
	vi.spyOn(ar, "openArchive").mockImplementation(async (input, options) => {
		const reader = await openArchive(input, options);
		const inputPath = typeof input === "string" ? input : "path" in input ? input.path : undefined;
		if (inputPath === archivePath && !rewritten) {
			rewritten = true;
			await fs.writeFile(archivePath, rewrittenBytes);
		}
		return reader;
	});
	const tool = new ReadTool(makeSession(temp.path()));
	await tool.execute("before-rewrite", { path: archivePath });
	expect(rewritten).toBe(true);
	const freshPath = temp.join("fresh.tar");
	await fs.writeFile(freshPath, rewrittenBytes);
	const fresh = await tool.execute("independent-rewritten-index", { path: freshPath });
	expect(fresh.content).toEqual([{ type: "text", text: expect.stringContaining(newName) }]);
	expect(fresh.content[0]).toMatchObject({ text: expect.not.stringContaining(oldName) });
	const cached = await tool.execute("stable-after-rewrite", { path: archivePath });
	expect(cached.content).toEqual([{ type: "text", text: expect.stringContaining(newName) }]);
	expect(cached.content[0]).toMatchObject({ text: expect.not.stringContaining(oldName) });
});

for (const change of ["rewrite", "replace"] as const) {
	it(`re-indexes a cached plain TAR after a same-size ${change}`, async () => {
		await using temp = await TempDir.create("@read-tar-cache-change-");
		const archivePath = temp.join("members.tar");
		await ar.writeArchive(archivePath, "tar", [["value.txt", "before"]]);
		const originalTime = new Date("2020-01-02T00:00:00Z");
		await fs.utimes(archivePath, originalTime, originalTime);
		const originalStat = await fs.stat(archivePath);
		const open = vi.spyOn(ar, "openArchive");
		const tool = new ReadTool(makeSession(temp.path()));
		const before = await tool.execute("before-change", { path: `${archivePath}:value.txt:raw` });
		expect(before.content).toEqual([{ type: "text", text: "before" }]);
		const replacementPath = temp.join("replacement.tar");
		await ar.writeArchive(replacementPath, "tar", [["value.txt", "after!"]]);
		if (change === "rewrite") {
			await Bun.write(archivePath, await Bun.file(replacementPath).bytes());
			const changedTime = new Date("2021-01-02T00:00:00Z");
			await fs.utimes(archivePath, changedTime, changedTime);
		} else {
			await fs.utimes(replacementPath, originalTime, originalTime);
			await fs.rename(replacementPath, archivePath);
		}
		const changedStat = await fs.stat(archivePath);
		expect(changedStat.size).toBe(originalStat.size);
		if (change === "rewrite") {
			expect(changedStat.ino).toBe(originalStat.ino);
			expect(changedStat.mtimeMs).not.toBe(originalStat.mtimeMs);
		} else {
			expect(changedStat.ino).not.toBe(originalStat.ino);
			expect(changedStat.mtimeMs).toBe(originalStat.mtimeMs);
		}
		const after = await tool.execute("after-change", { path: `${archivePath}:value.txt:raw` });
		expect(after.content).toEqual([{ type: "text", text: "after!" }]);
		expect(open).toHaveBeenCalledTimes(2);
	});
}
