import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import {
	getTab,
	getTabsMapForTest,
	releaseAllTabs,
	releaseTab,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { createRunPageScope } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker";
import {
	BROWSER_AUDIT_CORE_PACKAGE_IDENTITY,
	BROWSER_AUDIT_MAX_EVIDENCE_ITEMS,
	BROWSER_AUDIT_MAX_FROZEN_EVIDENCE_BYTES,
	BROWSER_AUDIT_MAX_OBSERVATIONS,
	BROWSER_AUDIT_MAX_ORDINARY_OPERATIONS,
	BROWSER_AUDIT_TOOL_IMPLEMENTATION_REVISION,
	type BrowserAuditActor,
	type BrowserAuditAuthorization,
	type BrowserAuditDispatch,
	BrowserAuditEngine,
	type BrowserAuditEvidence,
	type BrowserAuditFileDocumentAuthority,
	type BrowserAuditObservation,
	type BrowserAuditSnapshot,
	type BrowserAuditTuple,
	canonicalBytes,
	type HostEffectExecutor,
	validateBrowserAuditDispatch,
	validateBrowserAuditFileDocumentAuthority,
} from "@oh-my-pi/pi-coding-agent/tools/browser-audit";
import {
	buildBrowserAuditInterceptionCode,
	buildBrowserAuditViewportCode,
	handoffBrowserAuditSnapshot,
	readPinnedBrowserAuditFile,
} from "@oh-my-pi/pi-coding-agent/tools/browser-audit-production";

let auditSequence = 0;

function createAuditId(): string {
	auditSequence++;
	return `browser-audit-${auditSequence.toString(16).padStart(16, "0")}`;
}

function fixtures(auditId = createAuditId()) {
	const actor: BrowserAuditActor = {
		actor_kind: "sub",
		actor_id: "specialist",
		parent_actor_id: "parent",
	};
	const dispatch: BrowserAuditDispatch = {
		schema: "browser-audit-dispatch/v2",
		audit_id: auditId,
		request_sha256: "a".repeat(64),
		task_sha256: "b".repeat(64),
		request_byte_count: 1,
		task_byte_count: 1,
		agent_source: "user",
		agent_logical_path: "agents/browser-audit-specialist.md",
		agent_definition_sha256: "c".repeat(64),
		tool_origin_class: "builtin",
		tool_implementation_revision: BROWSER_AUDIT_TOOL_IMPLEMENTATION_REVISION,
		core_package_identity: BROWSER_AUDIT_CORE_PACKAGE_IDENTITY,
		expected_spawn_id: actor.actor_id,
		expected_parent_actor_id: actor.parent_actor_id,
		tool_call_fingerprint: "d".repeat(64),
	};
	const authorization: BrowserAuditAuthorization = {
		document_locators: ["https://example.test/audit"],
		origins: ["https://example.test"],
		route_states: [
			{
				route_state_id: "route",
				locator: "https://example.test/audit",
				state_assertions: [],
				allowed_action_ids: ["click"],
			},
		],
		viewports: [{ viewport_id: "viewport", width: 800, height: 600, device_scale_factor: 1 }],
		actions: [{ action_id: "click", kind: "click", target: "#approved", value: null, mutation: "none" }],
		mutation_policy: { mode: "deny", allowed_action_ids: [] },
		credential_policy: { mode: "deny-raw", pre_established_state_ids: [] },
		screenshot_policy: { mode: "deny", max_count: 0, max_bytes: 0, allowed_check_ids: [] },
		resource_policy: {
			mode: "allow-listed",
			allowed_origins: ["https://example.test"],
			allow_file_subresources: false,
		},
		protected_actions: [],
	};
	const tuples: readonly BrowserAuditTuple[] = [
		{ tuple_id: "check@route@viewport", check_id: "check", route_state_id: "route", viewport_id: "viewport" },
	];
	return { actor, authorization, dispatch, tuples };
}

function passingObservation(): BrowserAuditObservation {
	return {
		status: "PASS",
		evidence: [
			{
				evidence_id: "untrusted",
				tuple_id: "wrong",
				kind: "accessibility",
				locator: "#approved",
				sha256: null,
				description: "approved element is visible",
			},
		],
		error: null,
	};
}
function evidenceBatch(count: number, description = "evidence"): readonly BrowserAuditEvidence[] {
	return Array.from({ length: count }, (_, index) => ({
		evidence_id: `untrusted-${index}`,
		tuple_id: "untrusted",
		kind: "network" as const,
		locator: null,
		sha256: null,
		description,
	}));
}

function projectedEvidenceBytes(operationIndex: number, count: number, description: string): number {
	const operationId = `operation-${operationIndex.toString(16).padStart(16, "0")}`;
	const projected = Array.from({ length: count }, (_, index) => ({
		evidence_id: `evidence-${operationId}-${index.toString(16).padStart(4, "0")}`,
		tuple_id: "check@route@viewport",
		kind: "network" as const,
		locator: null,
		sha256: null,
		description,
	}));
	return canonicalBytes(projected).byteLength;
}

function createExecutor(overrides: Partial<HostEffectExecutor> = {}) {
	let closes = 0;
	let cleanups = 0;
	const executor: HostEffectExecutor = {
		armInterception: () => undefined,
		execute: async () => passingObservation(),
		close: async () => {
			closes++;
		},
		cleanup: () => {
			cleanups++;
			return { session_name: null, close_attempted: true, closed: true, process_kill_requested: true, error: null };
		},
		...overrides,
	};
	return { executor, closes: () => closes, cleanups: () => cleanups };
}

function createEngine(executor: HostEffectExecutor, auditId?: string): BrowserAuditEngine {
	const { actor, authorization, dispatch, tuples } = fixtures(auditId);
	return new BrowserAuditEngine({
		dispatch,
		actor,
		spawn_id: actor.actor_id,
		authorization,
		tuples,
		file_document_authority: null,
		executor,
	});
}
describe("Browser Audit tab ownership", () => {
	it("hides audit-owned tabs from ordinary lookup and close-all operations", async () => {
		const name = "audit-browser-audit-ownership";
		const tabs = getTabsMapForTest() as Map<string, any>;
		tabs.set(name, {
			name,
			browser: { kind: { kind: "audit", auditId: "browser-audit-owner" } },
			state: "alive",
		});
		try {
			expect(getTab(name)).toBeUndefined();
			expect(getTab(name, "browser-audit-owner")).toBeDefined();
			expect(await releaseAllTabs()).toBe(0);
			expect(tabs.has(name)).toBe(true);
			await expect(releaseTab(name)).rejects.toThrow("owned by a dedicated browser audit");
		} finally {
			tabs.delete(name);
		}
	});
});
describe("Browser Audit fixed provenance", () => {
	it("rejects caller-asserted core revision and package identity", () => {
		const { dispatch } = fixtures();
		expect(() => validateBrowserAuditDispatch({ ...dispatch, tool_implementation_revision: "forged" })).toThrow(
			"dispatch package identity is invalid",
		);
		expect(() => validateBrowserAuditDispatch({ ...dispatch, core_package_identity: "forged" })).toThrow(
			"dispatch package identity is invalid",
		);
	});

	it("derives distinct host viewport primitives for each authorized tuple viewport", () => {
		const first = buildBrowserAuditViewportCode({
			viewport_id: "desktop",
			width: 1440,
			height: 900,
			device_scale_factor: 1,
		});
		const second = buildBrowserAuditViewportCode({
			viewport_id: "mobile",
			width: 390,
			height: 844,
			device_scale_factor: 2,
		});
		expect(first).toContain('setViewport({"width":1440,"height":900,"deviceScaleFactor":1})');
		expect(second).toContain('setViewport({"width":390,"height":844,"deviceScaleFactor":2})');
		expect(second).not.toBe(first);
	});
});

describe("Browser Audit file document authority", () => {
	const authority = {
		schema: "browser-audit-file-document-authority/v1",
		document_locator: "file:///workspace/fixture.html",
		expected_sha256: "a".repeat(64),
		hash_authority: "caller-verified-external",
		hash_verified_external: true,
		repository_local: true,
		document_only: true,
	};

	it("accepts only the exact externally verified canonical file authority", () => {
		expect(() => validateBrowserAuditFileDocumentAuthority(authority)).not.toThrow();
		for (const invalid of [
			{ ...authority, expected_sha256: "A".repeat(64) },
			{ ...authority, hash_verified_external: false },
			{ ...authority, repository_local: false },
			{ ...authority, document_only: false },
			{ ...authority, document_locator: "file://host/workspace/fixture.html" },
			{ ...authority, document_locator: "file:///workspace/fixture.html?query=1" },
			{ ...authority, extra: true },
		]) {
			expect(() => validateBrowserAuditFileDocumentAuthority(invalid)).toThrow();
		}
	});
});

describe("BrowserAuditEngine fail-closed lifecycle", () => {
	it("derives frozen host evidence IDs and keeps records aligned with operation IDs", async () => {
		const { executor } = createExecutor();
		const engine = createEngine(executor);
		const opened = await engine.open();
		expect(opened.status).toBe("PASS");
		await engine.close();
		const snapshot = engine.consumeSnapshot();
		expect(snapshot?.observations[0]?.evidence_ids).toEqual(snapshot?.evidence.map(item => item.evidence_id));
		expect(snapshot?.evidence[0]?.tuple_id).toBe("check@route@viewport");
		expect(Object.isFrozen(snapshot?.evidence ?? [])).toBe(true);
		expect(Object.isFrozen(snapshot?.evidence[0] ?? {})).toBe(true);
		expect(engine.consumeSnapshot()).toBeNull();
	});

	it("serializes operations and invalidates on an abort that arrives during an effect", async () => {
		let release!: () => void;
		const effect = new Promise<void>(resolve => {
			release = resolve;
		});
		const { executor, closes, cleanups } = createExecutor({
			execute: async () => {
				await effect;
				return passingObservation();
			},
		});
		const engine = createEngine(executor);
		const controller = new AbortController();
		const first = engine.open(undefined, controller.signal);
		const second = engine.inspect("check@route@viewport");
		controller.abort();
		release();
		expect((await first).status).toBe("BLOCKED");
		expect((await second).status).toBe("BLOCKED");
		expect(engine.lifecycle).toBe("INVALID");
		expect(closes()).toBe(1);
		expect(cleanups()).toBe(1);
		expect(engine.consumeSnapshot()).toBeNull();
	});

	it("cleans up once for blocked observations and wrong audit IDs", async () => {
		const blocked = createExecutor({ execute: async () => ({ status: "BLOCKED", error: "denied" }) });
		const blockedEngine = createEngine(blocked.executor);
		expect((await blockedEngine.open()).status).toBe("BLOCKED");
		expect(blocked.closes()).toBe(1);
		expect(blocked.cleanups()).toBe(1);

		const wrong = createExecutor();
		const wrongEngine = createEngine(wrong.executor);
		expect((await wrongEngine.close("browser-audit-ffffffffffffffff")).status).toBe("BLOCKED");
		expect(wrong.closes()).toBe(1);
		expect(wrong.cleanups()).toBe(1);
	});

	it("gates snapshots on verified cleanup and burns audit identifiers", async () => {
		const auditId = createAuditId();
		const unverified = createExecutor({
			cleanup: () => ({
				session_name: null,
				close_attempted: true,
				closed: false,
				process_kill_requested: true,
				error: "resource remains",
			}),
		});
		const engine = createEngine(unverified.executor, auditId);
		await engine.open();
		expect((await engine.close()).status).toBe("BLOCKED");
		expect(engine.consumeSnapshot()).toBeNull();
		expect(() => createEngine(createExecutor().executor, auditId)).toThrow("audit_id has already been used");
	});

	it("poisons a closed audit on every late non-close operation without repeating cleanup", async () => {
		for (const operation of ["open", "inspect", "act"] as const) {
			const { executor, closes, cleanups } = createExecutor();
			const engine = createEngine(executor);
			await engine.open();
			expect((await engine.close()).status).toBe("CLOSED");
			const late =
				operation === "open"
					? await engine.open()
					: operation === "inspect"
						? await engine.inspect("check@route@viewport")
						: await engine.act("check@route@viewport", "click");
			expect(late.status).toBe("BLOCKED");
			expect(engine.lifecycle).toBe("INVALID");
			expect(engine.consumeSnapshot()).toBeNull();
			expect(closes()).toBe(1);
			expect(cleanups()).toBe(1);
		}
	});

	it("accepts the ordinary-operation and observation boundary and blocks the next append", async () => {
		expect(BROWSER_AUDIT_MAX_OBSERVATIONS).toBe(BROWSER_AUDIT_MAX_ORDINARY_OPERATIONS);
		const boundary = createEngine(
			createExecutor({ execute: async () => ({ status: "PASS", evidence: [] }) }).executor,
		);
		for (let index = 0; index < BROWSER_AUDIT_MAX_ORDINARY_OPERATIONS; index++) {
			expect((await boundary.inspect("check@route@viewport")).status).toBe("PASS");
		}
		expect((await boundary.close()).status).toBe("CLOSED");
		expect(boundary.consumeSnapshot()?.observations).toHaveLength(BROWSER_AUDIT_MAX_OBSERVATIONS);

		const exceeded = createEngine(
			createExecutor({ execute: async () => ({ status: "PASS", evidence: [] }) }).executor,
		);
		for (let index = 0; index < BROWSER_AUDIT_MAX_ORDINARY_OPERATIONS; index++) {
			await exceeded.inspect("check@route@viewport");
		}
		expect((await exceeded.inspect("check@route@viewport")).status).toBe("BLOCKED");
		expect(exceeded.lifecycle).toBe("INVALID");
		expect(exceeded.consumeSnapshot()).toBeNull();
	});

	it("accepts the cumulative evidence-item boundary and never truncates an over-bound run", async () => {
		const batchSize = 64;
		const batches = BROWSER_AUDIT_MAX_EVIDENCE_ITEMS / batchSize;
		const executor = createExecutor({
			execute: async () => ({ status: "PASS", evidence: evidenceBatch(batchSize) }),
		});
		const boundary = createEngine(executor.executor);
		for (let index = 0; index < batches; index++)
			expect((await boundary.inspect("check@route@viewport")).status).toBe("PASS");
		expect((await boundary.close()).status).toBe("CLOSED");
		expect(boundary.consumeSnapshot()?.evidence).toHaveLength(BROWSER_AUDIT_MAX_EVIDENCE_ITEMS);

		const exceeded = createEngine(
			createExecutor({ execute: async () => ({ status: "PASS", evidence: evidenceBatch(batchSize) }) }).executor,
		);
		for (let index = 0; index < batches; index++) await exceeded.inspect("check@route@viewport");
		expect((await exceeded.inspect("check@route@viewport")).status).toBe("BLOCKED");
		expect(exceeded.lifecycle).toBe("INVALID");
		expect(exceeded.consumeSnapshot()).toBeNull();
	});

	it("accepts the cumulative frozen-byte boundary and invalidates before an oversized append", async () => {
		const batchSize = 32;
		const description = "x".repeat(1_024);
		let bytes = 0;
		let batches = 0;
		while (
			(batches + 1) * batchSize <= BROWSER_AUDIT_MAX_EVIDENCE_ITEMS &&
			bytes + projectedEvidenceBytes(batches, batchSize, description) <= BROWSER_AUDIT_MAX_FROZEN_EVIDENCE_BYTES
		) {
			bytes += projectedEvidenceBytes(batches, batchSize, description);
			batches++;
		}
		expect(batches).toBeGreaterThan(0);
		expect(bytes).toBeLessThanOrEqual(BROWSER_AUDIT_MAX_FROZEN_EVIDENCE_BYTES);
		expect(bytes + projectedEvidenceBytes(batches, batchSize, description)).toBeGreaterThan(
			BROWSER_AUDIT_MAX_FROZEN_EVIDENCE_BYTES,
		);

		const make = () =>
			createEngine(
				createExecutor({
					execute: async () => ({ status: "PASS", evidence: evidenceBatch(batchSize, description) }),
				}).executor,
			);
		const boundary = make();
		for (let index = 0; index < batches; index++)
			expect((await boundary.inspect("check@route@viewport")).status).toBe("PASS");
		expect((await boundary.close()).status).toBe("CLOSED");
		expect(boundary.consumeSnapshot()?.evidence).toHaveLength(batches * batchSize);

		const exceeded = make();
		for (let index = 0; index < batches; index++) await exceeded.inspect("check@route@viewport");
		expect((await exceeded.inspect("check@route@viewport")).status).toBe("BLOCKED");
		expect(exceeded.lifecycle).toBe("INVALID");
		expect(exceeded.consumeSnapshot()).toBeNull();
	});

	it("hands a revocable terminal snapshot lease to one trusted synchronous sink", async () => {
		const delivered: Array<() => BrowserAuditSnapshot | undefined> = [];
		const success = createEngine(createExecutor().executor);
		await success.open();
		await success.close();
		expect(
			await handoffBrowserAuditSnapshot(success, lease => {
				delivered.push(lease);
			}),
		).toBe(true);
		expect(delivered).toHaveLength(1);
		const snapshot = delivered[0]?.();
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(delivered[0]?.()).toBeUndefined();

		const revoked = createEngine(createExecutor().executor);
		await revoked.open();
		await revoked.close();
		let revokedLease: (() => BrowserAuditSnapshot | undefined) | undefined;
		expect(
			await handoffBrowserAuditSnapshot(revoked, lease => {
				revokedLease = lease;
			}),
		).toBe(true);

		const disconnected = createEngine(createExecutor().executor);
		await disconnected.open();
		await disconnected.close();
		let disconnectedLease: (() => BrowserAuditSnapshot | undefined) | undefined;
		let consumed = false;
		expect(
			await handoffBrowserAuditSnapshot(
				disconnected,
				lease => {
					disconnectedLease = lease;
				},
				() => {
					consumed = true;
				},
			),
		).toBe(true);
		await disconnected.invalidate();
		expect(disconnectedLease?.()).toBeUndefined();
		expect(consumed).toBe(false);
		expect((await revoked.inspect("check@route@viewport")).status).toBe("BLOCKED");
		expect(revokedLease?.()).toBeUndefined();

		for (const sink of [
			undefined,
			() => {
				throw new Error("sink failed");
			},
		] as const) {
			const engine = createEngine(createExecutor().executor);
			await engine.open();
			await engine.close();
			expect(await handoffBrowserAuditSnapshot(engine, sink)).toBe(false);
			expect(engine.lifecycle).toBe("INVALID");
			expect(engine.consumeSnapshot()).toBeNull();
		}

		const asynchronous = createEngine(createExecutor().executor);
		await asynchronous.open();
		await asynchronous.close();
		expect(await handoffBrowserAuditSnapshot(asynchronous, async () => {})).toBe(false);
		expect(asynchronous.lifecycle).toBe("INVALID");
	});
});

type HarnessListener = (...args: unknown[]) => unknown;

class HarnessEmitter {
	readonly #listeners = new Map<string, Set<HarnessListener>>();

	on(event: string, listener: HarnessListener): this {
		let listeners = this.#listeners.get(event);
		if (!listeners) {
			listeners = new Set();
			this.#listeners.set(event, listeners);
		}
		listeners.add(listener);
		return this;
	}

	once(event: string, listener: HarnessListener): this {
		const wrapper: HarnessListener = (...args) => {
			this.off(event, wrapper);
			return listener(...args);
		};
		return this.on(event, wrapper);
	}

	off(event: string, listener?: HarnessListener): this {
		if (listener === undefined) this.#listeners.delete(event);
		else this.#listeners.get(event)?.delete(listener);
		return this;
	}

	removeAllListeners(event?: string): this {
		if (event === undefined) this.#listeners.clear();
		else this.#listeners.delete(event);
		return this;
	}

	listenerCount(event: string): number {
		return this.#listeners.get(event)?.size ?? 0;
	}

	async emit(event: string, ...args: unknown[]): Promise<void> {
		// oxlint-disable-next-line unicorn/no-useless-spread -- snapshot listeners before awaits
		for (const listener of [...(this.#listeners.get(event) ?? [])]) await listener(...args);
	}
}

class HarnessCdpSession extends HarnessEmitter {
	readonly commands: Array<{ method: string; params: unknown }> = [];
	readonly closedTargets: string[] = [];

	async send(method: string, params: unknown = undefined): Promise<void> {
		this.commands.push({ method, params });
		if (method === "Target.closeTarget" && params && typeof params === "object" && "targetId" in params) {
			this.closedTargets.push(String(params.targetId));
		}
	}
}

class HarnessRequest {
	responded = 0;
	responseBody: Uint8Array | string | undefined;
	continued = 0;
	aborted = 0;

	constructor(
		readonly requestUrl: string,
		readonly navigation: boolean,
		readonly type: string,
	) {}

	url(): string {
		return this.requestUrl;
	}
	async respond(response: { body?: Uint8Array | string }): Promise<void> {
		this.responded++;
		this.responseBody = response.body;
	}

	isNavigationRequest(): boolean {
		return this.navigation;
	}

	resourceType(): string {
		return this.type;
	}

	async continue(): Promise<void> {
		this.continued++;
	}

	async abort(): Promise<void> {
		this.aborted++;
	}
}

class HarnessPage extends HarnessEmitter {
	readonly pageSession = new HarnessCdpSession();
	requestInterception = false;
	setRequestInterceptionCalls = 0;
	pageViolation: string | undefined;
	__browserAuditState?: { violation?: string; operation?: unknown; guardsInstalled: boolean };
	newDocumentScripts = 0;
	readonly pageGuardRealm: Record<string, any> = {
		open: () => undefined,
		Worker: class {},
		SharedWorker: class {},
		WebSocket: class {},
		WebTransport: class {},
		RTCPeerConnection: class {},
		webkitRTCPeerConnection: class {},
		navigator: { sendBeacon: () => true, serviceWorker: { register: async () => undefined } },
	};
	async setRequestInterception(enabled: boolean): Promise<void> {
		this.setRequestInterceptionCalls++;
		this.requestInterception = enabled;
	}

	async exposeFunction(_name: string, _callback: HarnessListener): Promise<void> {}

	async evaluateOnNewDocument(_callback: HarnessListener): Promise<void> {
		this.newDocumentScripts++;
	}

	async evaluate(callback: HarnessListener): Promise<unknown> {
		const source = String(callback);
		if (source.includes("guard not locked")) {
			runInNewContext(`(${source})()`, this.pageGuardRealm);
			this.pageViolation = this.pageGuardRealm.__browserAuditPageViolation;
			return undefined;
		}
		return source.includes("__browserAuditPageViolation") ? this.pageViolation : undefined;
	}

	target(): { _targetId: string; _targetInfo: { targetId: string } } {
		return { _targetId: "authorized-page", _targetInfo: { targetId: "authorized-page" } };
	}

	async createCDPSession(): Promise<HarnessCdpSession> {
		return this.pageSession;
	}
}
class HarnessBrowser extends HarnessEmitter {
	readonly browserSession = new HarnessCdpSession();

	target(): { createCDPSession: () => Promise<HarnessCdpSession> } {
		return { createCDPSession: async () => this.browserSession };
	}
}

class BrowserAuditCallbackHarness {
	readonly page = new HarnessPage();
	readonly browser = new HarnessBrowser();
	primitiveStartedWithGuards = false;

	async request(request: HarnessRequest): Promise<void> {
		this.primitiveStartedWithGuards =
			this.page.requestInterception &&
			this.page.listenerCount("request") > 0 &&
			this.browser.browserSession.commands.some(command => command.method === "Target.setAutoAttach");
		await this.page.emit("request", request);
	}

	async load(): Promise<void> {
		await this.page.emit("load");
	}

	async target(type: "page" | "worker" | "service_worker" | "shared_worker"): Promise<void> {
		await this.browser.browserSession.emit("Target.attachedToTarget", {
			targetInfo: { targetId: `forbidden-${type}`, type },
			sessionId: `session-${type}`,
		});
	}

	async websocket(
		event: "Network.webSocketCreated" | "Network.webSocketFrameSent" | "Network.webSocketFrameReceived",
	): Promise<void> {
		await this.page.pageSession.emit(event, {});
	}

	async download(): Promise<void> {
		await this.browser.browserSession.emit("Browser.downloadWillBegin", {});
	}
}

async function executeInterception(
	harness: BrowserAuditCallbackHarness,
	allowDocument: boolean,
	actionCode: string,
	documentLocator = "https://example.test/audit",
	allowedOrigins: readonly string[] = ["https://example.test"],
	pinnedDocumentBase64?: string,
): Promise<unknown> {
	const code = buildBrowserAuditInterceptionCode(
		documentLocator,
		allowedOrigins,
		allowDocument,
		actionCode,
		pinnedDocumentBase64,
	);
	const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
		...args: string[]
	) => (page: HarnessPage, browser: HarnessBrowser, tab: BrowserAuditCallbackHarness) => Promise<unknown>;
	return await new AsyncFunction("page", "browser", "tab", `return ${code};`)(harness.page, harness.browser, harness);
}
async function executeDeniedAudit(harness: BrowserAuditCallbackHarness, allowDocument: boolean, actionCode: string) {
	const { executor } = createExecutor({
		execute: async () => {
			try {
				await executeInterception(harness, allowDocument, actionCode);
				return { status: "PASS", evidence: [] };
			} catch (error) {
				return { status: "BLOCKED", error: error instanceof Error ? error.message : String(error) };
			}
		},
	});
	const engine = createEngine(executor);
	const result = await engine.inspect("check@route@viewport");
	expect(result.status).toBe("BLOCKED");
	expect(engine.lifecycle).toBe("INVALID");
	expect(engine.consumeSnapshot()).toBeNull();
	return engine;
}

describe("Browser Audit request interception", () => {
	it("arms retained request and CDP callbacks before the authorized document primitive", async () => {
		const harness = new BrowserAuditCallbackHarness() as BrowserAuditCallbackHarness & { document: HarnessRequest };
		harness.document = new HarnessRequest("https://example.test/audit", true, "document");
		await executeInterception(harness, true, "await tab.request(tab.document); await tab.load();");
		expect(harness.primitiveStartedWithGuards).toBe(true);
		expect(harness.document.continued).toBe(1);
		expect(harness.document.aborted).toBe(0);
		expect(harness.page.newDocumentScripts).toBe(1);
		expect(() => new harness.page.pageGuardRealm.WebTransport()).toThrow("denied WebTransport");
		expect(() => new harness.page.pageGuardRealm.RTCPeerConnection()).toThrow("denied RTCPeerConnection");
		expect(() => new harness.page.pageGuardRealm.webkitRTCPeerConnection()).toThrow("denied webkitRTCPeerConnection");
		await expect(harness.page.pageGuardRealm.navigator.serviceWorker.register()).rejects.toThrow(
			"denied service worker registration",
		);
		expect(harness.page.pageGuardRealm.__browserAuditPageViolation).toBe("webtransport");
	});

	it("serves descriptor-pinned file bytes instead of rereading a mutable path", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "browser-audit-pinned-"));
		try {
			const filePath = path.join(root, "audit.html");
			const original = Buffer.from("<main>authorized</main>");
			await writeFile(filePath, original);
			const authority: BrowserAuditFileDocumentAuthority = {
				schema: "browser-audit-file-document-authority/v1",
				document_locator: pathToFileURL(filePath).href,
				expected_sha256: createHash("sha256").update(original).digest("hex"),
				hash_authority: "caller-verified-external",
				hash_verified_external: true,
				repository_local: true,
				document_only: true,
			};
			const pinned = await readPinnedBrowserAuditFile(authority, root);
			await writeFile(filePath, "<main>mutated</main>");
			await expect(readPinnedBrowserAuditFile(authority, root)).rejects.toThrow("SHA-256 mismatch");

			const harness = new BrowserAuditCallbackHarness() as BrowserAuditCallbackHarness & {
				document: HarnessRequest;
			};
			harness.document = new HarnessRequest(authority.document_locator, true, "document");
			await executeInterception(
				harness,
				true,
				"await tab.request(tab.document); await tab.load();",
				authority.document_locator,
				[],
				Buffer.from(pinned).toString("base64"),
			);
			expect(harness.document.responded).toBe(1);
			expect(harness.document.continued).toBe(0);
			expect(Buffer.from(harness.document.responseBody as Uint8Array).toString()).toBe(original.toString());
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("authorizes each route against its current operation rather than the first installed guard", async () => {
		const harness = new BrowserAuditCallbackHarness() as BrowserAuditCallbackHarness & {
			first: HarnessRequest;
			second: HarnessRequest;
		};
		harness.first = new HarnessRequest("https://example.test/audit", true, "document");
		harness.second = new HarnessRequest("https://other.test/next", true, "document");
		await executeInterception(harness, true, "await tab.request(tab.first); await tab.load();");
		await executeInterception(
			harness,
			true,
			"await tab.request(tab.second); await tab.load();",
			"https://other.test/next",
			["https://other.test"],
		);
		expect(harness.first.continued).toBe(1);
		expect(harness.second.continued).toBe(1);
		expect(harness.page.__browserAuditState?.violation).toBeUndefined();
	});

	it("allows only the first exact authorized document request and blocks redirect hops", async () => {
		const harness = new BrowserAuditCallbackHarness() as BrowserAuditCallbackHarness & {
			document: HarnessRequest;
			redirect: HarnessRequest;
		};
		harness.document = new HarnessRequest("https://example.test/audit", true, "document");
		harness.redirect = new HarnessRequest("https://elsewhere.test/redirect", true, "document");
		await executeDeniedAudit(harness, true, "await tab.request(tab.document); await tab.request(tab.redirect);");
		expect(harness.page.__browserAuditState?.violation).toBe("redirect");
		expect(harness.primitiveStartedWithGuards).toBe(true);
		expect(harness.document.continued).toBe(1);
		expect(harness.document.aborted).toBe(0);
		expect(harness.redirect.continued).toBe(0);
		expect(harness.redirect.aborted).toBe(1);
	});

	it("blocks unauthorized subresources, beacon pings, and action navigation before external effects", async () => {
		const cases = [
			{
				allowDocument: true,
				request: new HarnessRequest("https://unauthorized.test/script.js", false, "script"),
				reason: "unauthorized-subresource",
			},
			{
				allowDocument: true,
				request: new HarnessRequest("https://example.test/beacon", false, "ping"),
				reason: "beacon",
			},
			{
				allowDocument: false,
				request: new HarnessRequest("https://example.test/next", true, "document"),
				reason: "action-navigation",
			},
		] as const;
		for (const testCase of cases) {
			const harness = new BrowserAuditCallbackHarness() as BrowserAuditCallbackHarness & {
				forbidden: HarnessRequest;
			};
			harness.forbidden = testCase.request;
			await executeDeniedAudit(harness, testCase.allowDocument, "await tab.request(tab.forbidden);");
			expect(harness.page.__browserAuditState?.violation).toBe(testCase.reason);
			expect(testCase.request.continued).toBe(0);
			expect(testCase.request.aborted).toBe(1);
		}
	});

	it("pauses and closes popup, page, dedicated-worker, service-worker, and shared-worker targets", async () => {
		for (const type of ["page", "worker", "service_worker", "shared_worker"] as const) {
			const harness = new BrowserAuditCallbackHarness() as BrowserAuditCallbackHarness & {
				forbiddenType: typeof type;
			};
			harness.forbiddenType = type;
			await executeDeniedAudit(harness, false, "await tab.target(tab.forbiddenType);");
			expect(harness.page.__browserAuditState?.violation).toBe(type === "page" ? "popup" : "worker");
			const autoAttach = harness.browser.browserSession.commands.find(
				command => command.method === "Target.setAutoAttach",
			);
			expect(autoAttach?.params).toMatchObject({ autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
			expect(harness.browser.browserSession.closedTargets).toEqual([`forbidden-${type}`]);
			expect(
				harness.browser.browserSession.commands.some(
					command => command.method === "Runtime.runIfWaitingForDebugger",
				),
			).toBe(false);
		}
	});

	it("blocks WebSocket creation and frames and denies downloads before the primitive can pass", async () => {
		for (const event of [
			"Network.webSocketCreated",
			"Network.webSocketFrameSent",
			"Network.webSocketFrameReceived",
		] as const) {
			const harness = new BrowserAuditCallbackHarness() as BrowserAuditCallbackHarness & {
				websocketEvent: typeof event;
			};
			harness.websocketEvent = event;
			await executeDeniedAudit(harness, false, "await tab.websocket(tab.websocketEvent);");
			expect(harness.page.__browserAuditState?.violation).toBe("websocket");
		}
		const downloadHarness = new BrowserAuditCallbackHarness();
		await executeDeniedAudit(downloadHarness, false, "await tab.download();");
		expect(downloadHarness.page.__browserAuditState?.violation).toBe("download");
		expect(downloadHarness.browser.browserSession.commands).toContainEqual({
			method: "Browser.setDownloadBehavior",
			params: { behavior: "deny" },
		});
	});

	it("latches delayed fetch traffic after a successful primitive and blocks the next operation", async () => {
		const harness = new BrowserAuditCallbackHarness();
		await executeInterception(harness, false, "return 'ok';");
		const delayed = new HarnessRequest("https://example.test/delayed", false, "fetch");
		await harness.page.emit("request", delayed);
		expect(delayed.continued).toBe(0);
		expect(delayed.aborted).toBe(1);
		await executeDeniedAudit(harness, false, "return 'should-not-run';");
		expect(harness.page.__browserAuditState?.violation).toBe("delayed-request");
	});

	it("retains audit request handlers in the real worker page scope until browser teardown", async () => {
		const page = new HarnessPage();
		let calls = 0;
		const scope = createRunPageScope(page as never, true);
		page.on("request", () => calls++);
		await scope.cleanup();
		await page.emit("request", new HarnessRequest("https://example.test/delayed", false, "fetch"));
		expect(calls).toBe(1);
		expect(page.setRequestInterceptionCalls).toBe(0);
	});
});
