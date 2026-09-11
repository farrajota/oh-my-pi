import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactManager, writeArtifact } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

describe("ArtifactManager durable publication", () => {
	const roots: string[] = [];

	function freshDir(): string {
		const root = path.join(os.tmpdir(), `omp-w4-artifacts-${crypto.randomUUID()}`);
		roots.push(root);
		return path.join(root, "artifacts");
	}

	afterEach(() => {
		for (const root of roots.splice(0)) removeSyncWithRetries(root);
	});

	test("publishes content only after durable metadata and never leaves staging visible", async () => {
		const manager = new ArtifactManager(freshDir());
		const id = await manager.save("complete", "bash", {
			provenance: "tool-call:one",
			scope: "agent:Main",
			metadata: { mediaType: "text/plain" },
		});
		const finalPath = await manager.getPath(id);
		expect(finalPath).not.toBeNull();
		expect(await fs.readFile(finalPath as string, "utf8")).toBe("complete");
		expect(await fs.readdir(path.join(manager.dir, ".artifact-staging-v1"))).toEqual([]);
	});

	test("publishes manager-allocated paths through the existing write helper", async () => {
		const manager = new ArtifactManager(freshDir());
		const allocated = await manager.allocatePath("bash");
		await writeArtifact(allocated.path, "stream closed");
		const finalPath = await manager.getPath(allocated.id);
		expect(finalPath).not.toBeNull();
		expect(await fs.readFile(finalPath as string, "utf8")).toBe("stream closed");
	});

	test("finishes staged and metadata-published records forward after restart", async () => {
		for (const phase of ["staged", "metadata"] as const) {
			const dir = freshDir();
			const writer = new ArtifactManager(dir);
			const reservation = await writer.reserve("task");
			await fs.writeFile(reservation.path, `payload-${phase}`);
			await writer.stageReserved(reservation.id);
			if (phase === "metadata") await writer.publishReservedMetadata(reservation.id);

			const recovered = new ArtifactManager(dir);
			const result = await recovered.recover();
			expect(result.published).toEqual([reservation.id]);
			expect(await fs.readFile((await recovered.getPath(reservation.id)) as string, "utf8")).toBe(
				`payload-${phase}`,
			);
		}
	});

	test("abandons reserved, missing, and tampered staging without publishing", async () => {
		const dir = freshDir();
		const writer = new ArtifactManager(dir);
		const incomplete = await writer.reserve("bash");
		await fs.writeFile(incomplete.path, "partial bytes without staged commit");
		const tampered = await writer.reserve("bash");
		await fs.writeFile(tampered.path, "original");
		await writer.stageReserved(tampered.id);
		await writer.publishReservedMetadata(tampered.id);
		await fs.writeFile(tampered.path, "tampered");
		const missing = await writer.reserve("bash");
		await writer.stageReserved(missing.id).catch(() => {});

		const recovered = new ArtifactManager(dir);
		const result = await recovered.recover();
		expect([...result.abandoned].sort()).toEqual([incomplete.id, missing.id, tampered.id].sort());
		for (const id of [incomplete.id, missing.id, tampered.id]) expect(await recovered.getPath(id)).toBeNull();
	});

	test("never overwrites a colliding final filename", async () => {
		const dir = freshDir();
		const manager = new ArtifactManager(dir);
		const reservation = await manager.reserve("bash");
		await fs.writeFile(reservation.path, "intended");
		await manager.stageReserved(reservation.id);
		await manager.publishReservedMetadata(reservation.id);
		const collisionPath = path.join(dir, `${reservation.id}.bash.log`);
		await fs.writeFile(collisionPath, "foreign");

		await expect(manager.publishReserved(reservation.id)).rejects.toThrow("collision");
		expect(await fs.readFile(collisionPath, "utf8")).toBe("foreign");
		expect(await manager.getPath(reservation.id)).toBeNull();
	});

	test("two managers reserve distinct occupied ids concurrently", async () => {
		const dir = freshDir();
		const left = new ArtifactManager(dir);
		const right = new ArtifactManager(dir);
		const [leftId, rightId] = await Promise.all([left.save("left", "bash"), right.save("right", "bash")]);
		expect(leftId).not.toBe(rightId);
		expect(await fs.readFile((await left.getPath(leftId)) as string, "utf8")).toBe("left");
		expect(await fs.readFile((await right.getPath(rightId)) as string, "utf8")).toBe("right");
	});

	test("recovery processes at most 100 occupied records per cursor", async () => {
		const dir = freshDir();
		const writer = new ArtifactManager(dir);
		for (let index = 0; index < 105; index++) await writer.reserve(`tool-${index}`);
		const recovered = new ArtifactManager(dir);
		const first = await recovered.recover(0, 1_000);
		expect(first.processed).toBe(100);
		expect(first.nextCursor).toBe(100);
		const second = await recovered.recover(first.nextCursor, 1_000);
		expect(second.processed).toBe(5);
		expect(second.nextCursor).toBeUndefined();
	});

	test("publishes exact agent output and sidecar aliases through one restart-stable head", async () => {
		const dir = freshDir();
		const writer = new ArtifactManager(dir);
		const publication = await writer.publishAgentArtifacts("TaskAgent", "public output", '{"ok":true}\n');
		expect(publication.outputPath).toBe(path.join(dir, "TaskAgent.md"));
		expect(publication.sidecarPath).toBe(path.join(dir, "TaskAgent.json"));
		expect(await writer.listFiles()).toEqual([]);

		const restarted = new ArtifactManager(dir);
		const outputPath = await restarted.getNamedPath("agent-output", "TaskAgent");
		const sidecarPath = await restarted.getNamedPath("agent-sidecar", "TaskAgent");
		expect(outputPath).toBe(path.join(dir, "TaskAgent.md"));
		expect(sidecarPath).toBe(path.join(dir, "TaskAgent.json"));
		expect(await fs.readFile(outputPath as string, "utf8")).toBe("public output");
		expect(await fs.readFile(sidecarPath as string, "utf8")).toBe('{"ok":true}\n');
	});

	test("does not disclose raw or tampered named files without a valid current head", async () => {
		const dir = freshDir();
		const manager = new ArtifactManager(dir);
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, "Unpublished.md"), "foreign");
		expect(await manager.getNamedPath("agent-output", "Unpublished")).toBeNull();

		const published = await manager.publishAgentArtifacts("Tampered", "trusted");
		await fs.writeFile(published.outputPath, "tampered");
		expect(await new ArtifactManager(dir).getNamedPath("agent-output", "Tampered")).toBeNull();
	});

	test("advances a named head with CAS so concurrent same-generation publication cannot overwrite", async () => {
		const dir = freshDir();
		const seed = new ArtifactManager(dir);
		await seed.publishAgentArtifacts("Concurrent", "seed", '{"generation":"seed"}\n');
		const expectedGenerationId = await seed.getAgentArtifactGeneration("Concurrent");
		const left = new ArtifactManager(dir);
		const right = new ArtifactManager(dir);
		const results = await Promise.allSettled([
			left.publishAgentArtifacts("Concurrent", "left", undefined, { expectedGenerationId }),
			right.publishAgentArtifacts("Concurrent", "right", '{"winner":"right"}\n', { expectedGenerationId }),
		]);
		expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter(result => result.status === "rejected")).toHaveLength(1);

		const reader = new ArtifactManager(dir);
		const output = await fs.readFile((await reader.getNamedPath("agent-output", "Concurrent")) as string, "utf8");
		expect(["left", "right"]).toContain(output);
		const sidecarPath = await reader.getNamedPath("agent-sidecar", "Concurrent");
		if (output === "left") expect(sidecarPath).toBeNull();
		else expect(await fs.readFile(sidecarPath as string, "utf8")).toBe('{"winner":"right"}\n');
	});
});
