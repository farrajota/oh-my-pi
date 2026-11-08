/**
 * A secrets-blind subagent cannot read the raw tool output of agents outside its own subtree: their
 * `artifact://` ids (artifact ids are shared across the agent tree, and every session's artifacts
 * resolve), nor the transcripts and artifact files behind them by host path. It keeps its own
 * artifacts and its descendants'.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { registerArtifactsDir } from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { ArtifactManager } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import type { PermissionScope } from "@oh-my-pi/pi-coding-agent/task/permissions/types";
import { __resetDirsFromEnvForTests, getSessionsDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { enforceScope } from "./scope-fixtures";
import { createScopedSession, type ScriptedCall } from "./scoped-session";

const SECRET = "API_KEY=sk-live-secret-value";

let tempDir: TempDir;
let parentArtifacts: string;
let unregisterDir: () => void;

beforeEach(() => {
	tempDir = TempDir.createSync("@omp-scope-artifacts-");
	setAgentDir(tempDir.join("agent"));
	// The parent's artifacts dir, beside its transcript in the sessions dir.
	parentArtifacts = path.join(getSessionsDir(tempDir.join("agent")), "--repo--", "parent-session");
	fs.mkdirSync(parentArtifacts, { recursive: true });
	unregisterDir = registerArtifactsDir(parentArtifacts);
});

afterEach(() => {
	unregisterDir();
	__resetDirsFromEnvForTests();
	tempDir.removeSync();
});

const blind = (overrides: Partial<PermissionScope> = {}) =>
	enforceScope({ guardrails: { noNetwork: false, secretsBlind: true }, ...overrides });

const read = (target: string): ScriptedCall => ({ name: "read", arguments: { path: target } });

describe("artifact:// under secrets-blind", () => {
	it("refuses another agent's raw tool output, by artifact id and by host path", async () => {
		const parent = new ArtifactManager(parentArtifacts);
		const id = await parent.save(`$ cat .env\n${SECRET}\n`, "bash");
		fs.writeFileSync(path.join(path.dirname(parentArtifacts), "parent-session.jsonl"), `${SECRET}\n`);
		const scoped = await createScopedSession({
			tempDir,
			scope: blind(),
			toolNames: ["read"],
			calls: [
				read(`artifact://${id}`),
				read(path.join(parentArtifacts, `${id}.bash.log`)),
				read(path.join(path.dirname(parentArtifacts), "parent-session.jsonl")),
			],
		});
		try {
			await scoped.session.sendUserMessage("go");
			for (const result of scoped.toolResults()) {
				expect(result.text).not.toContain(SECRET);
				expect(result.text).toContain("BLOCKED: secrets-blind guardrail");
			}
		} finally {
			await scoped.dispose();
		}
	});

	it("keeps its own artifacts and its descendants' readable", async () => {
		const shared = new ArtifactManager(parentArtifacts);
		const parentId = await shared.save(SECRET, "bash");
		const ownId = String(Number(parentId) + 1);
		const descendantId = String(Number(parentId) + 2);
		const scoped = await createScopedSession({
			tempDir,
			scope: blind(),
			toolNames: ["read"],
			calls: [read(`artifact://${ownId}`), read(`artifact://${descendantId}`), read(`artifact://${parentId}`)],
		});
		// The child adopts the shared manager the way a spawn does, then produces its own output.
		scoped.session.sessionManager.adoptArtifactManager(shared);
		expect(await scoped.session.sessionManager.saveArtifact("own output", "bash")).toBe(ownId);
		// A nested agent of this child allocated the next id through its own session.
		const descendantSession = {
			sessionManager: { getArtifactsDir: () => null, allocatedArtifact: (id: string) => id === descendantId },
		};
		await shared.save("descendant output", "bash");
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

	it("leaves artifacts readable to a subagent that is not secrets-blind", async () => {
		const id = await new ArtifactManager(parentArtifacts).save("shared output", "bash");
		const scoped = await createScopedSession({
			tempDir,
			scope: enforceScope({ tools: ["read"] }),
			toolNames: ["read"],
			calls: [read(`artifact://${id}`)],
		});
		try {
			await scoped.session.sendUserMessage("go");
			expect(scoped.toolResults()[0]?.text).toContain("shared output");
		} finally {
			await scoped.dispose();
		}
	});
});
