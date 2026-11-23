/**
 * A secrets-blind subagent cannot read the raw tool output of agents outside its own subtree: their
 * spills (`local://<N>.log`; the agent tree shares one `local://` root and one spill id space), nor
 * the transcripts and spill files behind them by host path, nor their content through a listing or
 * search of the shared root. It keeps its own spills and its descendants'.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { registerArtifactsDir } from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { ArtifactManager } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import type { PermissionScope } from "@oh-my-pi/pi-coding-agent/task/permissions/types";
import {
	__resetDirsFromEnvForTests,
	getSessionsDir,
	setAgentDir,
	spillFileName,
	spillUrl,
	TempDir,
} from "@oh-my-pi/pi-utils";
import { enforceScope } from "./scope-fixtures";
import { createScopedSession, type ScriptedCall } from "./scoped-session";

const SECRET = "API_KEY=sk-live-secret-value";

let tempDir: TempDir;
let parentSessionDir: string;
let parentLocalRoot: string;
let unregisterDir: () => void;

beforeEach(() => {
	tempDir = TempDir.createSync("@omp-scope-artifacts-");
	setAgentDir(tempDir.join("agent"));
	// The parent's session dir, beside its transcript in the sessions dir; its spills sit in its `local://` root.
	parentSessionDir = path.join(getSessionsDir(tempDir.join("agent")), "--repo--", "parent-session");
	parentLocalRoot = path.join(parentSessionDir, "local");
	fs.mkdirSync(parentLocalRoot, { recursive: true });
	unregisterDir = registerArtifactsDir(parentSessionDir);
});

afterEach(() => {
	unregisterDir();
	__resetDirsFromEnvForTests();
	tempDir.removeSync();
});

const blind = (overrides: Partial<PermissionScope> = {}) =>
	enforceScope({ guardrails: { noNetwork: false, secretsBlind: true }, ...overrides });

const read = (target: string): ScriptedCall => ({ name: "read", arguments: { path: target } });

/** The parent's spill manager, which a spawned child adopts. */
const parentSpills = () => new ArtifactManager(parentLocalRoot, parentSessionDir);

describe("local:// spills under secrets-blind", () => {
	it("refuses another agent's raw tool output, by spill URL and by host path", async () => {
		const parent = parentSpills();
		const id = await parent.save(`$ cat .env\n${SECRET}\n`);
		fs.writeFileSync(path.join(path.dirname(parentSessionDir), "parent-session.jsonl"), `${SECRET}\n`);
		const scoped = await createScopedSession({
			tempDir,
			scope: blind(),
			toolNames: ["read"],
			calls: [
				read(spillUrl(id)),
				read(path.join(parentLocalRoot, spillFileName(id))),
				read(path.join(path.dirname(parentSessionDir), "parent-session.jsonl")),
			],
		});
		// The child adopts the parent's manager the way a spawn does, so both share one `local://` root.
		scoped.session.sessionManager.adoptArtifactManager(parent);
		try {
			await scoped.session.sendUserMessage("go");
			const results = scoped.toolResults();
			expect(results).toHaveLength(3);
			for (const result of results) {
				expect(result.text).not.toContain(SECRET);
				expect(result.text).toContain("BLOCKED: secrets-blind guardrail");
			}
		} finally {
			await scoped.dispose();
		}
	});

	it("keeps its own spills and its descendants' readable", async () => {
		const shared = parentSpills();
		const parentId = await shared.save(SECRET);
		const ownId = String(Number(parentId) + 1);
		const descendantId = String(Number(parentId) + 2);
		const scoped = await createScopedSession({
			tempDir,
			scope: blind(),
			toolNames: ["read"],
			calls: [read(spillUrl(ownId)), read(spillUrl(descendantId)), read(spillUrl(parentId))],
		});
		// The child adopts the shared manager the way a spawn does, then produces its own output.
		scoped.session.sessionManager.adoptArtifactManager(shared);
		expect(await scoped.session.sessionManager.saveArtifact("own output")).toBe(ownId);
		// A nested agent of this child allocated the next id through its own session.
		const descendantSession = {
			sessionManager: {
				getArtifactsDir: () => null,
				getSessionId: () => "descendant-session",
				allocatedArtifact: (id: string) => id === descendantId,
			},
		};
		await shared.save("descendant output");
		const ref = AgentRegistry.global().register({
			id: "ScopedChild.Worker",
			displayName: "Worker",
			kind: "sub",
			session: descendantSession as never,
		});
		try {
			await scoped.session.sendUserMessage("go");
			const [own, descendant, parent] = scoped.toolResults();
			expect(own?.text).toContain("own output");
			expect(descendant?.text).toContain("descendant output");
			expect(parent?.text).not.toContain(SECRET);
			expect(parent?.text).toContain("BLOCKED: secrets-blind guardrail denied another agent's artifact");
		} finally {
			AgentRegistry.global().unregister(ref.id);
			await scoped.dispose();
		}
	});

	it("keeps another agent's spills out of a listing and a search of the shared root", async () => {
		const parent = parentSpills();
		const id = await parent.save(`needle ${SECRET}\n`);
		fs.writeFileSync(path.join(parentLocalRoot, "notes.md"), "needle in the notes\n");
		const scoped = await createScopedSession({
			tempDir,
			scope: blind(),
			toolNames: ["read", "grep"],
			calls: [read("local://"), { name: "grep", arguments: { pattern: "needle", path: "local://" } }],
		});
		scoped.session.sessionManager.adoptArtifactManager(parent);
		try {
			await scoped.session.sendUserMessage("go");
			const [listing, search] = scoped.toolResults();
			expect(listing?.text).toContain("notes.md");
			expect(listing?.text).not.toContain(spillFileName(id));
			expect(search?.text).toContain("needle in the notes");
			expect(search?.text).not.toContain(SECRET);
		} finally {
			await scoped.dispose();
		}
	});

	it("leaves spills readable to a subagent that is not secrets-blind", async () => {
		const parent = parentSpills();
		const id = await parent.save("shared output");
		const scoped = await createScopedSession({
			tempDir,
			scope: enforceScope({ tools: ["read"] }),
			toolNames: ["read"],
			calls: [read(spillUrl(id))],
		});
		scoped.session.sessionManager.adoptArtifactManager(parent);
		try {
			await scoped.session.sendUserMessage("go");
			expect(scoped.toolResults()[0]?.text).toContain("shared output");
		} finally {
			await scoped.dispose();
		}
	});
});
