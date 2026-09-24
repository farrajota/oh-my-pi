import { mkdir } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
	AgentTool,
	AgentToolArgStream,
	AgentToolArgStreamInit,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@oh-my-pi/pi-agent-core";
import type { Model, ToolExample } from "@oh-my-pi/pi-ai";
import {
	EditSession,
	editDescription,
	editGrammar,
	editInspect,
	type EditFileOutcome,
	type EditInspection,
	type EditPolicy,
	type EditSourceSnapshot,
	type EditWriteRequest,
	type EditWriteResponse,
} from "@oh-my-pi/pi-natives";
import { isEnoent, logger, prompt } from "@oh-my-pi/pi-utils";
import { resolveLocalRoot } from "../internal-urls";
import { cachedVaultRoots, isVaultEnabled } from "../internal-urls/vault-protocol";
import { createLspWritethrough, flushLspWritethroughBatch, type WritethroughCallback, writethroughNoop } from "../lsp";
import { type FileDiagnosticsResult } from "@oh-my-pi/pi-tui/tools/lsp";
import { FileChangeType, notifyWorkspaceWatchedFiles } from "../lsp/client";
import { DeferredDiagnostics } from "../lsp/deferred-diagnostics";
import { getDiagnosticsLedger } from "../lsp/diagnostics-ledger";
import type { ToolSession } from "../tools";
import type { AuthorizedFilesystemTarget, FilesystemOperation } from "../internal/session-path-scope";
import { routeWriteThroughBridge } from "../tools/acp-bridge";
import { truncateForPrompt } from "../tools/approval";
import {
	deleteFileWithFallback,
	hasFileWriteFallback,
	isPermissionDeniedError,
	writeFileWithFallback,
} from "../tools/file-write-fallback";
import {
	invalidateFsScanAfterDelete,
	invalidateFsScanAfterRename,
	invalidateFsScanAfterWrite,
} from "../tools/fs-cache-invalidation";
import { outputMeta } from "../tools/output-meta";
import { resolveFileWriteApprovalTier } from "../tools/path-utils";
import { planLocalProtocolOptions } from "../tools/plan-mode-guard";
import { throwIfAborted } from "../tools/tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { type EditMode } from "@oh-my-pi/pi-tui/tools/edit";
import { normalizeEditMode, resolveEditMode } from "../utils/edit-mode";
import { attemptEditAutoRepair, type EditAutoRepairOutcome } from "./auto-repair";
import { type AppliedEditSnapshot, createEditBlackboxRecorder } from "./blackbox";
import hashlineCompactPrompt from "./hashline-compact.md" with { type: "text" };
import { getLspBatchRequest } from "../lsp/batch";
import { type EditToolDetails, type EditToolPerFileResult, type Operation } from "@oh-my-pi/pi-tui/tools/edit";
import {
	type ApplyPatchParams,
	applyPatchSchema,
	type HashlineParams,
	hashlineEditParamsSchema,
	type PatchParams,
	patchEditSchema,
	type ReplaceBatchParams,
	type ReplaceParams,
	replaceEditSchema,
	type SloppyParams,
	sloppyEditSchema,
} from "./schemas";
import { getEditStore } from "./store";

export type {
	EditRenderContext,
	EditToolDetails,
	EditToolPerFileResult,
	Operation,
	PerFileDiffPreview,
} from "@oh-my-pi/pi-tui/tools/edit";
export * from "./schemas";
export * from "./store";
export { DEFAULT_EDIT_MODE, normalizeEditMode } from "../utils/edit-mode";
export { type EditMode } from "@oh-my-pi/pi-tui/tools/edit";

type TInput =
	| typeof replaceEditSchema
	| typeof patchEditSchema
	| typeof hashlineEditParamsSchema
	| typeof applyPatchSchema
	| typeof sloppyEditSchema;

type EditParams = ReplaceParams | ReplaceBatchParams | PatchParams | HashlineParams | ApplyPatchParams | SloppyParams;

const PATCH_EXAMPLES = [
	{
		caption: "Create",
		call: { path: "hello.txt", edits: [{ op: "create", diff: "Hello\n" }] },
	},
	{
		caption: "Update",
		call: {
			path: "src/app.py",
			edits: [{ op: "update", diff: "@@ def greet():\n def greet():\n-print('Hi')\n+print('Hello')\n" }],
		},
	},
	{
		caption: "Rename",
		call: {
			path: "src/app.py",
			edits: [{ op: "update", rename: "src/main.py", diff: "@@\n …\n" }],
		},
	},
	{
		caption: "Delete",
		call: { path: "obsolete.txt", edits: [{ op: "delete" }] },
	},
	{
		caption: "Multiple entries",
		note: "All entries in one call apply to the top-level `path`; use separate calls for different files.",
	},
] satisfies readonly ToolExample<PatchParams>[];

const APPLY_PATCH_EXAMPLES = [
	{
		caption: "Apply a combined patch file",
		call: {
			input: '*** Begin Patch\n*** Add File: hello.txt\n+Hello world\n*** Update File: src/app.py\n*** Move to: src/main.py\n@@ def greet():\n-print("Hi")\n+print("Hello, world!")\n*** Delete File: obsolete.txt\n*** End Patch\n',
		},
	},
] satisfies readonly ToolExample<ApplyPatchParams>[];

function resolveConfiguredEditMode(rawEditMode: string): EditMode | undefined {
	if (!rawEditMode || rawEditMode === "auto") return undefined;
	const editMode = normalizeEditMode(rawEditMode);
	if (!editMode) throw new Error(`Invalid PI_EDIT_VARIANT: ${rawEditMode}`);
	return editMode;
}

/**
 * Compact tool description markdown for `mode`, when one exists. TS-side
 * source (not the native addon) so PR CI — which tests against the latest
 * *release* addons — exercises the same rendering production does.
 */
export function editDescriptionCompact(mode: EditMode): string | undefined {
	switch (mode) {
		case "hashline":
			return hashlineCompactPrompt;
		default:
			return undefined;
	}
}

/**
 * Tool description for `mode`, at the density the model's catalog policy
 * selects (`edit-prompt-variant`). Models without the compact variant — or
 * modes that have none — keep the full prompt; both renderings preserve every
 * operation and invariant.
 */
export function resolveEditToolDescription(
	mode: EditMode,
	model: Pick<Model, "editPromptVariant"> | undefined,
): string {
	const source =
		model?.editPromptVariant === "compact"
			? (editDescriptionCompact(mode) ?? editDescription(mode))
			: editDescription(mode);
	return prompt.render(source);
}

function resolveAllowFuzzy(session: ToolSession, rawValue: string): boolean {
	switch (rawValue) {
		case "true":
		case "1":
			return true;
		case "false":
		case "0":
			return false;
		case "auto":
			return session.settings.get("edit.fuzzyMatch");
		default:
			throw new Error(`Invalid PI_EDIT_FUZZY: ${rawValue}`);
	}
}

function resolveFuzzyThreshold(session: ToolSession, rawValue: string): number {
	if (rawValue === "auto") return session.settings.get("edit.fuzzyThreshold");
	const threshold = Number.parseFloat(rawValue);
	if (Number.isNaN(threshold) || threshold < 0 || threshold > 1) {
		throw new Error(`Invalid PI_EDIT_FUZZY_THRESHOLD: ${rawValue}`);
	}
	return threshold;
}

function createEditWritethrough(session: ToolSession): WritethroughCallback {
	const enableLsp = session.enableLsp ?? true;
	const enableDiagnostics = enableLsp && session.settings.get("lsp.diagnosticsOnEdit");
	const enableFormat = enableLsp && session.settings.get("lsp.formatOnWrite");
	const deduplicate = enableDiagnostics && session.settings.get("lsp.diagnosticsDeduplicate");
	return enableLsp
		? createLspWritethrough(session.cwd, {
				enableFormat,
				enableDiagnostics,
				transformDiagnostics: deduplicate
					? (filePath, result) => getDiagnosticsLedger(session).reduce(filePath, result)
					: undefined,
			})
		: writethroughNoop;
}

function operationFromNative(op: string): Operation | undefined {
	return op === "create" || op === "delete" || op === "update" ? op : undefined;
}

function parseDiagnostics(json: string | undefined): FileDiagnosticsResult | undefined {
	if (!json) return undefined;
	try {
		return JSON.parse(json) as FileDiagnosticsResult;
	} catch {
		return undefined;
	}
}

function mergeDiagnosticsWithWarnings(
	diagnostics: FileDiagnosticsResult | undefined,
	warnings: readonly string[],
): FileDiagnosticsResult | undefined {
	if (warnings.length === 0) return diagnostics;
	const warningMessages = warnings.map(warning => `patch: ${warning}`);
	if (!diagnostics) {
		return {
			server: "patch",
			messages: warningMessages,
			summary: `Patch warnings: ${warnings.length}`,
			errored: false,
		};
	}
	return {
		...diagnostics,
		messages: [...warningMessages, ...diagnostics.messages],
		summary: `${diagnostics.summary}; Patch warnings: ${warnings.length}`,
	};
}

function toPerFileResult(file: EditFileOutcome, mode: EditMode): EditToolPerFileResult {
	let diagnostics = parseDiagnostics(file.diagnosticsJson);
	if (mode === "patch" || mode === "apply_patch") {
		diagnostics = mergeDiagnosticsWithWarnings(diagnostics, file.warnings);
	}
	const resultPath = file.moveTo ?? file.path;
	return {
		path: resultPath,
		diff: file.diff,
		firstChangedLine: file.firstChangedLine,
		diagnostics,
		op: operationFromNative(file.op),
		move: file.moveTo,
		sourcePath: file.moveTo ? file.path : undefined,
		oldText: file.oldText,
		newText: file.newText,
		snapshotsPruned: file.snapshotsPruned || undefined,
		meta: outputMeta()
			.diagnostics(diagnostics?.summary ?? "", diagnostics?.messages ?? [])
			.get(),
	};
}

function aggregateDetails(files: readonly EditFileOutcome[], mode: EditMode): EditToolDetails | undefined {
	if (files.length === 0) return undefined;
	const perFileResults = files.map(file => toPerFileResult(file, mode));
	if (perFileResults.length === 1) {
		const [file] = perFileResults;
		return {
			diff: file.diff,
			firstChangedLine: file.firstChangedLine,
			diagnostics: file.diagnostics,
			op: file.op,
			move: file.move,
			sourcePath: file.sourcePath,
			path: file.path,
			oldText: file.oldText,
			newText: file.newText,
			snapshotsPruned: file.snapshotsPruned,
			meta: file.meta,
		};
	}
	return {
		diff: perFileResults
			.map(file => file.diff)
			.filter(Boolean)
			.join("\n"),
		firstChangedLine: perFileResults.find(file => file.firstChangedLine !== undefined)?.firstChangedLine,
		perFileResults: capPerFileSnapshots(perFileResults),
	};
}

/**
 * Combined `oldText` + `newText` character budget shared across a multi-file
 * result. The engine already prunes each file on its own; this keeps a
 * many-small-files batch from accumulating unbounded snapshot bytes in the
 * session JSONL (#3787). Early entries keep their diff visualization; later
 * ones degrade to text-only.
 */
const MAX_EDIT_SNAPSHOT_TEXT_CHARS = 32_768;

function capPerFileSnapshots(entries: EditToolPerFileResult[]): EditToolPerFileResult[] {
	let remaining = MAX_EDIT_SNAPSHOT_TEXT_CHARS;
	return entries.map(entry => {
		const kept = (entry.oldText?.length ?? 0) + (entry.newText?.length ?? 0);
		if (kept === 0) return entry;
		if (kept <= remaining) {
			remaining -= kept;
			return entry;
		}
		const { oldText: _old, newText: _new, ...rest } = entry;
		return { ...rest, snapshotsPruned: true };
	});
}

async function mkdirAllowingFallback(directory: string): Promise<void> {
	try {
		await mkdir(directory, { recursive: true });
	} catch (error) {
		if (!hasFileWriteFallback() || !isPermissionDeniedError(error)) throw error;
	}
}

/** Memoized native inspection, tagged onto the streamed args object it describes. */
const kInspection = Symbol("edit.inspection");

interface InspectedArgs {
	[kInspection]?: { mode: EditMode; inspection: EditInspection; failed: boolean };
}

interface ScopedEditAuthorization {
	operation: FilesystemOperation;
	writeTargets: Map<string, AuthorizedFilesystemTarget>;
	deleteTargets: Map<string, AuthorizedFilesystemTarget>;
	readTargets: Map<string, AuthorizedFilesystemTarget>;
	sourcePaths: ReadonlySet<string>;
	snapshotPaths: readonly string[];
	sourceSnapshots: EditSourceSnapshot[];
	sourceSnapshotBytes: Map<string, Uint8Array>;
	pathResolution: ScopedEditPathResolution;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index++) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

function sloppySectionEntries(args: unknown): Array<{ path: string; digest: string }> {
	if (args === null || typeof args !== "object" || Array.isArray(args)) return [];
	const input = (args as Record<string, unknown>).input;
	if (typeof input !== "string") return [];
	const entries: Array<{ path: string; digest: string }> = [];
	const sectionPattern = /<SM:EDIT\b([^>]*)>([\s\S]*?)<\/SM:EDIT>/gi;
	for (const match of input.matchAll(sectionPattern)) {
		const attributes = match[1] ?? "";
		const pathMatch = /\bpath\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attributes);
		const target = pathMatch?.[1] ?? pathMatch?.[2] ?? pathMatch?.[3];
		if (!target) continue;
		const body = match[2] ?? "";
		const find = /<SM:FIND>([\s\S]*?)<\/SM:FIND>/i.exec(body)?.[1]?.trim();
		const put = /<SM:PUT>([\s\S]*?)<\/SM:PUT>/i.exec(body)?.[1]?.trim();
		if (find === undefined || put === undefined) continue;
		entries.push({ path: target, digest: `«\n${find}\n»\n${put}` });
	}
	return entries;
}

interface ScopedEditPathResolution {
	localSandboxRoot?: string;
	vaultRoots?: EditPolicy["vaultRoots"];
}

function scopedEditPathResolution(session: ToolSession): ScopedEditPathResolution {
	let localSandboxRoot: string | undefined;
	try {
		localSandboxRoot = path.resolve(resolveLocalRoot(planLocalProtocolOptions(session)));
	} catch {
		// Sessions without artifact wiring have no local:// sandbox.
	}
	return {
		localSandboxRoot,
		vaultRoots: isVaultEnabled() ? cachedVaultRoots() : undefined,
	};
}

function editPathKey(cwd: string, target: string, resolution: ScopedEditPathResolution): string {
	const normalized =
		target.startsWith("local:/") && !target.startsWith("local://")
			? `local://${target.slice("local:/".length)}`
			: target;
	const scheme = /^([a-z][a-z\d+.-]*):\/\//i.exec(normalized)?.[1]?.toLowerCase();
	if (!scheme || /^[a-z]:[\\/]/i.test(normalized)) return path.resolve(cwd, normalized);
	if (scheme !== "local" && scheme !== "vault") {
		throw new ToolError(`Unsupported scoped edit path scheme: ${scheme}://`, { path: target });
	}
	if (!normalized.startsWith(`${scheme}://`)) {
		throw new ToolError(`Unsupported scoped edit path syntax for ${scheme}:`, { path: target });
	}
	const rest = normalized
		.slice(scheme.length + 3)
		.split(/[?#]/, 1)[0]!
		.replaceAll("\\", "/");
	const separator = rest.indexOf("/");
	let host: string;
	let relative: string;
	try {
		host = decodeURIComponent(separator < 0 ? rest : rest.slice(0, separator));
		relative = decodeURIComponent(separator < 0 ? "" : rest.slice(separator + 1));
	} catch {
		throw new ToolError("Invalid scoped edit URL encoding.", { path: target });
	}
	let root: string | undefined;
	if (scheme === "local") {
		root = resolution.localSandboxRoot;
		relative = host ? (relative ? `${host}/${relative}` : host) : relative;
	} else {
		root = resolution.vaultRoots?.find(entry => entry.name === (host || "_"))?.root;
	}
	if (!root) throw new ToolError(`Scoped edit ${scheme}:// path has no configured root.`, { path: target });
	if (relative.split("/").includes("..")) {
		throw new ToolError(`Scoped edit ${scheme}:// URL escapes its root.`, { path: target });
	}
	const resolved = path.resolve(root, relative);
	const within = path.relative(root, resolved);
	if (within === ".." || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) {
		throw new ToolError(`Scoped edit ${scheme}:// URL escapes its root.`, { path: target });
	}
	return resolved;
}

export class EditTool implements AgentTool<TInput> {
	readonly name = "edit";
	readonly label = "Edit";
	readonly loadMode = "essential";
	readonly concurrency = "exclusive";
	readonly strict = true;

	readonly #allowFuzzy: boolean;
	readonly #fuzzyThreshold: number;
	readonly #writethrough: WritethroughCallback;
	readonly #editMode?: EditMode;
	readonly #deferredDiagnostics: DeferredDiagnostics;
	readonly #sessions = new Map<string, EditSession>();
	readonly #streamedArgs = new Map<string, string>();

	constructor(
		private readonly session: ToolSession,
		mode?: EditMode,
	) {
		const {
			PI_EDIT_FUZZY: editFuzzy = "auto",
			PI_EDIT_FUZZY_THRESHOLD: editFuzzyThreshold = "auto",
			PI_EDIT_VARIANT: envEditVariant = "auto",
		} = Bun.env;
		this.#editMode = mode ?? resolveConfiguredEditMode(envEditVariant);
		this.#allowFuzzy = resolveAllowFuzzy(session, editFuzzy);
		this.#fuzzyThreshold = resolveFuzzyThreshold(session, editFuzzyThreshold);
		const deduplicateDiagnostics =
			(session.enableLsp ?? true) &&
			session.settings.get("lsp.diagnosticsOnEdit") &&
			session.settings.get("lsp.diagnosticsDeduplicate");
		this.#deferredDiagnostics = new DeferredDiagnostics(session, deduplicateDiagnostics);
		this.#writethrough = createEditWritethrough(session);
	}

	get mode(): EditMode {
		return this.#editMode ?? resolveEditMode(this.session);
	}

	get description(): string {
		return resolveEditToolDescription(this.mode, this.session.getActiveModel?.());
	}

	get parameters(): TInput {
		switch (this.mode) {
			case "replace":
				return replaceEditSchema;
			case "patch":
				return patchEditSchema;
			case "apply_patch":
				return applyPatchSchema;
			case "hashline":
				return hashlineEditParamsSchema;
			case "sloppy":
				return sloppyEditSchema;
		}
	}

	get examples(): readonly ToolExample[] | undefined {
		if (this.mode === "patch") return PATCH_EXAMPLES;
		if (this.mode === "apply_patch") return APPLY_PATCH_EXAMPLES;
		return undefined;
	}

	get customFormat(): { syntax: "lark"; definition: string } | undefined {
		const definition = editGrammar(this.mode);
		return definition === null ? undefined : { syntax: "lark", definition };
	}

	get customWireName(): string | undefined {
		return this.mode === "apply_patch" ? "apply_patch" : undefined;
	}

	readonly approval = (args: unknown) => {
		const targets = this.#inspectionPaths(args);
		return targets.length > 0 && targets.every(target => resolveFileWriteApprovalTier(target) === "read")
			? "read"
			: "write";
	};

	readonly formatApprovalDetails = (args: unknown): string[] => {
		const targets = this.#inspectionPaths(args);
		return targets.length === 0 ? ["File: (unknown)"] : targets.map(target => `File: ${truncateForPrompt(target)}`);
	};

	matcherDigest(args: unknown): string | undefined {
		const digest = this.#inspect(args)
			.entries.map(entry => entry.digest)
			.filter(Boolean)
			.join("\n");
		return digest || undefined;
	}

	matcherPaths(args: unknown): readonly string[] | undefined {
		const paths = this.#inspectionPaths(args);
		return paths.length > 0 ? paths : undefined;
	}

	matcherEntries(args: unknown): readonly { path: string; digest: string }[] | undefined {
		const entries = this.#inspect(args).entries;
		return entries.length > 0 ? entries : undefined;
	}

	#inspectionPaths(args: unknown): string[] {
		const inspection = this.#inspect(args);
		const paths = new Set(inspection.paths);
		for (const entry of inspection.entries) paths.add(entry.path);
		for (const fileOp of inspection.fileOps) {
			paths.add(fileOp.path);
			if (typeof fileOp.to === "string" && fileOp.to.trim()) paths.add(fileOp.to);
		}
		return [...paths];
	}

	openArgStream(init: AgentToolArgStreamInit): AgentToolArgStream {
		const existing = this.#sessions.get(init.toolCallId);
		if (existing) existing.close();
		this.#sessions.delete(init.toolCallId);
		this.#streamedArgs.delete(init.toolCallId);
		if (this.session.pathScope?.isRestricted) {
			// Native streaming previews may read source files before the complete
			// payload can be authorized. Restricted sessions defer native parsing
			// until execute() has preflighted every inspected target.
			return {
				push: () => {},
				end: args => {
					this.#streamedArgs.set(init.toolCallId, JSON.stringify(args));
				},
				cancel: () => this.#streamedArgs.delete(init.toolCallId),
			};
		}
		// A call that arrived through the custom-tool wire streams the payload
		// verbatim; JSON function calls stream JSON text.
		const rawInput = init.customWireName !== undefined;
		const editSession = new EditSession(getEditStore(this.session), this.#policy(rawInput), (error, batch) => {
			if (error) {
				logger.debug("Native edit preview failed", { error: error.message, toolCallId: init.toolCallId });
				return;
			}
			init.emit(batch);
		});
		this.#sessions.delete(init.toolCallId);
		this.#sessions.set(init.toolCallId, editSession);
		while (this.#sessions.size > 32) {
			const oldestId = this.#sessions.keys().next().value;
			if (oldestId === undefined) break;
			this.#sessions.get(oldestId)?.close();
			this.#sessions.delete(oldestId);
			this.#streamedArgs.delete(oldestId);
		}
		return {
			push: delta => editSession.push(delta),
			end: args => {
				editSession.finish();
				this.#streamedArgs.set(init.toolCallId, JSON.stringify(args));
			},
			cancel: () => {
				editSession.close();
				if (this.#sessions.get(init.toolCallId) === editSession) this.#sessions.delete(init.toolCallId);
				this.#streamedArgs.delete(init.toolCallId);
			},
		};
	}

	async execute(
		toolCallId: string,
		params: EditParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<EditToolDetails, TInput>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<EditToolDetails, TInput>> {
		let editSession = this.#sessions.get(toolCallId);
		const argsJson = JSON.stringify(params);
		if (editSession && (this.session.pathScope?.isRestricted || this.#streamedArgs.get(toolCallId) !== argsJson)) {
			editSession.close();
			this.#sessions.delete(toolCallId);
			editSession = undefined;
		}
		this.#streamedArgs.delete(toolCallId);
		const batch = getLspBatchRequest(context?.toolCall);
		let authorization: ScopedEditAuthorization | undefined;
		let outcome;
		try {
			if (this.session.pathScope?.isRestricted) {
				authorization = await this.#authorizeInspection(params, signal);
				authorization.sourceSnapshots = await this.#snapshotSources(authorization, signal);
			}
			if (!editSession) {
				// No deltas were streamed (non-streaming provider, inline recovery,
				// Cursor batch frames), or a pre-execution hook revised the arguments:
				// the parsed args are the whole effective payload.
				editSession = new EditSession(
					getEditStore(this.session),
					this.#policy(false, authorization?.sourceSnapshots),
				);
				editSession.setArgsJson(argsJson);
				editSession.finish();
			}
			if (authorization) throwIfAborted(signal);
			outcome = await editSession.apply(
				{ lspBatchId: batch?.id, lspFlush: batch?.flush ?? false },
				(_error, request) => this.#write(request, signal, authorization),
			);
			if (!this.session.pathScope?.isRestricted && outcome.isError && batch?.flush) {
				await flushLspWritethroughBatch(batch.id, this.session.cwd, signal);
			}
		} catch (error) {
			if (!this.session.pathScope?.isRestricted && batch?.flush)
				await flushLspWritethroughBatch(batch.id, this.session.cwd, signal);
			throw error;
		} finally {
			editSession?.close();
			if (this.#sessions.get(toolCallId) === editSession) this.#sessions.delete(toolCallId);
			this.#streamedArgs.delete(toolCallId);
		}

		if (outcome.isError) {
			return { content: [{ type: "text", text: outcome.text }], isError: true };
		}

		const details = aggregateDetails(outcome.files, this.mode);
		const result: AgentToolResult<EditToolDetails, TInput> = {
			content: [{ type: "text", text: outcome.text }],
			...(details ? { details } : {}),
		};
		const record = createEditBlackboxRecorder(this.session, this.mode, params);
		const notes: string[] = [];
		for (const file of outcome.files) {
			if (!file.parseRegressed || file.oldText === undefined || file.newText === undefined) continue;
			const snapshot: AppliedEditSnapshot = {
				path: file.moveTo ?? file.path,
				prev: file.oldText,
				next: file.newText,
			};
			try {
				await record?.(snapshot);
			} catch {
				// Blackbox recording is diagnostic only.
			}
			const display = path.relative(this.session.cwd, snapshot.path) || snapshot.path;
			let repaired: EditAutoRepairOutcome | undefined;
			try {
				// Auto-repair performs its own path reads and writes without an operation proof.
				if (!this.session.pathScope?.isRestricted) {
					repaired = await attemptEditAutoRepair({
						session: this.session,
						snapshot,
						writethrough: this.#writethrough,
						signal,
					});
					if (repaired) getEditStore(this.session).invalidate(snapshot.path);
				}
			} catch (error) {
				logger.warn("Edit auto-repair failed", {
					path: snapshot.path,
					error: error instanceof Error ? error.message : String(error),
				});
			}
			notes.push(
				repaired
					? `Note: ${display} stopped parsing after this edit; an automatic syntax repair (${repaired.model}) was applied on top:\n${repaired.diff}\nReview the repaired region; adjust it if the repair guessed wrong.`
					: `Warning: ${display} no longer parses after this edit. The change was applied; re-read the edited region and fix the syntax, or revert if unintended.`,
			);
		}
		if (notes.length > 0) result.content.push({ type: "text", text: notes.join("\n\n") });
		return result;
	}

	/**
	 * TTSR asks `matcherPaths` and `matcherEntries` (and approval asks again)
	 * for the same streamed args object on every delta, and the native inspect
	 * re-parses the whole payload each time; the result is tagged onto the args
	 * so repeat lookups for one object pay once.
	 */
	#inspect(args: unknown, refresh = false): EditInspection {
		const tagged = typeof args === "object" && args !== null ? (args as InspectedArgs) : undefined;
		const cached = tagged?.[kInspection];
		if (!refresh && cached?.mode === this.mode) return cached.inspection;
		let inspection: EditInspection;
		let failed = false;
		try {
			inspection = editInspect(this.mode, JSON.stringify(args ?? {}));
		} catch {
			inspection = { paths: [], entries: [], fileOps: [] };
			failed = true;
		}
		if (inspection.paths.length === 0 && this.mode === "sloppy") {
			const entries = sloppySectionEntries(args);
			if (entries.length > 0) {
				inspection = { ...inspection, paths: entries.map(entry => entry.path), entries };
				failed = false;
			}
		}
		if (tagged) tagged[kInspection] = { mode: this.mode, inspection, failed };
		return inspection;
	}

	async #authorizeInspection(args: unknown, signal?: AbortSignal): Promise<ScopedEditAuthorization> {
		const scope = this.session.pathScope;
		if (!scope) throw new Error("Scoped edit authorization requires a session path scope.");
		const operation = scope.currentOperation();
		const pathResolution = scopedEditPathResolution(this.session);
		throwIfAborted(signal);
		const inspection = this.#inspect(args, true);
		const tagged = typeof args === "object" && args !== null ? (args as InspectedArgs) : undefined;
		if (tagged?.[kInspection]?.failed) {
			throw new ToolError("Native edit path inspection failed; refusing filesystem access in a restricted session.");
		}

		const sourcePaths = new Set<string>();
		const writePaths = new Set<string>();
		const deletePaths = new Set<string>();
		const addSourcePath = (rawPath: string): void => {
			if (!rawPath.trim()) {
				throw new ToolError("Native edit path inspection returned an empty source path.");
			}
			const target = editPathKey(this.session.cwd, rawPath, pathResolution);
			sourcePaths.add(target);
			writePaths.add(target);
		};

		for (const target of inspection.paths) addSourcePath(target);
		for (const entry of inspection.entries) addSourcePath(entry.path);
		for (const fileOp of inspection.fileOps) {
			addSourcePath(fileOp.path);
			if (fileOp.kind === "delete" || fileOp.kind === "move") {
				deletePaths.add(editPathKey(this.session.cwd, fileOp.path, pathResolution));
			} else {
				throw new ToolError(`Native edit path inspection returned an unsupported operation: ${fileOp.kind}`);
			}
			if (fileOp.kind === "move") {
				if (typeof fileOp.to !== "string" || !fileOp.to.trim()) {
					throw new ToolError("Native edit move inspection omitted its destination path.");
				}
				writePaths.add(editPathKey(this.session.cwd, fileOp.to, pathResolution));
			}
		}
		if (writePaths.size === 0) {
			throw new ToolError("Native edit path inspection returned no filesystem targets; refusing restricted edit.");
		}

		const writePathList = [...writePaths];
		const deletePathList = [...deletePaths];
		const candidates = [
			...writePathList.map(target => ({ path: target, kind: "write" as const })),
			...deletePathList.map(target => ({ path: target, kind: "delete" as const })),
		];
		const authorized = await operation.preflight(candidates);
		const writeTargets = new Map<string, AuthorizedFilesystemTarget>();
		const deleteTargets = new Map<string, AuthorizedFilesystemTarget>();
		let index = 0;
		for (const target of writePathList) {
			const proof = authorized[index++];
			if (!proof) throw new Error("Filesystem preflight returned an incomplete write authorization.");
			writeTargets.set(target, proof);
			writeTargets.set(editPathKey(this.session.cwd, proof.canonicalTarget, pathResolution), proof);
		}
		for (const target of deletePathList) {
			const proof = authorized[index++];
			if (!proof) throw new Error("Filesystem preflight returned an incomplete delete authorization.");
			deleteTargets.set(target, proof);
			deleteTargets.set(editPathKey(this.session.cwd, proof.canonicalTarget, pathResolution), proof);
		}
		for (const target of sourcePaths) {
			const proof = writeTargets.get(target);
			if (!proof) throw new ToolError("Native edit source is missing its write authorization.");
			if (proof.existed && !proof.isFile) {
				throw new ToolError(`Native edit source is not a regular file: ${target}`, { path: target });
			}
		}
		for (const target of new Set(writeTargets.values())) await operation.verify(target);
		for (const target of new Set(deleteTargets.values())) await operation.verify(target);

		const readableSources = [...sourcePaths].filter(target => writeTargets.get(target)?.existed);
		const readProofs = await operation.preflight(
			readableSources.map(target => ({ path: target, kind: "read" as const })),
		);
		const readTargets = new Map<string, AuthorizedFilesystemTarget>();
		for (let i = 0; i < readableSources.length; i++) {
			const target = readableSources[i];
			const proof = readProofs[i];
			const writeProof = target ? writeTargets.get(target) : undefined;
			if (!target || !proof || !writeProof) {
				throw new Error("Filesystem preflight returned an incomplete read authorization.");
			}
			if (proof.canonicalTarget !== writeProof.canonicalTarget) {
				throw new ToolError("Native edit source changed while filesystem access was being authorized.", {
					path: target,
				});
			}
			readTargets.set(target, proof);
			readTargets.set(editPathKey(this.session.cwd, proof.canonicalTarget, pathResolution), proof);
			await operation.verify(proof);
		}
		throwIfAborted(signal);
		return {
			operation,
			pathResolution,
			writeTargets,
			deleteTargets,
			readTargets,
			sourcePaths,
			snapshotPaths: writePathList,
			sourceSnapshots: [],
			sourceSnapshotBytes: new Map(),
		};
	}

	async #snapshotSources(authorization: ScopedEditAuthorization, signal?: AbortSignal): Promise<EditSourceSnapshot[]> {
		for (const target of authorization.sourcePaths) {
			throwIfAborted(signal);
			const proof = authorization.writeTargets.get(target);
			if (!proof) {
				throw new ToolError("Native edit source is missing its write authorization.", { path: target });
			}
			if (!proof.existed) continue;
			const readProof = authorization.readTargets.get(target);
			if (!readProof || readProof.canonicalTarget !== proof.canonicalTarget) {
				throw new ToolError("Native edit source is missing its preflighted read authorization.", { path: target });
			}
			const bytes = await this.#readScopedBytes(authorization, target);
			throwIfAborted(signal);
			const canonicalKey = editPathKey(this.session.cwd, proof.canonicalTarget, authorization.pathResolution);
			const prior = authorization.sourceSnapshotBytes.get(canonicalKey);
			if (prior && !bytesEqual(prior, bytes)) {
				throw new ToolError("Native edit source changed while its authorized snapshot was being read.", {
					path: target,
				});
			}
			authorization.sourceSnapshotBytes.set(target, bytes);
			authorization.sourceSnapshotBytes.set(canonicalKey, bytes);
		}

		const snapshots: EditSourceSnapshot[] = [];
		for (const target of authorization.snapshotPaths) {
			throwIfAborted(signal);
			const proof = authorization.writeTargets.get(target);
			if (!proof) {
				throw new ToolError("Native edit path is missing its preflighted write authorization.", { path: target });
			}
			const canonicalKey = editPathKey(this.session.cwd, proof.canonicalTarget, authorization.pathResolution);
			const bytes = proof.existed ? authorization.sourceSnapshotBytes.get(canonicalKey) : undefined;
			snapshots.push({
				path: target,
				canonicalPath: proof.canonicalTarget,
				exists: proof.existed,
				...(bytes === undefined ? {} : { bytes }),
			});
		}
		return snapshots;
	}

	#policy(rawInput: boolean, sourceSnapshots?: EditSourceSnapshot[]): EditPolicy {
		const pathResolution = scopedEditPathResolution(this.session);
		return {
			cwd: this.session.cwd,
			mode: this.mode,
			allowFuzzy: this.#allowFuzzy,
			fuzzyThreshold: this.#fuzzyThreshold,
			enforceSeenLines: this.session.settings.get("edit.enforceSeenLines"),
			blockAutoGenerated: this.session.settings.get("edit.blockAutoGenerated"),
			planActive: this.session.getPlanModeState?.()?.enabled ?? false,
			...pathResolution,
			homeDir: os.homedir(),
			rawInput,
			...(sourceSnapshots === undefined ? {} : { sourceSnapshots }),
		};
	}

	async #readScopedBytes(authorization: ScopedEditAuthorization, requestPath: string): Promise<Uint8Array> {
		const target = authorization.readTargets.get(
			editPathKey(this.session.cwd, requestPath, authorization.pathResolution),
		);
		if (!target) {
			throw new ToolError("Native edit source read did not match a preflighted read authorization.", {
				path: requestPath,
			});
		}
		const handle = await authorization.operation.openRead(target);
		try {
			return await handle.readFile();
		} finally {
			await handle.close();
		}
	}

	async #assertSourceSnapshotCurrent(
		authorization: ScopedEditAuthorization,
		requestPath: string,
	): Promise<Uint8Array> {
		const key = editPathKey(this.session.cwd, requestPath, authorization.pathResolution);
		const original = authorization.sourceSnapshotBytes.get(key);
		if (original === undefined) {
			throw new ToolError("Native edit source did not match a preflighted content snapshot.", { path: requestPath });
		}
		const current = await this.#readScopedBytes(authorization, requestPath);
		if (!bytesEqual(current, original)) {
			throw new ToolError("Native edit source changed after authorization; refusing to apply a stale edit.", {
				path: key,
			});
		}
		return current;
	}

	async #writeScoped(
		request: EditWriteRequest,
		signal: AbortSignal | undefined,
		authorization: ScopedEditAuthorization,
	): Promise<EditWriteResponse> {
		// Bridges and writethrough callbacks persist through ordinary path opens;
		// restricted effects must use the operation's verified filesystem proofs.
		const { operation } = authorization;
		const sourceKey = editPathKey(this.session.cwd, request.path, authorization.pathResolution);
		if (request.op === "delete") {
			const source = authorization.deleteTargets.get(sourceKey);
			if (!source) {
				throw new ToolError("Native edit delete callback did not match a preflighted source.", {
					path: request.path,
				});
			}
			operation.assertTarget(source, "delete");
			throwIfAborted(signal);
			await this.#assertSourceSnapshotCurrent(authorization, request.path);
			throwIfAborted(signal);
			await operation.deleteFile(source);
			if (this.session.enableLsp ?? true) {
				await notifyWorkspaceWatchedFiles(
					this.session.cwd,
					[{ filePath: source.canonicalTarget, type: FileChangeType.Deleted }],
					signal,
				);
			}
			invalidateFsScanAfterDelete(source.canonicalTarget);
			this.session.bumpFileMutationVersion?.(source.canonicalTarget);
			return { written: "" };
		}

		if (request.content === undefined) {
			throw new ToolError(`Native edit ${request.op} request omitted content`, { path: request.path });
		}

		if (request.op === "move") {
			if (!request.moveTo) {
				throw new ToolError("Native edit move request omitted destination", { path: request.path });
			}
			const source = authorization.deleteTargets.get(sourceKey);
			const destination = authorization.writeTargets.get(
				editPathKey(this.session.cwd, request.moveTo, authorization.pathResolution),
			);
			if (!source || !destination) {
				throw new ToolError("Native edit move callback did not match preflighted source and destination paths.");
			}
			operation.assertTarget(source, "delete");
			operation.assertTarget(destination, "write");
			throwIfAborted(signal);
			await operation.verify(source);
			await operation.verify(destination);
			await this.#assertSourceSnapshotCurrent(authorization, request.path);
			throwIfAborted(signal);
			await operation.writeFile(destination, request.content);
			await operation.deleteFile(source);
			if (this.session.enableLsp ?? true) {
				await notifyWorkspaceWatchedFiles(
					this.session.cwd,
					[
						{ filePath: source.canonicalTarget, type: FileChangeType.Deleted },
						{ filePath: destination.canonicalTarget, type: FileChangeType.Created },
					],
					signal,
				);
			}
			invalidateFsScanAfterRename(source.canonicalTarget, destination.canonicalTarget);
			this.session.bumpFileMutationVersion?.(source.canonicalTarget);
			this.session.bumpFileMutationVersion?.(destination.canonicalTarget);
			return { written: request.content };
		}

		if (request.op !== "create" && request.op !== "update") {
			throw new ToolError(`Native edit returned an unsupported write operation: ${request.op}`, {
				path: request.path,
			});
		}
		const target = authorization.writeTargets.get(sourceKey);
		if (!target) {
			throw new ToolError("Native edit write callback did not match a preflighted source.", { path: request.path });
		}
		operation.assertTarget(target, "write");
		throwIfAborted(signal);
		const preWriteBytes =
			request.op === "update" ? await this.#assertSourceSnapshotCurrent(authorization, request.path) : undefined;
		throwIfAborted(signal);
		await operation.writeFile(target, request.content);
		if (preWriteBytes !== undefined) {
			const requestedBytes = new TextEncoder().encode(request.content);
			if (!bytesEqual(requestedBytes, preWriteBytes)) {
				const postWriteBytes = await this.#readScopedBytes(authorization, request.path);
				if (bytesEqual(postWriteBytes, preWriteBytes)) {
					throw new ToolError(
						`edit appeared successful but file content did not change on disk: ${request.displayPath}`,
						{ path: target.canonicalTarget },
					);
				}
			}
		}
		if (this.session.enableLsp ?? true) {
			await notifyWorkspaceWatchedFiles(
				this.session.cwd,
				[
					{
						filePath: target.canonicalTarget,
						type: target.existed ? FileChangeType.Changed : FileChangeType.Created,
					},
				],
				signal,
			);
		}
		invalidateFsScanAfterWrite(target.canonicalTarget);
		this.session.bumpFileMutationVersion?.(target.canonicalTarget);
		return { written: request.content };
	}

	async #write(
		request: EditWriteRequest,
		signal?: AbortSignal,
		authorization?: ScopedEditAuthorization,
	): Promise<EditWriteResponse> {
		if (authorization) return this.#writeScoped(request, signal, authorization);
		if (this.session.pathScope?.isRestricted) {
			throw new ToolError("Restricted edit callback has no preflighted filesystem authorization.", {
				path: request.path,
			});
		}
		if (request.op === "delete") {
			await deleteFileWithFallback(request.path, Bun.file(request.path));
			if (this.session.enableLsp ?? true) {
				await notifyWorkspaceWatchedFiles(
					this.session.cwd,
					[{ filePath: request.path, type: FileChangeType.Deleted }],
					signal,
				);
			}
			invalidateFsScanAfterDelete(request.path);
			this.session.bumpFileMutationVersion?.(request.path);
			const diagnostics =
				request.flushLsp && request.lspBatchId
					? await flushLspWritethroughBatch(request.lspBatchId, this.session.cwd, signal)
					: undefined;
			return {
				written: "",
				diagnosticsJson: diagnostics ? JSON.stringify(diagnostics) : undefined,
			};
		}

		if (request.content === undefined) {
			throw new ToolError(`Native edit ${request.op} request omitted content`, { path: request.path });
		}

		if (request.op === "move") {
			if (!request.moveTo) {
				throw new ToolError("Native edit move request omitted destination", { path: request.path });
			}
			await mkdirAllowingFallback(path.dirname(request.moveTo));
			await writeFileWithFallback(request.moveTo, request.content);
			await deleteFileWithFallback(request.path, Bun.file(request.path));
			if (this.session.enableLsp ?? true) {
				await notifyWorkspaceWatchedFiles(
					this.session.cwd,
					[
						{ filePath: request.path, type: FileChangeType.Deleted },
						{ filePath: request.moveTo, type: FileChangeType.Created },
					],
					signal,
				);
			}
			invalidateFsScanAfterRename(request.path, request.moveTo);
			this.session.bumpFileMutationVersion?.(request.path);
			this.session.bumpFileMutationVersion?.(request.moveTo);
			const diagnostics =
				request.flushLsp && request.lspBatchId
					? await flushLspWritethroughBatch(request.lspBatchId, this.session.cwd, signal)
					: undefined;
			return {
				written: request.content,
				diagnosticsJson: diagnostics ? JSON.stringify(diagnostics) : undefined,
			};
		}

		const bridge = await routeWriteThroughBridge(
			this.session,
			request.displayPath,
			request.path,
			request.content,
			signal,
		);
		if (bridge) return { written: bridge.text };

		let preWriteBytes: Uint8Array | undefined;
		if (request.op === "update") {
			try {
				preWriteBytes = await Bun.file(request.path).bytes();
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		} else if (request.op === "create") {
			await mkdirAllowingFallback(path.dirname(request.path));
		}

		const diagnostics = await this.#writethrough(
			request.path,
			request.content,
			signal,
			Bun.file(request.path),
			request.lspBatchId ? { id: request.lspBatchId, flush: request.flushLsp } : undefined,
			destination => (destination === request.path ? this.#deferredDiagnostics.begin(request.path) : undefined),
		);

		if (preWriteBytes !== undefined) {
			const requestedBytes = new TextEncoder().encode(request.content);
			if (!bytesEqual(requestedBytes, preWriteBytes)) {
				let postWriteBytes: Uint8Array | undefined;
				try {
					postWriteBytes = await Bun.file(request.path).bytes();
				} catch (error) {
					if (!isEnoent(error)) throw error;
				}
				if (postWriteBytes !== undefined && bytesEqual(postWriteBytes, preWriteBytes)) {
					throw new ToolError(
						`edit appeared successful but file content did not change on disk: ${request.displayPath}`,
						{ path: request.path },
					);
				}
			}
		}

		invalidateFsScanAfterWrite(request.path);
		this.session.bumpFileMutationVersion?.(request.path);
		return {
			written: diagnostics.finalContent,
			diagnosticsJson: diagnostics.diagnostics ? JSON.stringify(diagnostics.diagnostics) : undefined,
		};
	}
}
