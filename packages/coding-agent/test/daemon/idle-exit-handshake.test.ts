/**
 * Idle exit against a connection that has not finished its hello, on a real
 * daemon isolated in a temp dir: it keeps the daemon up past its idle grace and
 * is then welcomed. Guards the fork contract of e55dfdb678 (the old broker shut
 * down under a client still authenticating) against an upstream regression.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { IpcConnection, ipcEndpoint } from "@oh-my-pi/pi-natives";
import { DAEMON_IDLE_EXIT_GRACE_ENV, DAEMON_PROTOCOL_VERSION } from "../../src/daemon/protocol";
import { TestDaemon, until } from "../fixtures/daemon-proc-harness";

const TEST_TIMEOUT_MS = 30_000;
/** Idle-exit grace (3 s by default): long enough for the harness's first connect to land before the daemon idles out. */
const IDLE_EXIT_GRACE_MS = 300;

let daemon: TestDaemon | undefined;
let raw: IpcConnection | undefined;

afterEach(async () => {
	raw?.destroy();
	raw = undefined;
	await daemon?.dispose();
	daemon = undefined;
});

/** A control-mode connection to `d` that has sent nothing yet. */
async function connectWithoutHello(d: TestDaemon): Promise<IpcConnection> {
	raw = await IpcConnection.connect(ipcEndpoint(d.dir, "daemon"), { framing: "lines", timeoutMs: 1_000 });
	return raw;
}

describe.skipIf(process.platform === "win32")("daemon idle exit during the hello", () => {
	it(
		"a connection still before its hello when the idle grace passes keeps the daemon up, and its hello is then welcomed",
		async () => {
			const started = await TestDaemon.start({ env: { [DAEMON_IDLE_EXIT_GRACE_ENV]: String(IDLE_EXIT_GRACE_MS) } });
			daemon = started.daemon;
			const d = started.daemon;
			const { pid: daemonPid } = await started.conn.request({ op: "ping" });
			const pending = await connectWithoutHello(d);
			const lines: string[] = [];
			let closed = false;
			pending.start(
				line => lines.push(line),
				() => {
					closed = true;
				},
			);

			// The last welcomed client leaves; only the connection that has not sent its hello remains.
			await started.conn.close();
			// Negative contract: the idle timer runs in the daemon process and has no observable event,
			// so a real wait past it (plus timer slack) is the only probe.
			await Bun.sleep(IDLE_EXIT_GRACE_MS + 300);
			expect(d.running).toBe(true);
			expect(closed).toBe(false);

			const token = (await fs.readFile(path.join(d.dir, "token"), "utf8")).trim();
			pending.send(
				JSON.stringify({
					v: DAEMON_PROTOCOL_VERSION,
					token,
					client: { pid: process.pid, build: "0.0.0-test", exe: [] },
				}),
			);
			const welcome = JSON.parse(await until(() => lines[0], "the welcome"));
			expect(welcome.error).toBeUndefined();
			expect(welcome.daemon.pid).toBe(daemonPid);

			pending.send(JSON.stringify({ id: "after-hello", op: "ping" }));
			const reply = JSON.parse(await until(() => lines[1], "the ping reply"));
			expect(reply).toMatchObject({ id: "after-hello", ok: true, result: { pid: daemonPid } });
		},
		TEST_TIMEOUT_MS,
	);
});
