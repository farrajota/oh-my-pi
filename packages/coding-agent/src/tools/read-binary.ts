import * as fs from "node:fs/promises";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ReadToolDetails } from "@oh-my-pi/pi-tui/tools/read";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import {
	acquireIdaDatabase,
	cfgIdaAvailable,
	EXECUTABLE_SNIFF_BYTES,
	isExecutableFile,
	isExecutableHeader,
	isIdaDatabasePath,
	SLICE_SEPARATOR,
} from "../ida";
import type { IdaDatabase } from "../ida";
import type { ToolSession } from "../sdk";
import { formatPathRelativeToCwd, resolveReadPath } from "./path-utils";
import { buildInMemorySelectorResult } from "./read-format";
import type { ParsedSelector } from "./read-selector";

async function withBinaryInput<T>(handle: fs.FileHandle, consume: () => Promise<T>): Promise<T> {
	let value: T;
	try {
		value = await consume();
	} catch (error) {
		try {
			await handle.close();
		} catch (closeError) {
			throw new AggregateError([error, closeError], "Binary input and resource close failed.");
		}
		throw error;
	}
	await handle.close();
	return value;
}

/** IDA view rendered by the worker's `view` method. */
export type IdaViewKind = "overview" | "pseudocode" | "asm" | "imports" | "exports" | "strings" | "xrefs";

/** Parsed `<binary>:<view>` suffix; `target` is a symbol name or `0x` address. */
export type BinaryView = { kind: IdaViewKind; target?: string };

/** An executable or IDB on disk plus the unparsed view suffix after it. */
export interface BinaryViewTarget {
	absolutePath: string;
	view: string;
	/** Universal-binary slice from a leading `@<arch>` view segment; default slice when absent. */
	arch?: string;
}

const RESERVED_VIEWS: Record<string, IdaViewKind> = { imports: "imports", exports: "exports", strings: "strings" };
const SLICE_PREFIX = "@";
const XREFS_PREFIX = "xrefs:";
const ASM_SUFFIX = ":asm";
const VIEW_TIMEOUT_MS = 120_000;

/**
 * Parse the view suffix of a binary read. Reserved words (`imports`, `exports`,
 * `strings`) win over same-named functions, which stay reachable by `0x` address.
 */
export function parseBinaryView(view: string): BinaryView {
	if (view === "") return { kind: "overview" };
	const reserved = Object.hasOwn(RESERVED_VIEWS, view) ? RESERVED_VIEWS[view] : undefined;
	if (reserved) return { kind: reserved };
	if (view.startsWith(XREFS_PREFIX)) {
		const target = view.slice(XREFS_PREFIX.length);
		if (!target) throw new ToolError("xrefs needs a target: <binary>:xrefs:<func|0xaddr>");
		return { kind: "xrefs", target };
	}
	if (view.endsWith(ASM_SUFFIX)) return { kind: "asm", target: view.slice(0, -ASM_SUFFIX.length) };
	return { kind: "pseudocode", target: view };
}

async function isFile(absolutePath: string): Promise<boolean> {
	try {
		return (await fs.stat(absolutePath)).isFile();
	} catch {
		return false;
	}
}

/**
 * Split `readPath` into an executable/IDB file and an IDA view suffix. Returns
 * null when IDA is disabled, the path has no `:`, the whole path is an existing
 * file, or no `:`-delimited prefix names an executable or IDB.
 */
export async function resolveBinaryViewPath(session: ToolSession, readPath: string): Promise<BinaryViewTarget | null> {
	if (!cfgIdaAvailable.get(session.settings)) return null;
	if (!readPath.includes(":")) return null;
	if (await isFile(resolveReadPath(readPath, session.cwd))) return null;
	for (let i = readPath.lastIndexOf(":"); i > 0; i = readPath.lastIndexOf(":", i - 1)) {
		const absolutePath = resolveReadPath(readPath.slice(0, i), session.cwd);
		if (!(await isFile(absolutePath))) continue;
		let executable = false;
		if (!isIdaDatabasePath(absolutePath)) {
			if (!session.pathScope) executable = await isExecutableFile(absolutePath);
			else {
				const operation = session.pathScope.currentOperation();
				const handle = await operation.openRead(await operation.authorize(absolutePath, "read"));
				executable = await withBinaryInput(handle, async () => {
					const header = Buffer.alloc(EXECUTABLE_SNIFF_BYTES);
					const { bytesRead } = await handle.read(header, 0, header.length, 0);
					return isExecutableHeader(header.subarray(0, bytesRead));
				});
			}
		}
		if (isIdaDatabasePath(absolutePath) || executable) {
			return { absolutePath, ...splitSliceView(readPath.slice(i + 1)) };
		}
	}
	return null;
}

/** Split a leading `@<arch>` slice segment off a view: `@x86_64:main` → `{ arch: "x86_64", view: "main" }`. */
function splitSliceView(view: string): { view: string; arch?: string } {
	if (!view.startsWith(SLICE_PREFIX)) return { view };
	const end = view.indexOf(":");
	const arch = view.slice(SLICE_PREFIX.length, end < 0 ? undefined : end);
	if (!arch) throw new ToolError(`empty slice name: use <binary>${SLICE_SEPARATOR}<arch>`);
	return { arch, view: end < 0 ? "" : view.slice(end + 1) };
}

/** Render an IDA view of an executable or IDB, opening (or creating) its database on first use. */
export async function readBinary(
	session: ToolSession,
	target: BinaryViewTarget,
	parsed: ParsedSelector,
	signal?: AbortSignal,
): Promise<AgentToolResult<ReadToolDetails>> {
	const view = parseBinaryView(target.view);
	let handle: fs.FileHandle | undefined;
	let sourceReadPath: string | undefined;
	if (session.pathScope) {
		const operation = session.pathScope.currentOperation();
		handle = await operation.openRead(await operation.authorize(target.absolutePath, "read"));
		sourceReadPath = `/proc/self/fd/${handle.fd}`;
	}
	let db!: IdaDatabase;
	let text!: string;
	const consume = async (): Promise<void> => {
		if (handle && sourceReadPath) {
			if (process.platform !== "linux") throw new Error("Exact binary input reads require Linux /proc support.");
			const actual = await handle.stat({ bigint: true });
			const source = await fs.stat(sourceReadPath, { bigint: true });
			if (actual.dev !== source.dev || actual.ino !== source.ino)
				throw new Error("Binary input descriptor identity changed.");
		}
		db = await acquireIdaDatabase(session, target.absolutePath, { arch: target.arch, signal, sourceReadPath });
		session.pathScope?.currentOperation().assertActive();
		signal?.throwIfAborted();
		({ text } = await db.request<{ text: string }>("view", view, {
			signal: handle ? undefined : signal,
			timeoutMs: VIEW_TIMEOUT_MS,
		}));
		signal?.throwIfAborted();
		session.pathScope?.currentOperation().assertActive();
	};
	if (handle) await withBinaryInput(handle, consume);
	else await consume();
	let output = text;
	if (view.kind === "overview") {
		const bin = formatPathRelativeToCwd(target.absolutePath, session.cwd);
		const fat = db.fat;
		const p = fat ? `${bin}${SLICE_SEPARATOR}${fat.slice.arch}` : bin;
		const slices = fat
			? `; universal slices: ${fat.slices.map(s => (s.arch === fat.slice.arch ? `${s.arch} (shown)` : s.arch)).join(", ")}, pick via ${bin}${SLICE_SEPARATOR}<arch>`
			: "";
		output = `[${db.id}${slices}; views: ${p}:<func|0xaddr> pseudocode, ${p}:<func>:asm, :imports, :exports, :strings, :xrefs:<func|0xaddr>]\n${text}`;
	}
	// Immutable: the view is generated text, so it must never seed hashline edits against the binary itself.
	return buildInMemorySelectorResult(session, output, parsed, {
		details: { resolvedPath: target.absolutePath },
		sourcePath: target.absolutePath,
		entityLabel: `binary ${view.kind}`,
		immutable: true,
	});
}
