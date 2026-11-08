/**
 * Native edits under a permission scope with path rules or secrets-blind apply against the files the
 * approval guard checked, as they were when the call was authorized (fork 1314b6b62f, "native source
 * snapshots"). A target swapped or rewritten between the full approval gate and the write is refused,
 * not written. The swap runs inside the approval prompt: after the guard, before the tool executes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { PermissionScope } from "@oh-my-pi/pi-coding-agent/task/permissions/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { AstEditTool } from "@oh-my-pi/pi-coding-agent/tools/ast-edit";
import type { EditMode } from "@oh-my-pi/pi-tui/tools/edit";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";
import { enforceScope, scopedSettings } from "./scope-fixtures";

const SECRET_SENTINEL = "SECRET_SENTINEL_7f3a";

let temp: TempDir;
let cwd: string;

beforeEach(() => {
	temp = TempDir.createSync("@omp-edit-source-binding-");
	// Rules and targets compare real paths; the OS temp dir may sit behind a symlink.
	cwd = fs.realpathSync(temp.path());
	fs.mkdirSync(path.join(cwd, "secret"));
	fs.writeFileSync(path.join(cwd, "secret", "key.txt"), `token = 1\n${SECRET_SENTINEL}\n`);
});
afterEach(() => {
	vi.restoreAllMocks();
	temp.removeSync();
});

/** The session's `local://` root: `<artifacts>/local`. */
function localRoot(): string {
	return path.join(cwd, "artifacts", "local");
}

function toolSession(settings: Settings, afterWrite?: (file: string) => void): ToolSession {
	return {
		bumpFileMutationVersion: afterWrite,
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getActiveModelString: () => "openai/gpt-5.6",
		enableLsp: false,
		settings,
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		getSessionId: () => "edit-source-binding",
		getPlanModeState: () => undefined,
	} as unknown as ToolSession;
}

/** A runner whose approval prompt runs `duringApproval` (after the guard, before execute) and approves. */
function approvingRunner(duringApproval: () => void): ExtensionRunner {
	const subject = new ExtensionRunner(
		[],
		new ExtensionRuntime(),
		cwd,
		SessionManager.inMemory(cwd),
		{} as ModelRegistry,
	);
	subject.initialize(
		{} as Parameters<ExtensionRunner["initialize"]>[0],
		{} as Parameters<ExtensionRunner["initialize"]>[1],
		undefined,
		{
			select: async () => {
				duringApproval();
				return "Approve";
			},
		} as unknown as ExtensionUIContext,
	);
	return subject;
}

const DENY_SECRET = enforceScope({ tools: ["edit"], denyPathGroups: [["secret"]] });

function settingsFor(scope: PermissionScope | undefined): Settings {
	const overrides = { "tools.approvalMode": "always-ask", "edit.enforceSeenLines": false };
	return scope ? scopedSettings(scope, overrides) : Settings.isolated(overrides);
}

interface RunOptions {
	readonly scope: PermissionScope | undefined;
	readonly mode?: EditMode;
	readonly params: Record<string, unknown>;
	readonly duringApproval?: () => void;
	/** Stream the arguments through `openArgStream` first, as a streaming provider does. */
	readonly streamed?: boolean;
	/** Runs after each file the edit writes. */
	readonly afterWrite?: (file: string) => void;
}

/** Run one edit through the extension wrapper; a thrown refusal comes back as error text. */
async function runEdit(options: RunOptions): Promise<{ text: string; isError: boolean }> {
	const settings = settingsFor(options.scope);
	const tool = new EditTool(toolSession(settings, options.afterWrite), options.mode ?? "replace");
	const wrapped = new ExtensionToolWrapper(tool, approvingRunner(options.duringApproval ?? (() => {})));
	const callId = "edit-call";
	if (options.streamed) {
		const stream = tool.openArgStream({ toolCallId: callId, emit: () => {} } as never);
		stream.push(JSON.stringify(options.params));
		stream.end(options.params);
	}
	try {
		const result = await wrapped.execute(callId, options.params as never, undefined, undefined, {
			settings,
		} as AgentToolContext);
		return {
			text: result.content.map(part => (part.type === "text" ? part.text : "")).join("\n"),
			isError: result.isError === true,
		};
	} catch (error) {
		return { text: error instanceof Error ? error.message : String(error), isError: true };
	}
}

function read(relative: string): string {
	return fs.readFileSync(path.join(cwd, relative), "utf8");
}

/** Replace `notes.txt` with a symlink to the denied `secret/key.txt`. */
function swapNotesForSecretLink(): void {
	fs.unlinkSync(path.join(cwd, "notes.txt"));
	fs.symlinkSync(path.join(cwd, "secret", "key.txt"), path.join(cwd, "notes.txt"));
}

const REPLACE_TOKEN = { path: "notes.txt", old_string: "token = 1", new_string: "token = 2" };

describe("edit source binding under a permission scope", () => {
	it("refuses, and does not write, a target swapped for a symlink into a denied path after approval", async () => {
		fs.writeFileSync(path.join(cwd, "notes.txt"), "token = 1\n");

		const result = await runEdit({
			scope: DENY_SECRET,
			params: REPLACE_TOKEN,
			duringApproval: swapNotesForSecretLink,
		});

		expect(read("secret/key.txt")).toBe(`token = 1\n${SECRET_SENTINEL}\n`);
		expect(result.isError).toBe(true);
		expect(result.text).toContain("changed after it was approved");
		expect(result.text).not.toContain(SECRET_SENTINEL);
	});

	it("refuses the same swap when the arguments were streamed before approval", async () => {
		fs.writeFileSync(path.join(cwd, "notes.txt"), "token = 1\n");

		const result = await runEdit({
			scope: DENY_SECRET,
			params: REPLACE_TOKEN,
			duringApproval: swapNotesForSecretLink,
			streamed: true,
		});

		expect(read("secret/key.txt")).toBe(`token = 1\n${SECRET_SENTINEL}\n`);
		expect(result.isError).toBe(true);
		expect(result.text).toContain("changed after it was approved");
		expect(result.text).not.toContain(SECRET_SENTINEL);
	});

	it("refuses a target whose content changed in place after approval", async () => {
		const notes = path.join(cwd, "notes.txt");
		fs.writeFileSync(notes, "token = 1\n");
		const inode = fs.statSync(notes).ino;

		const result = await runEdit({
			scope: DENY_SECRET,
			params: REPLACE_TOKEN,
			duringApproval: () => fs.writeFileSync(notes, "token = 1\nextra = 7\n"),
		});

		expect(fs.statSync(notes).ino).toBe(inode);
		expect(read("notes.txt")).toBe("token = 1\nextra = 7\n");
		expect(result.isError).toBe(true);
		expect(result.text).toContain("changed after it was approved");
	});

	it("writes no file of a multi-file edit when one changed in place after approval", async () => {
		fs.writeFileSync(path.join(cwd, "first.txt"), "token = 1\n");
		fs.writeFileSync(path.join(cwd, "second.txt"), "token = 1\n");

		const result = await runEdit({
			scope: DENY_SECRET,
			mode: "apply_patch",
			params: {
				input: [
					"*** Begin Patch",
					...["first.txt", "second.txt"].flatMap(file => [
						`*** Update File: ${file}`,
						"@@",
						"-token = 1",
						"+token = 2",
					]),
					"*** End Patch",
					"",
				].join("\n"),
			},
			duringApproval: () => fs.writeFileSync(path.join(cwd, "second.txt"), "token = 1\nextra = 7\n"),
		});

		expect(result.isError).toBe(true);
		expect(result.text).toContain("second.txt: the file changed after it was approved");
		expect(read("first.txt")).toBe("token = 1\n");
		expect(read("second.txt")).toBe("token = 1\nextra = 7\n");
	});

	it("refuses a later file of the edit swapped for a symlink into a denied path while an earlier one is written", async () => {
		fs.writeFileSync(path.join(cwd, "first.txt"), "token = 1\n");
		fs.writeFileSync(path.join(cwd, "notes.txt"), "token = 1\n");

		const result = await runEdit({
			scope: DENY_SECRET,
			mode: "apply_patch",
			params: {
				input: [
					"*** Begin Patch",
					...["first.txt", "notes.txt"].flatMap(file => [
						`*** Update File: ${file}`,
						"@@",
						"-token = 1",
						"+token = 2",
					]),
					"*** End Patch",
					"",
				].join("\n"),
			},
			afterWrite: file => {
				if (path.basename(file) === "first.txt") swapNotesForSecretLink();
			},
		});

		expect(result.isError).toBe(true);
		expect(result.text).toContain("notes.txt: the file changed after it was approved");
		expect(read("secret/key.txt")).toBe(`token = 1\n${SECRET_SENTINEL}\n`);
		// Files are written one by one; one written before the swap stays written, as without a scope.
		expect(read("first.txt")).toBe("token = 2\n");
	});

	it("refuses a new file whose path became a symlink into a denied path after approval", async () => {
		const result = await runEdit({
			scope: DENY_SECRET,
			mode: "apply_patch",
			params: { input: "*** Begin Patch\n*** Add File: fresh.txt\n+created\n*** End Patch\n" },
			duringApproval: () => fs.symlinkSync(path.join(cwd, "secret", "planted.txt"), path.join(cwd, "fresh.txt")),
		});

		expect(fs.existsSync(path.join(cwd, "secret", "planted.txt"))).toBe(false);
		expect(result.isError).toBe(true);
		expect(result.text).toContain("changed after it was approved");
	});

	it("applies an edit whose target did not change", async () => {
		fs.writeFileSync(path.join(cwd, "notes.txt"), "token = 1\n");

		const result = await runEdit({ scope: DENY_SECRET, params: REPLACE_TOKEN });

		expect(result.isError).toBe(false);
		expect(read("notes.txt")).toBe("token = 2\n");
	});

	it("applies an edit under secrets-blind alone", async () => {
		fs.writeFileSync(path.join(cwd, "notes.txt"), "token = 1\n");
		const scope = enforceScope({ tools: ["edit"], guardrails: { noNetwork: false, secretsBlind: true } });

		const result = await runEdit({ scope, params: REPLACE_TOKEN, streamed: true });

		expect(result.isError).toBe(false);
		expect(read("notes.txt")).toBe("token = 2\n");
	});
});

describe("apply_patch under a permission scope (fork edit-blackbox cases)", () => {
	const patch = (source: string, moveTo?: string): string =>
		[
			"*** Begin Patch",
			`*** Update File: ${source}`,
			...(moveTo ? [`*** Move to: ${moveTo}`] : []),
			"@@",
			"-token = 1",
			"+token = 2",
			"*** End Patch",
			"",
		].join("\n");

	it("denies a source that is a symlink into a denied path, and a denied move destination", async () => {
		fs.symlinkSync(path.join(cwd, "secret", "key.txt"), path.join(cwd, "alias.txt"));
		fs.writeFileSync(path.join(cwd, "allowed.txt"), "token = 1\n");

		const aliased = await runEdit({ scope: DENY_SECRET, mode: "apply_patch", params: { input: patch("alias.txt") } });
		const moved = await runEdit({
			scope: DENY_SECRET,
			mode: "apply_patch",
			params: { input: patch("allowed.txt", "secret/moved.txt") },
		});

		expect(aliased.isError).toBe(true);
		expect(aliased.text).toContain("BLOCKED: Subagent permission profile denied path");
		expect(read("secret/key.txt")).toBe(`token = 1\n${SECRET_SENTINEL}\n`);
		expect(moved.isError).toBe(true);
		expect(moved.text).toContain("BLOCKED: Subagent permission profile denied path");
		expect(read("allowed.txt")).toBe("token = 1\n");
		expect(fs.existsSync(path.join(cwd, "secret", "moved.txt"))).toBe(false);
	});

	it("updates and moves local:// files", async () => {
		fs.mkdirSync(localRoot(), { recursive: true });
		fs.writeFileSync(path.join(localRoot(), "update.txt"), "token = 1\n");
		fs.writeFileSync(path.join(localRoot(), "move.txt"), "token = 1\n");

		const updated = await runEdit({
			scope: DENY_SECRET,
			mode: "apply_patch",
			params: { input: patch("local://update.txt") },
		});
		const moved = await runEdit({
			scope: DENY_SECRET,
			mode: "apply_patch",
			params: { input: patch("local://move.txt", "local://moved.txt") },
		});

		expect(updated.isError).toBe(false);
		expect(fs.readFileSync(path.join(localRoot(), "update.txt"), "utf8")).toBe("token = 2\n");
		expect(moved.isError).toBe(false);
		expect(fs.readFileSync(path.join(localRoot(), "moved.txt"), "utf8")).toBe("token = 2\n");
		expect(fs.existsSync(path.join(localRoot(), "move.txt"))).toBe(false);
	});

	it("stages nothing from, and writes nothing beside, a target swapped while the edit is applied", async () => {
		fs.mkdirSync(localRoot(), { recursive: true });
		fs.writeFileSync(path.join(localRoot(), "scratch.txt"), "token = 1\n");
		fs.writeFileSync(path.join(cwd, "notes.txt"), "token = 1\n");
		// The native apply resolves URL targets through the host before it stages anything: swap then.
		const router = InternalUrlRouter.instance();
		const locate = router.locate.bind(router);
		let swapped = false;
		vi.spyOn(router, "locate").mockImplementation(async (...args) => {
			if (!swapped) {
				swapped = true;
				swapNotesForSecretLink();
			}
			return locate(...args);
		});

		const result = await runEdit({
			scope: DENY_SECRET,
			mode: "apply_patch",
			params: {
				input: [
					"*** Begin Patch",
					...["local://scratch.txt", "notes.txt"].flatMap(file => [
						`*** Update File: ${file}`,
						"@@",
						"-token = 1",
						"+token = 2",
					]),
					"*** End Patch",
					"",
				].join("\n"),
			},
		});

		expect(swapped).toBe(true);
		expect(result.isError).toBe(true);
		expect(result.text).toContain("notes.txt: the file changed after it was approved");
		expect(result.text).not.toContain(SECRET_SENTINEL);
		expect(fs.readFileSync(path.join(localRoot(), "scratch.txt"), "utf8")).toBe("token = 1\n");
		expect(read("secret/key.txt")).toBe(`token = 1\n${SECRET_SENTINEL}\n`);
	});

	it("moves, updates and creates files the scope allows", async () => {
		fs.writeFileSync(path.join(cwd, "source.txt"), "token = 1\n");

		const moved = await runEdit({
			scope: DENY_SECRET,
			mode: "apply_patch",
			params: { input: patch("source.txt", "moved.txt") },
		});
		const created = await runEdit({
			scope: DENY_SECRET,
			mode: "apply_patch",
			params: { input: "*** Begin Patch\n*** Add File: nested/created.txt\n+created\n*** End Patch\n" },
		});

		expect(moved.isError).toBe(false);
		expect(read("moved.txt")).toBe("token = 2\n");
		expect(fs.existsSync(path.join(cwd, "source.txt"))).toBe(false);
		expect(created.isError).toBe(false);
		expect(read("nested/created.txt")).toBe("created\n");
	});
});

describe("edit without a permission scope", () => {
	it("still applies against the file as it is when the edit runs", async () => {
		const notes = path.join(cwd, "notes.txt");
		fs.writeFileSync(notes, "token = 1\n");

		const result = await runEdit({
			scope: undefined,
			params: REPLACE_TOKEN,
			duringApproval: () => fs.writeFileSync(notes, "token = 1\nextra = 7\n"),
		});

		expect(result.isError).toBe(false);
		expect(read("notes.txt")).toBe("token = 2\nextra = 7\n");
	});
});

describe("ast_edit preview and apply under a permission scope", () => {
	const REWRITE = { ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }], paths: ["app.ts"] };

	/** Preview `REWRITE` under `scope`, run `betweenPreviewAndApply`, then apply through `resolve`. */
	async function previewThenApply(scope: PermissionScope, betweenPreviewAndApply: () => void): Promise<string> {
		const pending: Array<(input: unknown) => Promise<AgentToolResult<unknown>>> = [];
		const tool = new AstEditTool({
			...toolSession(scopedSettings(scope)),
			modelRegistry: new ModelRegistry(createInMemoryAuthStorage()),
			getToolChoiceQueue: () =>
				({
					registerPendingInvoker: (
						_id: string,
						_tool: string,
						invoke: (input: unknown) => Promise<AgentToolResult<unknown>>,
					) => pending.push(invoke),
					removePendingInvoker: () => {},
				}) as never,
		} as ToolSession);
		await tool.execute("ast-edit-preview", REWRITE);
		expect(pending).toHaveLength(1);
		betweenPreviewAndApply();
		try {
			const result = await pending[0]!({ action: "apply", reason: "apply the preview" });
			return result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	}

	it("refuses to apply after the previewed file was swapped for a symlink into a denied path", async () => {
		fs.writeFileSync(path.join(cwd, "app.ts"), "legacyWrap(a, b);\n");
		const secret = path.join(cwd, "secret", "keys.ts");
		fs.writeFileSync(secret, `legacyWrap(a, b);\n// ${SECRET_SENTINEL}\n`);

		const output = await previewThenApply(DENY_SECRET, () => {
			fs.unlinkSync(path.join(cwd, "app.ts"));
			fs.symlinkSync(secret, path.join(cwd, "app.ts"));
		});

		expect(fs.readFileSync(secret, "utf8")).toBe(`legacyWrap(a, b);\n// ${SECRET_SENTINEL}\n`);
		expect(output).toContain("changed after it was approved");
	});

	it("refuses a same-inode source change even when rewrite counts are unchanged (fork ast-edit case)", async () => {
		const source = path.join(cwd, "app.ts");
		fs.writeFileSync(source, "legacyWrap(a, b);\n");
		const inode = fs.statSync(source).ino;

		const output = await previewThenApply(DENY_SECRET, () => fs.writeFileSync(source, "legacyWrap(c, d);\n"));

		expect(fs.statSync(source).ino).toBe(inode);
		expect(read("app.ts")).toBe("legacyWrap(c, d);\n");
		expect(output).toContain("changed after it was approved");
	});

	it("applies a preview whose file did not change", async () => {
		fs.writeFileSync(path.join(cwd, "app.ts"), "legacyWrap(a, b);\n");

		const output = await previewThenApply(DENY_SECRET, () => {});

		expect(output).toContain("Applied 1 replacement in 1 file.");
		expect(read("app.ts")).toBe("modernWrap(a, b);\n");
	});
});
