import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { composeEffectivePermissions } from "@oh-my-pi/pi-coding-agent/task/permissions/compose";
import { evaluateSubagentPermission } from "@oh-my-pi/pi-coding-agent/task/permissions/evaluate";
import {
	BUILTIN_PERMISSION_PROFILES,
	loadPermissionProfiles,
} from "@oh-my-pi/pi-coding-agent/task/permissions/profiles";
import {
	canonicalPermissionValue,
	decodePermissionScope,
	encodePermissionScope,
	freezePermissionScope,
	permissionScopeHash,
	readPermissionSnapshot,
} from "@oh-my-pi/pi-coding-agent/task/permissions/snapshot";
import type {
	PathConstraintGroup,
	PermissionProfileIdentity,
	PermissionScope,
} from "@oh-my-pi/pi-coding-agent/task/permissions/types";
import v1FixtureJson from "./fixtures/v1-permission-snapshots.json" with { type: "json" };

const tempRoots: string[] = [];

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

/** Shape of a scope as the fork (0d98ea6aa3) persisted it in session_init.permissionSnapshot. */
interface V1Scope {
	mode: PermissionScope["mode"];
	toolsEnabled: boolean;
	pathsEnabled: boolean;
	actorId: string;
	actorKind: PermissionScope["actorKind"];
	parentId?: string;
	profiles: string[];
	tools?: string[];
	denyTools: string[];
	allowPaths: string[];
	denyPaths: string[];
	allowPathGroups: PathConstraintGroup[];
	denyPathGroups: PathConstraintGroup[];
	guardrails: { noNetwork: boolean; secretsBlind: boolean };
	restrictedState: string;
	clauses: Array<{ source: string }>;
	provenance: { source: string; profileNames: string[]; profiles: PermissionProfileIdentity[] };
}

interface V1Probe {
	toolName: string;
	toolInput: Record<string, unknown>;
	action: string;
	code?: string;
}

/** Generated once with the fork's own code; see the generatedBy field and the WP08 report. */
const v1Fixture = v1FixtureJson as unknown as {
	cwd: string;
	userPermissionsFile: unknown;
	profileIdentities: Record<string, PermissionProfileIdentity>;
	snapshots: Record<string, { snapshot: { scope: V1Scope; canonicalSha256: string }; decisions: V1Probe[] }>;
};

function composedScope(): PermissionScope {
	const result = composeEffectivePermissions({
		mode: "enforce",
		toolsEnabled: true,
		pathsEnabled: true,
		actorId: "Child",
		actorKind: "sub",
		parentId: "Main",
		request: { profiles: ["focused-edit", "secrets-blind"], allowPaths: ["src/**"] },
		profiles: BUILTIN_PERMISSION_PROFILES,
	});
	if (!result.ok) throw new Error(result.error);
	return result.value;
}

describe("v1 (fork-era) permission snapshots", () => {
	const entries = Object.entries(v1Fixture.snapshots);

	test("the fixture covers enforce, inherited, guardrail, suggest and off snapshots", () => {
		expect(entries.map(([name]) => name)).toEqual(["parent", "child", "editor", "suggest", "off"]);
	});

	for (const [name, entry] of entries) {
		test(`${name}: the fork hash verifies and the projection keeps every enforcement field`, () => {
			const v1 = entry.snapshot.scope;
			const read = readPermissionSnapshot(entry.snapshot);
			if (!read.ok) throw new Error(read.error);

			expect(read.version).toBe(1);
			const scope = read.snapshot.scope;
			expect(scope).toEqual({
				v: 2,
				mode: v1.mode,
				toolsEnabled: v1.toolsEnabled,
				pathsEnabled: v1.pathsEnabled,
				actorId: v1.actorId,
				actorKind: v1.actorKind,
				parentId: v1.parentId,
				profiles: v1.profiles,
				...(v1.tools === undefined ? {} : { tools: v1.tools }),
				denyTools: v1.denyTools,
				allowPathGroups: v1.allowPathGroups,
				denyPathGroups: v1.denyPathGroups,
				guardrails: v1.guardrails,
				restricted: v1.restrictedState === "restricted",
				inherited: v1.clauses.some(clause => clause.source === "inherited"),
				provenance: { profiles: v1.provenance.profiles },
			});
			expect(Object.isFrozen(scope.denyPathGroups)).toBe(true);
			expect(read.snapshot.canonicalSha256).toBe(permissionScopeHash(scope));
		});

		test(`${name}: the projected scope reproduces every decision the fork evaluator made`, () => {
			const read = readPermissionSnapshot(entry.snapshot);
			if (!read.ok) throw new Error(read.error);
			for (const probe of entry.decisions) {
				const decision = evaluateSubagentPermission({
					scope: read.snapshot.scope,
					toolName: probe.toolName,
					toolInput: probe.toolInput,
					cwd: v1Fixture.cwd,
				});
				// The probe rides along so a failure names the call that diverged.
				const observed: { probe: V1Probe; action: string; code?: string } = {
					probe,
					action: decision.action,
					code: decision.details?.code,
				};
				expect(observed).toEqual({ probe, action: probe.action, code: probe.code });
			}
		});
	}

	test("a one-byte edit to the scope or the hash fails verification", () => {
		const original = v1Fixture.snapshots.parent!.snapshot;
		const editedScope = structuredClone(original);
		editedScope.scope.actorId = `${original.scope.actorId.slice(0, -1)}X`;
		const editedHash = structuredClone(original);
		editedHash.canonicalSha256 = `${original.canonicalSha256.slice(0, -1)}${original.canonicalSha256.endsWith("0") ? "1" : "0"}`;
		const widened = structuredClone(original);
		widened.scope.denyPathGroups = [];

		for (const tampered of [editedScope, editedHash, widened]) {
			expect(readPermissionSnapshot(tampered)).toEqual({
				ok: false,
				error: "permission snapshot hash does not match its scope",
			});
		}
	});

	test("a v1 scope with an unknown field is refused even when its hash matches", () => {
		const scope = { ...v1Fixture.snapshots.child!.snapshot.scope, futureField: true };
		const canonicalSha256 = new Bun.CryptoHasher("sha256").update(canonicalPermissionValue(scope)).digest("hex");

		expect(readPermissionSnapshot({ scope, canonicalSha256 })).toEqual({
			ok: false,
			error: 'permission snapshot scope has unknown field "futureField"',
		});
	});

	test("the fork's profile identities still match the current loader, so drift checks agree", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-v1-identities-"));
		tempRoots.push(cwd);
		await Bun.write(path.join(cwd, "agent", "permissions.json"), JSON.stringify(v1Fixture.userPermissionsFile));
		const loaded = await loadPermissionProfiles(cwd, { agentDir: path.join(cwd, "agent") });

		const forkIdentities = Object.values(v1Fixture.snapshots).flatMap(
			entry => entry.snapshot.scope.provenance.profiles,
		);
		expect(forkIdentities.length).toBeGreaterThan(0);
		for (const identity of forkIdentities) expect(loaded.profileIdentities[identity.name]).toEqual(identity);
		expect(loaded.profileIdentities["fixture-scout"]).toEqual(v1Fixture.profileIdentities["fixture-scout"]);
	});
});

describe("v2 permission snapshots", () => {
	test("a frozen snapshot owns its state and round-trips through JSON with the same hash", () => {
		const original = composedScope();
		const mutable = structuredClone(original) as { -readonly [K in keyof PermissionScope]: PermissionScope[K] };
		const snapshot = freezePermissionScope(mutable);
		(mutable.tools as string[]).push("bash");
		(mutable.allowPathGroups as PathConstraintGroup[])[0] = ["test/**"];

		expect(snapshot.scope.tools).toEqual(original.tools);
		expect(snapshot.scope.allowPathGroups).toEqual([["src/**"]]);
		expect(Object.isFrozen(snapshot.scope.allowPathGroups)).toBe(true);
		expect(snapshot.canonicalSha256).toMatch(/^[a-f0-9]{64}$/);
		expect(permissionScopeHash(mutable)).not.toBe(snapshot.canonicalSha256);

		const read = readPermissionSnapshot(JSON.parse(JSON.stringify(snapshot)));
		if (!read.ok) throw new Error(read.error);
		expect(read.version).toBe(2);
		expect(read.snapshot).toEqual(snapshot);
		expect(Object.isFrozen(read.snapshot.scope.provenance.profiles)).toBe(true);
	});

	test("identity and provenance edits change the hash", () => {
		const scope = composedScope();
		const hash = permissionScopeHash(scope);
		expect(permissionScopeHash({ ...scope, actorId: "other" })).not.toBe(hash);
		expect(permissionScopeHash({ ...scope, parentId: "other" })).not.toBe(hash);
		expect(permissionScopeHash({ ...scope, provenance: { profiles: [] } })).not.toBe(hash);
	});

	test("the active-scope string codec accepts only verified v2 scopes", () => {
		const scope = composedScope();
		const decoded = decodePermissionScope(encodePermissionScope(scope));
		if (!decoded.ok) throw new Error(decoded.error);
		expect(decoded.snapshot.scope).toEqual(scope);

		expect(decodePermissionScope(JSON.stringify(v1Fixture.snapshots.parent!.snapshot))).toEqual({
			ok: false,
			error: "permission scope must be a v2 snapshot",
		});
		expect(decodePermissionScope("{not json")).toMatchObject({ ok: false });
		const text = encodePermissionScope(scope);
		expect(decodePermissionScope(text.replace('"mode":"enforce"', '"mode":"suggest"'))).toEqual({
			ok: false,
			error: "permission snapshot hash does not match its scope",
		});
	});

	test("a v2 scope with a malformed field is refused even when its hash matches", () => {
		const scope = { ...composedScope(), allowPathGroups: [[]] };
		const canonicalSha256 = new Bun.CryptoHasher("sha256").update(canonicalPermissionValue(scope)).digest("hex");

		expect(readPermissionSnapshot({ scope, canonicalSha256 })).toEqual({
			ok: false,
			error: 'permission snapshot scope field "allowPathGroups" is malformed',
		});
	});
});
