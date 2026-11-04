import {
	acquireAuthorityOwnership,
	withAuthorityRelocationExclusive,
	type AuthorityRelocationLockRequest,
} from "../../src/registry/authority/ownership";

async function main(): Promise<void> {
	const [mode, serializedRequest] = process.argv.slice(2);
	if (
		mode !== "hold" &&
		mode !== "hold-fail" &&
		mode !== "try" &&
		mode !== "ordinary-try" &&
		mode !== "reserve-target"
	)
		throw new Error("Relocation fixture requires hold, hold-fail, try, ordinary-try or reserve-target mode");
	if (!serializedRequest) throw new Error("Relocation fixture requires a request");
	const request = JSON.parse(serializedRequest) as AuthorityRelocationLockRequest;
	const holdsLocks = mode === "hold" || mode === "hold-fail" || mode === "reserve-target";
	try {
		if (mode === "ordinary-try") {
			const ownership = await acquireAuthorityOwnership(request.target.sessionFile, {
				owningSessionId: request.owningSessionId,
			});
			try {
				process.stdout.write(`${JSON.stringify({ acquired: true })}\n`);
			} finally {
				await ownership.release();
			}
		} else {
			await withAuthorityRelocationExclusive(request, async context => {
				process.stdout.write(
					`${JSON.stringify({ acquired: true, sourceCount: context.sources.length, targetPhysicalIdentity: context.target.physicalIdentity })}\n`,
				);
				if (holdsLocks) await waitForRelease();
			});
		}
		if (holdsLocks) {
			process.stdout.write("Relocation locks released\n");
			process.stderr.write("Relocation release diagnostics\n");
			if (mode === "hold-fail") throw new Error("injected relocation failure after release");
		}
	} catch (error) {
		process.stdout.write(
			`${JSON.stringify({ acquired: false, error: error instanceof Error ? error.message : String(error) })}\n`,
		);
		if (holdsLocks) process.exitCode = 1;
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
