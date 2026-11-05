import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthorityScratch } from "../../src/registry/authority/export-stream";

/**
 * The scratch database an offline inspection replays into lives in the inspection directory; close() must leave
 * nothing of it behind, including SQLite's rollback journal, or a later removal of that directory or a listing of
 * the session directory sees an unexplained file.
 */

const directories: string[] = [];

afterEach(async () => {
	for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

describe("authority export scratch", () => {
	it("close() removes the scratch database and its rollback journal", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-scratch-"));
		directories.push(directory);
		const scratch = new AuthorityScratch(directory);
		const map = scratch.map();
		// Past one periodic commit, so the open transaction has modified pages already on disk.
		for (let index = 0; index < 25_000; index++) {
			map.set(`key-${index}`, JSON.stringify({ index, pad: "x".repeat(200) }));
			scratch.wrote();
		}
		const names = await fs.readdir(directory);
		expect(names.some(name => name.endsWith(".sqlite-journal"))).toBe(true);

		scratch.close();

		expect(await fs.readdir(directory)).toEqual([]);
	});
});
