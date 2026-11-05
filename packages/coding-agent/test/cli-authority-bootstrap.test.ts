import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			text += decoder.decode(value, { stream: true });
		}
		return text + decoder.decode();
	} finally {
		reader.releaseLock();
	}
}

describe("authority environment bootstrap", () => {
	it("rejects a non-exact backend value before CLI command dispatch", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-bootstrap-"));
		try {
			const cliEntry = path.resolve(import.meta.dir, "../src/cli.ts");
			const childEnv: Record<string, string | undefined> = {
				...process.env,
				HOME: root,
				USERPROFILE: root,
				PI_CONFIG_DIR: path.join(root, ".omp"),
				OMP_JOURNALING_BACKEND: "SQLite",
			};
			delete childEnv.OMP_PROFILE;
			delete childEnv.PI_PROFILE;
			delete childEnv.PI_CODING_AGENT_DIR;
			const child = Bun.spawn([process.execPath, cliEntry, "--version"], {
				cwd: root,
				env: childEnv,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				readStream(child.stdout as ReadableStream<Uint8Array>),
				readStream(child.stderr as ReadableStream<Uint8Array>),
				child.exited,
			]);

			expect(exitCode, stderr).not.toBe(0);
			expect(stderr).toContain("OMP_JOURNALING_BACKEND");
			expect(stdout).not.toContain("version");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	}, 30_000);
	it("rejects a non-exact capacity value with one line before CLI command dispatch", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-capacity-bootstrap-"));
		try {
			const cliEntry = path.resolve(import.meta.dir, "../src/cli.ts");
			const childEnv: Record<string, string | undefined> = {
				...process.env,
				HOME: root,
				USERPROFILE: root,
				PI_CONFIG_DIR: path.join(root, ".omp"),
				OMP_JOURNALING_CAPACITY: "XFS",
			};
			delete childEnv.OMP_JOURNALING_BACKEND;
			delete childEnv.OMP_PROFILE;
			delete childEnv.PI_PROFILE;
			delete childEnv.PI_CODING_AGENT_DIR;
			const child = Bun.spawn([process.execPath, cliEntry, "--version"], {
				cwd: root,
				env: childEnv,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				readStream(child.stdout as ReadableStream<Uint8Array>),
				readStream(child.stderr as ReadableStream<Uint8Array>),
				child.exited,
			]);

			expect(exitCode, stderr).not.toBe(0);
			expect(stderr.trimEnd().split("\n")).toEqual([
				'Error: Invalid OMP_JOURNALING_CAPACITY value "XFS"; expected exactly "off" or "xfs"',
			]);
			expect(stdout).not.toContain("version");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	}, 30_000);
	it("routes the authority selector into the worker handler before CLI command routing", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-authority-worker-dispatch-"));
		try {
			const cliEntry = path.resolve(import.meta.dir, "../src/cli.ts");
			const child = Bun.spawn([process.execPath, cliEntry, "__omp_worker_authority"], {
				cwd: root,
				env: {
					...process.env,
					HOME: root,
					USERPROFILE: root,
					PI_CONFIG_DIR: path.join(root, ".omp"),
					OMP_JOURNALING_BACKEND: "jsonl",
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stderr, exitCode] = await Promise.all([
				readStream(child.stderr as ReadableStream<Uint8Array>),
				child.exited,
			]);

			expect(exitCode, stderr).not.toBe(0);
			expect(stderr).toContain("Authority worker requires a Bun worker parent port");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	}, 30_000);
});
