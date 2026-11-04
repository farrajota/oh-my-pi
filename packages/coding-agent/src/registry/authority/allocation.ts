import * as path from "node:path";
import { canonicalAuthoritySession, readAuthoritySessionId } from "./ownership";

declare const allocationBrand: unique symbol;
export interface FreshAuthorityRootAllocation {
	readonly [allocationBrand]: true;
}

interface AllocationState {
	readonly sessionFile: string;
	readonly owningSessionId: string;
	active: boolean;
	consuming: boolean;
}

const allocations = new Map<string, AllocationState>();
const tokens = new WeakMap<FreshAuthorityRootAllocation, AllocationState>();

export function issueFreshAuthorityRootAllocation(
	sessionFile: string,
	owningSessionId: string,
): FreshAuthorityRootAllocation {
	if (!owningSessionId || allocations.has(owningSessionId))
		throw new Error(`Fresh authority allocation already exists or has invalid UUID: ${owningSessionId}`);
	const state: AllocationState = {
		sessionFile: path.resolve(sessionFile),
		owningSessionId,
		active: true,
		consuming: false,
	};
	const token = {} as FreshAuthorityRootAllocation;
	allocations.set(owningSessionId, state);
	tokens.set(token, state);
	return token;
}

export function revokeFreshAuthorityRootAllocation(allocation: FreshAuthorityRootAllocation): void {
	const state = tokens.get(allocation);
	if (!state) return;
	state.active = false;
	if (!state.consuming && allocations.get(state.owningSessionId) === state) allocations.delete(state.owningSessionId);
}

export async function consumeFreshAuthorityRootAllocation(sessionFile: string, owningSessionId: string): Promise<void> {
	const state = allocations.get(owningSessionId);
	if (!state || !state.active || state.consuming)
		throw new Error(`No fresh authority root allocation for ${owningSessionId}`);
	// Keep the UUID reserved until every validation await settles, including after revocation.
	state.consuming = true;
	try {
		const allocated = await canonicalAuthoritySession(state.sessionFile);
		const requested = await canonicalAuthoritySession(sessionFile);
		if (
			!state.active ||
			allocated !== requested ||
			(await readAuthoritySessionId(requested)) !== owningSessionId ||
			!state.active
		) {
			throw new Error(`Fresh authority allocation does not match transcript ${sessionFile}`);
		}
	} finally {
		state.active = false;
		if (allocations.get(owningSessionId) === state) allocations.delete(owningSessionId);
	}
}
