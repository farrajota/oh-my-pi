import { describe, expect, it } from "bun:test";
import {
	advanceWorkerResultState,
	deriveArtifactId,
	preflightWorkerArtifact,
	validateArtifactId,
	validateCriticFindingStatus,
	validateParentFindingDisposition,
	validateTaskSelection,
	workerArtifactPath,
	type ReservedWorkerArtifact,
	type WorkerArtifactLocation,
	type WorkerEnvelopeIdentity,
	type WorkerResultState,
} from "./routing-and-artifact-contract";

const taskId = await deriveArtifactId("task", "Security review", "topic:criteria:security");
const sliceId = await deriveArtifactId("slice", "Authentication boundary", "topic:criteria:security:auth");
const candidateId = await deriveArtifactId("candidate", "Native capability", "topic:candidate:native");
const frameRevision = "frame-7f87af38";
const assignmentId = "criteria-security-auth-v1";
const canonicalSha256 = "a".repeat(64);
const location: WorkerArtifactLocation = { phase: "criteria", taskId, sliceId };
const path = workerArtifactPath(location);
const reserved: ReservedWorkerArtifact = {
	assignmentId,
	assignmentState: "active",
	taskId,
	sliceId,
	frameRevision,
	path,
};
const envelope: WorkerEnvelopeIdentity = {
	assignmentId,
	taskId,
	sliceId,
	frameRevision,
	canonicalSha256,
};

describe("filesystem-safe worker artifact identities", () => {
	it("derives bounded ASCII components and reserved phase paths from hostile labels", async () => {
		const hostileTaskId = await deriveArtifactId("task", "../../Résumé / secrets", "topic:criteria:hostile");
		const hostileSliceId = await deriveArtifactId("slice", "..\\escape", "topic:criteria:hostile:slice");
		const dfsPath = workerArtifactPath({ phase: "dfs", candidateId, taskId: hostileTaskId, sliceId: hostileSliceId });

		expect(validateArtifactId("task", hostileTaskId)).toBe(true);
		expect(validateArtifactId("slice", hostileSliceId)).toBe(true);
		expect(hostileTaskId.length).toBeLessThanOrEqual(64);
		expect(hostileSliceId.length).toBeLessThanOrEqual(64);
		expect(hostileTaskId).not.toContain("/");
		expect(hostileSliceId).not.toContain("\\");
		expect(dfsPath).toBe(`dfs/${candidateId}/${hostileTaskId}/${hostileSliceId}.md`);
		expect(await deriveArtifactId("task", "X", "abc")).toBe("task-x-ba7816bf8f01");
	});

	it("rejects traversal and overlong worker-supplied path components before path construction", () => {
		expect(() => workerArtifactPath({ phase: "criteria", taskId: "../escape", sliceId })).toThrow(
			"Noncanonical task or slice ID",
		);
		expect(() =>
			workerArtifactPath({
				phase: "criteria",
				taskId: `task-${"a".repeat(65)}-aaaaaaaaaaaa`,
				sliceId,
			}),
		).toThrow("Noncanonical task or slice ID");
		expect(() =>
			workerArtifactPath({ phase: "dfs", candidateId: "candidate-../../escape", taskId, sliceId }),
		).toThrow("Noncanonical candidate ID");
	});
});

const materialTasks = [
	{
		taskId: await deriveArtifactId("task", "Security", "task:security"),
		covers: ["security"],
		prerequisiteReady: true,
		independenceGroup: "security-source",
	},
	{
		taskId: await deriveArtifactId("task", "Operations", "task:operations"),
		covers: ["operations"],
		prerequisiteReady: true,
		independenceGroup: "operations-source",
	},
	{
		taskId: await deriveArtifactId("task", "Data", "task:data"),
		covers: ["data"],
		prerequisiteReady: true,
		independenceGroup: "data-source",
	},
];

describe("coverage-driven task selection", () => {
	it("retains every nonredundant prerequisite-ready task even when more than two are required", () => {
		const result = validateTaskSelection({
			materialObligations: ["security", "operations", "data"],
			selectedTasks: materialTasks,
			independenceMode: "disjoint-primary",
			fixedWorkflowQuota: null,
			userOrBudgetMaximum: 4,
		});

		expect(result).toEqual({ ok: true, value: { taskCount: 3 } });
	});

	it("rejects a fixed workflow quota but enforces a user or budget maximum", () => {
		expect(
			validateTaskSelection({
				materialObligations: ["security", "operations", "data"],
				selectedTasks: materialTasks,
				independenceMode: "disjoint-primary",
				fixedWorkflowQuota: 2,
			}),
		).toEqual({ ok: false, error: "fixed-cap-prohibited" });
		expect(
			validateTaskSelection({
				materialObligations: ["security", "operations", "data"],
				selectedTasks: materialTasks,
				independenceMode: "disjoint-primary",
				userOrBudgetMaximum: 2,
			}),
		).toEqual({ ok: false, error: "maximum-exceeded" });
	});

	it("allows the smallest independently sourced overlap required by quorum phases", async () => {
		const quorumTasks = [
			{
				taskId: await deriveArtifactId("task", "Quorum A", "task:quorum:a"),
				covers: ["selected-candidate"],
				prerequisiteReady: true,
				independenceGroup: "provider-a",
			},
			{
				taskId: await deriveArtifactId("task", "Quorum B", "task:quorum:b"),
				covers: ["selected-candidate"],
				prerequisiteReady: true,
				independenceGroup: "provider-b",
			},
		];

		expect(
			validateTaskSelection({
				materialObligations: ["selected-candidate"],
				selectedTasks: quorumTasks,
				independenceMode: "overlapping-independent",
				requiredIndependentAssessments: 2,
			}),
		).toEqual({ ok: true, value: { taskCount: 2 } });
	});

	it("rejects extra overlapping tasks beyond the phase independence requirement", async () => {
		const overlappingTasks = await Promise.all(
			["provider-a", "provider-b", "provider-c"].map(async independenceGroup => ({
				taskId: await deriveArtifactId("task", independenceGroup, `task:quorum:${independenceGroup}`),
				covers: ["selected-candidate"],
				prerequisiteReady: true,
				independenceGroup,
			})),
		);

		expect(
			validateTaskSelection({
				materialObligations: ["selected-candidate"],
				selectedTasks: overlappingTasks,
				independenceMode: "overlapping-independent",
				requiredIndependentAssessments: 2,
			}),
		).toEqual({ ok: false, error: "redundant-task" });
	});
});

describe("worker result lifecycle", () => {
	it("accepts only the complete ordered transition sequence", () => {
		const states: WorkerResultState[] = [
			"planned",
			"dispatched",
			"identity-verified",
			"payload-validated",
			"destination-preflighted",
			"materialized",
			"accepted",
		];

		for (let index = 0; index < states.length - 1; index += 1) {
			expect(advanceWorkerResultState(states[index], states[index + 1])).toEqual({
				ok: true,
				value: states[index + 1],
			});
		}
	});

	it("rejects materialization without preflight and acceptance before materialization", () => {
		expect(advanceWorkerResultState("payload-validated", "materialized")).toEqual({
			ok: false,
			error: "transition-rejected",
		});
		expect(advanceWorkerResultState("destination-preflighted", "accepted")).toEqual({
			ok: false,
			error: "transition-rejected",
		});
	});
});

describe("materialization preflight", () => {
	it("permits a collision-free create-if-absent write", () => {
		expect(preflightWorkerArtifact({ location, reserved, envelope })).toEqual({
			outcome: "write-new",
			shouldWrite: true,
		});
	});

	it("treats the same assignment and canonical bytes as an idempotent replay", () => {
		expect(
			preflightWorkerArtifact({
				location,
				reserved,
				envelope,
				existing: { ...envelope, path },
			}),
		).toEqual({ outcome: "idempotent-replay", shouldWrite: false });
	});

	it("rejects different bytes for the same reserved identity before writing", () => {
		expect(
			preflightWorkerArtifact({
				location,
				reserved,
				envelope: { ...envelope, canonicalSha256: "b".repeat(64) },
				existing: { ...envelope, path },
			}),
		).toEqual({ outcome: "rejected", shouldWrite: false, error: "content-conflict" });
	});

	it("rejects a competing or superseded assignment while preserving replay reachability", () => {
		expect(
			preflightWorkerArtifact({
				location,
				reserved,
				envelope: { ...envelope, assignmentId: "criteria-security-auth-v2" },
			}),
		).toEqual({ outcome: "rejected", shouldWrite: false, error: "assignment-conflict" });
		expect(
			preflightWorkerArtifact({
				location,
				reserved: { ...reserved, assignmentState: "superseded" },
				envelope,
			}),
		).toEqual({ outcome: "rejected", shouldWrite: false, error: "assignment-conflict" });
	});

	it("rejects noncanonical envelope identities before writing", () => {
		expect(
			preflightWorkerArtifact({
				location,
				reserved,
				envelope: { ...envelope, taskId: "../escape" },
			}),
		).toEqual({ outcome: "rejected", shouldWrite: false, error: "noncanonical-id" });
	});

	it("binds the proposed location to the reserved task and slice before writing", async () => {
		const competingTaskId = await deriveArtifactId("task", "Competing task", "task:competing");
		const competingLocation: WorkerArtifactLocation = { ...location, taskId: competingTaskId };
		expect(
			preflightWorkerArtifact({
				location: competingLocation,
				reserved: { ...reserved, path: workerArtifactPath(competingLocation) },
				envelope,
			}),
		).toEqual({ outcome: "rejected", shouldWrite: false, error: "identity-conflict" });
	});

	it("binds a DFS candidate location to its reserved candidate identity", async () => {
		const dfsLocation = { phase: "dfs", candidateId, taskId, sliceId } satisfies WorkerArtifactLocation;
		const dfsReserved = { ...reserved, candidateId, path: workerArtifactPath(dfsLocation) };
		const dfsEnvelope = { ...envelope, candidateId };
		const competingCandidateId = await deriveArtifactId("candidate", "Competing", "candidate:competing");
		const competingLocation: WorkerArtifactLocation = { ...dfsLocation, candidateId: competingCandidateId };
		expect(
			preflightWorkerArtifact({
				location: competingLocation,
				reserved: { ...dfsReserved, path: workerArtifactPath(competingLocation) },
				envelope: dfsEnvelope,
			}),
		).toEqual({ outcome: "rejected", shouldWrite: false, error: "identity-conflict" });
	});
});

describe("critic and parent disposition ownership", () => {
	it("allows critics to emit only unresolved findings", () => {
		expect(validateCriticFindingStatus("UNRESOLVED")).toEqual({ ok: true, value: "UNRESOLVED" });
		for (const status of ["REJECTED_WITH_EVIDENCE", "FIXED", "ACCEPTED_RISK"]) {
			expect(validateCriticFindingStatus(status)).toEqual({
				ok: false,
				error: "invalid-critic-status",
			});
		}
	});

	it("reserves every finding disposition for the parent", () => {
		expect(validateParentFindingDisposition("UNRESOLVED")).toBe(true);
		expect(validateParentFindingDisposition("REJECTED_WITH_EVIDENCE")).toBe(true);
		expect(validateParentFindingDisposition("FIXED")).toBe(true);
		expect(validateParentFindingDisposition("ACCEPTED_RISK")).toBe(true);
	});
});
