/**
 * Eval runs arbitrary code, shell commands included (`sh()`, `Bun.$`, `Bun.spawn`, Python
 * `subprocess`), so an enforce scope grants it only together with `bash`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { composeEffectivePermissions } from "@oh-my-pi/pi-coding-agent/task/permissions/compose";
import { evaluateSubagentPermission } from "@oh-my-pi/pi-coding-agent/task/permissions/evaluate";
import {
	BUILTIN_PERMISSION_PROFILES,
	loadPermissionProfiles,
	permissionProfileStartupWarning,
} from "@oh-my-pi/pi-coding-agent/task/permissions/profiles";
import { permissionStartupToolNames } from "@oh-my-pi/pi-coding-agent/task/permissions/spawn";
import type { PermissionScope } from "@oh-my-pi/pi-coding-agent/task/permissions/types";
import { approvalRestrictions, resolveApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";
import { enforceScope, scopedSettings } from "./scope-fixtures";

const CWD = "/repo";
const EVAL_NEEDS_BASH =
	"BLOCKED: tool 'eval' runs arbitrary code including shell commands; it requires the 'bash' grant.";
const REQUESTED = ["eval", "bash", "read"];

const tempRoots: string[] = [];

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempRoots.push(dir);
	return dir;
}

function evaluateEval(scope: PermissionScope) {
	return evaluateSubagentPermission({ scope, toolName: "eval", toolInput: { code: "1" }, cwd: CWD });
}

/** The decision the model-facing approval guard reaches for one eval call under `scope`. */
function guardEval(scope: PermissionScope) {
	const restrictions = approvalRestrictions(scopedSettings(scope), CWD);
	return resolveApproval({ name: "eval", approval: "exec" }, { code: "1" }, "yolo", {}, undefined, restrictions);
}

describe("eval requires the bash grant in enforce mode", () => {
	test("an allowlist with eval but not bash starts without eval and the guard denies it", () => {
		const scope = enforceScope({ tools: ["eval", "read"] });

		expect(permissionStartupToolNames(scopedSettings(scope), REQUESTED)).toEqual(["read"]);
		expect(evaluateEval(scope)).toMatchObject({
			action: "deny",
			reason: EVAL_NEEDS_BASH,
			matched: "subagent:eval-requires-bash",
			details: { code: "tool-not-allowed", tool: "eval" },
		});
		expect(guardEval(scope)).toMatchObject({ policy: "deny", source: "permission", reason: EVAL_NEEDS_BASH });
	});

	test("an allowlist with eval and bash keeps eval", () => {
		const scope = enforceScope({ tools: ["eval", "bash", "read"] });

		expect(permissionStartupToolNames(scopedSettings(scope), REQUESTED)).toEqual(["eval", "bash", "read"]);
		expect(evaluateEval(scope).action).toBe("allow");
		expect(guardEval(scope).policy).toBe("allow");
	});

	test("denying bash without an allowlist denies eval", () => {
		const scope = enforceScope({ denyTools: ["bash"] });

		expect(permissionStartupToolNames(scopedSettings(scope), REQUESTED)).toEqual(["read"]);
		expect(evaluateEval(scope)).toMatchObject({ action: "deny", reason: EVAL_NEEDS_BASH });
	});

	test("a clause denying bash on top of a profile granting both denies eval in the composed scope", () => {
		const composed = composeEffectivePermissions({
			mode: "enforce",
			toolsEnabled: true,
			pathsEnabled: true,
			actorId: "child",
			actorKind: "sub",
			request: { profiles: ["scripter"], denyTools: ["bash"] },
			profiles: { ...BUILTIN_PERMISSION_PROFILES, scripter: { tools: ["read", "eval", "bash"] } },
		});
		if (!composed.ok) throw new Error(composed.error);

		expect(evaluateEval(composed.value)).toMatchObject({ action: "deny", reason: EVAL_NEEDS_BASH });
	});

	test("suggest mode keeps eval without bash", () => {
		const scope = enforceScope({ mode: "suggest", tools: ["eval", "read"] });

		expect(permissionStartupToolNames(scopedSettings(scope), REQUESTED)).toEqual(REQUESTED);
		expect(evaluateEval(scope).action).toBe("allow");
		expect(guardEval(scope).policy).toBe("allow");
	});

	test("a scope with path rules keeps the unprovable-effect reason for eval", () => {
		const scope = enforceScope({ tools: ["eval", "read"], denyPathGroups: [["secret/**"]] });

		expect(evaluateEval(scope)).toMatchObject({
			action: "deny",
			reason:
				"BLOCKED: Subagent permission scope cannot verify the effects of tool 'eval' while path rules or guardrails apply.",
			matched: "guardrail:unprovable-effect",
			details: { code: "guardrail" },
		});
	});
});

describe("load warning for eval without bash", () => {
	const TAIL =
		"; eval runs arbitrary code including shell commands, so enforce mode drops eval from a scope without the bash grant";

	test("warns for profiles granting eval but not bash, and not for ones granting both", async () => {
		const cwd = await tempDir("omp-eval-shell-grant-");
		const agentDir = await tempDir("omp-eval-shell-grant-agent-");
		await Bun.write(
			path.join(cwd, ".omp", "permissions.json"),
			JSON.stringify({
				profiles: {
					"eval-only": { tools: ["read", "eval"] },
					"eval-and-bash": { tools: ["read", "eval", "bash"] },
					"bash-denied": { denyTools: ["bash"] },
					// Path rules already drop eval, and the path-rule warning names it.
					"eval-with-paths": { tools: ["read", "eval"], denyPaths: ["vault"] },
				},
			}),
		);

		const loaded = await loadPermissionProfiles(cwd, { agentDir });

		expect(loaded.errors).toEqual([]);
		expect(loaded.warnings).toHaveLength(3);
		expect(loaded.warnings).toContain(
			`.omp/permissions.json: permission profile "eval-only" grants eval but not bash${TAIL}`,
		);
		expect(loaded.warnings).toContain(
			`.omp/permissions.json: permission profile "bash-denied" grants eval but not bash${TAIL}`,
		);
		expect(loaded.warnings.filter(warning => warning.includes('"eval-with-paths"'))).toHaveLength(1);
		expect(loaded.warnings.some(warning => warning.includes('"eval-and-bash"'))).toBe(false);
		expect(await permissionProfileStartupWarning(cwd, { mode: "suggest", agentDir })).toContain(
			`permission profile "eval-only" grants eval but not bash${TAIL}`,
		);
	});
});
