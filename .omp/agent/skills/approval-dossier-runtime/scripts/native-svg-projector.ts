import { hashCanonicalJson } from "./canonical-json.ts";

export type NativeVisualType = "flow" | "bar" | "matrix" | "timeline" | "comparison";

export interface NativeVisualBase {
	readonly visual_id: string;
	readonly type: NativeVisualType;
	readonly sha256: string;
	readonly title: string;
	readonly description: string;
	readonly units: string;
	readonly source_evidence_ids: readonly string[];
	/** Exact, visible textual authority; the SVG adds no facts. */
	readonly textual_equivalent: string;
}

export interface FlowVisual extends NativeVisualBase {
	readonly type: "flow";
	readonly data: Readonly<{
		readonly nodes: readonly Readonly<{ readonly node_id: string; readonly label: string; readonly description: string }>[];
		readonly edges: readonly Readonly<{ readonly from: string; readonly to: string; readonly label: string }>[];
	}>;
}
export interface BarVisual extends NativeVisualBase {
	readonly type: "bar";
	readonly data: Readonly<{ readonly entries: readonly Readonly<{ readonly label: string; readonly value: number }>[] }>;
}
export interface MatrixVisual extends NativeVisualBase {
	readonly type: "matrix";
	readonly data: Readonly<{ readonly x_axis: string; readonly y_axis: string; readonly points: readonly Readonly<{ readonly label: string; readonly x: number; readonly y: number }>[] }>;
}
export interface TimelineVisual extends NativeVisualBase {
	readonly type: "timeline";
	readonly data: Readonly<{ readonly entries: readonly Readonly<{ readonly label: string; readonly start: number; readonly end: number }>[] }>;
}
export interface ComparisonVisual extends NativeVisualBase {
	readonly type: "comparison";
	readonly data: Readonly<{ readonly entries: readonly Readonly<{ readonly label: string; readonly left: number; readonly right: number }>[] }>;
}
export type NativeVisual = FlowVisual | BarVisual | MatrixVisual | TimelineVisual | ComparisonVisual;

const MAX_VISUALS = 1_024;
const MAX_ITEMS = 128;
const MAX_TEXT = 4_096;
const HASH = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function nativeVisualSha256(visual: object): string {
	return hashCanonicalJson(visual, { maximum_bytes: 256 * 1_024, maximum_items: 2_048, maximum_depth: 12 });
}

/** Validates a small, fixed vocabulary of graphics; SVG is never accepted as input. */
export function validateNativeVisual(input: unknown): NativeVisual {
	if (!isObject(input)) throw new TypeError("native visual must be an object");
	const type = text(input.type, "type", 16) as NativeVisualType;
	if (!(["flow", "bar", "matrix", "timeline", "comparison"] as const).includes(type)) throw new TypeError("native visual type is invalid");
	const base = {
		visual_id: identifier(input.visual_id, "visual_id"),
		type,
		sha256: hash(input.sha256),
		title: text(input.title, "title", MAX_TEXT),
		description: text(input.description, "description", MAX_TEXT),
		units: text(input.units, "units", 256),
		source_evidence_ids: identifierList(input.source_evidence_ids, "source_evidence_ids"),
		textual_equivalent: text(input.textual_equivalent, "textual_equivalent", MAX_TEXT),
	};
	const data = isObject(input.data) ? input.data : fail("native visual data is invalid");
	let visual: NativeVisual;
	switch (type) {
		case "flow": visual = { ...base, type, data: { nodes: flowNodes(data.nodes), edges: flowEdges(data.edges) } }; break;
		case "bar": visual = { ...base, type, data: { entries: numericEntries(data.entries, "value") } }; break;
		case "matrix": visual = { ...base, type, data: { x_axis: text(data.x_axis, "x_axis", 256), y_axis: text(data.y_axis, "y_axis", 256), points: matrixPoints(data.points) } }; break;
		case "timeline": visual = { ...base, type, data: { entries: timelineEntries(data.entries) } }; break;
		case "comparison": visual = { ...base, type, data: { entries: comparisonEntries(data.entries) } }; break;
	}
	const { sha256: declared, ...material } = visual;
	if (declared !== nativeVisualSha256(material)) throw new TypeError("native visual hash does not bind its closed content");
	return Object.freeze(visual);
}

export function validateNativeVisuals(input: readonly unknown[]): readonly NativeVisual[] {
	if (!Array.isArray(input) || input.length > MAX_VISUALS) throw new TypeError("native visual collection is invalid");
	const visuals = input.map(validateNativeVisual).sort((left, right) => left.visual_id < right.visual_id ? -1 : left.visual_id > right.visual_id ? 1 : 0);
	for (let index = 1; index < visuals.length; index += 1) if (visuals[index - 1]?.visual_id === visuals[index]?.visual_id) throw new TypeError("native visual identifiers must be unique");
	return Object.freeze(visuals);
}

/** Returns server-rendered safe SVG and its required adjacent textual equivalent. */
export function projectNativeVisual(input: unknown): string {
	const visual = validateNativeVisual(input);
	return visualFigure(visual, svgFor(visual));
}

/** Visual rendering is optional: this fallback retains every text authority. */
export function projectNativeVisualFallback(input: unknown): string {
	if (!isObject(input)) return "<figure class=\"visual\"><p>Visual unavailable. No visual authority is required.</p></figure>";
	const visual = safeMetadata(input);
	return visualFigure(visual, "<p class=\"visual-unavailable\">Native visual unavailable. The textual equivalent below remains complete.</p>");
}

function visualFigure(visual: Pick<NativeVisualBase, "visual_id" | "title" | "description" | "units" | "source_evidence_ids" | "textual_equivalent">, graphic: string): string {
	return `<figure class="visual" id="visual-${escapeAttribute(visual.visual_id)}"><h3>${escapeHtml(visual.title)}</h3><p>${escapeHtml(visual.description)}</p><p class="metadata">Units: ${escapeHtml(visual.units)} · Source/evidence IDs: ${escapeHtml(visual.source_evidence_ids.join(", "))}</p>${graphic}<figcaption><strong>Exact textual equivalent</strong><pre class="textual-equivalent">${escapeHtml(visual.textual_equivalent)}</pre></figcaption></figure>`;
}

function svgFor(visual: NativeVisual): string {
	const titleId = `visual-title-${visual.visual_id}`;
	const descriptionId = `visual-description-${visual.visual_id}`;
	const inner = visual.type === "flow" ? flowSvg(visual) : visual.type === "bar" ? barSvg(visual) : visual.type === "matrix" ? matrixSvg(visual) : visual.type === "timeline" ? timelineSvg(visual) : comparisonSvg(visual);
	return `<svg viewBox="0 0 800 320" role="img" aria-labelledby="${escapeAttribute(titleId)} ${escapeAttribute(descriptionId)}" xmlns="http://www.w3.org/2000/svg"><title id="${escapeAttribute(titleId)}">${escapeHtml(visual.title)}</title><desc id="${escapeAttribute(descriptionId)}">${escapeHtml(visual.description)} Units: ${escapeHtml(visual.units)}. Sources: ${escapeHtml(visual.source_evidence_ids.join(", "))}.</desc>${inner}</svg>`;
}

function flowSvg(visual: FlowVisual): string {
	const nodes = visual.data.nodes;
	const positions = new Map(nodes.map((node, index) => [node.node_id, { x: 50 + (index % 4) * 185, y: 55 + Math.floor(index / 4) * 130 }]));
	const edges = visual.data.edges.map((edge) => {
		const from = positions.get(edge.from); const to = positions.get(edge.to);
		return !from || !to ? "" : `<path d="M ${from.x + 130} ${from.y + 30} L ${to.x} ${to.y + 30}" stroke="currentColor" fill="none" marker-end="url(#arrow)"/><text x="${(from.x + to.x + 130) / 2}" y="${(from.y + to.y) / 2 + 18}" text-anchor="middle">${escapeHtml(edge.label)}</text>`;
	}).join("");
	const boxes = nodes.map((node, index) => { const p = positions.get(node.node_id)!; return `<rect x="${p.x}" y="${p.y}" width="130" height="60" rx="6" fill="none" stroke="currentColor"/><text x="${p.x + 65}" y="${p.y + 27}" text-anchor="middle">${escapeHtml(trimLabel(node.label))}</text><text x="${p.x + 65}" y="${p.y + 46}" text-anchor="middle">${escapeHtml(trimLabel(node.description))}</text>`; }).join("");
	return `<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="currentColor"/></marker></defs>${edges}${boxes}`;
}

function barSvg(visual: BarVisual): string {
	const maximum = Math.max(1, ...visual.data.entries.map((entry) => entry.value));
	return visual.data.entries.map((entry, index) => { const y = 30 + index * 36; const width = (entry.value / maximum) * 510; return `<text x="15" y="${y + 18}">${escapeHtml(trimLabel(entry.label))}</text><rect x="250" y="${y}" width="${width}" height="24" fill="currentColor" opacity=".72"/><text x="${260 + width}" y="${y + 18}">${escapeHtml(String(entry.value))} ${escapeHtml(visual.units)}</text>`; }).join("");
}

function matrixSvg(visual: MatrixVisual): string {
	return `<path d="M80 25 V270 H750" stroke="currentColor" fill="none"/><text x="390" y="305" text-anchor="middle">${escapeHtml(visual.data.x_axis)}</text><text x="25" y="150" transform="rotate(-90 25 150)" text-anchor="middle">${escapeHtml(visual.data.y_axis)}</text>${visual.data.points.map((point) => `<circle cx="${80 + point.x * 6.7}" cy="${270 - point.y * 2.45}" r="6" fill="currentColor"/><text x="${90 + point.x * 6.7}" y="${266 - point.y * 2.45}">${escapeHtml(trimLabel(point.label))}</text>`).join("")}`;
}

function timelineSvg(visual: TimelineVisual): string {
	const maximum = Math.max(1, ...visual.data.entries.map((entry) => entry.end));
	return `<path d="M60 35 V280" stroke="currentColor"/>${visual.data.entries.map((entry, index) => { const y = 50 + index * 42; return `<text x="70" y="${y + 17}">${escapeHtml(trimLabel(entry.label))}</text><rect x="260" y="${y}" width="${Math.max(3, ((entry.end - entry.start) / maximum) * 460)}" height="24" fill="currentColor" opacity=".72"/><text x="${270 + ((entry.end - entry.start) / maximum) * 460}" y="${y + 17}">${escapeHtml(`${entry.start}–${entry.end} ${visual.units}`)}</text>`; }).join("")}`;
}

function comparisonSvg(visual: ComparisonVisual): string {
	const maximum = Math.max(1, ...visual.data.entries.flatMap((entry) => [entry.left, entry.right]));
	return visual.data.entries.map((entry, index) => { const y = 35 + index * 52; const left = entry.left / maximum * 230; const right = entry.right / maximum * 230; return `<text x="15" y="${y + 19}">${escapeHtml(trimLabel(entry.label))}</text><rect x="250" y="${y}" width="${left}" height="18" fill="currentColor" opacity=".72"/><rect x="250" y="${y + 22}" width="${right}" height="18" fill="none" stroke="currentColor"/><text x="490" y="${y + 16}">${escapeHtml(String(entry.left))}/${escapeHtml(String(entry.right))} ${escapeHtml(visual.units)}</text>`; }).join("");
}

function flowNodes(value: unknown): FlowVisual["data"]["nodes"] { return list(value, "nodes").map((item) => { if (!isObject(item)) throw new TypeError("flow node is invalid"); return Object.freeze({ node_id: identifier(item.node_id, "node_id"), label: text(item.label, "node label", 256), description: text(item.description, "node description", 256) }); }); }
function flowEdges(value: unknown): FlowVisual["data"]["edges"] { return list(value, "edges").map((item) => { if (!isObject(item)) throw new TypeError("flow edge is invalid"); return Object.freeze({ from: identifier(item.from, "edge from"), to: identifier(item.to, "edge to"), label: text(item.label, "edge label", 256) }); }); }
function numericEntries(value: unknown, numericKey: "value"): BarVisual["data"]["entries"] { return list(value, "entries").map((item) => { if (!isObject(item)) throw new TypeError("bar entry is invalid"); return Object.freeze({ label: text(item.label, "entry label", 256), value: finite(item[numericKey], numericKey) }); }); }
function matrixPoints(value: unknown): MatrixVisual["data"]["points"] { return list(value, "points").map((item) => { if (!isObject(item)) throw new TypeError("matrix point is invalid"); return Object.freeze({ label: text(item.label, "point label", 256), x: range(item.x, "x", 0, 100), y: range(item.y, "y", 0, 100) }); }); }
function timelineEntries(value: unknown): TimelineVisual["data"]["entries"] { return list(value, "entries").map((item) => { if (!isObject(item)) throw new TypeError("timeline entry is invalid"); const start = finite(item.start, "start"); const end = finite(item.end, "end"); if (end < start) throw new TypeError("timeline end precedes start"); return Object.freeze({ label: text(item.label, "entry label", 256), start, end }); }); }
function comparisonEntries(value: unknown): ComparisonVisual["data"]["entries"] { return list(value, "entries").map((item) => { if (!isObject(item)) throw new TypeError("comparison entry is invalid"); return Object.freeze({ label: text(item.label, "entry label", 256), left: finite(item.left, "left"), right: finite(item.right, "right") }); }); }
function safeMetadata(input: Record<string, unknown>): Pick<NativeVisualBase, "visual_id" | "title" | "description" | "units" | "source_evidence_ids" | "textual_equivalent"> { return { visual_id: typeof input.visual_id === "string" && ID.test(input.visual_id) ? input.visual_id : "unavailable", title: typeof input.title === "string" ? input.title : "Visual unavailable", description: typeof input.description === "string" ? input.description : "The visual data could not be projected.", units: typeof input.units === "string" ? input.units : "Not available", source_evidence_ids: Array.isArray(input.source_evidence_ids) ? input.source_evidence_ids.filter((item): item is string => typeof item === "string") : [], textual_equivalent: typeof input.textual_equivalent === "string" ? input.textual_equivalent : "No visual authority is required." }; }
function list(value: unknown, name: string): readonly unknown[] { if (!Array.isArray(value) || value.length > MAX_ITEMS) throw new TypeError(`${name} are invalid`); return value; }
function identifierList(value: unknown, name: string): readonly string[] { return Object.freeze(list(value, name).map((item) => identifier(item, name))); }
function identifier(value: unknown, name: string): string { if (typeof value !== "string" || !ID.test(value)) throw new TypeError(`${name} is invalid`); return value; }
function hash(value: unknown): string { if (typeof value !== "string" || !HASH.test(value)) throw new TypeError("native visual hash is invalid"); return value; }
function text(value: unknown, name: string, maximum: number): string { if (typeof value !== "string" || value.length === 0 || value.length > maximum) throw new TypeError(`${name} is invalid`); return value; }
function finite(value: unknown, name: string): number { if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1_000_000) throw new TypeError(`${name} is invalid`); return value; }
function range(value: unknown, name: string, min: number, max: number): number { const numeric = finite(value, name); if (numeric < min || numeric > max) throw new TypeError(`${name} is outside range`); return numeric; }
function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function fail(message: string): never { throw new TypeError(message); }
function trimLabel(value: string): string { return value.length > 32 ? `${value.slice(0, 29)}…` : value; }
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character] as string); }
function escapeAttribute(value: string): string { return escapeHtml(value); }
