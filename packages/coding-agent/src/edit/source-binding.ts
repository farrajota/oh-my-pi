/**
 * Edit sources pinned when a call is approved, for sessions whose permission scope judges targets by
 * their real path ({@link permissionPinsEditSources}).
 *
 * The approval guard checks each target's real path. Pinning records, at that moment, the real path,
 * the identity of the file there and its bytes. The native session then stages against those bytes
 * only (a target whose path now lands elsewhere is refused), and the host writes to the pinned real
 * path only after checking that the file there is still the one pinned, with the same bytes. A
 * target swapped (for example for a symlink into a denied folder) or rewritten in between is refused,
 * not written.
 *
 * What remains: a racing process that swaps a parent folder between that last check and the write.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { EditSourceSnapshot } from "@oh-my-pi/pi-natives";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { isEnoent, resolveEquivalentPath } from "@oh-my-pi/pi-utils";
import { InternalUrlRouter, type ResolveContext } from "../internal-urls";
import { internalUrlFileRefusal } from "../task/permissions/session-checks";
import { toolApprovalScopeToken } from "../tools/approval-scope";
import { approvalTargetKey } from "../tools/approval-targets";
import { resolveToCwd } from "../tools/path-utils";

interface FileIdentity {
	readonly dev: bigint;
	readonly ino: bigint;
	readonly birthtimeNs: bigint;
}

/** One target as it was at approval. */
interface PinnedSource {
	/** Real path; for a missing target, its deepest existing folder's real path plus the rest. */
	readonly physical: string;
	/** The regular file there; absent when nothing existed there. */
	readonly file?: { readonly identity: FileIdentity; readonly bytes: Uint8Array };
}

export interface EditSourceBinding {
	/** Pinned sources by real path. */
	readonly sources: ReadonlyMap<string, PinnedSource>;
	/** Approval cache keys of the pinned targets: what the approval guard checks. */
	readonly approvalKeys: readonly string[];
	/** Why a target could not be pinned; the edit is refused with these. */
	readonly errors: readonly string[];
}

/** The wording every refusal shares, so a model sees one cause however late the change was caught. */
function changedSince(label: string): ToolError {
	return new ToolError(`${label}: the file changed after it was approved; the edit was refused.`);
}

// Never follow a symlink in the last component (a swap after the real path was taken) and never block
// opening a FIFO. Windows has neither flag.
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

/**
 * Pin `file` (an absolute path). Throws a {@link ToolError} when the target is not a regular file or
 * changed while it was being pinned. Synchronous because approval binding is
 * (`AgentTool.bindApprovalTargets`).
 */
function pin(file: string, label: string): PinnedSource {
	const physical = resolveEquivalentPath(file, { throughMissing: true });
	let fd: number;
	try {
		fd = fs.openSync(physical, OPEN_FLAGS);
	} catch (error) {
		if (isEnoent(error) && fs.lstatSync(physical, { throwIfNoEntry: false }) === undefined) return { physical };
		throw new ToolError(`${label}: cannot be pinned for this edit (${(error as Error).message}).`);
	}
	try {
		const stat = fs.fstatSync(fd, { bigint: true });
		if (!stat.isFile()) throw new ToolError(`${label}: not a regular file.`);
		if (resolveEquivalentPath(file, { throughMissing: true }) !== physical) throw changedSince(label);
		const bytes = fs.readFileSync(fd);
		return { physical, file: { identity: { dev: stat.dev, ino: stat.ino, birthtimeNs: stat.birthtimeNs }, bytes } };
	} finally {
		fs.closeSync(fd);
	}
}

/** The approval cache key (`approvalCacheKeyForPath`) of a path that is already real. */
function approvalKeyOf(physical: string): string {
	return process.platform === "win32" ? physical.toLowerCase() : physical;
}

function samePin(pinned: PinnedSource, current: PinnedSource): boolean {
	if (pinned.physical !== current.physical) return false;
	if (!pinned.file || !current.file) return pinned.file === current.file;
	const a = pinned.file;
	const b = current.file;
	return (
		a.identity.dev === b.identity.dev &&
		a.identity.ino === b.identity.ino &&
		a.identity.birthtimeNs === b.identity.birthtimeNs &&
		Buffer.from(a.bytes.buffer, a.bytes.byteOffset, a.bytes.byteLength).equals(b.bytes)
	);
}

/**
 * Pin every target an edit names (`targets`: section paths and move destinations, as authored).
 * Filesystem paths resolve against `cwd`. A file-backed internal URL (`local://`) is located
 * synchronously and its file must pass the scope's internal-URL rule, as the native session's own
 * lookup would; one that cannot be located synchronously is not editable in a pinned session.
 */
export function captureEditSources(
	targets: readonly string[],
	cwd: string,
	context: ResolveContext,
): EditSourceBinding {
	const router = InternalUrlRouter.instance();
	const sources = new Map<string, PinnedSource>();
	const approvalKeys: string[] = [];
	const errors: string[] = [];
	for (const target of new Set(targets)) {
		if (target.trim().length === 0) continue;
		const normalized = router.normalize(target.trim());
		let file: string;
		if (router.canHandle(normalized)) {
			approvalKeys.push(normalized);
			// Handler-written and read-only schemes never reach a file; the native session refuses them.
			if (!router.fileWritable(normalized)) continue;
			let located: string | undefined;
			try {
				located = router.locateSync(router.peelWriteSelector(normalized, "edit"), context);
			} catch (error) {
				errors.push(`${target}: ${error instanceof Error ? error.message : String(error)}`);
				continue;
			}
			if (located === undefined) {
				errors.push(`${target}: cannot be pinned to a file when the edit is approved, so it is not editable here.`);
				continue;
			}
			const refusal = internalUrlFileRefusal(context.settings, cwd, normalized, located);
			if (refusal !== undefined) {
				errors.push(refusal);
				continue;
			}
			file = located;
		} else {
			try {
				file = resolveToCwd(target, cwd);
			} catch {
				// Not a path the native session can resolve either; it refuses the target unpinned.
				continue;
			}
		}
		try {
			const source = pin(file, target);
			sources.set(source.physical, source);
			// The guard must judge the very path pinned, so the key is not resolved again.
			if (!router.canHandle(normalized)) approvalKeys.push(approvalKeyOf(source.physical));
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
			if (!router.canHandle(normalized)) {
				const key = approvalTargetKey(cwd, target);
				if (key !== undefined) approvalKeys.push(key);
			}
		}
	}
	return { sources, approvalKeys, errors };
}

const bindings = new WeakMap<object, WeakMap<object, { args: unknown; binding: EditSourceBinding }>>();

/** Keep `binding`, made for the arguments object `args`, for `owner` in this call's approval scope. */
export function bindEditSources(owner: object, args: unknown, binding: EditSourceBinding): void {
	const scope = toolApprovalScopeToken();
	if (!scope) return;
	let owners = bindings.get(scope);
	if (!owners) {
		owners = new WeakMap();
		bindings.set(scope, owners);
	}
	owners.set(owner, { args, binding });
}

/** The binding `owner` made for exactly the arguments object `args` in this call's approval scope. */
export function boundEditSources(owner: object, args: unknown): EditSourceBinding | undefined {
	const scope = toolApprovalScopeToken();
	const bound = scope ? bindings.get(scope)?.get(owner) : undefined;
	return bound !== undefined && bound.args === args ? bound.binding : undefined;
}

/** The pinned sources in the shape the native session reads them. */
export function nativeSourceSnapshots(binding: EditSourceBinding): EditSourceSnapshot[] {
	return [...binding.sources.values()].map(source =>
		source.file ? { path: source.physical, bytes: source.file.bytes } : { path: source.physical },
	);
}

/** Throw unless every pinned source is still what was pinned. Run before the first write. */
export function assertEditSourcesUnchanged(binding: EditSourceBinding, cwd: string): void {
	if (binding.errors.length > 0) throw new ToolError(binding.errors.join("\n"));
	for (const source of binding.sources.values()) {
		const label = path.relative(cwd, source.physical) || source.physical;
		let current: PinnedSource;
		try {
			current = pin(source.physical, label);
		} catch {
			throw changedSince(label);
		}
		if (!samePin(source, current)) throw changedSince(label);
	}
}

/**
 * The real path to write for `file` (a path the native session resolved), after checking that it
 * still lands on a pinned source that is unchanged. Throws a {@link ToolError} otherwise.
 */
export function pinnedWritePath(binding: EditSourceBinding, file: string, label: string): string {
	const source = binding.sources.get(resolveEquivalentPath(file, { throughMissing: true }));
	if (!source) throw changedSince(label);
	let current: PinnedSource;
	try {
		current = pin(file, label);
	} catch {
		throw changedSince(label);
	}
	if (!samePin(source, current)) throw changedSince(label);
	return source.physical;
}

/**
 * Throw unless `target` (a path or internal URL as {@link captureEditSources} saw it) still lands on
 * an unchanged pinned source. For a caller that hands `target` itself to a native call, which
 * resolves it again: a swap in between those two steps is not caught.
 */
export function assertPinnedTarget(
	binding: EditSourceBinding,
	target: string,
	cwd: string,
	context: ResolveContext,
): void {
	const router = InternalUrlRouter.instance();
	const normalized = router.normalize(target.trim());
	if (!router.canHandle(normalized)) {
		pinnedWritePath(binding, resolveToCwd(target, cwd), target);
		return;
	}
	const located = router.locateSync(router.peelWriteSelector(normalized, "edit"), context);
	if (located === undefined) throw changedSince(target);
	pinnedWritePath(binding, located, target);
}
