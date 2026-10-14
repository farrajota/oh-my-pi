/**
 * Descriptors omp holds for its own lifetime — session/advisor transcripts and
 * the rotating log — must not reach the commands the bash tool runs.
 *
 * The bash tool executes through the natives brush shell, which `fork`/`exec`s
 * external commands and therefore hands every descriptor not marked
 * close-on-exec to them (the same property pinned by
 * `config-value-fd-inheritance.test.ts`). Before #13224, session and log
 * descriptors were inheritable, so a command — or any daemon it started —
 * held a writable handle to the session it was launched from for its whole
 * life.
 *
 * Oracle: list the child's descriptor table. `sh -c` is required — a bare `ls`
 * resolves to an in-process builtin, whose `$$` is omp itself. A control
 * descriptor uses the same `fs.openSync(path, "a")` path as the old writer,
 * then explicitly clears `FD_CLOEXEC`, so the positive control remains valid
 * even when Bun marks newly opened descriptors close-on-exec. This ensures the
 * assertions cannot pass vacuously. `/proc` makes this Linux-only; the
 * helper's flag handling is covered on every platform by
 * `packages/utils/test/fs-open.test.ts`.
 */
import { afterAll, expect, test } from "bun:test";
import { dlopen, FFIType } from "bun:ffi";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Shell } from "@oh-my-pi/pi-natives";
import { RotatingFileSink } from "@oh-my-pi/pi-utils/logger/rotating-file";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { FileSessionStorage } from "../src/session/session-storage";

const F_GETFD = 1;
const F_SETFD = 2;
const FD_CLOEXEC = 1;
const ROOTS: string[] = [];

afterAll(async () => {
	for (const root of ROOTS) await removeWithRetries(root).catch(() => {});
});

test.skipIf(process.platform !== "linux")("bash tool children never inherit session or log descriptors", async () => {
	const root = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-session-fd-"));
	ROOTS.push(root);

	const storage = new FileSessionStorage();
	const transcript = path.join(root, "session.jsonl");
	const writer = storage.openWriter(transcript);
	await writer.append('{"type":"session_start"}\n');

	const logsDir = path.join(root, "logs");
	await fsp.mkdir(logsDir, { recursive: true });
	const logSink = new RotatingFileSink({
		directory: logsDir,
		filenamePrefix: "omp",
		filenameSuffix: String(process.pid),
		maxBytes: 1 << 20,
		maxFiles: 2,
	});
	logSink.write("entry");

	const { symbols: libc } = dlopen("libc.so.6", {
		fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
	});
	const control = path.join(root, "control.jsonl");
	const controlFd = fs.openSync(control, "a");
	const descriptorFlags = libc.fcntl(controlFd, F_GETFD, 0);
	if (descriptorFlags === -1 || libc.fcntl(controlFd, F_SETFD, descriptorFlags & ~FD_CLOEXEC) === -1) {
		fs.closeSync(controlFd);
		throw new Error("Failed to make the control descriptor inheritable");
	}

	let output = "";
	try {
		await new Shell().run({ command: "sh -c 'ls -l /proc/$$/fd'", cwd: root }, (_err, chunk) => {
			output += chunk;
		});
	} finally {
		fs.closeSync(controlFd);
		logSink.close();
		await writer.close();
	}

	const inherited = output.split("\n").filter(line => line.includes(root));
	expect(inherited.join("\n"), "control: an inheritable descriptor must reach the child").toContain(control);
	expect(inherited.join("\n")).not.toContain(transcript);
	expect(inherited.join("\n")).not.toMatch(/omp\.[\d-]+\.\d+\.log/);
});
