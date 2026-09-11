import { afterAll, afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { AgentProtocolHandler } from "../../src/internal-urls/agent-protocol";
import { resetRegisteredArtifactDirsForTests } from "../../src/internal-urls/registry-helpers";
import { AgentRegistry } from "../../src/registry/agent-registry";
import type { AgentSession } from "../../src/session/agent-session";
import { ArtifactManager } from "../../src/session/artifacts";

const tempDir = TempDir.createSync("omp-nested-agent-repro-");
afterEach(() => {
	AgentRegistry.resetGlobalForTests();
	resetRegisteredArtifactDirsForTests();
});
afterAll(() => {
	tempDir.removeSync();
});

it("agent:// resolves a depth-2 subagent's .md output while its session is live and artifact-manager-adopted", async () => {
	const root = tempDir.path();
	const rootSessionFile = path.join(root, "session.jsonl");
	const rootArtifactsDir = rootSessionFile.slice(0, -6);
	await fs.mkdir(rootArtifactsDir, { recursive: true });
	// Every subagent adopts the root ArtifactManager and reports its dir.
	const sharedArtifactManager = new ArtifactManager(rootArtifactsDir);

	// A depth-1 subagent's OWN children are written under its own
	// sessionFile.slice(0, -6) (task/index.ts), i.e. one level deeper.
	const midSessionFile = path.join(rootArtifactsDir, "CodexDeepDive.jsonl");
	const midOwnArtifactsDir = midSessionFile.slice(0, -6);
	await fs.mkdir(midOwnArtifactsDir, { recursive: true });

	const grandchildId = "CodexDeepDive.GraphStore";
	const grandchildSessionFile = path.join(midOwnArtifactsDir, `${grandchildId}.jsonl`);
	await new ArtifactManager(midOwnArtifactsDir).publishAgentArtifacts(grandchildId, "full report content");

	const fakeSession = {
		sessionManager: { getArtifactsDir: () => sharedArtifactManager.dir },
	} as unknown as AgentSession;
	const registry = AgentRegistry.global();
	registry.register({
		id: "Main",
		displayName: "main",
		kind: "main",
		session: fakeSession,
		sessionFile: rootSessionFile,
	});
	registry.register({
		id: "CodexDeepDive",
		displayName: "sub",
		kind: "sub",
		parentId: "Main",
		session: fakeSession,
		sessionFile: midSessionFile,
	});
	registry.register({
		id: grandchildId,
		displayName: "sub",
		kind: "sub",
		parentId: "CodexDeepDive",
		session: fakeSession,
		sessionFile: grandchildSessionFile,
	});

	const resource = await new AgentProtocolHandler().resolve(new URL(`agent://${grandchildId}`) as never);
	expect(resource.content).toBe("full report content");
});

it("agent:// slash form resolves a nested subagent child (hierarchy separator)", async () => {
	const root = tempDir.path();
	const rootSessionFile = path.join(root, "slash-session.jsonl");
	const rootArtifactsDir = rootSessionFile.slice(0, -6);
	await fs.mkdir(rootArtifactsDir, { recursive: true });
	const sharedArtifactManager = new ArtifactManager(rootArtifactsDir);

	// Parent subagent adopts the root ArtifactManager; its own children are
	// written one level deeper under its sessionFile-derived dir, dot-qualified.
	const parentSessionFile = path.join(rootArtifactsDir, "Parent.jsonl");
	const parentOwnDir = parentSessionFile.slice(0, -6);
	await fs.mkdir(parentOwnDir, { recursive: true });
	await new ArtifactManager(parentOwnDir).publishAgentArtifacts("Parent.Child", "child capsule");
	// Parent output may be in the root dir; the nested child must still win.
	await sharedArtifactManager.publishAgentArtifacts("Parent", JSON.stringify({ Child: "wrong base output" }));

	const fakeSession = {
		sessionManager: { getArtifactsDir: () => sharedArtifactManager.dir },
	} as unknown as AgentSession;
	const registry = AgentRegistry.global();
	registry.register({
		id: "Main",
		displayName: "main",
		kind: "main",
		session: fakeSession,
		sessionFile: rootSessionFile,
	});
	registry.register({
		id: "Parent",
		displayName: "sub",
		kind: "sub",
		parentId: "Main",
		session: fakeSession,
		sessionFile: parentSessionFile,
	});

	const handler = new AgentProtocolHandler();
	// Slash form is a hierarchy hop, not a jq extraction.
	const slash = await handler.resolve(new URL("agent://Parent/Child") as never);
	expect(slash.content).toBe("child capsule");
	expect(slash.contentType).toBe("text/markdown");
	// The canonical dotted id resolves to the same output.
	const dotted = await handler.resolve(new URL("agent://Parent.Child") as never);
	expect(dotted.content).toBe("child capsule");
});

it("agent:// path form falls back to JSON extraction when no nested output matches", async () => {
	const root = tempDir.path();
	const rootSessionFile = path.join(root, "json-session.jsonl");
	const rootArtifactsDir = rootSessionFile.slice(0, -6);
	await fs.mkdir(rootArtifactsDir, { recursive: true });
	const sharedArtifactManager = new ArtifactManager(rootArtifactsDir);
	await sharedArtifactManager.publishAgentArtifacts("Worker", JSON.stringify({ result: { ok: true } }));

	const fakeSession = {
		sessionManager: { getArtifactsDir: () => sharedArtifactManager.dir },
	} as unknown as AgentSession;
	const registry = AgentRegistry.global();
	registry.register({
		id: "Main",
		displayName: "main",
		kind: "main",
		session: fakeSession,
		sessionFile: rootSessionFile,
	});

	const handler = new AgentProtocolHandler();
	// `result` names no nested output, so the path extracts JSON from Worker.md.
	const extracted = await handler.resolve(new URL("agent://Worker/result") as never);
	expect(extracted.contentType).toBe("application/json");
	expect(JSON.parse(extracted.content)).toEqual({ ok: true });
});

it("agent:// path extraction prefers the <id>.json sidecar over the markdown body", async () => {
	const root = tempDir.path();
	const rootSessionFile = path.join(root, "sidecar-session.jsonl");
	const rootArtifactsDir = rootSessionFile.slice(0, -6);
	await fs.mkdir(rootArtifactsDir, { recursive: true });
	const sharedArtifactManager = new ArtifactManager(rootArtifactsDir);
	// Non-JSON body proves the fallback path could not have produced the answer.
	await sharedArtifactManager.publishAgentArtifacts(
		"Worker",
		"schema_violation summary text",
		JSON.stringify({ summary: "ok", count: 7 }),
	);

	const fakeSession = {
		sessionManager: { getArtifactsDir: () => sharedArtifactManager.dir },
	} as unknown as AgentSession;
	const registry = AgentRegistry.global();
	registry.register({
		id: "Main",
		displayName: "main",
		kind: "main",
		session: fakeSession,
		sessionFile: rootSessionFile,
	});

	const handler = new AgentProtocolHandler();
	const resource = await handler.resolve(new URL("agent://Worker/count") as never);
	expect(resource.contentType).toBe("application/json");
	expect(JSON.parse(resource.content)).toBe(7);
	expect(resource.sourcePath?.endsWith("Worker.json")).toBe(true);

	// A bare id keeps serving the markdown body, never the sidecar.
	const bare = await handler.resolve(new URL("agent://Worker") as never);
	expect(bare.contentType).toBe("text/markdown");
	expect(bare.content).toBe("schema_violation summary text");

	// A corrupt sidecar falls back to <id>.md instead of surfacing its own parse error.
	await fs.writeFile(path.join(rootArtifactsDir, "Worker.json"), "{not json");
	await expect(handler.resolve(new URL("agent://Worker/count") as never)).rejects.toThrow(/Worker is not valid JSON/);
});

it("agent:// keeps raw and tampered aliases invisible without changing lookup errors", async () => {
	const handler = new AgentProtocolHandler();
	await expect(handler.resolve(new URL("agent://Missing") as never)).rejects.toThrow(
		"No session - agent outputs unavailable",
	);

	const root = tempDir.path();
	const missingSessionFile = path.join(root, "missing-artifacts.jsonl");
	AgentRegistry.global().register({
		id: "Main",
		displayName: "main",
		kind: "main",
		session: null,
		sessionFile: missingSessionFile,
	});
	await expect(handler.resolve(new URL("agent://Missing") as never)).rejects.toThrow("No artifacts directory found");

	AgentRegistry.resetGlobalForTests();
	const sessionFile = path.join(root, "marker-gated.jsonl");
	const artifactsDir = sessionFile.slice(0, -6);
	await fs.mkdir(artifactsDir, { recursive: true });
	await fs.writeFile(path.join(artifactsDir, "RawOnly.md"), "unpublished raw payload");
	const manager = new ArtifactManager(artifactsDir);
	const tampered = await manager.publishAgentArtifacts("Tampered", "trusted payload");
	await fs.writeFile(tampered.outputPath, "tampered payload");
	const fakeSession = {
		sessionManager: { getArtifactsDir: () => manager.dir },
	} as unknown as AgentSession;
	AgentRegistry.global().register({
		id: "Main",
		displayName: "main",
		kind: "main",
		session: fakeSession,
		sessionFile,
	});

	await expect(handler.resolve(new URL("agent://RawOnly") as never)).rejects.toThrow("Not found: RawOnly");
	await expect(handler.resolve(new URL("agent://Tampered") as never)).rejects.toThrow("Not found: Tampered");
});

it("agent:// extraction uses only the current output generation's sidecar in the preferred root", async () => {
	const root = tempDir.path();
	const rootASessionFile = path.join(root, "generation-a.jsonl");
	const rootBSessionFile = path.join(root, "generation-b.jsonl");
	await Promise.all([fs.writeFile(rootASessionFile, ""), fs.writeFile(rootBSessionFile, "")]);
	const managerA = new ArtifactManager(rootASessionFile.slice(0, -6));
	const managerB = new ArtifactManager(rootBSessionFile.slice(0, -6));
	await managerA.publishAgentArtifacts("Worker", "old summary", JSON.stringify({ count: 1 }));
	await managerA.publishAgentArtifacts("Worker", JSON.stringify({ count: 3 }));
	// Neither a stale raw sidecar in the preferred root nor a current foreign
	// sidecar in a later root may be paired with A's current output generation.
	await fs.writeFile(path.join(managerA.dir, "Worker.json"), JSON.stringify({ count: 1 }));
	await managerB.publishAgentArtifacts("Worker", "foreign summary", JSON.stringify({ count: 2 }));

	const fakeSessionB = {
		sessionManager: { getArtifactsDir: () => managerB.dir },
	} as unknown as AgentSession;
	AgentRegistry.global().register({
		id: "Main",
		displayName: "main",
		kind: "main",
		session: fakeSessionB,
		sessionFile: rootBSessionFile,
	});

	const resource = await new AgentProtocolHandler().resolve(new URL("agent://Worker/count") as never, {
		sessionFile: rootASessionFile,
	});
	expect(JSON.parse(resource.content)).toBe(3);
	expect(resource.sourcePath).toBe(path.join(managerA.dir, "Worker.md"));
});

it("agent:// completion is registry-bounded and independent of raw filenames", async () => {
	const root = tempDir.path();
	const sessionFile = path.join(root, "completion.jsonl");
	const artifactsDir = sessionFile.slice(0, -6);
	const manager = new ArtifactManager(artifactsDir);
	await manager.publishAgentArtifacts("Published", "published output");
	await manager.publishAgentArtifacts("Parent.Child", "nested output");
	const tampered = await manager.publishAgentArtifacts("Tampered", "trusted output");
	await fs.writeFile(tampered.outputPath, "tampered output");
	await fs.writeFile(path.join(artifactsDir, "FilenameOnly.md"), "raw output");

	const fakeSession = {
		sessionManager: { getArtifactsDir: () => manager.dir },
	} as unknown as AgentSession;
	for (const id of ["Main", "Published", "Parent.Child", "Tampered", "RegisteredWithoutOutput"]) {
		AgentRegistry.global().register({
			id,
			displayName: id,
			kind: id === "Main" ? "main" : "sub",
			...(id === "Main" ? {} : { parentId: "Main" }),
			session: fakeSession,
			sessionFile: id === "Main" ? sessionFile : path.join(artifactsDir, `${id}.jsonl`),
		});
	}

	await expect(new AgentProtocolHandler().complete()).resolves.toEqual([
		{ value: "Parent.Child" },
		{ value: "Published" },
		{ value: "RegisteredWithoutOutput" },
		{ value: "Tampered" },
	]);
});
