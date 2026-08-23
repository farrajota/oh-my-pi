import { writeFile } from "node:fs/promises";
import { visualSetSha256 } from "../schemas/approval-dossier.ts";
import type { VisualSet } from "../schemas/approval-dossier.ts";
import {
	createApprovalResponse,
	createCandidateBinding,
	createMarkdownFileRecord,
} from "./approval-dossier-runtime.ts";
import { renderApprovalDossier } from "./approval-dossier-renderer.ts";
import { nativeVisualSha256 } from "./native-svg-projector.ts";
import type { NativeVisual } from "./native-svg-projector.ts";
const FIXTURE_SEMANTIC_SHA256 = "1".repeat(64);
const FIXTURE_RUNTIME_SHA256 = "2".repeat(64);
const FIXTURE_REVIEW_SHA256 = "3".repeat(64);
const FIXTURE_MARKDOWN = Buffer.from("# Browser review fixture\n\nThis exact Markdown remains visible without JavaScript.\n", "utf8");

/** Returns deterministic candidate HTML for browser-only verification; it is not workflow authority. */
export async function createApprovalDossierBrowserFixture(): Promise<string> {
	const visualMaterial = {
		visual_id: "fixture-bar",
		type: "bar" as const,
		title: "Fixture coverage",
		description: "A bounded browser verification visual.",
		units: "items",
		source_evidence_ids: ["fixture-evidence"],
		textual_equivalent: "Fixture coverage\nMarkdown: 1 item",
		data: { entries: [{ label: "Markdown", value: 1 }] },
	};
	const visual: NativeVisual = { ...visualMaterial, sha256: nativeVisualSha256(visualMaterial) };
	const visual_set: VisualSet = {
		schema: "approval-dossier/visual-set/v1",
		visual_set_sha256: visualSetSha256([{ visual_id: visual.visual_id, type: visual.type, sha256: visual.sha256 }]),
		visuals: [{ visual_id: visual.visual_id, type: visual.type, sha256: visual.sha256 }],
	};
	const files = [createMarkdownFileRecord("ai_docs/fixtures/approval-dossier.md", FIXTURE_MARKDOWN)];
	const candidate = createCandidateBinding({
		workflow: "fixture",
		run_id: "browser-fixture",
		revision: 1,
		semantic_sha256: FIXTURE_SEMANTIC_SHA256,
		files,
		visual_set_sha256: visual_set.visual_set_sha256,
		runtime_sha256: FIXTURE_RUNTIME_SHA256,
		review_authority_sha256: FIXTURE_REVIEW_SHA256,
		predecessors: [],
	});
	const approval = createApprovalResponse({
		candidate,
		approval_status: "draft",
		approval_actor: "Browser verifier",
		submitted_at: "2026-08-03T12:00:00.000Z",
		approved_at: null,
		files: [{ path: "ai_docs/fixtures/approval-dossier.md", bytes: FIXTURE_MARKDOWN }],
		feedback: [],
	});
	const feedback_targets = [
		{
			target: { target_type: "semantic-id" as const, semantic_id: "G1" },
			label: "Goal G1 · Comprehensible review",
			context: "Confirm that a reviewer can understand the candidate without reading implementation details first.",
			unresolved: true,
		},
		{
			target: { target_type: "semantic-id" as const, semantic_id: "C1" },
			label: "Criterion C1 · Bounded navigation",
			context: "Verify that each review item is isolated with its own context and response fields.",
			unresolved: true,
		},
		{
			target: { target_type: "semantic-id" as const, semantic_id: "D1" },
			label: "Decision D1 · Decision Navigator",
			context: "Assess the three-pane queue, focused reading, and item-bound feedback structure.",
			unresolved: true,
		},
		{
			target: { target_type: "markdown-path" as const, markdown_path: "ai_docs/fixtures/approval-dossier.md" },
			label: "Exact Markdown projection",
			context: "Request a change or proposal for this exact protected Markdown projection.",
			unresolved: true,
		},
	];
	return (await renderApprovalDossier({ title: "Approval dossier browser fixture", candidate, approval, visual_set, visuals: [visual], feedback_targets, review_presentations: feedback_targets.map(({ target }) => ({ target_id: target.target_type === "semantic-id" ? target.semantic_id : target.target_type === "markdown-path" ? target.markdown_path : "dossier", presentation: { kind: "context-only" as const } })) })).html;
}

/** Writes the deterministic fixture once, preserving any prior evidence file. */
export async function writeApprovalDossierBrowserFixture(outputPath: string): Promise<void> {
	await writeFile(outputPath, await createApprovalDossierBrowserFixture(), { encoding: "utf8", flag: "wx" });
}

if (import.meta.main) {
	const args = Bun.argv.slice(2);
	if (args.length !== 1) {
		console.error("Usage: bun approval-dossier-browser-fixture.ts <output-path>");
		process.exitCode = 1;
	} else {
		try {
			await writeApprovalDossierBrowserFixture(args[0]);
			console.log(args[0]);
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		}
	}
}
