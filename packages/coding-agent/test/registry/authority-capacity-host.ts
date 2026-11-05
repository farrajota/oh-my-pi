import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthorityCapacityUnsupportedError, assertAuthorityCapacityHost } from "../../src/registry/authority/ownership";
import { authorityThreadLifetimeMode } from "../../src/registry/authority/thread-lifetime";

/**
 * Why this host cannot run real OMP_JOURNALING_CAPACITY=xfs authority under os.tmpdir(), or undefined when it can.
 *
 * Physical capacity needs Linux x86_64, PIDFD_THREAD (Linux 6.9+ with glibc 2.36+) and an XFS temp directory.
 * GitHub's hosted runners (Ubuntu 22.04: kernel 6.8, glibc 2.35, ext4) have none of the last two, so the cases
 * that fund real XFS capacity cannot run there; production refuses xfs mode on such hosts, which
 * authority-capacity-optin.test.ts proves on every host. The probe is the production host check itself, so the
 * test gate and the runtime refusal cannot disagree; any other probe failure propagates instead of skipping.
 */
async function probeXfsCapacityHost(): Promise<string | undefined> {
	try {
		await assertAuthorityCapacityHost(path.join(os.tmpdir(), "omp-capacity-host-probe.jsonl"), "xfs");
		return undefined;
	} catch (error) {
		if (error instanceof AuthorityCapacityUnsupportedError) return error.message;
		throw error;
	}
}

export const xfsCapacityHostUnavailableReason = await probeXfsCapacityHost();

/** True when real XFS capacity cases can run here; gate them with `it.skipIf(!xfsCapacityHost)`. */
export const xfsCapacityHost = xfsCapacityHostUnavailableReason === undefined;

/**
 * True when worker lifetime is proved with pidfd_open(tid, PIDFD_THREAD) (Linux 6.9+, glibc 2.36+). Hosts without
 * it, such as GitHub's Ubuntu 22.04 runners whose glibc does not even export pidfd_open, use the worker-close lifetime.
 */
export const pidfdThreadHost = authorityThreadLifetimeMode() === "pidfd-thread";

const XFS_MAGIC = 0x58465342;

/** True when os.tmpdir() itself is on XFS, for cases that pin the filesystem but not the capacity runtime. */
export const tmpdirOnXfs = (await fs.statfs(os.tmpdir())).type === XFS_MAGIC;
