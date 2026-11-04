import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AuthorityRpcClient } from "../../src/registry/authority/client";
import { acquireAuthorityOwnership } from "../../src/registry/authority/ownership";
import type { AuthorityStore } from "../../src/registry/authority/types";
import {
	bindSessionOperationAuthority,
	bindSessionOperationDurability,
	installSessionOperationLedger,
	issueBoundSessionOperationAuthority,
} from "../../src/registry/operation-lease";

/** Live host-managed jsonl root authority store for a fresh root transcript in `directory`. */
export async function createRootAuthorityStore(
	directory: string,
): Promise<{ store: AuthorityStore; close: () => Promise<void> }> {
	const sessionFile = path.join(directory, "session.jsonl");
	await fs.writeFile(sessionFile, '{"type":"session","id":"root"}\n');
	const ownership = await acquireAuthorityOwnership(sessionFile, { owningSessionId: "root", create: true });
	const client = await AuthorityRpcClient.open(
		{
			path: ownership.paths.jsonl,
			identity: { backend: "jsonl", owningSessionId: "root", incarnation: Bun.randomUUIDv7(), format: 2 },
			create: true,
		},
		ownership,
	);
	return { store: client as AuthorityRpcClient & AuthorityStore, close: () => client.close() };
}

/** Root ("Main") session operation ledger bound to `store`, as the sdk installs it for a live root. */
export async function createBoundOperationLedger(
	store: AuthorityStore,
): Promise<{ manager: object; close: () => Promise<void> }> {
	const manager = {};
	const control = installSessionOperationLedger(manager);
	bindSessionOperationDurability(manager, store);
	const authority = issueBoundSessionOperationAuthority(
		{ capability: {}, actorId: "Main", rootId: "Main", generation: 1, sessionFile: null, validate: () => true },
		manager,
	);
	await bindSessionOperationAuthority(manager, authority);
	return { manager, close: () => control.close() };
}
