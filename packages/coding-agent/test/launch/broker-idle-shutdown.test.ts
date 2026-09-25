// Integration test — real timers are required (ts-no-test-timers exception): this drives the actual
// cross-process daemon broker running a real child process, and the bug is a missing idle-shutdown
// rearm in #settle. Fake timers cannot control the OS process-exit promise or the unix-socket RPC,
// and shutdown is observed by awaiting the broker's own run() promise — its resolution IS the signal
// (no polling, no fixed sleep). A regression leaves the broker alive, so the test's own timeout
// surfaces the failure.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as net from "node:net";
import { TempDir } from "@oh-my-pi/pi-utils";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient } from "../../src/launch/client";
import { DAEMON_IDLE_GRACE_ENV, DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } from "../../src/launch/protocol";
import { daemonBrokerEndpoint } from "../../src/launch/paths";

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function startBroker(projectDir: string, runtimeDir: string, idleGraceMs: number): Promise<void> {
	const previousProjectDir = process.env[DAEMON_PROJECT_DIR_ENV];
	const previousRuntimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
	const previousGrace = process.env[DAEMON_IDLE_GRACE_ENV];
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = String(idleGraceMs);
	const broker = startDaemonBrokerFromEnvironment();
	restoreEnv(DAEMON_PROJECT_DIR_ENV, previousProjectDir);
	restoreEnv(DAEMON_RUNTIME_DIR_ENV, previousRuntimeDir);
	restoreEnv(DAEMON_IDLE_GRACE_ENV, previousGrace);
	return broker;
}

describe("daemon broker idle shutdown", () => {
	it("shuts down after its last persistent daemon exits with no clients", async () => {
		using tempDir = TempDir.createSync("@omp-launch-idle-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const previousTitle = process.title;
		// Create the client (writes broker.token) before starting the broker, which reads that token.
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 100 });
		const broker = startBroker(projectDir, runtimeDir, 100);
		try {
			// A persistent daemon that outlives the first idle-shutdown timer (100ms) and then
			// self-exits (~300ms). restart:"no" so its exit is terminal.
			const started = await client.request({
				op: "start",
				spec: {
					name: "persistent-temp",
					application: process.execPath,
					args: ["-e", "setTimeout(() => {}, 300)"],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: true,
					detached: false,
				},
			});
			expect(started.op).toBe("start");

			// Disconnect the final client. The broker keeps the persistent daemon alive, so the
			// idle timer this arms fires while the daemon is still live and returns without rearming.
			client.close();

			// When the daemon self-exits, terminal settlement must rearm idle shutdown; the broker
			// then releases its lease and run() resolves. Awaiting the broker promise IS the shutdown
			// signal. Before the fix nothing rearmed, so this await never resolved and the test timed
			// out — the regression this guards.
			await broker;
		} finally {
			process.title = previousTitle;
		}
	}, 30_000);

	it("keeps a pending client handshake alive past idle grace", async () => {
		using tempDir = TempDir.createSync("@omp-launch-handshake-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const previousTitle = process.title;
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 100 });
		const token = (await fs.readFile(path.join(runtimeDir, "broker.token"), "utf8")).trim();
		const broker = startBroker(projectDir, runtimeDir, 100);
		await client.request({ op: "ping" });
		const socket = net.createConnection({ path: daemonBrokerEndpoint(projectDir, runtimeDir) });
		try {
			const connected = Promise.withResolvers<void>();
			socket.once("connect", connected.resolve);
			socket.once("error", connected.reject);
			await connected.promise;
			client.close();
			// This race requires the real broker timer to elapse while the accepted socket stays open.
			const idleGraceElapsed = Promise.withResolvers<void>();
			setTimeout(idleGraceElapsed.resolve, 150);
			await idleGraceElapsed.promise;
			if (socket.destroyed) throw new Error("Broker closed before authenticating the pending request");

			const response = Promise.withResolvers<{ ok: boolean; result?: { op: string } }>();
			let buffer = "";
			const onData = (chunk: Buffer): void => {
				buffer += chunk.toString("utf8");
				const newline = buffer.indexOf("\n");
				if (newline < 0) return;
				socket.off("data", onData);
				socket.off("error", onError);
				socket.off("close", onClose);
				try {
					response.resolve(JSON.parse(buffer.slice(0, newline)));
				} catch (error) {
					response.reject(error);
				}
			};
			const onError = (error: Error): void => {
				socket.off("data", onData);
				socket.off("close", onClose);
				response.reject(error);
			};
			const onClose = (): void => {
				socket.off("data", onData);
				socket.off("error", onError);
				response.reject(new Error("Broker closed before authenticating the pending request"));
			};
			socket.on("data", onData);
			socket.once("error", onError);
			socket.once("close", onClose);

			socket.write(
				`${JSON.stringify({
					id: "pending-handshake",
					token,
					owners: [],
					detachedOwners: [],
					completionEvents: true,
					completionSubscriptionId: "pending-handshake",
					completionUnsubscribes: [],
					completionReplays: [],
					operation: { op: "ping" },
				})}\n`,
			);
			expect(await response.promise).toMatchObject({ ok: true, result: { op: "ping" } });
		} finally {
			socket.destroy();
			client.close();
			try {
				await broker;
			} finally {
				process.title = previousTitle;
			}
		}
	}, 30_000);
});
