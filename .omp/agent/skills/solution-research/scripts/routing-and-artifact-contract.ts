export type ArtifactIdKind = "task" | "slice" | "candidate";

const ID_PATTERNS: Record<ArtifactIdKind, RegExp> = {
	task: /^task-[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?-[0-9a-f]{12}$/,
	slice: /^slice-[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?-[0-9a-f]{12}$/,
	candidate: /^candidate-[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?-[0-9a-f]{12}$/,
};

const MAX_COMPONENT_BYTES = 64;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export type ContractError =
	| "assignment-conflict"
	| "content-conflict"
	| "fixed-cap-prohibited"
	| "identity-conflict"
	| "invalid-critic-status"
	| "invalid-hash"
	| "invalid-phase-independence"
	| "maximum-exceeded"
	| "noncanonical-id"
	| "path-conflict"
	| "redundant-task"
	| "transition-rejected"
	| "uncovered-obligation"
	| "unready-task";

export type ContractResult<T> = { ok: true; value: T } | { ok: false; error: ContractError };

export function validateArtifactId(kind: ArtifactIdKind, value: string): boolean {
	return value.length <= MAX_COMPONENT_BYTES && ID_PATTERNS[kind].test(value);
}

async function sha256Prefix(value: string): Promise<string> {
	const bytes = new TextEncoder().encode(value);
	const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0"))
		.join("")
		.slice(0, 12);
}

export async function deriveArtifactId(
	kind: ArtifactIdKind,
	label: string,
	canonicalIdentity: string,
): Promise<string> {
	const ascii = label
		.normalize("NFKD")
		.replace(/\p{Mark}/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	const slug = (ascii.slice(0, 32).replace(/-+$/g, "") || "item").slice(0, 32);
	const value = `${kind}-${slug}-${await sha256Prefix(canonicalIdentity)}`;
	if (!validateArtifactId(kind, value)) throw new Error(`Failed to derive canonical ${kind} ID`);
	return value;
}

export type WorkerArtifactLocation =
	| { phase: "criteria" | "fast-path-validation" | "selection-quorum"; taskId: string; sliceId: string }
	| { phase: "hypotheses"; wave: number; taskId: string; sliceId: string }
	| { phase: "dfs"; candidateId: string; taskId: string; sliceId: string }
	| { phase: "critique"; round: number; taskId: string; sliceId: string };

function validateOrdinal(value: number): void {
	if (!Number.isSafeInteger(value) || value < 1 || value > 9999) throw new Error("Invalid phase ordinal");
}

export function workerArtifactPath(location: WorkerArtifactLocation): string {
	if (!validateArtifactId("task", location.taskId) || !validateArtifactId("slice", location.sliceId)) {
		throw new Error("Noncanonical task or slice ID");
	}
	const suffix = `${location.taskId}/${location.sliceId}.md`;
	switch (location.phase) {
		case "criteria":
		case "fast-path-validation":
		case "selection-quorum":
			return `${location.phase}/${suffix}`;
		case "hypotheses":
			validateOrdinal(location.wave);
			return `hypotheses/wave-${location.wave}/${suffix}`;
		case "dfs":
			if (!validateArtifactId("candidate", location.candidateId)) throw new Error("Noncanonical candidate ID");
			return `dfs/${location.candidateId}/${suffix}`;
		case "critique":
			validateOrdinal(location.round);
			return `critique/round-${location.round}/${suffix}`;
	}
}

export interface MaterialTask {
	taskId: string;
	covers: string[];
	prerequisiteReady: boolean;
	independenceGroup: string;
}

export interface TaskSelectionInput {
	materialObligations: string[];
	selectedTasks: MaterialTask[];
	independenceMode: "disjoint-primary" | "overlapping-independent";
	requiredIndependentAssessments?: number;
	fixedWorkflowQuota?: number | null;
	userOrBudgetMaximum?: number | null;
}

export function validateTaskSelection(input: TaskSelectionInput): ContractResult<{ taskCount: number }> {
	if (input.fixedWorkflowQuota !== undefined && input.fixedWorkflowQuota !== null) {
		return { ok: false, error: "fixed-cap-prohibited" };
	}
	if (
		input.userOrBudgetMaximum !== undefined &&
		input.userOrBudgetMaximum !== null &&
		input.selectedTasks.length > input.userOrBudgetMaximum
	) {
		return { ok: false, error: "maximum-exceeded" };
	}
	const seenTaskIds = new Set<string>();
	for (const task of input.selectedTasks) {
		if (!validateArtifactId("task", task.taskId)) return { ok: false, error: "noncanonical-id" };
		if (!task.prerequisiteReady) return { ok: false, error: "unready-task" };
		if (seenTaskIds.has(task.taskId)) return { ok: false, error: "assignment-conflict" };
		seenTaskIds.add(task.taskId);
	}
	const obligations = new Set(input.materialObligations);
	const tasksByObligation = new Map<string, MaterialTask[]>();
	for (const task of input.selectedTasks) {
		for (const obligation of new Set(task.covers)) {
			if (!obligations.has(obligation)) continue;
			const coveringTasks = tasksByObligation.get(obligation) ?? [];
			coveringTasks.push(task);
			tasksByObligation.set(obligation, coveringTasks);
		}
	}
	for (const obligation of obligations) {
		if (!tasksByObligation.has(obligation)) return { ok: false, error: "uncovered-obligation" };
	}
	if (
		input.independenceMode === "disjoint-primary" &&
		Array.from(tasksByObligation.values()).some(tasks => tasks.length > 1)
	) {
		return { ok: false, error: "invalid-phase-independence" };
	}
	const requiredIndependentAssessments = input.requiredIndependentAssessments ?? 2;
	if (
		input.independenceMode === "overlapping-independent" &&
		(!Number.isSafeInteger(requiredIndependentAssessments) || requiredIndependentAssessments < 2)
	) {
		return { ok: false, error: "invalid-phase-independence" };
	}
	for (const [obligation, coveringTasks] of tasksByObligation) {
		if (input.independenceMode !== "overlapping-independent") continue;
		const independenceGroups = new Set(coveringTasks.map(task => task.independenceGroup));
		if (independenceGroups.size < requiredIndependentAssessments) {
			return { ok: false, error: "invalid-phase-independence" };
		}
		if (!obligations.has(obligation)) return { ok: false, error: "uncovered-obligation" };
	}
	for (const task of input.selectedTasks) {
		const uniquelyCoversMaterial = task.covers.some(
			obligation => obligations.has(obligation) && tasksByObligation.get(obligation)?.length === 1,
		);
		const requiredForIndependence =
			input.independenceMode === "overlapping-independent" &&
			task.covers.some(obligation => {
				const coveringTasks = tasksByObligation.get(obligation) ?? [];
				const groupsWithoutTask = new Set(
					coveringTasks.filter(item => item.taskId !== task.taskId).map(item => item.independenceGroup),
				);
				return groupsWithoutTask.size < requiredIndependentAssessments;
			});
		if (!uniquelyCoversMaterial && !requiredForIndependence) {
			return { ok: false, error: "redundant-task" };
		}
	}
	return { ok: true, value: { taskCount: input.selectedTasks.length } };
}

export type WorkerResultState =
	| "planned"
	| "dispatched"
	| "identity-verified"
	| "payload-validated"
	| "destination-preflighted"
	| "materialized"
	| "accepted";

const NEXT_STATE: Partial<Record<WorkerResultState, WorkerResultState>> = {
	planned: "dispatched",
	dispatched: "identity-verified",
	"identity-verified": "payload-validated",
	"payload-validated": "destination-preflighted",
	"destination-preflighted": "materialized",
	materialized: "accepted",
};

export function advanceWorkerResultState(
	current: WorkerResultState,
	next: WorkerResultState,
): ContractResult<WorkerResultState> {
	if (NEXT_STATE[current] !== next) return { ok: false, error: "transition-rejected" };
	return { ok: true, value: next };
}

export interface ReservedWorkerArtifact {
	assignmentId: string;
	assignmentState: "active" | "superseded";
	taskId: string;
	sliceId: string;
	candidateId?: string;
	frameRevision: string;
	path: string;
}

export interface WorkerEnvelopeIdentity {
	assignmentId: string;
	taskId: string;
	sliceId: string;
	candidateId?: string;
	frameRevision: string;
	canonicalSha256: string;
}

export interface ExistingWorkerArtifact extends WorkerEnvelopeIdentity {
	path: string;
}

export type MaterializationDecision =
	| { outcome: "write-new"; shouldWrite: true }
	| { outcome: "idempotent-replay"; shouldWrite: false }
	| { outcome: "rejected"; shouldWrite: false; error: ContractError };

export function preflightWorkerArtifact(input: {
	location: WorkerArtifactLocation;
	reserved: ReservedWorkerArtifact;
	envelope: WorkerEnvelopeIdentity;
	existing?: ExistingWorkerArtifact;
}): MaterializationDecision {
	const { reserved, envelope, existing } = input;
	if (
		!validateArtifactId("task", reserved.taskId) ||
		!validateArtifactId("slice", reserved.sliceId) ||
		!validateArtifactId("task", envelope.taskId) ||
		!validateArtifactId("slice", envelope.sliceId)
	) {
		return { outcome: "rejected", shouldWrite: false, error: "noncanonical-id" };
	}
	if (!SHA256_PATTERN.test(envelope.canonicalSha256)) {
		return { outcome: "rejected", shouldWrite: false, error: "invalid-hash" };
	}
	if (reserved.assignmentState === "superseded" || envelope.assignmentId !== reserved.assignmentId) {
		return { outcome: "rejected", shouldWrite: false, error: "assignment-conflict" };
	}
	if (
		envelope.taskId !== reserved.taskId ||
		envelope.sliceId !== reserved.sliceId ||
		envelope.frameRevision !== reserved.frameRevision ||
		envelope.candidateId !== reserved.candidateId ||
		input.location.taskId !== reserved.taskId ||
		input.location.sliceId !== reserved.sliceId ||
		(input.location.phase === "dfs"
			? input.location.candidateId !== reserved.candidateId
			: reserved.candidateId !== undefined)
	) {
		return { outcome: "rejected", shouldWrite: false, error: "identity-conflict" };
	}
	let expectedPath: string;
	try {
		expectedPath = workerArtifactPath(input.location);
	} catch {
		return { outcome: "rejected", shouldWrite: false, error: "noncanonical-id" };
	}
	if (reserved.path !== expectedPath) {
		return { outcome: "rejected", shouldWrite: false, error: "path-conflict" };
	}
	if (!existing) return { outcome: "write-new", shouldWrite: true };
	if (
		existing.path !== reserved.path ||
		existing.assignmentId !== reserved.assignmentId ||
		existing.taskId !== reserved.taskId ||
		existing.sliceId !== reserved.sliceId ||
		existing.candidateId !== reserved.candidateId ||
		existing.frameRevision !== reserved.frameRevision
	) {
		return { outcome: "rejected", shouldWrite: false, error: "identity-conflict" };
	}
	if (!SHA256_PATTERN.test(existing.canonicalSha256) || existing.canonicalSha256 !== envelope.canonicalSha256) {
		return { outcome: "rejected", shouldWrite: false, error: "content-conflict" };
	}
	return { outcome: "idempotent-replay", shouldWrite: false };
}

export type CriticFindingStatus = "UNRESOLVED";
export type ParentFindingDisposition = CriticFindingStatus | "REJECTED_WITH_EVIDENCE" | "FIXED" | "ACCEPTED_RISK";

export function validateCriticFindingStatus(status: string): ContractResult<CriticFindingStatus> {
	if (status === "UNRESOLVED") return { ok: true, value: "UNRESOLVED" };
	return { ok: false, error: "invalid-critic-status" };
}

export function validateParentFindingDisposition(status: string): status is ParentFindingDisposition {
	return ["UNRESOLVED", "REJECTED_WITH_EVIDENCE", "FIXED", "ACCEPTED_RISK"].includes(status);
}
