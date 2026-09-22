import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactManager, writeArtifact } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

describe("ArtifactManager publication integrity", () => {
	const dirs: string[] = [];

	function freshDir(): string {
		const dir = path.join(os.tmpdir(), `omp-artifact-integrity-${crypto.randomUUID()}`);
		dirs.push(dir);
		return dir;
	}

	afterEach(() => {
		for (const dir of dirs.splice(0)) removeSyncWithRetries(dir);
	});

	it("keeps an incomplete reservation invisible and abandons its occupied id during recovery", async () => {
		const manager = new ArtifactManager(freshDir());
		const reservation = await manager.reserve("task");
		await fs.writeFile(reservation.path, "partial report");

		expect(await manager.getPath(reservation.id)).toBeNull();
		expect(await manager.listFiles()).toEqual([]);

		const recovery = await manager.recover();
		expect(recovery.abandoned).toContain(reservation.id);
		expect(await manager.getPath(reservation.id)).toBeNull();
		await expect(manager.publishReserved(reservation.id)).rejects.toThrow(
			`Artifact reservation is unavailable: ${reservation.id}`,
		);
	});

	it("rejects an incomplete write without publishing the allocated artifact", async () => {
		const manager = new ArtifactManager(freshDir());
		const allocation = await manager.allocatePath("task");
		const content = "complete report";
		const partial = "partial";
		const originalWrite = Bun.write;
		const writeSpy = spyOn(Bun, "write").mockImplementationOnce(
			(async (destination: string | URL | Bun.BunFile) => originalWrite(destination, partial)) as typeof Bun.write,
		);

		try {
			await expect(writeArtifact(allocation.path, content)).rejects.toThrow(
				`Artifact write incomplete: wrote ${Buffer.byteLength(partial)} of ${Buffer.byteLength(content)} bytes`,
			);
		} finally {
			writeSpy.mockRestore();
		}

		expect(await manager.getPath(allocation.id)).toBeNull();
		expect(await manager.listFiles()).toEqual([]);
		await expect(fs.access(allocation.path)).rejects.toThrow();
	});

	it("publishes an allocated artifact only after writeArtifact completes", async () => {
		const manager = new ArtifactManager(freshDir());
		const allocation = await manager.allocatePath("task");
		const content = "complete report";

		expect(await manager.getPath(allocation.id)).toBeNull();
		expect(await manager.listFiles()).toEqual([]);

		expect(await writeArtifact(allocation.path, content)).toBe(Buffer.byteLength(content));
		const publishedPath = path.join(path.dirname(path.dirname(allocation.path)), `${allocation.id}.task.log`);
		expect(await manager.getPath(allocation.id)).toBe(publishedPath);
		expect(publishedPath).not.toBe(allocation.path);
		expect(await manager.listFiles()).toEqual([path.basename(publishedPath)]);
		expect(await fs.readFile(publishedPath, "utf8")).toBe(content);
		await expect(fs.access(allocation.path)).rejects.toThrow();
	});

	it("rejects tampered staged bytes and keeps the reserved id invisible", async () => {
		const manager = new ArtifactManager(freshDir());
		const reservation = await manager.reserve("task");
		await fs.writeFile(reservation.path, "complete report");
		await manager.stageReserved(reservation.id);
		await fs.writeFile(reservation.path, "tampered report");

		await expect(manager.publishReserved(reservation.id)).rejects.toThrow(
			`Artifact staging bytes failed validation: ${reservation.id}`,
		);
		expect(await manager.getPath(reservation.id)).toBeNull();
		expect(await manager.listFiles()).toEqual([]);
		await expect(manager.publishReserved(reservation.id)).rejects.toThrow(
			`Artifact reservation is unavailable: ${reservation.id}`,
		);
	});

	it("hides tampered published content from manifest-governed discovery", async () => {
		const manager = new ArtifactManager(freshDir());
		const id = await manager.save("original valid report", "task");
		const publishedPath = await manager.getPath(id);
		expect(publishedPath).not.toBeNull();
		await fs.writeFile(publishedPath as string, "tampered report");

		expect(await manager.getPath(id)).toBeNull();
		expect(await manager.exists(id)).toBe(false);
		expect(await manager.listFiles()).toEqual([]);
		expect((await manager.recover()).quarantined).toContain(id);

	});

	it("does not expose a raw filename without a publication manifest", async () => {
		const dir = freshDir();
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, "0.task.log"), "raw alias");
		const manager = new ArtifactManager(dir);

		expect(await manager.getPath("0")).toBeNull();
		expect(await manager.exists("0")).toBe(false);
		expect(await manager.listFiles()).toEqual([]);
	});
});
