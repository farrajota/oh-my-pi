import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { watch } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $which, acquireFileLock } from "@oh-my-pi/pi-utils";
import type { IdbLocation } from "../../src/ida/store";
import { IdaWorker } from "../../src/ida/supervisor";

const pythonPath = Bun.env.PYTHON ?? ($which("python3") ? "python3" : "python");

/** Permissive stand-ins for idalib's modules so `worker.py` runs its real protocol loop without IDA. */
const STUB = `
class _Any:
    def __init__(self, *args, **kwargs):
        pass
    def __call__(self, *args, **kwargs):
        return _Any()
    def __getattr__(self, name):
        return _Any()
    def __iter__(self):
        return iter(())
    def __bool__(self):
        return False
    def hook(self):
        return True

def module_getattr(name):
    if name.startswith("__"):
        raise AttributeError(name)
    return type(name, (_Any,), {})
`;
const STUB_MODULE = "from _omp_ida_stub import _Any, module_getattr as __getattr__\n";
const STUB_MODULES = [
	"idapro",
	"ida_auto",
	"ida_bytes",
	"ida_funcs",
	"ida_hexrays",
	"ida_idaapi",
	"ida_idp",
	"ida_lines",
	"ida_loader",
	"ida_nalt",
	"ida_name",
	"ida_segment",
	"ida_typeinf",
	"ida_ua",
	"ida_xref",
	"idautils",
];
const STUB_DATABASE = `${STUB_MODULE}
class Database(_Any):
    module = "stub.bin"
    format = "stub"
    architecture = "metapc"
    bitness = 64

    @classmethod
    def open(cls, *args, **kwargs):
        return cls()

    def close(self, save=False):
        pass
`;

interface ExecResult {
	value: string | null;
	error: string | null;
}

function watchForFile(file: string): { promise: Promise<void>; close(): void } {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	let settled = false;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	const watcher = watch(path.dirname(file), (_event, name) => {
		if (name?.toString() !== path.basename(file)) return;
		void fs.access(file).then(
			() => {
				if (settled) return;
				settled = true;
				watcher.close();
				resolve();
			},
			() => {},
		);
	});
	watcher.on("error", error => {
		if (settled) return;
		settled = true;
		watcher.close();
		reject(error);
	});
	void fs.access(file).then(
		() => {
			if (settled) return;
			settled = true;
			watcher.close();
			resolve();
		},
		() => {},
	);
	return {
		promise,
		close: () => {
			watcher.close();
		},
	};
}

describe("IDA worker protocol", () => {
	let dir: string;
	let worker: IdaWorker;

	beforeAll(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "ida-worker-"));
		const stubs = path.join(dir, "stubs");
		await Bun.write(path.join(stubs, "_omp_ida_stub.py"), STUB);
		for (const name of STUB_MODULES) await Bun.write(path.join(stubs, `${name}.py`), STUB_MODULE);
		await Bun.write(path.join(stubs, "ida_domain", "__init__.py"), STUB_DATABASE);
		await Bun.write(path.join(stubs, "ida_domain", "database.py"), STUB_MODULE);
		await Bun.write(path.join(stubs, "ida_domain", "xrefs.py"), STUB_MODULE);

		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
		env.PYTHONPATH = stubs;
		env.PYTHONUNBUFFERED = "1";
		env.PYTHONIOENCODING = "utf-8";
		const loc: IdbLocation = {
			id: "stub",
			dir,
			sourcePath: path.join(dir, "stub.bin"),
			kind: "inplace",
			openPath: path.join(dir, "stub.i64"),
			isNew: false,
			lockTarget: path.join(dir, "stub.i64"),
		};
		const lock = await acquireFileLock(loc.lockTarget);
		worker = await IdaWorker.start(loc, { pythonPath, env }, lock, 0);
	});

	afterAll(async () => {
		await worker?.close({ save: false }).catch(() => {});
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("interrupts a running exec and keeps answering the next request on the same worker", async () => {
		const pid = worker.pid;
		const interrupted = await worker.request<ExecResult>("exec", { code: "while True: pass" }, { timeoutMs: 300 });
		expect(interrupted.error).toContain("KeyboardInterrupt");

		const next = await worker.request<ExecResult>("exec", { code: "6 * 7" });
		expect(next).toMatchObject({ value: "42", error: null });
		expect(worker.pid).toBe(pid);
	});

	it("contains an interrupt that arrives while uninterruptible native code runs", async () => {
		const pid = worker.pid;
		const marker = path.join(dir, "native-expression-dispatched");
		const temporaryMarker = `${marker}.tmp`;
		const nativeDispatched = watchForFile(marker);
		const interrupt = new AbortController();
		const nativeExec = [
			"import os",
			`with open(${JSON.stringify(temporaryMarker)}, "w") as marker_file: marker_file.write("dispatched")`,
			`os.replace(${JSON.stringify(temporaryMarker)}, ${JSON.stringify(marker)})`,
			"x = sum(range(60_000_000))",
			"x",
		].join("\n");
		try {
			const pending = worker.request<ExecResult>("exec", { code: nativeExec }, { signal: interrupt.signal });
			await Promise.race([
				nativeDispatched.promise,
				pending.then(() => {
					throw new Error("IDA exec completed before its native-work handshake");
				}),
			]);
			// Abort only after the worker has dispatched the native expression, rather than relying on a fixed 100 ms race.
			interrupt.abort();
			const late = await pending;
			expect(late.value === "1799999970000000" || late.error?.includes("KeyboardInterrupt")).toBe(true);
		} finally {
			nativeDispatched.close();
		}

		for (let i = 0; i < 5; i++) {
			const next = await worker.request<ExecResult>("exec", { code: `${i} + 1` });
			expect(next).toMatchObject({ value: String(i + 1), error: null });
		}
		expect(worker.pid).toBe(pid);
	});
});
