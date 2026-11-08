/**
 * `task.permissions.activeScope`: the compiled scope a subagent runs under, carried as a runtime-only
 * settings override and enforced through the approval guard `approvalRestrictions` builds.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool, ToolTier } from "@oh-my-pi/pi-agent-core";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CfgProtocolHandler, setCfgApprovalHost } from "@oh-my-pi/pi-coding-agent/internal-urls/cfg-protocol";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { cfgTaskPermissionsActiveScope } from "@oh-my-pi/pi-coding-agent/task/permissions/settings";
import { encodePermissionScope } from "@oh-my-pi/pi-coding-agent/task/permissions/snapshot";
import type { PermissionScope } from "@oh-my-pi/pi-coding-agent/task/permissions/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { approvalRestrictions, type ResolvedApproval, resolveApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";
import { approvalTargetKey } from "@oh-my-pi/pi-coding-agent/tools/approval-targets";
import { getProjectAgentDir, isRecord, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

const ACTIVE_SCOPE = "task.permissions.activeScope";

function scope(overrides: Partial<PermissionScope> = {}): PermissionScope {
	return {
		v: 2,
		mode: "enforce",
		toolsEnabled: true,
		pathsEnabled: true,
		actorId: "ActiveScopeTest",
		actorKind: "sub",
		profiles: [],
		denyTools: [],
		allowPathGroups: [],
		denyPathGroups: [],
		guardrails: { noNetwork: false, secretsBlind: false },
		restricted: true,
		inherited: false,
		provenance: { profiles: [] },
		...overrides,
	};
}

/** Settings whose runtime layer carries `target`, as a subagent overlay would. */
function scoped(target: PermissionScope): Settings {
	return Settings.isolated({ [ACTIVE_SCOPE]: encodePermissionScope(target) });
}

/** A tool reporting the canonical approval targets of `args.path`, like read/write/edit. */
function pathTool(name: string, tier: ToolTier, cwd: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} test tool`,
		parameters: {} as never,
		approval: tier,
		approvalCacheTargets: (args: unknown) =>
			isRecord(args) && typeof args.path === "string" ? [approvalTargetKey(cwd, args.path)!] : undefined,
		execute: async () => ({ content: [{ type: "text" as const, text: "executed" }] }),
	};
}

/** A tool that reports no approval targets, like ast_edit or an extension tool. */
function untargetedTool(name: string, tier: ToolTier): AgentTool {
	return {
		name,
		label: name,
		description: `${name} test tool`,
		parameters: {} as never,
		approval: tier,
		execute: async () => ({ content: [{ type: "text" as const, text: "executed" }] }),
	};
}

function resolveIn(settings: Settings, cwd: string, subject: AgentTool, args: unknown = {}): ResolvedApproval {
	return resolveApproval(subject, args, "yolo", {}, undefined, approvalRestrictions(settings, cwd));
}

let temp: TempDir;
let cwd: string;

beforeEach(() => {
	temp = TempDir.createSync("@omp-active-scope-");
	cwd = fs.realpathSync(temp.path());
	fs.mkdirSync(path.join(cwd, "src"));
	fs.mkdirSync(path.join(cwd, "vault"));
	fs.writeFileSync(path.join(cwd, "src", "a.ts"), "export {};\n");
	fs.writeFileSync(path.join(cwd, "secret.txt"), "hunter2\n");
	fs.writeFileSync(path.join(cwd, ".env"), "TOKEN=hunter2\n");
	fs.symlinkSync(path.join(cwd, "secret.txt"), path.join(cwd, "src", "link"));
	fs.symlinkSync(path.join(cwd, ".env"), path.join(cwd, "notes.txt"));
});

afterEach(() => {
	setCfgApprovalHost(null);
	temp.removeSync();
});

describe("active scope guard", () => {
	it("denies a tool the runtime scope does not list and allows the ones it does", () => {
		const settings = scoped(scope({ tools: ["read"] }));
		expect(resolveIn(settings, cwd, pathTool("read", "read", cwd), { path: "src/a.ts" }).policy).toBe("allow");
		expect(resolveIn(settings, cwd, untargetedTool("bash", "exec"), { command: "ls" })).toEqual({
			policy: "deny",
			tier: "exec",
			override: false,
			source: "permission",
			reason: "BLOCKED: Subagent permission profile does not allow tool 'bash'.",
		});
	});

	it("leaves a session without a scope unrestricted", () => {
		expect(resolveIn(Settings.isolated(), cwd, untargetedTool("bash", "exec")).policy).toBe("allow");
	});

	it("ignores a scope written to the global config", () => {
		const settings = Settings.isolated();
		cfgTaskPermissionsActiveScope.set(settings, encodePermissionScope(scope({ tools: ["read"] })));
		expect(settings.getProvenance(cfgTaskPermissionsActiveScope)).toBe("global");
		expect(resolveIn(settings, cwd, untargetedTool("bash", "exec")).policy).toBe("allow");
	});

	it("ignores a scope from config files on disk, global or project", async () => {
		const agentDir = path.join(cwd, "agent");
		const project = path.join(cwd, "project");
		const encoded = encodePermissionScope(scope({ tools: ["read"] }));
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(project), { recursive: true });
		fs.writeFileSync(
			path.join(getProjectAgentDir(project), "settings.json"),
			JSON.stringify({ task: { permissions: { activeScope: encoded } } }),
		);
		const fromProject = await Settings.loadReadOnly({ cwd: project, agentDir });
		expect(fromProject.getProvenance(cfgTaskPermissionsActiveScope)).toBe("project");
		expect(resolveIn(fromProject, project, untargetedTool("bash", "exec")).policy).toBe("allow");

		fs.writeFileSync(
			path.join(agentDir, "config.yml"),
			YAML.stringify({ task: { permissions: { activeScope: encoded } } }),
		);
		const fromGlobal = await Settings.loadReadOnly({ cwd, agentDir });
		expect(fromGlobal.getProvenance(cfgTaskPermissionsActiveScope)).toBe("global");
		expect(resolveIn(fromGlobal, cwd, untargetedTool("bash", "exec")).policy).toBe("allow");
	});

	it("enforces nothing under suggest or off", () => {
		for (const mode of ["suggest", "off"] as const) {
			const settings = scoped(scope({ mode, tools: ["read"], denyPathGroups: [["vault"]] }));
			expect(resolveIn(settings, cwd, untargetedTool("bash", "exec")).policy).toBe("allow");
			expect(resolveIn(settings, cwd, pathTool("read", "read", cwd), { path: "vault/key" }).policy).toBe("allow");
		}
	});

	it("denies everything but yield when the stored scope cannot be read", () => {
		const tampered = JSON.parse(encodePermissionScope(scope({ tools: ["read"] })));
		tampered.scope.tools = ["read", "bash"];
		for (const value of ["not json", JSON.stringify(tampered), ""]) {
			const settings = Settings.isolated({ [ACTIVE_SCOPE]: value });
			const read = resolveIn(settings, cwd, pathTool("read", "read", cwd), { path: "src/a.ts" });
			expect(read).toMatchObject({ policy: "deny", source: "permission" });
			expect(read.reason).toStartWith("BLOCKED: Subagent permission scope is unreadable");
			expect(resolveIn(settings, cwd, untargetedTool("bash", "exec")).policy).toBe("deny");
			expect(resolveIn(settings, cwd, untargetedTool("yield", "read")).policy).toBe("allow");
		}
	});

	it("replaces an inherited scope completely when a child overrides it, and inherits it otherwise", () => {
		const parentScope = scope({ tools: ["read", "grep"], denyPathGroups: [["vault"]] });
		const childScope = scope({ tools: ["read", "write"] });
		const parent = Settings.isolated().overlay({ [ACTIVE_SCOPE]: encodePermissionScope(parentScope) });
		const child = parent.overlay({ [ACTIVE_SCOPE]: encodePermissionScope(childScope) });
		const grandchild = child.overlay({});

		const grep = untargetedTool("grep", "read");
		const readVault = [pathTool("read", "read", cwd), { path: "vault/key" }] as const;
		expect(resolveIn(parent, cwd, grep, { pattern: "x" }).policy).toBe("allow");
		expect(resolveIn(parent, cwd, ...readVault).policy).toBe("deny");
		for (const settings of [child, grandchild]) {
			expect(cfgTaskPermissionsActiveScope.get(settings)).toBe(encodePermissionScope(childScope));
			expect(settings.getProvenance(cfgTaskPermissionsActiveScope)).toBe("runtime");
			expect(resolveIn(settings, cwd, grep, { pattern: "x" }).policy).toBe("deny");
			expect(resolveIn(settings, cwd, ...readVault).policy).toBe("allow");
		}
	});
});

describe("active scope path targets", () => {
	it("checks the canonical target, so a symlink inside an allowed folder cannot reach outside it", () => {
		const settings = scoped(scope({ tools: ["read", "ast_edit"], allowPathGroups: [["src"]] }));
		expect(resolveIn(settings, cwd, pathTool("read", "read", cwd), { path: "src/a.ts" }).policy).toBe("allow");
		expect(resolveIn(settings, cwd, pathTool("read", "read", cwd), { path: "src/link" })).toMatchObject({
			policy: "deny",
			source: "permission",
			reason: `BLOCKED: Subagent permission profile does not allow path '${path.join(cwd, "secret.txt")}'.`,
		});
		// A tool reporting no targets is checked by the real path of each path argument.
		expect(resolveIn(settings, cwd, untargetedTool("ast_edit", "write"), { path: "src/link" }).policy).toBe("deny");
		expect(resolveIn(settings, cwd, untargetedTool("ast_edit", "write"), { path: "src/a.ts" }).policy).toBe("allow");
	});

	it("applies secrets-blind to the file a link points at", () => {
		const settings = scoped(scope({ tools: ["read"], guardrails: { noNetwork: false, secretsBlind: true } }));
		expect(resolveIn(settings, cwd, pathTool("read", "read", cwd), { path: "src/a.ts" }).policy).toBe("allow");
		expect(resolveIn(settings, cwd, pathTool("read", "read", cwd), { path: "notes.txt" })).toMatchObject({
			policy: "deny",
			source: "permission",
		});
	});

	it("checks the paths a tool binds for restriction, such as task files", () => {
		const settings = scoped(scope({ tools: ["task"], denyPathGroups: [["vault"]] }));
		const task = (file: string): AgentTool => ({
			...untargetedTool("task", "exec"),
			approvalRestrictionPaths: () => [path.join(cwd, file)],
		});
		expect(resolveIn(settings, cwd, task("vault/plan.md")).policy).toBe("deny");
		expect(resolveIn(settings, cwd, task("src/plan.md")).policy).toBe("allow");
	});

	it("matches relative rules from a working directory reached through a symlink", () => {
		const linkedCwd = path.join(cwd, "linked-cwd");
		fs.symlinkSync(cwd, linkedCwd);
		const settings = scoped(scope({ tools: ["read"], allowPathGroups: [["src"]] }));
		expect(resolveIn(settings, linkedCwd, pathTool("read", "read", linkedCwd), { path: "src/a.ts" }).policy).toBe(
			"allow",
		);
		expect(resolveIn(settings, linkedCwd, pathTool("read", "read", linkedCwd), { path: "secret.txt" }).policy).toBe(
			"deny",
		);
	});
});

describe("active scope visibility", () => {
	const session = (settings: Settings) =>
		({ settings, hasUI: true, settingsApproval: true, taskDepth: 0 }) as unknown as ToolSession;
	const handler = new CfgProtocolHandler();

	it("is absent from cfg:// and the settings panel", async () => {
		const settings = scoped(scope({ tools: ["read"] }));
		const tree = await handler.resolve(parseInternalUrl("cfg://task"), { session: session(settings) });
		expect(tree.content).not.toContain("activeScope");
		await expect(
			handler.resolve(parseInternalUrl(`cfg://${ACTIVE_SCOPE}`), { session: session(settings) }),
		).rejects.toThrow("Unknown setting");
		expect((await handler.complete()).map(completion => completion.value)).not.toContain(
			ACTIVE_SCOPE.replaceAll(".", "/"),
		);
		expect(createSettingsHost().entries.map(entry => entry.path)).not.toContain(ACTIVE_SCOPE);
	});

	it("cannot be written through cfg://", async () => {
		const settings = Settings.isolated();
		setCfgApprovalHost({ approve: async () => "once", applied: () => {}, persistentSettings: settings });
		await expect(
			handler.write(parseInternalUrl(`cfg://${ACTIVE_SCOPE}`), encodePermissionScope(scope()), {
				session: session(settings),
			}),
		).rejects.toThrow("Unknown setting");
		expect(settings.isConfigured(cfgTaskPermissionsActiveScope)).toBe(false);
	});
});
