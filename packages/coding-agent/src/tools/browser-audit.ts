import { createHash } from "node:crypto";

export const BROWSER_AUDIT_TOOL_NAME = "browser_audit" as const;
export const BROWSER_AUDIT_TOOL_IMPLEMENTATION_REVISION = "browser-audit/v2" as const;
export const BROWSER_AUDIT_CORE_PACKAGE_IDENTITY = "@oh-my-pi/pi-coding-agent" as const;
export const BROWSER_AUDIT_OPERATIONS = ["open", "inspect", "act", "close"] as const;
export type BrowserAuditOperation = (typeof BROWSER_AUDIT_OPERATIONS)[number];
export type BrowserAuditLifecycle = "ACTIVE" | "FINALIZING" | "CLOSED" | "INVALID";
export type BrowserAuditOutcomeStatus = "PASS" | "BLOCKED";

const AUDIT_ID_RE = /^browser-audit-[0-9a-f]{16}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const ID_RE = /^[a-z][a-z0-9-]{0,47}$/;
const ACTOR_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const ACTION_KINDS = ["navigate", "click", "press", "type", "select", "scroll"] as const;
const CANDIDATE_KINDS = [
	"redirect",
	"popup",
	"download",
	"subresource",
	"worker",
	"websocket",
	"beacon",
	"action-navigation",
] as const;
export const BROWSER_AUDIT_MAX_ORDINARY_OPERATIONS = 128;
export const BROWSER_AUDIT_MAX_OBSERVATIONS = 128;
export const BROWSER_AUDIT_MAX_EVIDENCE_ITEMS = 256;
export const BROWSER_AUDIT_MAX_FROZEN_EVIDENCE_BYTES = 256 * 1024;

export interface BrowserAuditActor {
	readonly actor_kind: "sub";
	readonly actor_id: string;
	readonly parent_actor_id: string;
}

export interface BrowserAuditDispatch {
	readonly schema: "browser-audit-dispatch/v2";
	readonly audit_id: string;
	readonly request_sha256: string;
	readonly task_sha256: string;
	readonly request_byte_count: number;
	readonly task_byte_count: number;
	readonly agent_source: "user";
	readonly agent_logical_path: "agents/browser-audit-specialist.md";
	readonly agent_definition_sha256: string;
	readonly tool_origin_class: "builtin";
	readonly tool_implementation_revision: typeof BROWSER_AUDIT_TOOL_IMPLEMENTATION_REVISION;
	readonly core_package_identity: typeof BROWSER_AUDIT_CORE_PACKAGE_IDENTITY;
	readonly expected_spawn_id: string;
	readonly expected_parent_actor_id: string;
	readonly tool_call_fingerprint: string;
}

export interface BrowserAuditRouteState {
	readonly route_state_id: string;
	readonly locator: string;
	readonly state_assertions: readonly string[];
	readonly allowed_action_ids: readonly string[];
}

export interface BrowserAuditViewport {
	readonly viewport_id: string;
	readonly width: number;
	readonly height: number;
	readonly device_scale_factor: number;
}

export interface BrowserAuditAction {
	readonly action_id: string;
	readonly kind: (typeof ACTION_KINDS)[number];
	readonly target: string;
	readonly value: string | null;
	readonly mutation: "none" | "ephemeral-ui";
}

export interface BrowserAuditAuthorization {
	readonly document_locators: readonly string[];
	readonly origins: readonly string[];
	readonly route_states: readonly BrowserAuditRouteState[];
	readonly viewports: readonly BrowserAuditViewport[];
	readonly actions: readonly BrowserAuditAction[];
	readonly mutation_policy: { readonly mode: "deny" | "allow-listed"; readonly allowed_action_ids: readonly string[] };
	readonly credential_policy: { readonly mode: "deny-raw"; readonly pre_established_state_ids: readonly string[] };
	readonly screenshot_policy: {
		readonly mode: "deny" | "allow-listed";
		readonly max_count: number;
		readonly max_bytes: number;
		readonly allowed_check_ids: readonly string[];
	};
	readonly resource_policy: {
		readonly mode: "deny" | "allow-listed";
		readonly allowed_origins: readonly string[];
		readonly allow_file_subresources: false;
	};
	readonly protected_actions: readonly string[];
}

export interface BrowserAuditTuple {
	readonly tuple_id: string;
	readonly check_id: string;
	readonly route_state_id: string;
	readonly viewport_id: string;
}

export interface BrowserAuditCandidate {
	readonly candidate_id: string;
	readonly kind: (typeof CANDIDATE_KINDS)[number];
	readonly locator_id: string;
	readonly origin_id: string | null;
	readonly route_state_id: string | null;
	readonly action_id: string | null;
}

export interface BrowserAuditEvidence {
	readonly evidence_id: string;
	readonly tuple_id: string;
	readonly kind: "accessibility" | "interaction" | "visual" | "screenshot" | "console" | "network" | "navigation";
	readonly locator: string | null;
	readonly sha256: string | null;
	readonly description: string;
}

export interface BrowserAuditObservation {
	readonly status: BrowserAuditOutcomeStatus;
	readonly evidence?: readonly BrowserAuditEvidence[];
	readonly error?: string | null;
}

export interface BrowserAuditCleanupObservation {
	readonly session_name: string | null;
	readonly close_attempted: boolean;
	readonly closed: boolean;
	readonly process_kill_requested: boolean;
	readonly error: string | null;
}

export interface BrowserAuditSnapshot {
	readonly audit_id: string;
	readonly request_sha256: string;
	readonly dispatch_sha256: string;
	readonly actor_id: string;
	readonly parent_actor_id: string;
	readonly tool_implementation_revision: string;
	readonly core_package_identity: string;
	readonly session_name: string | null;
	readonly observations: readonly BrowserAuditObservationRecord[];
	/** Frozen host-observed evidence, reidentified by the authoritative operation. */
	readonly evidence: readonly BrowserAuditEvidence[];
	readonly cleanup: BrowserAuditCleanupObservation;
}

export interface BrowserAuditObservationRecord {
	readonly operation_id: string;
	readonly operation: BrowserAuditOperation;
	readonly tuple_id: string | null;
	readonly action_id: string | null;
	readonly status: BrowserAuditOutcomeStatus;
	readonly evidence_ids: readonly string[];
}

export interface HostEffectRequest {
	readonly kind: "open" | "inspect" | "act";
	readonly audit_id: string;
	readonly operation_id: string;
	readonly tuple_id: string;
	readonly action_id: string | null;
	readonly authorization_state_sha256: string;
}

export interface HostCleanupRequest {
	readonly audit_id: string;
	readonly session_name: string | null;
}

export interface HostEffectExecutor {
	/** Must synchronously arm the actual request callback before any effect begins. */
	readonly armInterception: (
		input: {
			readonly audit_id: string;
			readonly authorization_state_sha256: string;
			readonly tuple_id: string;
		},
		signal: AbortSignal | undefined,
	) => void | Promise<void>;
	/** Executes exactly one host-derived browser primitive. No child-supplied values are accepted. */
	readonly execute: (request: HostEffectRequest, signal: AbortSignal | undefined) => Promise<BrowserAuditObservation>;
	/** Closes the exact browser session owned by this run. */
	readonly close: (signal: AbortSignal | undefined) => Promise<void>;
	/** Verifies that the owned session and interception resources are gone. */
	readonly cleanup: (
		input: HostCleanupRequest,
		signal: AbortSignal | undefined,
	) => BrowserAuditCleanupObservation | Promise<BrowserAuditCleanupObservation>;
}

export interface BrowserAuditFileDocumentAuthority {
	readonly schema: "browser-audit-file-document-authority/v1";
	readonly document_locator: string;
	readonly expected_sha256: string;
	readonly hash_authority: "caller-verified-external";
	readonly hash_verified_external: true;
	readonly repository_local: true;
	readonly document_only: true;
}

export interface BrowserAuditEngineOptions {
	readonly dispatch: BrowserAuditDispatch;
	readonly actor: BrowserAuditActor;
	readonly spawn_id: string;
	readonly authorization: BrowserAuditAuthorization;
	readonly tuples: readonly BrowserAuditTuple[];
	readonly file_document_authority: BrowserAuditFileDocumentAuthority | null;
	readonly executor: HostEffectExecutor;
	readonly session_name?: string | null;
}

export interface BrowserAuditToolInput {
	readonly operation: BrowserAuditOperation;
	readonly audit_id: string;
	readonly tuple_id?: string;
	readonly action_id?: string;
}

export interface BrowserAuditOperationResult {
	readonly status: BrowserAuditOutcomeStatus | "CLOSED";
	readonly operation_id?: string;
	readonly evidence_ids: readonly string[];
}

function fail(message: string): never {
	throw new Error(`browser_audit: ${message}`);
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
	if (
		!isRecord(value) ||
		Object.keys(value).length !== keys.length ||
		Object.keys(value).some(key => !keys.includes(key))
	)
		fail(`${label} has unknown or missing fields`);
	return value;
}
function boundedId(value: unknown, label: string): string {
	if (typeof value !== "string" || !ID_RE.test(value)) fail(`${label} is invalid`);
	return value;
}
function boundedActor(value: unknown, label: string): string {
	if (typeof value !== "string" || !ACTOR_ID_RE.test(value)) fail(`${label} is invalid`);
	return value;
}
function hash(value: Uint8Array | string): string {
	return createHash("sha256").update(value).digest("hex");
}
function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (isRecord(value))
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map(key => [key, canonicalize(value[key])]),
		);
	return value;
}
export function canonicalJson(value: unknown): string {
	return `${JSON.stringify(canonicalize(value))}\n`;
}
export function canonicalBytes(value: unknown): Uint8Array {
	return new TextEncoder().encode(canonicalJson(value));
}
export function sha256Bytes(value: Uint8Array | string): string {
	return hash(value);
}
export function dispatchSha256(dispatch: BrowserAuditDispatch): string {
	return hash(canonicalBytes(dispatch));
}
export const computeDispatchSha256 = dispatchSha256;

function canonicalUrl(value: unknown): value is string {
	if (typeof value !== "string" || value.length > 2048 || /[\0\r\n]/.test(value)) return false;
	try {
		const url = new URL(value);
		return (
			(url.protocol === "https:" || url.protocol === "http:") &&
			url.username === "" &&
			url.password === "" &&
			url.hash === "" &&
			url.pathname.length > 0 &&
			url.toString() === value
		);
	} catch {
		return false;
	}
}
function validateArrayStrings(value: unknown, label: string, max = 128): readonly string[] {
	if (
		!Array.isArray(value) ||
		value.length > max ||
		value.some(item => typeof item !== "string" || item.length === 0 || item.length > 256 || /[\0\r\n]/.test(item))
	)
		fail(`${label} is invalid`);
	return value;
}
function isAuditOperation(value: unknown): value is BrowserAuditOperation {
	return typeof value === "string" && BROWSER_AUDIT_OPERATIONS.some(operation => operation === value);
}

function isActionKind(value: unknown): value is BrowserAuditAction["kind"] {
	return typeof value === "string" && ACTION_KINDS.some(kind => kind === value);
}

export function validateBrowserAuditDispatch(value: unknown): asserts value is BrowserAuditDispatch {
	exact(
		value,
		[
			"schema",
			"audit_id",
			"request_sha256",
			"task_sha256",
			"request_byte_count",
			"task_byte_count",
			"agent_source",
			"agent_logical_path",
			"agent_definition_sha256",
			"tool_origin_class",
			"tool_implementation_revision",
			"core_package_identity",
			"expected_spawn_id",
			"expected_parent_actor_id",
			"tool_call_fingerprint",
		],
		"dispatch",
	);
	const v = value as BrowserAuditDispatch;
	if (
		v.schema !== "browser-audit-dispatch/v2" ||
		!AUDIT_ID_RE.test(v.audit_id) ||
		!HASH_RE.test(v.request_sha256) ||
		!HASH_RE.test(v.task_sha256) ||
		!HASH_RE.test(v.agent_definition_sha256) ||
		!HASH_RE.test(v.tool_call_fingerprint)
	)
		fail("dispatch identity is invalid");
	if (
		!Number.isSafeInteger(v.request_byte_count) ||
		v.request_byte_count < 0 ||
		!Number.isSafeInteger(v.task_byte_count) ||
		v.task_byte_count < 0 ||
		v.agent_source !== "user" ||
		v.agent_logical_path !== "agents/browser-audit-specialist.md" ||
		v.tool_origin_class !== "builtin"
	)
		fail("dispatch provenance is invalid");
	boundedActor(v.expected_spawn_id, "expected_spawn_id");
	boundedActor(v.expected_parent_actor_id, "expected_parent_actor_id");
	if (
		v.tool_implementation_revision !== BROWSER_AUDIT_TOOL_IMPLEMENTATION_REVISION ||
		v.core_package_identity !== BROWSER_AUDIT_CORE_PACKAGE_IDENTITY
	)
		fail("dispatch package identity is invalid");
}
export function validateBrowserAuditFileDocumentAuthority(
	value: unknown,
): asserts value is BrowserAuditFileDocumentAuthority {
	const authority = exact(
		value,
		[
			"schema",
			"document_locator",
			"expected_sha256",
			"hash_authority",
			"hash_verified_external",
			"repository_local",
			"document_only",
		],
		"file_document_authority",
	) as unknown as BrowserAuditFileDocumentAuthority;
	if (
		authority.schema !== "browser-audit-file-document-authority/v1" ||
		!HASH_RE.test(authority.expected_sha256) ||
		authority.hash_authority !== "caller-verified-external" ||
		authority.hash_verified_external !== true ||
		authority.repository_local !== true ||
		authority.document_only !== true
	) {
		fail("file document authority is invalid");
	}
	let locator: URL;
	try {
		locator = new URL(authority.document_locator);
	} catch {
		fail("file document locator is invalid");
	}
	if (
		locator.protocol !== "file:" ||
		locator.username !== "" ||
		locator.password !== "" ||
		locator.host !== "" ||
		locator.search !== "" ||
		locator.hash !== "" ||
		!locator.pathname.startsWith("/") ||
		locator.toString() !== authority.document_locator
	) {
		fail("file document locator is not canonical");
	}
}

export function validateBrowserAuditActor(value: unknown): asserts value is BrowserAuditActor {
	exact(value, ["actor_kind", "actor_id", "parent_actor_id"], "actor");
	const v = value as BrowserAuditActor;
	if (v.actor_kind !== "sub") fail("actor kind is invalid");
	boundedActor(v.actor_id, "actor_id");
	boundedActor(v.parent_actor_id, "parent_actor_id");
}
export function validateBrowserAuditAuthorization(
	value: unknown,
	fileAuthority: BrowserAuditFileDocumentAuthority | null = null,
): asserts value is BrowserAuditAuthorization {
	if (fileAuthority !== null) validateBrowserAuditFileDocumentAuthority(fileAuthority);
	const authorization = exact(
		value,
		[
			"document_locators",
			"origins",
			"route_states",
			"viewports",
			"actions",
			"mutation_policy",
			"credential_policy",
			"screenshot_policy",
			"resource_policy",
			"protected_actions",
		],
		"authorization",
	);
	const documentLocators = validateArrayStrings(authorization.document_locators, "document_locators");
	if (documentLocators.some(item => !canonicalUrl(item))) {
		if (!(fileAuthority && documentLocators.length === 1 && documentLocators[0] === fileAuthority.document_locator)) {
			fail("document locator is not canonical");
		}
	}
	const origins = validateArrayStrings(authorization.origins, "origins");
	for (const origin of origins) {
		let parsed: URL;
		try {
			parsed = new URL(origin);
		} catch {
			fail("origin is invalid");
		}
		if (
			(parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
			parsed.pathname !== "/" ||
			parsed.search !== "" ||
			parsed.hash !== "" ||
			parsed.username !== "" ||
			parsed.password !== "" ||
			parsed.origin !== origin
		) {
			fail("origin is not canonical");
		}
	}

	if (
		!Array.isArray(authorization.route_states) ||
		authorization.route_states.length === 0 ||
		authorization.route_states.length > 128
	) {
		fail("route_states is invalid");
	}
	const routes = new Set<string>();
	const routeActionIds: Array<readonly string[]> = [];
	for (const routeValue of authorization.route_states) {
		const route = exact(
			routeValue,
			["route_state_id", "locator", "state_assertions", "allowed_action_ids"],
			"route state",
		);
		const routeId = boundedId(route.route_state_id, "route_state_id");
		if (routes.has(routeId) || typeof route.locator !== "string" || !documentLocators.includes(route.locator)) {
			fail("route state is not authorized");
		}
		routes.add(routeId);
		validateArrayStrings(route.state_assertions, "state_assertions");
		routeActionIds.push(validateArrayStrings(route.allowed_action_ids, "allowed_action_ids"));
	}

	if (
		!Array.isArray(authorization.viewports) ||
		authorization.viewports.length === 0 ||
		authorization.viewports.length > 128
	) {
		fail("viewports is invalid");
	}
	const viewports = new Set<string>();
	for (const viewportValue of authorization.viewports) {
		const viewport = exact(viewportValue, ["viewport_id", "width", "height", "device_scale_factor"], "viewport");
		const viewportId = boundedId(viewport.viewport_id, "viewport_id");
		if (
			viewports.has(viewportId) ||
			typeof viewport.width !== "number" ||
			!Number.isSafeInteger(viewport.width) ||
			typeof viewport.height !== "number" ||
			!Number.isSafeInteger(viewport.height) ||
			viewport.width < 1 ||
			viewport.height < 1 ||
			typeof viewport.device_scale_factor !== "number" ||
			!Number.isFinite(viewport.device_scale_factor) ||
			viewport.device_scale_factor <= 0
		) {
			fail("viewport is invalid");
		}
		viewports.add(viewportId);
	}

	if (!Array.isArray(authorization.actions) || authorization.actions.length > 128) fail("actions is invalid");
	const actions = new Set<string>();
	for (const actionValue of authorization.actions) {
		const action = exact(actionValue, ["action_id", "kind", "target", "value", "mutation"], "action");
		const actionId = boundedId(action.action_id, "action_id");
		if (
			actions.has(actionId) ||
			!isActionKind(action.kind) ||
			typeof action.target !== "string" ||
			action.target.length === 0 ||
			action.target.length > 256 ||
			(action.value !== null && typeof action.value !== "string") ||
			(action.mutation !== "none" && action.mutation !== "ephemeral-ui")
		) {
			fail("action is invalid");
		}
		actions.add(actionId);
	}
	for (const allowedActionIds of routeActionIds) {
		for (const actionId of allowedActionIds) if (!actions.has(actionId)) fail("route action is unknown");
	}

	const mutationPolicy = exact(authorization.mutation_policy, ["mode", "allowed_action_ids"], "mutation policy");
	if (mutationPolicy.mode !== "deny" && mutationPolicy.mode !== "allow-listed") fail("mutation policy is invalid");
	const mutationActionIds = validateArrayStrings(mutationPolicy.allowed_action_ids, "mutation allow-list");
	for (const actionId of mutationActionIds) if (!actions.has(actionId)) fail("mutation action is unknown");

	const credentialPolicy = exact(
		authorization.credential_policy,
		["mode", "pre_established_state_ids"],
		"credential policy",
	);
	if (credentialPolicy.mode !== "deny-raw") fail("credential policy is invalid");
	validateArrayStrings(credentialPolicy.pre_established_state_ids, "credential state ids");

	const screenshotPolicy = exact(
		authorization.screenshot_policy,
		["mode", "max_count", "max_bytes", "allowed_check_ids"],
		"screenshot policy",
	);
	if (
		(screenshotPolicy.mode !== "deny" && screenshotPolicy.mode !== "allow-listed") ||
		typeof screenshotPolicy.max_count !== "number" ||
		!Number.isSafeInteger(screenshotPolicy.max_count) ||
		screenshotPolicy.max_count < 0 ||
		typeof screenshotPolicy.max_bytes !== "number" ||
		!Number.isSafeInteger(screenshotPolicy.max_bytes) ||
		screenshotPolicy.max_bytes < 0
	) {
		fail("screenshot policy is invalid");
	}
	validateArrayStrings(screenshotPolicy.allowed_check_ids, "screenshot check ids");

	const resourcePolicy = exact(
		authorization.resource_policy,
		["mode", "allowed_origins", "allow_file_subresources"],
		"resource policy",
	);
	if (
		(resourcePolicy.mode !== "deny" && resourcePolicy.mode !== "allow-listed") ||
		resourcePolicy.allow_file_subresources !== false
	) {
		fail("resource policy is invalid");
	}
	const resourceOrigins = validateArrayStrings(resourcePolicy.allowed_origins, "resource origins");
	for (const origin of resourceOrigins) if (!origins.includes(origin)) fail("resource origin is not authorized");

	validateArrayStrings(authorization.protected_actions, "protected actions");
}
export function validateBrowserAuditTuple(
	value: unknown,
	authorization: BrowserAuditAuthorization,
): asserts value is BrowserAuditTuple {
	exact(value, ["tuple_id", "check_id", "route_state_id", "viewport_id"], "tuple");
	const v = value as BrowserAuditTuple;
	if (
		!/^[a-z][a-z0-9-]{0,47}@[a-z][a-z0-9-]{0,47}@[a-z][a-z0-9-]{0,47}$/.test(v.tuple_id) ||
		typeof v.check_id !== "string" ||
		!v.check_id
	)
		fail("tuple is invalid");
	if (
		!authorization.route_states.some(route => route.route_state_id === v.route_state_id) ||
		!authorization.viewports.some(viewport => viewport.viewport_id === v.viewport_id)
	)
		fail("tuple references unknown host state");
}
export function validateBrowserAuditInput(value: unknown): asserts value is BrowserAuditToolInput {
	if (!isRecord(value)) fail("input must be an object");
	const input = value;
	const keys = Object.keys(input);
	if (keys.some(key => !["operation", "audit_id", "tuple_id", "action_id"].includes(key)))
		fail("input exposes unsupported fields");
	if (!isAuditOperation(input.operation) || typeof input.audit_id !== "string" || !AUDIT_ID_RE.test(input.audit_id)) {
		fail("input identity is invalid");
	}
	if (
		input.tuple_id !== undefined &&
		(typeof input.tuple_id !== "string" ||
			!/^[a-z][a-z0-9-]{0,47}@[a-z][a-z0-9-]{0,47}@[a-z][a-z0-9-]{0,47}$/.test(input.tuple_id))
	) {
		fail("tuple_id is invalid");
	}
	if (input.action_id !== undefined) boundedId(input.action_id, "action_id");
	if (input.operation === "close" && (input.tuple_id !== undefined || input.action_id !== undefined)) {
		fail("close does not accept tuple or action ids");
	}
	if (input.operation !== "act" && input.action_id !== undefined) fail("action_id is only valid for act");
}

const reservedAuditIds = new Set<string>();
export const validateAuthorization = validateBrowserAuditAuthorization;
export const validateToolInput = validateBrowserAuditInput;

function freeze<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
		Object.freeze(value);
	}
	return value;
}

function projectEvidence(
	value: readonly BrowserAuditEvidence[] | undefined,
	tupleId: string,
	operationId: string,
): readonly BrowserAuditEvidence[] {
	if (!value || value.length === 0) return Object.freeze([]);
	if (value.length > 64) fail("host evidence exceeds the audit bound");
	const evidence: BrowserAuditEvidence[] = [];
	for (const [index, item] of value.entries()) {
		if (
			!isRecord(item) ||
			typeof item.kind !== "string" ||
			!["accessibility", "interaction", "visual", "screenshot", "console", "network", "navigation"].includes(
				item.kind,
			) ||
			(item.locator !== null && (typeof item.locator !== "string" || item.locator.length > 256)) ||
			(item.sha256 !== null && (typeof item.sha256 !== "string" || !HASH_RE.test(item.sha256))) ||
			typeof item.description !== "string" ||
			item.description.length === 0 ||
			item.description.length > 1_024
		) {
			fail("host evidence is invalid");
		}
		evidence.push(
			freeze({
				evidence_id: `evidence-${operationId}-${index.toString(16).padStart(4, "0")}`,
				tuple_id: tupleId,
				kind: item.kind as BrowserAuditEvidence["kind"],
				locator: item.locator,
				sha256: item.sha256,
				description: item.description,
			}),
		);
	}
	return Object.freeze(evidence);
}
export class BrowserAuditEngine {
	readonly audit_id: string;
	readonly dispatch_sha256: string;
	readonly authorization_state_sha256: string;
	#dispatch: BrowserAuditDispatch;
	#actor: BrowserAuditActor;
	#authorization: BrowserAuditAuthorization;
	#tuples: ReadonlyMap<string, BrowserAuditTuple>;
	#executor: HostEffectExecutor;
	#sessionName: string | null;
	#lifecycle: BrowserAuditLifecycle = "ACTIVE";
	#queue: Promise<void> = Promise.resolve();
	#sequence = 0;
	#observations: BrowserAuditObservationRecord[] = [];
	#evidence: BrowserAuditEvidence[] = [];
	#frozenEvidenceBytes = 0;
	#cleanupPromise: Promise<BrowserAuditCleanupObservation> | null = null;
	#snapshot: BrowserAuditSnapshot | null = null;
	#snapshotConsumed = false;

	constructor(options: BrowserAuditEngineOptions) {
		validateBrowserAuditDispatch(options.dispatch);
		validateBrowserAuditActor(options.actor);
		validateBrowserAuditAuthorization(options.authorization, options.file_document_authority);
		if (
			options.spawn_id !== options.actor.actor_id ||
			options.spawn_id !== options.dispatch.expected_spawn_id ||
			options.actor.parent_actor_id !== options.dispatch.expected_parent_actor_id
		) {
			fail("actor identity does not match spawn provenance");
		}
		if (
			!options.executor ||
			typeof options.executor.armInterception !== "function" ||
			typeof options.executor.execute !== "function" ||
			typeof options.executor.close !== "function" ||
			typeof options.executor.cleanup !== "function"
		) {
			fail("closed host executor is required");
		}
		if (reservedAuditIds.has(options.dispatch.audit_id)) fail("audit_id has already been used");
		reservedAuditIds.add(options.dispatch.audit_id);

		const tuples = new Map<string, BrowserAuditTuple>();
		for (const tuple of options.tuples) {
			validateBrowserAuditTuple(tuple, options.authorization);
			if (tuples.has(tuple.tuple_id)) fail("tuple_id is duplicated");
			tuples.set(tuple.tuple_id, freeze({ ...tuple }));
		}
		if (tuples.size === 0) fail("at least one tuple is required");

		this.#dispatch = freeze({ ...options.dispatch });
		this.#actor = freeze({ ...options.actor });
		this.#authorization = freeze(structuredClone(options.authorization));
		this.#tuples = tuples;
		this.#executor = options.executor;
		this.#sessionName = options.session_name ?? null;
		if (this.#sessionName !== null && (!this.#sessionName || this.#sessionName.length > 256))
			fail("session_name is invalid");
		this.audit_id = options.dispatch.audit_id;
		this.dispatch_sha256 = dispatchSha256(options.dispatch);
		this.authorization_state_sha256 = hash(canonicalBytes(options.authorization));
	}

	get lifecycle(): BrowserAuditLifecycle {
		return this.#lifecycle;
	}

	get observations(): readonly BrowserAuditObservationRecord[] {
		return Object.freeze(this.#observations.slice());
	}

	#enqueue<T>(work: () => Promise<T> | T): Promise<T> {
		const prior = this.#queue;
		let release!: () => void;
		this.#queue = new Promise<void>(resolve => {
			release = resolve;
		});
		return prior.then(async () => {
			try {
				return await work();
			} finally {
				release();
			}
		});
	}

	#resolve(input: BrowserAuditToolInput): { tuple: BrowserAuditTuple | null; actionId: string | null } {
		validateBrowserAuditInput(input);
		if (input.audit_id !== this.audit_id) fail("audit_id does not match dispatch");
		if (input.operation === "close") return { tuple: null, actionId: null };

		const tupleId = input.tuple_id ?? (this.#tuples.size === 1 ? this.#tuples.keys().next().value : undefined);
		if (typeof tupleId !== "string") fail("tuple_id is required");
		const tuple = this.#tuples.get(tupleId);
		if (!tuple) fail("tuple_id is not authorized");
		if (input.operation !== "act") return { tuple, actionId: null };

		if (!input.action_id) fail("act requires action_id");
		const action = this.#authorization.actions.find(item => item.action_id === input.action_id);
		const route = this.#authorization.route_states.find(item => item.route_state_id === tuple.route_state_id);
		if (
			!action ||
			!route?.allowed_action_ids.includes(input.action_id) ||
			this.#authorization.protected_actions.includes(input.action_id)
		) {
			fail("action_id is not authorized");
		}
		if (
			(this.#authorization.mutation_policy.mode === "deny" && action.mutation === "ephemeral-ui") ||
			(this.#authorization.mutation_policy.mode === "allow-listed" &&
				!this.#authorization.mutation_policy.allowed_action_ids.includes(input.action_id))
		) {
			fail("mutation policy denies action");
		}
		return { tuple, actionId: input.action_id };
	}

	#assertActive(): void {
		if (this.#lifecycle !== "ACTIVE") fail("audit is no longer active");
	}

	#invalidateNow(): void {
		this.#lifecycle = "INVALID";
		this.#snapshot = null;
	}

	#cleanupOwned(): Promise<BrowserAuditCleanupObservation> {
		if (this.#cleanupPromise) return this.#cleanupPromise;
		this.#cleanupPromise = (async () => {
			let closeError: string | null = null;
			try {
				await this.#executor.close(undefined);
			} catch (error) {
				closeError = error instanceof Error ? error.message : String(error);
			}

			try {
				const cleanup = freeze(
					await this.#executor.cleanup({ audit_id: this.audit_id, session_name: this.#sessionName }, undefined),
				);
				if (closeError !== null || !cleanup.close_attempted || !cleanup.closed || cleanup.error !== null) {
					this.#invalidateNow();
				}
				return cleanup;
			} catch (error) {
				const message = closeError ?? (error instanceof Error ? error.message : String(error));
				const cleanup = freeze({
					session_name: this.#sessionName,
					close_attempted: closeError === null,
					closed: false,
					process_kill_requested: true,
					error: message,
				});
				this.#invalidateNow();
				return cleanup;
			}
		})();
		return this.#cleanupPromise;
	}

	async #invalidateUnderQueue(): Promise<void> {
		this.#invalidateNow();
		await this.#cleanupOwned();
	}
	#canPublish(cleanup: BrowserAuditCleanupObservation): boolean {
		return this.#lifecycle === "FINALIZING" && cleanup.close_attempted && cleanup.closed && cleanup.error === null;
	}

	async execute(input: BrowserAuditToolInput, signal?: AbortSignal): Promise<BrowserAuditOperationResult> {
		return this.#enqueue(async () => {
			try {
				validateBrowserAuditInput(input);
			} catch {
				await this.#invalidateUnderQueue();
				return { status: "BLOCKED", evidence_ids: [] };
			}
			if (input.operation === "close") return this.#closeUnderQueue(input.audit_id);
			if (signal?.aborted) {
				await this.#invalidateUnderQueue();
				return { status: "BLOCKED", evidence_ids: [] };
			}

			let tuple: BrowserAuditTuple;
			let actionId: string | null;
			try {
				this.#assertActive();
				const resolved = this.#resolve(input);
				if (!resolved.tuple) fail("ordinary operation requires tuple");
				tuple = resolved.tuple;
				actionId = resolved.actionId;
			} catch {
				await this.#invalidateUnderQueue();
				return { status: "BLOCKED", evidence_ids: [] };
			}
			if (
				this.#sequence >= BROWSER_AUDIT_MAX_ORDINARY_OPERATIONS ||
				this.#observations.length >= BROWSER_AUDIT_MAX_OBSERVATIONS
			) {
				await this.#invalidateUnderQueue();
				return { status: "BLOCKED", evidence_ids: [] };
			}

			const operationId = `operation-${(this.#sequence++).toString(16).padStart(16, "0")}`;
			try {
				await this.#executor.armInterception(
					{
						audit_id: this.audit_id,
						authorization_state_sha256: this.authorization_state_sha256,
						tuple_id: tuple.tuple_id,
					},
					signal,
				);
				if (signal?.aborted || this.#lifecycle !== "ACTIVE") throw new Error("audit invalidated before effect");
				const observation = await this.#executor.execute(
					{
						kind: input.operation,
						audit_id: this.audit_id,
						operation_id: operationId,
						tuple_id: tuple.tuple_id,
						action_id: actionId,
						authorization_state_sha256: this.authorization_state_sha256,
					},
					signal,
				);
				if (signal?.aborted || this.#lifecycle !== "ACTIVE") throw new Error("audit invalidated during effect");
				if (!observation || (observation.status !== "PASS" && observation.status !== "BLOCKED"))
					throw new Error("host observation is uncertain");

				const evidence = projectEvidence(observation.evidence, tuple.tuple_id, operationId);
				const evidenceBytes = canonicalBytes(evidence).byteLength;
				if (
					this.#observations.length + 1 > BROWSER_AUDIT_MAX_OBSERVATIONS ||
					this.#evidence.length + evidence.length > BROWSER_AUDIT_MAX_EVIDENCE_ITEMS ||
					this.#frozenEvidenceBytes + evidenceBytes > BROWSER_AUDIT_MAX_FROZEN_EVIDENCE_BYTES
				) {
					await this.#invalidateUnderQueue();
					return { status: "BLOCKED", operation_id: operationId, evidence_ids: [] };
				}
				const evidenceIds = Object.freeze(evidence.map(item => item.evidence_id));
				this.#evidence.push(...evidence);
				this.#frozenEvidenceBytes += evidenceBytes;
				this.#observations.push(
					freeze({
						operation_id: operationId,
						operation: input.operation,
						tuple_id: tuple.tuple_id,
						action_id: actionId,
						status: observation.status,
						evidence_ids: evidenceIds,
					}),
				);
				if (observation.status === "BLOCKED") await this.#invalidateUnderQueue();
				return { status: observation.status, operation_id: operationId, evidence_ids: evidenceIds };
			} catch {
				await this.#invalidateUnderQueue();
				return { status: "BLOCKED", operation_id: operationId, evidence_ids: [] };
			}
		});
	}

	open(tupleId?: string, signal?: AbortSignal): Promise<BrowserAuditOperationResult> {
		return this.execute({ operation: "open", audit_id: this.audit_id, tuple_id: tupleId }, signal);
	}

	inspect(tupleId: string, signal?: AbortSignal): Promise<BrowserAuditOperationResult> {
		return this.execute({ operation: "inspect", audit_id: this.audit_id, tuple_id: tupleId }, signal);
	}

	act(tupleId: string, actionId: string, signal?: AbortSignal): Promise<BrowserAuditOperationResult> {
		return this.execute(
			{ operation: "act", audit_id: this.audit_id, tuple_id: tupleId, action_id: actionId },
			signal,
		);
	}

	close(auditId = this.audit_id): Promise<BrowserAuditOperationResult> {
		return this.#enqueue(() => this.#closeUnderQueue(auditId));
	}

	async invalidate(): Promise<void> {
		this.#invalidateNow();
		return this.#enqueue(() => this.#cleanupOwned().then(() => undefined));
	}

	async #closeUnderQueue(auditId: string): Promise<BrowserAuditOperationResult> {
		if (auditId !== this.audit_id || this.#lifecycle === "INVALID") {
			await this.#invalidateUnderQueue();
			return { status: "BLOCKED", evidence_ids: [] };
		}
		if (this.#lifecycle === "CLOSED") return { status: "CLOSED", evidence_ids: [] };
		if (this.#lifecycle !== "ACTIVE") {
			await this.#invalidateUnderQueue();
			return { status: "BLOCKED", evidence_ids: [] };
		}

		this.#lifecycle = "FINALIZING";
		const cleanup = await this.#cleanupOwned();
		if (!this.#canPublish(cleanup)) {
			this.#invalidateNow();
			return { status: "BLOCKED", evidence_ids: [] };
		}

		this.#snapshot = freeze({
			audit_id: this.audit_id,
			request_sha256: this.#dispatch.request_sha256,
			dispatch_sha256: this.dispatch_sha256,
			actor_id: this.#actor.actor_id,
			parent_actor_id: this.#actor.parent_actor_id,
			tool_implementation_revision: this.#dispatch.tool_implementation_revision,
			core_package_identity: this.#dispatch.core_package_identity,
			session_name: this.#sessionName,
			observations: this.observations,
			evidence: Object.freeze(this.#evidence.slice()),
			cleanup,
		});
		this.#lifecycle = "CLOSED";
		return { status: "CLOSED", evidence_ids: [] };
	}

	/** Returns the terminal host snapshot once. Invalid runs never expose one. */
	consumeSnapshot(): BrowserAuditSnapshot | null {
		if (this.#snapshotConsumed || this.#lifecycle !== "CLOSED" || !this.#snapshot) return null;
		this.#snapshotConsumed = true;
		const snapshot = this.#snapshot;
		this.#snapshot = null;
		return snapshot;
	}
}

export function createBrowserAuditEngine(options: BrowserAuditEngineOptions): BrowserAuditEngine {
	return new BrowserAuditEngine(options);
}
export const createBrowserAudit = createBrowserAuditEngine;
export const BrowserAudit = BrowserAuditEngine;
