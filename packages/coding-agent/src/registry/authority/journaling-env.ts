import type { JournalingBackend } from "./types";

/**
 * Runtime admission policy for physical authority capacity. `off` (the default) admits writes without a
 * physical disk reserve and runs on every supported host; `xfs` enables the qualified reserve, which
 * requires Linux x86_64 with the session directory on XFS. It is never persisted: the same root may be
 * opened under either value.
 */
export type JournalingCapacity = "off" | "xfs";

export interface JournalingEnvironment {
	readonly backend: JournalingBackend;
	readonly capacity: JournalingCapacity;
}

// Kept free of the authority runtime graph so CLI startup can validate the backend
// without loading the worker client or its native addon.
let processEnvironment: JournalingEnvironment | undefined;

export function parseJournalingBackend(value: string | undefined): JournalingBackend {
	if (value === undefined) return "jsonl";
	if (value === "jsonl" || value === "sqlite") return value;
	throw new Error(
		`Invalid OMP_JOURNALING_BACKEND value ${JSON.stringify(value)}; expected exactly "jsonl" or "sqlite"`,
	);
}

export function parseJournalingCapacity(value: string | undefined): JournalingCapacity {
	if (value === undefined) return "off";
	if (value === "off" || value === "xfs") return value;
	throw new Error(`Invalid OMP_JOURNALING_CAPACITY value ${JSON.stringify(value)}; expected exactly "off" or "xfs"`);
}

/**
 * Parses both journaling variables once (at CLI or SDK bootstrap, before any authority mutation) and
 * caches the typed result for the process. Later calls return the cached choice without re-reading the
 * environment.
 */
export function journalingEnvironment(): JournalingEnvironment {
	if (processEnvironment !== undefined) return processEnvironment;
	const backend = parseJournalingBackend(process.env.OMP_JOURNALING_BACKEND);
	const capacity = parseJournalingCapacity(process.env.OMP_JOURNALING_CAPACITY);
	processEnvironment = Object.freeze({ backend, capacity });
	return processEnvironment;
}

export function validateJournalingEnvironment(): JournalingBackend {
	return journalingEnvironment().backend;
}

export function journalingCapacity(): JournalingCapacity {
	return journalingEnvironment().capacity;
}
