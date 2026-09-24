import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool, getEditStore, type PatchParams } from "@oh-my-pi/pi-coding-agent/edit";
import { SessionPathScope } from "@oh-my-pi/pi-coding-agent/internal/session-path-scope";
import { resolveLocalRoot } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { planLocalProtocolOptions } from "@oh-my-pi/pi-coding-agent/tools/plan-mode-guard";
import {
	installSessionOperationLedger,
	markUnregisteredSessionOperationProjection,
	runFilesystemOperation,
} from "@oh-my-pi/pi-coding-agent/registry/operation-lease";
import type { EffectiveSubagentPermissions } from "@oh-my-pi/pi-coding-agent/task/permission-profiles";
import { formatHashlineHeader } from "@oh-my-pi/pi-tui/tools/hashline-format";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { EditMode } from "@oh-my-pi/pi-tui/tools/edit";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const MODEL = "openai/gpt-5.6";
const SOURCE = "export function value(): number {\n\treturn 1;\n}\n";

function makeSession(cwd: string, settings: Settings): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getActiveModelString: () => MODEL,
		enableLsp: false,
		settings,
		getArtifactsDir: () => null,
		getSessionId: () => null,
		getPlanModeState: () => undefined,
	} as unknown as ToolSession;
}

let tempDir: string;
let agentDir: string;
let logPath: string;
let settings: Settings;
let session: ToolSession;

beforeEach(async () => {
	resetSettingsForTest();
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-edit-blackbox-"));
	agentDir = path.join(tempDir, "agent");
	logPath = path.join(agentDir, "edit-blackbox.jsonl");
	await fs.mkdir(agentDir, { recursive: true });
	settings = await Settings.loadIsolated({
		cwd: tempDir,
		agentDir,
		inMemory: true,
		overrides: { "edit.enforceSeenLines": false, "edit.blackbox.enabled": true },
	});
	session = makeSession(tempDir, settings);
});

afterEach(async () => {
	resetSettingsForTest();
	await removeWithRetries(tempDir);
});

async function writeFixture(name: string): Promise<string> {
	const absolutePath = path.join(tempDir, name);
	await Bun.write(absolutePath, SOURCE);
	return absolutePath;
}

describe("edit parse-regression blackbox", () => {
	test("is disabled by default", async () => {
		const disabledSettings = await Settings.loadIsolated({
			cwd: tempDir,
			agentDir,
			inMemory: true,
			overrides: { "edit.enforceSeenLines": false },
		});
		const disabledSession = makeSession(tempDir, disabledSettings);
		const filePath = await writeFixture("disabled.ts");

		const result = await new EditTool(disabledSession, "replace").execute("disabled", {
			path: "disabled.ts",
			old_string: "return 1;",
			new_string: "return (;",
		});

		expect(await Bun.file(filePath).text()).toContain("return (;");
		expect(await Bun.file(logPath).exists()).toBe(false);
		// The parse-regression warning is independent of blackbox recording.
		const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
		expect(text).toMatch(/no longer parses after this edit/);
	});
	test("does not warn when the edit keeps the file parsing", async () => {
		await writeFixture("clean.ts");

		const result = await new EditTool(session, "replace").execute("clean", {
			path: "clean.ts",
			old_string: "return 1;",
			new_string: "return 2;",
		});

		const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
		expect(text).not.toMatch(/no longer parses/);
	});

	test("appends valid-to-invalid transitions from every edit variant", async () => {
		await fs.appendFile(logPath, '{"seed":true}\n');
		const expected: Array<{
			prev: string;
			new: string;
			model: string;
			variant: EditMode;
			arg: unknown;
		}> = [];

		const replacePath = await writeFixture("replace.ts");
		const replaceArg = { path: "replace.ts", old_string: "return 1;", new_string: "return (;" };
		await new EditTool(session, "replace").execute("replace", replaceArg);
		expected.push({
			prev: SOURCE,
			new: await Bun.file(replacePath).text(),
			model: MODEL,
			variant: "replace",
			arg: replaceArg,
		});

		const patchPath = await writeFixture("patch.ts");
		const patchArg = {
			path: "patch.ts",
			edits: [{ op: "update", diff: "@@\n-\treturn 1;\n+\treturn (;" }],
		} satisfies PatchParams;
		await new EditTool(session, "patch").execute("patch", patchArg);
		expected.push({
			prev: SOURCE,
			new: await Bun.file(patchPath).text(),
			model: MODEL,
			variant: "patch",
			arg: patchArg,
		});

		const applyPatchPath = await writeFixture("apply-patch.ts");
		const applyPatchArg = {
			input: [
				"*** Begin Patch",
				"*** Update File: apply-patch.ts",
				"@@",
				"-\treturn 1;",
				"+\treturn (;",
				"*** End Patch",
				"",
			].join("\n"),
		};
		await new EditTool(session, "apply_patch").execute("apply-patch", applyPatchArg);
		expected.push({
			prev: SOURCE,
			new: await Bun.file(applyPatchPath).text(),
			model: MODEL,
			variant: "apply_patch",
			arg: applyPatchArg,
		});

		const hashlinePath = await writeFixture("hashline.ts");
		const tag = getEditStore(session).recordSnapshot(hashlinePath, SOURCE, undefined);
		const hashlineArg = {
			input: `${formatHashlineHeader("hashline.ts", tag)}\nPUT 2-2:\n+\treturn (;`,
		};
		await new EditTool(session, "hashline").execute("hashline", hashlineArg);
		expected.push({
			prev: SOURCE,
			new: await Bun.file(hashlinePath).text(),
			model: MODEL,
			variant: "hashline",
			arg: hashlineArg,
		});

		const sloppyPath = await writeFixture("sloppy.ts");
		const sloppyArg = {
			input: "*** SM:EDIT sloppy.ts\n*** SM:FIND\n\treturn 1;\n*** SM:PUT\n\treturn (;",
		};
		await new EditTool(session, "sloppy").execute("sloppy", sloppyArg);
		expected.push({
			prev: SOURCE,
			new: await Bun.file(sloppyPath).text(),
			model: MODEL,
			variant: "sloppy",
			arg: sloppyArg,
		});

		const lines = (await Bun.file(logPath).text()).trimEnd().split("\n");
		expect(JSON.parse(lines[0])).toEqual({ seed: true });
		expect(lines.slice(1).map(line => JSON.parse(line))).toEqual(expected);
	});

	test("does not record valid or already-invalid transitions", async () => {
		await writeFixture("valid.ts");
		await new EditTool(session, "replace").execute("valid", {
			path: "valid.ts",
			old_string: "return 1;",
			new_string: "return 2;",
		});

		await Bun.write(path.join(tempDir, "invalid.ts"), "export const value = (;\n");
		await new EditTool(session, "replace").execute("already-invalid", {
			path: "invalid.ts",
			old_string: "value",
			new_string: "next",
		});

		expect(await Bun.file(logPath).exists()).toBe(false);
	});

	test("treats an empty supported source as parseable", async () => {
		await writeFixture("empty.ts");
		await new EditTool(session, "replace").execute("empty", {
			path: "empty.ts",
			old_string: SOURCE,
			new_string: "",
		});

		expect(await Bun.file(path.join(tempDir, "empty.ts")).text()).toBe("");
		expect(await Bun.file(logPath).exists()).toBe(false);
	});

	test("authorizes parsed apply-patch sources and move destinations before reads or effects", async () => {
		const deniedSourcePath = await writeFixture("denied-source.ts");
		const sourceAliasPath = path.join(tempDir, "source-alias.ts");
		await fs.symlink(deniedSourcePath, sourceAliasPath);
		const allowedSourcePath = await writeFixture("allowed-source.ts");
		const deniedDestinationPath = path.join(tempDir, "denied-destination.ts");
		const allowedDestinationPath = path.join(tempDir, "allowed-moved.ts");

		const operationManager = {};
		const ledger = installSessionOperationLedger(operationManager);
		markUnregisteredSessionOperationProjection(operationManager, false);
		const permissions: EffectiveSubagentPermissions = {
			mode: "enforce",
			toolsEnabled: false,
			pathsEnabled: true,
			actorId: "edit-blackbox",
			actorKind: "sub",
			profiles: [],
			denyTools: [],
			allowPaths: [path.join(tempDir, "allowed-*")],
			denyPaths: [deniedSourcePath, deniedDestinationPath],
		};
		const pathScope = new SessionPathScope({
			actorId: () => "edit-blackbox",
			sessionId: () => "edit-blackbox-session",
			operationManager: () => operationManager,
			cwd: () => tempDir,
			permissionScope: () => permissions,
		});
		const scopedSession = { ...session, pathScope } as ToolSession;
		const applyPatch = (source: string, moveTo?: string) =>
			[
				"*** Begin Patch",
				`*** Update File: ${source}`,
				...(moveTo ? [`*** Move to: ${moveTo}`] : []),
				"@@",
				"-\treturn 1;",
				"+\treturn 2;",
				"*** End Patch",
				"",
			].join("\n");
		const runPatch = async (operationId: string, input: string) => {
			try {
				const result = await runFilesystemOperation(operationManager, operationId, () =>
					pathScope.withOperationLease(operationId, () =>
						new EditTool(scopedSession, "apply_patch").execute(operationId, { input }),
					),
				);
				return {
					isError: result.isError === true,
					text: result.content.map(part => (part.type === "text" ? part.text : "")).join("\n"),
				};
			} catch (error) {
				return { isError: true, text: error instanceof Error ? error.message : String(error) };
			}
		};

		try {
			await fs.chmod(deniedSourcePath, 0);
			const deniedSource = await runPatch("edit:denied-source", applyPatch("source-alias.ts"));
			expect(deniedSource.isError).toBe(true);
			expect(deniedSource.text).toContain("BLOCKED: Subagent permission profile denied path");
			expect(deniedSource.text).toContain(deniedSourcePath);
			await fs.chmod(deniedSourcePath, 0o600);
			expect(await Bun.file(deniedSourcePath).text()).toBe(SOURCE);

			await fs.chmod(allowedSourcePath, 0);
			const deniedDestination = await runPatch(
				"edit:denied-move-destination",
				applyPatch("allowed-source.ts", "denied-destination.ts"),
			);
			expect(deniedDestination.isError).toBe(true);
			expect(deniedDestination.text).toContain("BLOCKED: Subagent permission profile denied path");
			expect(deniedDestination.text).toContain(deniedDestinationPath);
			await fs.chmod(allowedSourcePath, 0o600);
			expect(await Bun.file(allowedSourcePath).text()).toBe(SOURCE);
			expect(await Bun.file(deniedDestinationPath).exists()).toBe(false);

			const allowedMove = await runPatch("edit:allowed-move", applyPatch("allowed-source.ts", "allowed-moved.ts"));
			expect(allowedMove.isError).toBe(false);
			expect(await Bun.file(allowedDestinationPath).text()).toBe(SOURCE.replace("return 1;", "return 2;"));
			expect(await Bun.file(allowedSourcePath).exists()).toBe(false);
			const allowedCreate = await runPatch(
				"edit:allowed-create",
				["*** Begin Patch", "*** Add File: allowed-created.ts", "+created", "*** End Patch", ""].join("\n"),
			);
			expect(allowedCreate.isError).toBe(false);
			expect(await Bun.file(path.join(tempDir, "allowed-created.ts")).text()).toBe("created\n");
		} finally {
			const deniedSourceExists = await Bun.file(deniedSourcePath).exists();
			if (deniedSourceExists) await fs.chmod(deniedSourcePath, 0o600);
			const allowedSourceExists = await Bun.file(allowedSourcePath).exists();
			if (allowedSourceExists) await fs.chmod(allowedSourcePath, 0o600);
			await ledger.close();
		}
	});

	test("preflights local:// updates and moves against the configured sandbox", async () => {
		const artifactsDir = path.join(tempDir, "local-artifacts");
		await fs.mkdir(artifactsDir, { recursive: true });
		const localSession = { ...session, getArtifactsDir: () => artifactsDir } as ToolSession;
		const localRoot = path.resolve(resolveLocalRoot(planLocalProtocolOptions(localSession)));
		await fs.mkdir(localRoot, { recursive: true });

		const allowedUpdatePath = path.join(localRoot, "allowed-update.ts");
		const allowedMoveSourcePath = path.join(localRoot, "allowed-move-source.ts");
		const deniedMoveSourcePath = path.join(localRoot, "allowed-denied-move-source.ts");
		const allowedMoveDestinationPath = path.join(localRoot, "allowed-move-destination.ts");
		const deniedMoveDestinationPath = path.join(localRoot, "denied-move-destination.ts");
		const colonPath = path.join(tempDir, "allowed:notes.ts");
		await fs.writeFile(allowedUpdatePath, SOURCE);
		await fs.writeFile(allowedMoveSourcePath, SOURCE);
		await fs.writeFile(deniedMoveSourcePath, SOURCE);
		await fs.writeFile(colonPath, SOURCE);

		const operationManager = {};
		const ledger = installSessionOperationLedger(operationManager);
		markUnregisteredSessionOperationProjection(operationManager, false);
		const permissions: EffectiveSubagentPermissions = {
			mode: "enforce",
			toolsEnabled: false,
			pathsEnabled: true,
			actorId: "edit-blackbox",
			actorKind: "sub",
			profiles: [],
			denyTools: [],
			allowPaths: [path.join(localRoot, "allowed-*"), colonPath],
			denyPaths: [deniedMoveDestinationPath],
		};
		const pathScope = new SessionPathScope({
			actorId: () => "edit-blackbox",
			sessionId: () => "edit-blackbox-session",
			operationManager: () => operationManager,
			cwd: () => tempDir,
			permissionScope: () => permissions,
		});
		const scopedSession = { ...localSession, pathScope } as ToolSession;
		const applyPatch = (source: string, moveTo?: string) =>
			[
				"*** Begin Patch",
				`*** Update File: ${source}`,
				...(moveTo ? [`*** Move to: ${moveTo}`] : []),
				"@@",
				"-\treturn 1;",
				"+\treturn 2;",
				"*** End Patch",
			].join("\n");
		const runPatch = async (operationId: string, input: string) => {
			try {
				const result = await runFilesystemOperation(operationManager, operationId, () =>
					pathScope.withOperationLease(operationId, () =>
						new EditTool(scopedSession, "apply_patch").execute(operationId, { input }),
					),
				);
				return {
					isError: result.isError === true,
					text: result.content.map(part => (part.type === "text" ? part.text : "")).join("\n"),
				};
			} catch (error) {
				return { isError: true, text: error instanceof Error ? error.message : String(error) };
			}
		};
		try {
			const update = await runPatch("edit:local-update", applyPatch("local://allowed-update.ts"));
			expect(update.isError).toBe(false);
			expect(await Bun.file(allowedUpdatePath).text()).toBe(SOURCE.replace("return 1;", "return 2;"));

			const colonUpdate = await runPatch("edit:colon-filename", applyPatch("allowed:notes.ts"));
			expect(colonUpdate.isError).toBe(false);
			expect(await Bun.file(colonPath).text()).toBe(SOURCE.replace("return 1;", "return 2;"));

			const allowedMove = await runPatch(
				"edit:local-allowed-move",
				applyPatch("local://allowed-move-source.ts", "local://allowed-move-destination.ts"),
			);
			expect(allowedMove.isError).toBe(false);
			expect(await Bun.file(allowedMoveDestinationPath).text()).toBe(SOURCE.replace("return 1;", "return 2;"));
			expect(await Bun.file(allowedMoveSourcePath).exists()).toBe(false);

			const deniedMove = await runPatch(
				"edit:local-denied-move",
				applyPatch("local://allowed-denied-move-source.ts", "local://denied-move-destination.ts"),
			);
			expect(deniedMove.isError).toBe(true);
			expect(deniedMove.text).toContain("BLOCKED: Subagent permission profile denied path");
			expect(deniedMove.text).toContain(deniedMoveDestinationPath);
			expect(await Bun.file(deniedMoveSourcePath).text()).toBe(SOURCE);
			expect(await Bun.file(deniedMoveDestinationPath).exists()).toBe(false);
		} finally {
			await ledger.close();
		}
	});

	test("uses the authorized source snapshot after a symlink is swapped", async () => {
		const allowedSourcePath = await writeFixture("allowed-source.ts");
		const deniedSourcePath = path.join(tempDir, "denied-source.ts");
		const deniedContent = `DENIED_CONTENT_SENTINEL\n${SOURCE}`;
		await fs.writeFile(deniedSourcePath, deniedContent);
		const sourceAliasPath = path.join(tempDir, "allowed-alias.ts");
		await fs.symlink(allowedSourcePath, sourceAliasPath);

		const operationManager = {};
		const ledger = installSessionOperationLedger(operationManager);
		markUnregisteredSessionOperationProjection(operationManager, false);
		const permissions: EffectiveSubagentPermissions = {
			mode: "enforce",
			toolsEnabled: false,
			pathsEnabled: true,
			actorId: "edit-blackbox",
			actorKind: "sub",
			profiles: [],
			denyTools: [],
			allowPaths: [path.join(tempDir, "allowed-*")],
			denyPaths: [deniedSourcePath],
		};
		const pathScope = new SessionPathScope({
			actorId: () => "edit-blackbox",
			sessionId: () => "edit-blackbox-session",
			operationManager: () => operationManager,
			cwd: () => tempDir,
			permissionScope: () => permissions,
		});
		const scopedSession = { ...session, pathScope } as ToolSession;
		const operationId = "edit:source-alias-swap";
		let aliasSwapped = false;
		try {
			const result = await runFilesystemOperation(operationManager, operationId, () =>
				pathScope.withOperationLease(operationId, async () => {
					const operation = pathScope.currentOperation();
					const originalOpenRead = operation.openRead.bind(operation);
					operation.openRead = async (target, resourceClass) => {
						if (!aliasSwapped && target.canonicalTarget === allowedSourcePath) {
							await fs.unlink(sourceAliasPath);
							await fs.symlink(deniedSourcePath, sourceAliasPath);
							aliasSwapped = true;
						}
						return originalOpenRead(target, resourceClass);
					};
					try {
						return await new EditTool(scopedSession, "replace").execute(operationId, {
							path: "allowed-alias.ts",
							old_string: "return 1;",
							new_string: "return 2;",
						});
					} finally {
						operation.openRead = originalOpenRead;
					}
				}),
			);
			expect(aliasSwapped).toBe(true);
			expect(result.isError).not.toBe(true);
			expect(await Bun.file(allowedSourcePath).text()).toBe(SOURCE.replace("return 1;", "return 2;"));
			expect(await Bun.file(deniedSourcePath).text()).toBe(deniedContent);
			expect(result.content.map(part => (part.type === "text" ? part.text : "")).join("\n")).not.toContain(
				"DENIED_CONTENT_SENTINEL",
			);
		} finally {
			await ledger.close();
		}
	});

	test("rejects same-inode content changes before applying a scoped edit", async () => {
		const sourcePath = await writeFixture("allowed-stale.ts");
		const concurrentlyWritten = SOURCE.replace("return 1;", "return 7;");
		const operationManager = {};
		const ledger = installSessionOperationLedger(operationManager);
		markUnregisteredSessionOperationProjection(operationManager, false);
		const permissions: EffectiveSubagentPermissions = {
			mode: "enforce",
			toolsEnabled: false,
			pathsEnabled: true,
			actorId: "edit-blackbox",
			actorKind: "sub",
			profiles: [],
			denyTools: [],
			allowPaths: [path.join(tempDir, "allowed-*")],
			denyPaths: [],
		};
		const pathScope = new SessionPathScope({
			actorId: () => "edit-blackbox",
			sessionId: () => "edit-blackbox-session",
			operationManager: () => operationManager,
			cwd: () => tempDir,
			permissionScope: () => permissions,
		});
		const scopedSession = { ...session, pathScope } as ToolSession;
		const operationId = "edit:stale-source";
		let changedDuringSnapshot = false;
		let rejected = false;
		try {
			try {
				const outcome = await runFilesystemOperation(operationManager, operationId, () =>
					pathScope.withOperationLease(operationId, async () => {
						const operation = pathScope.currentOperation();
						const originalOpenRead = operation.openRead.bind(operation);
						operation.openRead = async (target, resourceClass) => {
							const handle = await originalOpenRead(target, resourceClass);
							if (!changedDuringSnapshot && target.canonicalTarget === sourcePath) {
								const readFile = handle.readFile.bind(handle);
								handle.readFile = (async () => {
									const bytes = await readFile();
									const writeHandle = await fs.open(sourcePath, "r+");
									try {
										await writeHandle.truncate(0);
										await writeHandle.writeFile(concurrentlyWritten);
									} finally {
										await writeHandle.close();
									}
									changedDuringSnapshot = true;
									return bytes;
								}) as typeof handle.readFile;
							}
							return handle;
						};
						try {
							return await new EditTool(scopedSession, "replace").execute(operationId, {
								path: "allowed-stale.ts",
								old_string: "return 1;",
								new_string: "return 2;",
							});
						} finally {
							operation.openRead = originalOpenRead;
						}
					}),
				);
				rejected = outcome.isError === true;
			} catch {
				rejected = true;
			}
			expect(changedDuringSnapshot).toBe(true);
			expect(rejected).toBe(true);
			expect(await Bun.file(sourcePath).text()).toBe(concurrentlyWritten);
		} finally {
			await ledger.close();
		}
	});
});
