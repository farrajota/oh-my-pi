import {
	closeSessionAuthority,
	registryDurableStateForSession,
	validateJournalingEnvironment,
} from "../../src/registry/authority";
import { AuthorityRpcClient } from "../../src/registry/authority/client";
import { acquireAuthorityOwnership } from "../../src/registry/authority/ownership";

async function main(): Promise<void> {
	const [mode, session] = process.argv.slice(2);
	if (mode === "close-release-reject") {
		if (!session) throw new Error("Close fixture requires a session path");
		const ownership = await acquireAuthorityOwnership(session, { owningSessionId: "root-uuid", create: true });
		const releaseEntered = Promise.withResolvers<void>();
		const releaseAllowed = Promise.withResolvers<void>();
		const failure = new Error("injected ownership release failure");
		let releases = 0;
		const client = await AuthorityRpcClient.open(
			{
				path: ownership.paths.jsonl,
				identity: { backend: "jsonl", owningSessionId: "root-uuid", incarnation: crypto.randomUUID(), format: 2 },
				create: true,
			},
			{
				...ownership,
				async release() {
					releases++;
					releaseEntered.resolve();
					await releaseAllowed.promise;
					await ownership.release();
					throw failure;
				},
			},
		);
		const first = client.close();
		const second = client.close();
		const observedFirst = first.catch(error => error);
		const observedSecond = second.catch(error => error);
		await releaseEntered.promise;
		let prematureSuccess = false;
		const third = client.close();
		const observedThird = third.then(
			() => {
				prematureSuccess = true;
			},
			error => error,
		);
		await Promise.resolve();
		const premature = prematureSuccess;
		releaseAllowed.resolve();
		const failures: unknown[] = await Promise.all([observedFirst, observedSecond, observedThird]);
		const terminal = await client.close().catch(error => error);
		process.stdout.write(
			`${JSON.stringify({
				samePromise: first === second && first === third,
				prematureSuccess: premature,
				releases,
				failures: failures.map(error => (error instanceof Error ? error.message : String(error))),
				sameFailure: failures.every(error => error === failure) && terminal === failure,
			})}\n`,
		);
		return;
	}
	if (mode === "env") {
		process.env.OMP_JOURNALING_BACKEND = " ";
		let invalidRejected = false;
		try {
			validateJournalingEnvironment();
		} catch {
			invalidRejected = true;
		}
		process.env.OMP_JOURNALING_BACKEND = "sqlite";
		const parsed = validateJournalingEnvironment();
		process.env.OMP_JOURNALING_BACKEND = "jsonl";
		const cached = validateJournalingEnvironment();
		process.stdout.write(`${JSON.stringify({ invalidRejected, parsed, cached })}\n`);
		return;
	}
	if ((mode !== "hold" && mode !== "try") || !session)
		throw new Error("Authority process fixture requires a mode and session path");

	try {
		await registryDurableStateForSession(session, { create: true });
		process.stdout.write(`${JSON.stringify({ acquired: true })}\n`);
		if (mode === "hold") await waitForRelease();
		await closeSessionAuthority(session);
	} catch (error) {
		process.stdout.write(
			`${JSON.stringify({ acquired: false, error: error instanceof Error ? error.message : String(error) })}\n`,
		);
		if (mode === "hold") process.exitCode = 1;
	}
}

function waitForRelease(): Promise<void> {
	const released = Promise.withResolvers<void>();
	process.stdin.once("data", () => released.resolve());
	process.stdin.once("end", () => released.resolve());
	return released.promise;
}

void main().catch(error => {
	process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
	process.exitCode = 1;
});
