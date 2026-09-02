import { existsSync } from "node:fs";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ToolExample } from "@oh-my-pi/pi-ai";
import { BrowserTool } from "../tools/browser";
import {
	type BrowserHandle,
	forgetAuditBrowserLaunch,
	isBrowserRegistered,
	settleAuditBrowserLaunch,
} from "../tools/browser/registry";
import { getTab, hasTab } from "../tools/browser/tab-supervisor";
import {
	type BrowserAuditAction,
	type BrowserAuditAuthorization,
	BrowserAuditEngine,
	type BrowserAuditFileDocumentAuthority,
	type BrowserAuditObservation,
	type BrowserAuditOperationResult,
	type BrowserAuditTuple,
	type HostEffectExecutor,
	type HostEffectRequest,
	validateBrowserAuditActor,
	validateBrowserAuditAuthorization,
	validateBrowserAuditDispatch,
	validateBrowserAuditInput,
	validateBrowserAuditTuple,
} from "../tools/browser-audit";
import {
	type BrowserAuditBindingInput,
	type BrowserAuditTerminalSnapshotSink,
	buildBrowserAuditInterceptionCode,
	buildBrowserAuditViewportCode,
	handoffBrowserAuditSnapshot,
	readPinnedBrowserAuditFile,
} from "../tools/browser-audit-production";
import type { ToolSession } from "../tools/index";

const browserAuditSchema = type({
	operation: "'open' | 'inspect' | 'act' | 'close'",
	audit_id: "string",
	"tuple_id?": "string",
	"action_id?": "string",
});
type BrowserAuditRuntimeParams = typeof browserAuditSchema.infer;
const browserAuditAuthority = Symbol("browser-audit-prepared-authority");

interface BrowserAuditProductionOptions extends BrowserAuditBindingInput {
	readonly [browserAuditAuthority]: true;
}

export type BrowserAuditToolCapability = object;

export interface BrowserAuditSpawnBindingIdentity {
	readonly agentName: string;
	readonly agentSource: string;
	readonly agentLogicalPath: string | undefined;
	readonly agentDefinitionSha256: string | undefined;
	readonly spawnId: string;
	readonly parentAgentId: string | null;
	readonly toolCallFingerprint: string;
}

export interface BrowserAuditTaskAuthority {
	install(key: object, options: BrowserAuditBindingInput): void;
	activate(key: object, identity: BrowserAuditSpawnBindingIdentity): BrowserAuditToolCapability | undefined;
	revoke(key: object): void;
}

interface BrowserAuditAuthorityBroker {
	readonly task: BrowserAuditTaskAuthority;
	createTool(session: ToolSession): BrowserAuditTool | null;
}

const taskAuthorities = new WeakMap<object, BrowserAuditTaskAuthority>();
const runCapabilities = new WeakMap<object, BrowserAuditToolCapability>();
const sessionOptionCapabilities = new WeakMap<object, BrowserAuditToolCapability>();
const toolSessionCapabilities = new WeakMap<object, BrowserAuditToolCapability>();

export function bindBrowserAuditTaskAuthority(session: ToolSession, authority: BrowserAuditTaskAuthority): void {
	if (taskAuthorities.has(session)) throw new Error("browser_audit: Task authority is already bound to this session");
	taskAuthorities.set(session, authority);
}

export function takeBrowserAuditTaskAuthority(session: ToolSession): BrowserAuditTaskAuthority | undefined {
	const authority = taskAuthorities.get(session);
	taskAuthorities.delete(session);
	return authority;
}

export function bindBrowserAuditRunOptions(options: object, capability: BrowserAuditToolCapability | undefined): void {
	if (capability === undefined) return;
	if (runCapabilities.has(options)) throw new Error("browser_audit: run capability is already bound");
	runCapabilities.set(options, capability);
}

export function takeBrowserAuditRunCapability(options: object): BrowserAuditToolCapability | undefined {
	const capability = runCapabilities.get(options);
	runCapabilities.delete(options);
	return capability;
}

export function bindBrowserAuditSessionOptions(
	options: object,
	capability: BrowserAuditToolCapability | undefined,
): void {
	if (capability === undefined) return;
	if (sessionOptionCapabilities.has(options)) throw new Error("browser_audit: session capability is already bound");
	sessionOptionCapabilities.set(options, capability);
}

export function takeBrowserAuditSessionCapability(options: object): BrowserAuditToolCapability | undefined {
	const capability = sessionOptionCapabilities.get(options);
	sessionOptionCapabilities.delete(options);
	return capability;
}

export function bindBrowserAuditToolSession(
	session: ToolSession,
	capability: BrowserAuditToolCapability | undefined,
): void {
	if (capability === undefined) return;
	if (toolSessionCapabilities.has(session)) throw new Error("browser_audit: tool session capability is already bound");
	toolSessionCapabilities.set(session, capability);
}

export function clearBrowserAuditToolSession(session: ToolSession): void {
	toolSessionCapabilities.delete(session);
}

const BLOCKED_RESULT: BrowserAuditOperationResult = Object.freeze({
	status: "BLOCKED",
	evidence_ids: Object.freeze([]),
});

function validateOptions(options: BrowserAuditBindingInput): void {
	validateBrowserAuditDispatch(options.dispatch);
	validateBrowserAuditActor(options.actor);
	validateBrowserAuditAuthorization(options.authorization, options.file_document_authority);
	if (
		options.spawn_id !== options.actor.actor_id ||
		options.spawn_id !== options.dispatch.expected_spawn_id ||
		options.actor.parent_actor_id !== options.dispatch.expected_parent_actor_id
	) {
		throw new Error("browser_audit: actor identity does not match spawn provenance");
	}
	if (!Array.isArray(options.tuples) || options.tuples.length === 0 || options.tuples.length > 128) {
		throw new Error("browser_audit: tuples are invalid");
	}
	const ids = new Set<string>();
	for (const tuple of options.tuples) {
		validateBrowserAuditTuple(tuple, options.authorization);
		if (ids.has(tuple.tuple_id)) throw new Error("browser_audit: tuple_id is duplicated");
		ids.add(tuple.tuple_id);
	}
	if (options.terminal_snapshot_sink !== undefined && typeof options.terminal_snapshot_sink !== "function") {
		throw new Error("browser_audit: terminal snapshot sink is invalid");
	}
}

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}

function freezeBindingInput(options: BrowserAuditBindingInput): BrowserAuditBindingInput {
	validateOptions(options);
	const authority = deepFreeze({
		dispatch: structuredClone(options.dispatch),
		actor: structuredClone(options.actor),
		spawn_id: options.spawn_id,
		authorization: structuredClone(options.authorization),
		tuples: structuredClone(options.tuples),
		file_document_authority:
			options.file_document_authority === null ? null : structuredClone(options.file_document_authority),
		session_name: options.session_name,
		terminal_snapshot_sink: options.terminal_snapshot_sink,
	});
	validateOptions(authority);
	return authority;
}

function observation(
	status: "PASS" | "BLOCKED",
	description: string,
	kind: "navigation" | "accessibility" | "interaction" | "network",
): BrowserAuditObservation {
	return {
		status,
		evidence: [{ evidence_id: "host", tuple_id: "host", kind, locator: null, sha256: null, description }],
		error: status === "PASS" ? null : description,
	};
}

function createBrowserAuditAuthorityBroker(): BrowserAuditAuthorityBroker {
	const preparedBindings = new WeakMap<object, BrowserAuditBindingInput>();
	const activatedBindings = new WeakSet<object>();
	const install = (key: object, options: BrowserAuditBindingInput): void => {
		if (preparedBindings.has(key)) throw new Error("browser_audit: prepared binding already exists");
		preparedBindings.set(key, freezeBindingInput(options));
	};
	const revoke = (key: object): void => {
		preparedBindings.delete(key);
	};
	const activate = (
		key: object,
		identity: BrowserAuditSpawnBindingIdentity,
	): BrowserAuditToolCapability | undefined => {
		const candidate = preparedBindings.get(key);
		preparedBindings.delete(key);
		if (
			!candidate ||
			identity.agentName !== "browser-audit-specialist" ||
			typeof identity.parentAgentId !== "string" ||
			identity.parentAgentId.length === 0
		) {
			return undefined;
		}
		const dispatch = candidate.dispatch;
		if (
			candidate.spawn_id !== identity.spawnId ||
			candidate.actor.actor_id !== identity.spawnId ||
			dispatch.expected_spawn_id !== identity.spawnId ||
			candidate.actor.parent_actor_id !== identity.parentAgentId ||
			dispatch.expected_parent_actor_id !== identity.parentAgentId ||
			dispatch.agent_source !== identity.agentSource ||
			dispatch.agent_logical_path !== identity.agentLogicalPath ||
			dispatch.agent_definition_sha256 !== identity.agentDefinitionSha256 ||
			dispatch.tool_call_fingerprint !== identity.toolCallFingerprint
		) {
			return undefined;
		}
		const capability = Object.freeze({ ...candidate, [browserAuditAuthority]: true as const });
		activatedBindings.add(capability);
		return capability;
	};
	const createTool = (session: ToolSession): BrowserAuditTool | null => {
		const capability = toolSessionCapabilities.get(session);
		toolSessionCapabilities.delete(session);
		if (session.isDisposed?.() === true || capability === undefined) return null;
		if (!activatedBindings.delete(capability)) {
			throw new Error("browser_audit: activation is not bound to this registry authority");
		}
		return new BrowserAuditTool(session, capability as BrowserAuditProductionOptions);
	};
	return Object.freeze({ task: Object.freeze({ install, activate, revoke }), createTool });
}

function routeAndViewportCode(
	route: BrowserAuditAuthorization["route_states"][number],
	viewport: BrowserAuditAuthorization["viewports"][number],
): string {
	const locator = JSON.stringify(route.locator);
	const assertions = JSON.stringify(route.state_assertions);
	const expectedViewport = JSON.stringify({
		width: viewport.width,
		height: viewport.height,
		deviceScaleFactor: viewport.device_scale_factor,
	});
	return `
const expectedLocator = ${locator};
const expectedViewport = ${expectedViewport};
const current = await tab.observe();
if (current.url !== expectedLocator) throw new Error("authorized route state does not match current document");
if (current.viewport.width !== expectedViewport.width || current.viewport.height !== expectedViewport.height || current.viewport.deviceScaleFactor !== expectedViewport.deviceScaleFactor) throw new Error("authorized viewport does not match current viewport");
for (const selector of ${assertions}) {
  if (!(await page.$(selector))) throw new Error("authorized route state assertion is not satisfied");
}
`;
}

class NativeBrowserAuditAdapter implements HostEffectExecutor {
	readonly #browser: BrowserTool;
	readonly #authorization: BrowserAuditAuthorization;
	readonly #tuples: ReadonlyMap<string, BrowserAuditTuple>;
	readonly #sessionName: string;
	readonly #auditId: string;
	#ownedBrowser: BrowserHandle | null = null;
	#opened = false;
	#closed = false;
	readonly #fileDocumentAuthority: BrowserAuditFileDocumentAuthority | null;
	readonly #repositoryRoot: string;
	#pinnedFileDocument: Uint8Array | null = null;

	constructor(session: ToolSession, options: BrowserAuditProductionOptions) {
		this.#browser = new BrowserTool(session, { dedicatedAuditId: options.dispatch.audit_id });
		this.#auditId = options.dispatch.audit_id;
		this.#authorization = options.authorization;
		this.#tuples = new Map(options.tuples.map(tuple => [tuple.tuple_id, tuple]));
		this.#sessionName = options.session_name ?? `audit-${options.dispatch.audit_id}`;
		this.#fileDocumentAuthority = options.file_document_authority;
		this.#repositoryRoot = session.cwd;
	}

	async armInterception(
		input: {
			readonly audit_id: string;
			readonly authorization_state_sha256: string;
			readonly tuple_id: string;
		},
		signal: AbortSignal | undefined,
	): Promise<void> {
		if (signal?.aborted || this.#closed) throw new Error("browser audit aborted before interception");
		if (input.audit_id !== this.#auditId) throw new Error("browser audit identity changed before interception");
		const tuple = this.#tuples.get(input.tuple_id);
		const route = tuple
			? this.#authorization.route_states.find(item => item.route_state_id === tuple.route_state_id)
			: undefined;
		const viewport = tuple
			? this.#authorization.viewports.find(item => item.viewport_id === tuple.viewport_id)
			: undefined;
		if (!tuple || !route || !viewport) throw new Error("host route or viewport is unavailable before interception");
		if (this.#fileDocumentAuthority && this.#pinnedFileDocument === null) {
			this.#pinnedFileDocument = await readPinnedBrowserAuditFile(this.#fileDocumentAuthority, this.#repositoryRoot);
		}
		if (!this.#opened && hasTab(this.#sessionName)) {
			throw new Error("an incumbent tab uses the dedicated audit session name");
		}
		if (!this.#opened) {
			await this.#browser.execute(
				`browser-audit:arm:${this.#auditId}:open`,
				{
					action: "open",
					name: this.#sessionName,
					viewport: { width: viewport.width, height: viewport.height, scale: viewport.device_scale_factor },
				} as never,
				signal,
			);
			const tab = getTab(this.#sessionName, input.audit_id);
			if (tab?.browser.kind.kind !== "audit" || tab.browser.kind.auditId !== input.audit_id) {
				throw new Error("dedicated browser ownership could not be established before interception");
			}
			this.#ownedBrowser = tab.browser;
			this.#opened = true;
		}
		await this.#browser.execute(
			`browser-audit:arm:${this.#auditId}:guards`,
			{
				action: "run",
				name: this.#sessionName,
				code: buildBrowserAuditInterceptionCode(
					route.locator,
					this.#authorization.resource_policy.mode === "allow-listed"
						? this.#authorization.resource_policy.allowed_origins
						: [],
					false,
					"return undefined;",
					this.#pinnedFileDocument ? Buffer.from(this.#pinnedFileDocument).toString("base64") : undefined,
				),
			} as never,
			signal,
		);
		if (signal?.aborted || this.#closed) throw new Error("browser audit invalidated while arming interception");
	}

	async execute(request: HostEffectRequest, signal: AbortSignal | undefined): Promise<BrowserAuditObservation> {
		if (signal?.aborted || this.#closed) return observation("BLOCKED", "browser audit is not active", "network");
		const tuple = this.#tuples.get(request.tuple_id);
		if (!tuple) return observation("BLOCKED", "tuple is not authorized", "network");
		const route = this.#authorization.route_states.find(item => item.route_state_id === tuple.route_state_id);
		const viewport = this.#authorization.viewports.find(item => item.viewport_id === tuple.viewport_id);
		if (!route || !viewport) return observation("BLOCKED", "host route or viewport is unavailable", "network");
		if (!this.#opened) return observation("BLOCKED", "browser audit interception is not armed", "network");
		try {
			const action = request.action_id
				? this.#authorization.actions.find(item => item.action_id === request.action_id)
				: undefined;
			if (request.kind === "act" && (!action || action.kind === "navigate")) {
				return observation("BLOCKED", "action navigation is denied", "interaction");
			}
			const verifiedState = routeAndViewportCode(route, viewport);
			const applyViewport = buildBrowserAuditViewportCode(viewport);
			let primitive: string;
			if (request.kind === "open") {
				primitive = `${applyViewport} await tab.goto(${JSON.stringify(route.locator)});${verifiedState}`;
			} else if (request.kind === "inspect") {
				primitive = `${applyViewport} ${verifiedState} await tab.observe();`;
			} else {
				if (!action) return observation("BLOCKED", "action is unavailable", "interaction");
				primitive = `${applyViewport} ${verifiedState} ${actionCode(action)} ${verifiedState}`;
			}
			await this.#browser.execute(
				`browser-audit:${request.operation_id}:run`,
				{
					action: "run",
					name: this.#sessionName,
					code: buildBrowserAuditInterceptionCode(
						route.locator,
						this.#authorization.resource_policy.mode === "allow-listed"
							? this.#authorization.resource_policy.allowed_origins
							: [],
						request.kind === "open",
						primitive,
						this.#pinnedFileDocument ? Buffer.from(this.#pinnedFileDocument).toString("base64") : undefined,
					),
				} as never,
				signal,
			);
			if (signal?.aborted || this.#closed) throw new Error("browser audit invalidated while running");
			return observation(
				"PASS",
				request.kind === "open"
					? "opened authorized document"
					: request.kind === "inspect"
						? "inspected authorized state"
						: "performed authorized interaction",
				request.kind === "open" ? "navigation" : request.kind === "inspect" ? "accessibility" : "interaction",
			);
		} catch (error) {
			const settled = await settleAuditBrowserLaunch(this.#auditId);
			const tab = getTab(this.#sessionName, request.audit_id);
			const owned = tab?.browser ?? settled.handle;
			if (owned?.kind.kind === "audit" && owned.kind.auditId === request.audit_id) {
				this.#ownedBrowser = owned;
				this.#opened = tab !== undefined;
			}
			return observation("BLOCKED", error instanceof Error ? error.message : String(error), "network");
		}
	}

	async close(signal: AbortSignal | undefined): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		if (!this.#opened) return;
		let violation: unknown;
		try {
			await this.#browser.execute(
				`browser-audit:verify:${this.#sessionName}`,
				{
					action: "run",
					name: this.#sessionName,
					code: `
const auditState = page.__browserAuditState;
if (!auditState?.guardsInstalled) throw new Error("browser audit guards are unavailable during finalization");
auditState.operation = undefined;
auditState.finalizing = true;
await new Promise(resolve => setTimeout(resolve, 0));
await new Promise(resolve => setTimeout(resolve, 0));
let pageViolation;
try { pageViolation = await page.evaluate(() => globalThis.__browserAuditPageViolation); } catch (error) { throw new Error("browser audit page guard is unobservable: " + String(error)); }
if (pageViolation && !auditState.violation) auditState.violation = String(pageViolation);
if (auditState.violation) throw new Error("browser audit forbidden channel: " + auditState.violation);
`,
				} as never,
				signal,
			);
		} catch (error) {
			violation = error;
		}
		try {
			await this.#browser.execute(
				`browser-audit:close:${this.#sessionName}`,
				{ action: "close", name: this.#sessionName, kill: true } as never,
				signal,
			);
		} finally {
			this.#opened = false;
		}
		if (violation !== undefined) throw violation;
	}

	async cleanup(
		input: { readonly audit_id: string; readonly session_name: string | null },
		_signal: AbortSignal | undefined,
	) {
		const settled = await settleAuditBrowserLaunch(this.#auditId);
		const owned = this.#ownedBrowser ?? settled.handle;
		const tabGone = !hasTab(this.#sessionName);
		const registryGone = owned === null || !isBrowserRegistered(owned);
		const disconnected = owned === null || !("browser" in owned) || !owned.browser.connected;
		const process = owned !== null && "browser" in owned ? owned.browser.process() : null;
		const processGone =
			owned === null || (process !== null && (process.exitCode !== null || process.signalCode !== null));
		const profileGone =
			owned === null || !("userDataDir" in owned) || !owned.userDataDir || !existsSync(owned.userDataDir);
		const launchKnownClean = !settled.failed && (!settled.attempted || owned !== null);
		const closed =
			this.#closed && launchKnownClean && tabGone && registryGone && disconnected && processGone && profileGone;
		const residual = [
			launchKnownClean ? null : "launch",
			tabGone ? null : "tab",
			registryGone ? null : "registry",
			disconnected ? null : "connection",
			processGone ? null : "process",
			profileGone ? null : "profile",
		].filter((value): value is string => value !== null);
		forgetAuditBrowserLaunch(this.#auditId);
		return {
			session_name: input.session_name,
			close_attempted: this.#closed,
			closed,
			process_kill_requested: this.#closed && owned !== null,
			error: closed ? null : `owned browser cleanup unverified: ${residual.join(", ") || "close not attempted"}`,
		};
	}
}

function actionCode(action: BrowserAuditAction): string {
	const target = JSON.stringify(action.target);
	const value = action.value === null ? "undefined" : JSON.stringify(action.value);
	switch (action.kind) {
		case "click":
			return `await tab.click(${target});`;
		case "type":
			return `await tab.type(${target}, ${value});`;
		case "press":
			return `await tab.press(${value === "undefined" ? target : value});`;
		case "select":
			return `await tab.select(${target}, ${value});`;
		case "scroll":
			return `await tab.scroll(0, Number(${value}));`;
		case "navigate":
			return 'throw new Error("action navigation is denied");';
	}
}

class BrowserAuditTool implements AgentTool<typeof browserAuditSchema, BrowserAuditOperationResult> {
	readonly name = "browser_audit";
	readonly label = "Browser Audit";
	readonly description = "Run a fail-closed, permission-bound browser audit using host-derived identifiers.";
	readonly parameters = browserAuditSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;
	readonly summary = "Run a browser audit";
	readonly examples: readonly ToolExample<BrowserAuditRuntimeParams>[] = [];
	readonly #engine: BrowserAuditEngine;
	readonly #terminalSnapshotSink: BrowserAuditTerminalSnapshotSink | undefined;
	#terminalization: Promise<boolean> | undefined;
	#unregisterDispose: (() => void) | undefined;
	#unregisterSessionChange: (() => void) | undefined;

	constructor(session: ToolSession, options: BrowserAuditProductionOptions) {
		if (options[browserAuditAuthority] !== true) {
			throw new Error("browser_audit: prepared authority brand is invalid");
		}
		validateOptions(options);
		const sessionAgentId = session.getAgentId?.();
		if (sessionAgentId !== undefined && sessionAgentId !== null && sessionAgentId !== options.spawn_id) {
			throw new Error("browser_audit: session identity does not match bound spawn");
		}
		const sessionName = options.session_name ?? `audit-${options.dispatch.audit_id}`;
		const adapter = new NativeBrowserAuditAdapter(session, options);
		this.#engine = new BrowserAuditEngine({
			dispatch: options.dispatch,
			actor: options.actor,
			spawn_id: options.spawn_id,
			authorization: options.authorization,
			tuples: options.tuples,
			file_document_authority: options.file_document_authority,
			executor: adapter,
			session_name: sessionName,
		});
		this.#terminalSnapshotSink = options.terminal_snapshot_sink;
		this.#unregisterDispose = session.registerDisposeCallback?.(() => this.#invalidate()) as (() => void) | undefined;
		this.#unregisterSessionChange = session.registerSessionChangeCallback?.(() => this.#invalidate()) as
			| (() => void)
			| undefined;
	}

	async execute(
		_toolCallId: string,
		params: BrowserAuditRuntimeParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<BrowserAuditOperationResult>,
	): Promise<AgentToolResult<BrowserAuditOperationResult>> {
		let result = BLOCKED_RESULT;
		try {
			validateBrowserAuditInput(params);
			result = await this.#engine.execute(params, signal);
			if (params.operation === "close" && !(await this.#terminalize(result.status === "CLOSED", signal))) {
				result = BLOCKED_RESULT;
			}
		} catch {
			await this.#invalidate();
		}
		return { content: [{ type: "text", text: result.status }], details: result };
	}

	async #invalidate(): Promise<void> {
		await this.#engine.invalidate();
	}

	async #terminalize(closed: boolean, signal?: AbortSignal): Promise<boolean> {
		if (this.#terminalization) return this.#terminalization;
		this.#terminalization = (async () => {
			if (!closed || signal?.aborted) {
				await this.#engine.invalidate();
				return false;
			}
			signal?.throwIfAborted();
			return handoffBrowserAuditSnapshot(this.#engine, this.#terminalSnapshotSink, () => {
				this.#unregisterDispose?.();
				this.#unregisterSessionChange?.();
				this.#unregisterDispose = undefined;
				this.#unregisterSessionChange = undefined;
			});
		})();
		return this.#terminalization;
	}
}

const browserAuditRegistryAuthority = createBrowserAuditAuthorityBroker();

export function installRegisteredBrowserAuditBinding(key: object, binding: BrowserAuditBindingInput): void {
	browserAuditRegistryAuthority.task.install(key, binding);
}

export function bindRegisteredBrowserAuditTaskAuthority(session: ToolSession): void {
	bindBrowserAuditTaskAuthority(session, browserAuditRegistryAuthority.task);
}

export function createRegisteredBrowserAuditTool(session: ToolSession): BrowserAuditTool | null {
	return browserAuditRegistryAuthority.createTool(session);
}
