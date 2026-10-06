import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { extractSessionInit, SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	buildEffectivePermissionSummary,
	composeEffectivePermissions,
	freezePermissionScope,
} from "@oh-my-pi/pi-coding-agent/task/permission-profiles";
import { TempDir } from "@oh-my-pi/pi-utils";

const tempDirs: TempDir[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

function createManager(): { manager: SessionManager; sessionFile: string } {
	const dir = TempDir.createSync("@pi-extract-session-init-");
	tempDirs.push(dir);
	const manager = SessionManager.create(dir.path(), path.join(dir.path(), "sessions"));
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a persisted session file path");
	return { manager, sessionFile };
}

function childPermissions() {
	const composed = composeEffectivePermissions({
		mode: "enforce",
		toolsEnabled: true,
		pathsEnabled: true,
		actorId: "child",
		actorKind: "sub",
		parentId: "Main",
		profiles: {},
		profileIdentities: {},
	});
	if (!composed.ok) throw new Error(composed.error);
	return {
		scope: composed.value,
		snapshot: freezePermissionScope(composed.value),
		summary: buildEffectivePermissionSummary(composed.value),
		profiles: [...composed.value.profiles],
	};
}

describe("extractSessionInit", () => {
	it("keeps the permission and MCP revival contract when a rebuilt session_init is re-appended", async () => {
		const { manager, sessionFile } = createManager();
		const permissions = childPermissions();
		manager.appendSessionInit({
			systemPrompt: ["base", "batch 1"],
			task: "work",
			tools: ["read"],
			requestedPermissionProfiles: [],
			effectivePermissionProfiles: permissions.profiles,
			permissionSnapshot: permissions.snapshot,
			permissionSummary: permissions.summary,
			enableMCP: false,
		});
		await manager.ensureOnDisk();

		// AgentSession re-appends the extracted contract with a new base whenever a model call's base changes.
		const extracted = extractSessionInit(manager.getEntries());
		if (!extracted) throw new Error("Expected a persisted session_init");
		manager.appendSessionInit({ ...extracted, systemPrompt: ["base", "batch 2"] });
		await manager.flush();

		const peek = await SessionManager.peekSessionInit(sessionFile);
		expect(peek?.init?.systemPrompt).toEqual(["base", "batch 2"]);
		expect(peek?.init?.permissionSnapshot).toEqual(permissions.snapshot);
		expect(peek?.init?.permissionSummary).toEqual(permissions.summary);
		expect(peek?.init?.effectivePermissionProfiles).toEqual(permissions.profiles);
		expect(peek?.init?.requestedPermissionProfiles).toEqual([]);
		expect(peek?.init?.enableMCP).toBe(false);
	});

	it.each([
		["no explicit list", null],
		["an explicit list", ["read"]],
	] as const)("keeps the spawn's tool list (%s) when a rebuilt session_init is re-appended", async (_label, list) => {
		const { manager, sessionFile } = createManager();
		const startupToolNames = list === null ? null : [...list];
		manager.appendSessionInit({ systemPrompt: ["base"], task: "work", tools: ["read", "yield"], startupToolNames });
		await manager.ensureOnDisk();
		const extracted = extractSessionInit(manager.getEntries());
		if (!extracted) throw new Error("Expected a persisted session_init");
		manager.appendSessionInit({ ...extracted, systemPrompt: ["base", "rebuilt"] });
		await manager.flush();

		const peek = await SessionManager.peekSessionInit(sessionFile);
		expect(peek?.init?.systemPrompt).toEqual(["base", "rebuilt"]);
		expect(peek?.init?.startupToolNames).toEqual(startupToolNames);
	});

	it("carries the latest permission summary update into the rebuilt contract", () => {
		const { manager } = createManager();
		const permissions = childPermissions();
		manager.appendSessionInit({
			systemPrompt: ["base"],
			task: "work",
			tools: ["read"],
			permissionSnapshot: permissions.snapshot,
			permissionSummary: permissions.summary,
		});
		manager.appendPermissionSummaryUpdate(
			buildEffectivePermissionSummary(permissions.scope, [
				{
					kind: "subagent_permission_denial",
					code: "tool-deny",
					tool: "write",
					targets: { items: [], omittedCount: 0 },
					matched: "write",
					reason: "outside scope",
				},
			]),
		);

		const latest = manager.getLatestPermissionSummary();
		expect(latest).not.toEqual(permissions.summary);

		const extracted = extractSessionInit(manager.getEntries());
		if (!extracted) throw new Error("Expected a persisted session_init");
		expect(extracted.permissionSummary).toEqual(latest);
		manager.appendSessionInit({ ...extracted, systemPrompt: ["base", "rebuilt"] });

		expect(manager.getLatestPermissionSummary()).toEqual(latest);
	});
});
