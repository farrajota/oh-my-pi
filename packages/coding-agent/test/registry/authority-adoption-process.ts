// Child process for authority-adoption.test.ts: resumes one root (no creation evidence) and reports
// the outcome as one JSON line. `hold <ms>` keeps the opened store for that long before closing it.
import type { AuthorityAdoption } from "../../src/registry/authority";
import { closeSessionAuthority, registryDurableStateForSession } from "../../src/registry/authority";

const [session, owningSessionId, holdMs = "0"] = process.argv.slice(2);
if (!session || !owningSessionId) throw new Error("Usage: authority-adoption-process.ts <session> <uuid> [holdMs]");
let adoption: AuthorityAdoption | undefined;
try {
	const store = await registryDurableStateForSession(session, {
		owningSessionId,
		onAdopted: value => {
			adoption = value;
		},
	});
	process.stdout.write(
		`${JSON.stringify({ ok: true, backend: store.identity.backend, adoption: adoption?.kind ?? null })}\n`,
	);
	await Bun.sleep(Number(holdMs));
	await closeSessionAuthority(session);
} catch (error) {
	process.stdout.write(
		`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`,
	);
}
