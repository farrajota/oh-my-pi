import { EventEmitter } from "node:events";
import { createRunPageScope, persistentAuditFacadeSignal } from "../../src/tools/browser/tab-worker";
import { buildBrowserAuditInterceptionCode } from "../../src/tools/browser-audit-production";
import { BrowserNetworkManager } from "../../src/tools/browser/network";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { postmortem, TempDir } from "@oh-my-pi/pi-utils";
import { JsRuntime, type RuntimeHooks } from "../../src/eval/js/shared/runtime";
import {
	bindRunFacade,
	isBrowserRunOwnedRejection,
	isBrowserRunRejection,
	markBrowserRunRejection,
	markHandled,
	waitForRun,
	withBrowserPromiseCombinatorTracking,
} from "../../src/tools/run-scope";
import { ToolAbortError } from "../../src/tools/tool-errors";
import { EventEmitter as PuppeteerEventEmitter } from "puppeteer-core/internal/common/EventEmitter.js";

function hasInterceptActionQueue(event: unknown): event is { enqueueInterceptAction(action: () => unknown): void } {
	return (
		typeof event === "object" &&
		event !== null &&
		"enqueueInterceptAction" in event &&
		typeof event.enqueueInterceptAction === "function"
	);
}

type PageFixtureHandler = (event: unknown) => void;

/** Uses Puppeteer's emitter and mirrors Page's request-listener dispatch boundary. */
class RunPageScopeFixture extends PuppeteerEventEmitter<Record<string | symbol, unknown>> {
	readonly interceptionStates: boolean[] = [];
	#requestHandlers = new WeakMap<PageFixtureHandler, PageFixtureHandler>();

	override on(type: string | symbol, handler: PageFixtureHandler): this {
		if (type !== "request") return super.on(type, handler);
		let wrapper = this.#requestHandlers.get(handler);
		if (!wrapper) {
			wrapper = event => {
				if (!hasInterceptActionQueue(event)) throw new TypeError("request event cannot queue interception actions");
				event.enqueueInterceptAction(() => handler(event));
			};
			this.#requestHandlers.set(handler, wrapper);
		}
		return super.on(type, wrapper);
	}

	override off(type: string | symbol, handler?: PageFixtureHandler): this {
		if (type === "request" && handler) handler = this.#requestHandlers.get(handler) ?? handler;
		return super.off(type, handler);
	}

	async setRequestInterception(enabled: boolean): Promise<void> {
		this.interceptionStates.push(enabled);
	}

	async dispatchRequest(request: { enqueueInterceptAction(action: () => unknown): void }): Promise<unknown> {
		const actions: Array<() => unknown> = [];
		request.enqueueInterceptAction = action => actions.push(action);
		this.emit("request", request);
		let result: unknown;
		for (const action of actions) result = await action();
		return result;
	}
}

const runScopeModuleUrl = new URL("../../src/tools/run-scope.ts", import.meta.url).href;

async function collectUnhandledRejections(action: () => void | Promise<void>): Promise<unknown[]> {
	const reasons: unknown[] = [];
	const onUnhandled = (reason: unknown) => reasons.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		await action();
		await Promise.resolve();
		await Promise.resolve();
		vi.advanceTimersByTime(0);
		await Promise.resolve();
		return reasons;
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
}

describe("browser run cancellation", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns the same promise while preserving awaited rejection", async () => {
		const rejection = new Error("browser run ended");
		const promise = Promise.reject(rejection);

		const handled = markHandled(promise);

		expect(handled).toBe(promise);
		await expect(handled).rejects.toBe(rejection);
	});

	it("resolves run-scoped wait when the run is not aborted", async () => {
		const controller = new AbortController();

		const wait = waitForRun(25, controller.signal);
		vi.advanceTimersByTime(25);

		await expect(wait).resolves.toBeUndefined();
	});

	it("rejects run-scoped wait when the run aborts mid-sleep", async () => {
		const controller = new AbortController();
		const wait = waitForRun(1000, controller.signal);

		controller.abort(new Error("browser run ended"));

		await expect(wait).rejects.toThrow("browser run ended");
	});

	it("resolves wait(predicate) with the first truthy value", async () => {
		vi.useRealTimers();
		const controller = new AbortController();
		let calls = 0;

		const wait = waitForRun(() => (++calls >= 3 ? "ready" : null), controller.signal, { interval: 10 });

		await expect(wait).resolves.toBe("ready");
		expect(calls).toBe(3);
	});

	it("fails wait(predicate) with a named timeout error instead of stalling", async () => {
		vi.useRealTimers();
		const controller = new AbortController();

		const wait = waitForRun(() => false, controller.signal, { timeout: 50, interval: 10 });

		await expect(wait).rejects.toThrow("wait(predicate) timed out after 50ms");
	});

	it("rejects wait(predicate) when the run aborts mid-poll", async () => {
		vi.useRealTimers();
		const controller = new AbortController();

		const wait = waitForRun(() => false, controller.signal, { timeout: 5000 });
		controller.abort(new Error("browser run ended"));

		await expect(wait).rejects.toThrow("browser run ended");
	});

	it("rejects wait() input that is neither milliseconds nor a predicate", async () => {
		const controller = new AbortController();

		await expect(waitForRun("soon" as never, controller.signal)).rejects.toThrow(
			"wait(...) expects milliseconds (number) or a predicate function to poll",
		);
	});

	it("does not emit unhandledRejection for an unawaited wait aborted by run teardown", async () => {
		const controller = new AbortController();

		const reasons = await collectUnhandledRejections(async () => {
			void waitForRun(1000, controller.signal);
			controller.abort(postmortem.markExpectedCleanupError(new Error("browser run ended")));
		});

		expect(reasons).toEqual([]);
	});

	it("does not emit unhandledRejection when an unawaited facade method settles after abort", async () => {
		const controller = new AbortController();
		const deferred = Promise.withResolvers<string>();
		const facade = bindRunFacade(
			{
				readTitle(): Promise<string> {
					return deferred.promise;
				},
			},
			controller.signal,
		);

		const reasons = await collectUnhandledRejections(async () => {
			void facade.readTitle();
			controller.abort(postmortem.markExpectedCleanupError(new Error("browser run ended")));
			deferred.resolve("late title");
		});

		expect(reasons).toEqual([]);
	});

	it("keeps dedicated audit guard facades across cells but invalidates them on caller abort", () => {
		const page = new EventEmitter();
		const firstDeadline = new AbortController();
		const firstCaller = new AbortController();
		const firstRunEnd = new AbortController();
		const auditSignal = persistentAuditFacadeSignal(page as never, [firstDeadline.signal, firstCaller.signal]);
		let inspections = 0;
		const persistentGuard = bindRunFacade({ inspect: () => ++inspections }, auditSignal);
		const firstUserFacade = bindRunFacade({ inspect: () => ++inspections }, firstRunEnd.signal);

		firstRunEnd.abort(new ToolAbortError("Browser run ended"));
		expect(() => firstUserFacade.inspect()).toThrow("Browser run ended");
		expect(persistentGuard.inspect()).toBe(1);

		const secondDeadline = new AbortController();
		const secondCaller = new AbortController();
		const secondRunEnd = new AbortController();
		expect(persistentAuditFacadeSignal(page as never, [secondDeadline.signal, secondCaller.signal])).toBe(
			auditSignal,
		);
		const secondUserFacade = bindRunFacade({ inspect: () => ++inspections }, secondRunEnd.signal);
		expect(persistentGuard.inspect()).toBe(2);
		secondRunEnd.abort(new ToolAbortError("Browser run ended"));
		expect(() => secondUserFacade.inspect()).toThrow("Browser run ended");

		secondCaller.abort(new ToolAbortError("Browser audit caller aborted"));
		expect(() => persistentGuard.inspect()).toThrow("Browser audit caller aborted");
		expect(inspections).toBe(2);
	});

	it("scoped off preserves host-only and shared callback registrations", () => {
		const page = new RunPageScopeFixture();
		const scope = createRunPageScope(page as never);
		let hostOnlyCalls = 0;
		const hostOnly = (): void => {
			hostOnlyCalls++;
		};
		page.on("host-only", hostOnly);
		scope.page.off("host-only", hostOnly);
		expect(page.listenerCount("host-only")).toBe(1);
		page.emit("host-only", undefined);
		expect(hostOnlyCalls).toBe(1);

		let sharedCellCalls = 0;
		let sharedHostCalls = 0;
		const shared = function (this: unknown): void {
			if (this === scope.page) sharedCellCalls++;
			else sharedHostCalls++;
		};
		scope.page.on("shared", shared);
		page.on("shared", shared);
		page.emit("shared", undefined);
		expect({ sharedCellCalls, sharedHostCalls }).toEqual({ sharedCellCalls: 1, sharedHostCalls: 1 });
		scope.page.off("shared", shared);
		expect(page.listenerCount("shared")).toBe(1);
		page.emit("shared", undefined);
		expect({ sharedCellCalls, sharedHostCalls }).toEqual({ sharedCellCalls: 1, sharedHostCalls: 2 });

		let duplicateCellCalls = 0;
		let duplicateHostCalls = 0;
		const duplicate = function (this: unknown): void {
			if (this === scope.page) duplicateCellCalls++;
			else duplicateHostCalls++;
		};
		scope.page.on("duplicate", duplicate).on("duplicate", duplicate);
		page.on("duplicate", duplicate);
		page.emit("duplicate", undefined);
		expect({ duplicateCellCalls, duplicateHostCalls }).toEqual({ duplicateCellCalls: 2, duplicateHostCalls: 1 });
		scope.page.off("duplicate", duplicate);
		expect(page.listenerCount("duplicate")).toBe(2);
		scope.page.off("duplicate", duplicate);
		expect(page.listenerCount("duplicate")).toBe(1);
		page.emit("duplicate", undefined);
		expect({ duplicateCellCalls, duplicateHostCalls }).toEqual({ duplicateCellCalls: 2, duplicateHostCalls: 2 });
	});

	it("event and all-event removal plus detach preserve raw host listeners", () => {
		const page = new RunPageScopeFixture();
		const scope = createRunPageScope(page as never);
		let hostCalls = 0;
		let cellCalls = 0;
		const host = (): void => {
			hostCalls++;
		};
		const cell = (): void => {
			cellCalls++;
		};

		page.on("selected", host);
		scope.page.on("selected", cell);
		scope.page.removeAllListeners("selected");
		expect(page.listenerCount("selected")).toBe(1);
		page.emit("selected", undefined);
		expect({ hostCalls, cellCalls }).toEqual({ hostCalls: 1, cellCalls: 0 });

		page.on("all-a", host);
		page.on("all-b", host);
		scope.page.on("all-a", cell);
		scope.page.on("all-b", cell);
		scope.page.removeAllListeners();
		expect(page.listenerCount("all-a")).toBe(1);
		expect(page.listenerCount("all-b")).toBe(1);
		page.emit("all-a", undefined);
		page.emit("all-b", undefined);
		expect({ hostCalls, cellCalls }).toEqual({ hostCalls: 3, cellCalls: 0 });

		scope.page.on("detached", cell);
		page.on("detached", host);
		scope.detach();
		expect(page.listenerCount("detached")).toBe(1);
		page.emit("detached", undefined);
		expect({ hostCalls, cellCalls }).toEqual({ hostCalls: 4, cellCalls: 0 });
	});

	it("scoped wildcard listeners receive the event type and exact payload with the scoped receiver", () => {
		const page = new RunPageScopeFixture();
		const scope = createRunPageScope(page as never);
		const payload = { marker: "wildcard-payload" };
		const ordinary: unknown[][] = [];
		const once: unknown[][] = [];
		scope.page.on("*", function (this: unknown, ...args: unknown[]) {
			expect(this).toBe(scope.page);
			ordinary.push(args);
		});
		scope.page.once("*", function (this: unknown, ...args: unknown[]) {
			expect(this).toBe(scope.page);
			// A once registration is unregistered before it runs, so re-entrant emits cannot reach it.
			expect(page.listenerCount("*")).toBe(1);
			once.push(args);
		});

		page.emit("console", payload);
		page.emit("dialog", payload);

		expect(ordinary).toEqual([
			["console", payload],
			["dialog", payload],
		]);
		expect(ordinary[0]?.[1]).toBe(payload);
		expect(once).toEqual([["console", payload]]);
		scope.detach();
		expect(page.listenerCount("*")).toBe(0);
	});

	it("bulk cleanup removes only the scoped registration of shared callbacks", () => {
		const page = new RunPageScopeFixture();
		const scope = createRunPageScope(page as never);
		const cellCalls: unknown[] = [];
		const hostCalls: unknown[] = [];
		// The installed Puppeteer emitter invokes raw registrations without a receiver; only the
		// scoped facade rebinds `this`, so the receiver tells the two registrations apart.
		const shared = function (this: unknown, event: unknown): void {
			if (this === scope.page) cellCalls.push(event);
			else if (this === undefined) hostCalls.push(event);
			else throw new Error("shared listener received an unexpected receiver");
		};

		scope.page.on("selected", shared);
		page.on("selected", shared);
		scope.page.on("preserved", shared);
		page.on("preserved", shared);
		scope.page.removeAllListeners("selected");
		expect(page.listenerCount("selected")).toBe(1);
		expect(page.listenerCount("preserved")).toBe(2);
		page.emit("selected", "selected");
		page.emit("preserved", "preserved");
		expect(cellCalls).toEqual(["preserved"]);
		expect(hostCalls).toEqual(["selected", "preserved"]);

		cellCalls.length = 0;
		hostCalls.length = 0;
		scope.page.on("all-a", shared);
		page.on("all-a", shared);
		scope.page.on("all-b", shared);
		page.on("all-b", shared);
		scope.page.removeAllListeners();
		expect({
			selected: page.listenerCount("selected"),
			preserved: page.listenerCount("preserved"),
			allA: page.listenerCount("all-a"),
			allB: page.listenerCount("all-b"),
		}).toEqual({ selected: 1, preserved: 1, allA: 1, allB: 1 });
		page.emit("selected", "selected");
		page.emit("preserved", "preserved");
		page.emit("all-a", "all-a");
		page.emit("all-b", "all-b");
		expect(cellCalls).toEqual([]);
		expect(hostCalls).toEqual(["selected", "preserved", "all-a", "all-b"]);

		cellCalls.length = 0;
		hostCalls.length = 0;
		scope.page.on("detached", shared);
		page.on("detached", shared);
		scope.detach();
		expect(page.listenerCount("detached")).toBe(1);
		page.emit("detached", "detached");
		expect(cellCalls).toEqual([]);
		expect(hostCalls).toEqual(["detached"]);
	});

	it("once callbacks keep created listeners and interception changes run-scoped", async () => {
		for (const preserveInterception of [false, true]) {
			const page = new RunPageScopeFixture();
			const scope = createRunPageScope(page as never, preserveInterception, async () => {
				await page.setRequestInterception(false);
			});
			let createdListenerCalls = 0;
			const createdListener = (): void => {
				createdListenerCalls++;
			};
			scope.page.once("install", function (this: typeof scope.page) {
				this.on("created", createdListener);
				return this.setRequestInterception(true);
			});

			page.emit("install", undefined);
			expect(page.listenerCount("install")).toBe(0);
			expect(page.listenerCount("created")).toBe(1);
			await scope.restoreInterception();
			expect(page.interceptionStates).toEqual(preserveInterception ? [true, true] : [true, false]);
			scope.detach();
			expect(page.listenerCount("created")).toBe(0);
			page.emit("created", undefined);
			expect(createdListenerCalls).toBe(0);
		}
	});

	it("once callback return values reach Puppeteer's cooperative request dispatch", async () => {
		const page = new RunPageScopeFixture();
		const scope = createRunPageScope(page as never);
		const expected = { action: "continue", source: "cell" };
		const returned = Promise.resolve(expected);
		scope.page.once("request", () => returned);
		const result = await page.dispatchRequest({ enqueueInterceptAction() {} });

		expect(result).toBe(expected);
		expect(page.listenerCount("request")).toBe(0);
	});

	it("once listeners are removed before throwing or recursively emitting", () => {
		const page = new RunPageScopeFixture();
		const scope = createRunPageScope(page as never);
		const failure = new Error("once callback failed");
		scope.page.once("throws", () => {
			throw failure;
		});
		expect(() => page.emit("throws", undefined)).toThrow(failure);
		expect(page.listenerCount("throws")).toBe(0);

		let recursiveCalls = 0;
		scope.page.once("recursive", () => {
			recursiveCalls++;
			page.emit("recursive", undefined);
		});
		page.emit("recursive", undefined);
		expect(recursiveCalls).toBe(1);
		expect(page.listenerCount("recursive")).toBe(0);
	});

	it("keeps host-owned audit guards and interception across completed cells", async () => {
		vi.useRealTimers();
		let pageClosed = false;
		const createSession = () => {
			return Object.assign(new EventEmitter(), {
				async send(_method: string, _params?: unknown): Promise<void> {},
			});
		};
		const page = Object.assign(new EventEmitter(), {
			interceptionEnabled: false,
			async setRequestInterception(enabled: boolean): Promise<void> {
				this.interceptionEnabled = enabled;
			},
			isClosed(): boolean {
				return pageClosed;
			},
			async evaluate<T>(_fn: () => T): Promise<T | undefined> {
				return undefined;
			},
			async evaluateOnNewDocument(_fn: (...args: unknown[]) => unknown): Promise<void> {},
			async exposeFunction(_name: string, _callback: (...args: unknown[]) => unknown): Promise<void> {},
			target: () => ({ _targetId: "audit-page" }),
			createCDPSession: createSession,
		});
		const browser = Object.assign(new EventEmitter(), {
			target: () => ({ createCDPSession: createSession }),
		});
		const network = new BrowserNetworkManager(page as never);
		await network.start();
		expect(network.hasPersistentInterception()).toBe(false);
		const facadeSignal = persistentAuditFacadeSignal(page as never, []);
		let ordinaryEvents = 0;
		let workerEvents = 0;
		page.on("worker-event", () => workerEvents++);
		type GuardedActions = {
			allowedRequest: string | undefined;
			deniedRequest: string | undefined;
			popupClosed: number;
			workerTerminated: number;
			downloadCancelled: number;
			targetClosed: number;
		};
		const auditPage = page as typeof page & { __browserAuditState?: { guardsInstalled?: boolean } };

		const guardListenerCountsBeforeInstall = {
			request: page.listenerCount("request"),
			popup: page.listenerCount("popup"),
			workercreated: page.listenerCount("workercreated"),
			download: page.listenerCount("download"),
			targetcreated: browser.listenerCount("targetcreated"),
		};
		const expectSingleAuditGuardInstall = (): void => {
			expect({
				request: page.listenerCount("request"),
				popup: page.listenerCount("popup"),
				workercreated: page.listenerCount("workercreated"),
				download: page.listenerCount("download"),
				targetcreated: browser.listenerCount("targetcreated"),
			}).toEqual({
				request: guardListenerCountsBeforeInstall.request + 1,
				popup: guardListenerCountsBeforeInstall.popup + 1,
				workercreated: guardListenerCountsBeforeInstall.workercreated + 1,
				download: guardListenerCountsBeforeInstall.download + 1,
				targetcreated: guardListenerCountsBeforeInstall.targetcreated + 1,
			});
		};
		const executeAuditCode = (
			scopedPage: unknown,
			actionCode: string,
			options: {
				allowedOrigins?: readonly string[];
				allowDocument?: boolean;
				runAction?: () => Promise<void>;
			} = {},
		): Promise<unknown> => {
			const execute = new Function(
				"page",
				"browser",
				"testHooks",
				`return ${buildBrowserAuditInterceptionCode(
					"https://audit.example/",
					options.allowedOrigins ?? [],
					options.allowDocument ?? false,
					actionCode,
				)};`,
			) as (page: unknown, browser: unknown, testHooks: { run?: () => Promise<void> }) => Promise<unknown>;
			return execute(scopedPage, browser, { run: options.runAction });
		};
		const dispatchRequest = async (url: string): Promise<string | undefined> => {
			let action: string | undefined;
			const request = {
				url: () => url,
				method: () => "GET",
				postData: () => undefined,
				resourceType: () => "fetch",
				headers: () => ({}),
				isNavigationRequest: () => false,
				isInterceptResolutionHandled: () => false,
				abort: async (reason: string) => {
					action = `aborted:${reason}`;
				},
				continue: async () => {
					action = "continued";
				},
			};

			page.emit("request", request);
			await Promise.resolve();
			return action;
		};
		const dispatchGuardedActions = async (): Promise<GuardedActions> => {
			const allowedRequest = await dispatchRequest("https://allowed.example/resource");
			const deniedRequest = await dispatchRequest("https://unauthorized.example/resource");
			const popup = {
				closeCount: 0,
				async close() {
					this.closeCount++;
				},
			};
			const worker = {
				terminationCount: 0,
				terminate() {
					this.terminationCount++;
				},
			};
			const download = {
				cancellationCount: 0,
				cancel() {
					this.cancellationCount++;
				},
			};
			const targetPage = {
				closeCount: 0,
				async close() {
					this.closeCount++;
				},
			};
			const target = {
				type: () => "page",
				page: async () => targetPage,
			};

			page.emit("popup", popup);
			page.emit("workercreated", worker);
			page.emit("download", download);
			browser.emit("targetcreated", target);
			await Promise.resolve();
			return {
				allowedRequest,
				deniedRequest,
				popupClosed: popup.closeCount,
				workerTerminated: worker.terminationCount,
				downloadCancelled: download.cancellationCount,
				targetClosed: targetPage.closeCount,
			};
		};

		for (let cell = 0; cell < 2; cell++) {
			const scope = createRunPageScope(page as never, true, () => network.restoreInterception());
			scope.page.on("ordinary-cell-event", () => ordinaryEvents++);

			if (cell === 0) {
				await executeAuditCode(scope.page, "return undefined;");
				expect(auditPage.__browserAuditState?.guardsInstalled).toBe(true);
			} else {
				let activeActions: GuardedActions | undefined;
				await expect(
					executeAuditCode(scope.page, "await testHooks.run(); return undefined;", {
						allowDocument: true,
						allowedOrigins: ["https://allowed.example"],
						runAction: async () => {
							activeActions = await dispatchGuardedActions();
						},
					}),
				).rejects.toThrow("browser audit forbidden channel: unauthorized-subresource");
				expect(activeActions).toEqual({
					allowedRequest: "continued",
					deniedRequest: "aborted:blockedbyclient",
					popupClosed: 1,
					workerTerminated: 1,
					downloadCancelled: 1,
					targetClosed: 1,
				});
			}

			expect(page.interceptionEnabled).toBe(true);
			expectSingleAuditGuardInstall();
			scope.detach();
			await scope.restoreInterception();

			expect(page.interceptionEnabled).toBe(true);
			expectSingleAuditGuardInstall();
			page.emit("ordinary-cell-event");
			page.emit("worker-event");
			expect(ordinaryEvents).toBe(0);
			expect(workerEvents).toBe(cell + 1);
			expect(facadeSignal.aborted).toBe(false);
		}

		const delayedActions = await dispatchGuardedActions();
		expect(delayedActions).toEqual({
			allowedRequest: "aborted:blockedbyclient",
			deniedRequest: "aborted:blockedbyclient",
			popupClosed: 1,
			workerTerminated: 1,
			downloadCancelled: 1,
			targetClosed: 1,
		});
		expect(auditPage.__browserAuditState?.guardsInstalled).toBe(true);
		expectSingleAuditGuardInstall();

		await network.close();
		pageClosed = true;
		page.emit("close");
		expect(facadeSignal.aborted).toBe(true);
	});

	it("scopes browser rejection markers to the owning run and direct reason", () => {
		const owner = {};
		const browserFailure = new Error("browser failed");
		markBrowserRunRejection(browserFailure, owner);

		expect(isBrowserRunRejection(browserFailure, owner)).toBe(true);
		expect(isBrowserRunRejection(browserFailure, {})).toBe(false);
		expect(isBrowserRunRejection(new Error("unrelated", { cause: browserFailure }), owner)).toBe(false);
	});

	it("keeps unrelated worker rejections outside the active browser run", () => {
		const owner = {};
		const workerFailure = new Error("transport failed");
		workerFailure.stack = "Error: transport failed\n    at tab-worker.ts:1:1";
		const evaluatedFailure = new Error("evaluated failure");
		evaluatedFailure.stack = "Error: evaluated failure\n    at browser-run-run-1.js:1:1";

		expect(isBrowserRunOwnedRejection(workerFailure, owner, "browser-run-run-1.js")).toBe(false);
		expect(isBrowserRunOwnedRejection(evaluatedFailure, owner, "browser-run-run-1.js")).toBe(true);
		expect(
			isBrowserRunOwnedRejection(markBrowserRunRejection(workerFailure, owner), owner, "browser-run-run-1.js"),
		).toBe(true);
	});

	it("keeps a later cause-wrapped rejection on the fatal path", async () => {
		vi.useRealTimers();
		const script = `
			import { markBrowserRunRejection } from ${JSON.stringify(runScopeModuleUrl)};

			const browserFailure = new Error("browser failure");
			markBrowserRunRejection(browserFailure, {});
			Promise.reject(new Error("unrelated fatal", { cause: browserFailure }));
			await Promise.resolve();
		`;
		const proc = Bun.spawn([process.execPath, "-e", script], {
			cwd: process.cwd(),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);

		expect(exitCode).toBe(1);
		expect(stderr).toContain("[Unhandled Rejection] Error: unrelated fatal");
	});

	it("preserves a browser rejection marker through native await", async () => {
		const owner = {};
		const browserFailure = new Error("browser failed");
		const facade = bindRunFacade(
			{
				fail(): Promise<never> {
					return Promise.reject(browserFailure);
				},
			},
			new AbortController().signal,
			owner,
		);

		let caught: unknown;
		try {
			await (async () => await facade.fail())();
		} catch (error) {
			caught = error;
		}

		expect(caught).toBe(browserFailure);
		expect(isBrowserRunRejection(caught, owner)).toBe(true);
	});

	it("reports user rethrows from native browser-promise combinators", async () => {
		vi.useRealTimers();
		for (const name of ["all", "race", "allSettled", "any"] as const) {
			const owner = {};
			const browserFailure = new Error(`${name} browser failure`);
			const floatingRejections: unknown[] = [];
			const facade = bindRunFacade(
				{
					fail(): Promise<never> {
						return Promise.reject(browserFailure);
					},
				},
				new AbortController().signal,
				owner,
				reason => floatingRejections.push(reason),
			);
			const originalCombinator = Promise[name];

			await withBrowserPromiseCombinatorTracking(
				owner,
				reason => floatingRejections.push(reason),
				async () => {
					// oxlint-disable unicorn/no-single-promise-in-promise-methods -- the combinators themselves are under test
					const combined =
						name === "all"
							? Promise.all([facade.fail()])
							: name === "race"
								? Promise.race([facade.fail()])
								: name === "allSettled"
									? Promise.allSettled([facade.fail()]).then(results => {
											const [first] = results;
											if (first?.status === "rejected") throw first.reason;
										})
									: Promise.any([facade.fail()]);
					void combined.catch(reason => {
						throw reason;
					});
					// oxlint-enable unicorn/no-single-promise-in-promise-methods
					await Bun.sleep(20);
				},
			);

			if (name === "any") {
				expect(floatingRejections).toHaveLength(1);
				expect(floatingRejections[0]).toBeInstanceOf(AggregateError);
				expect((floatingRejections[0] as AggregateError).errors).toEqual([browserFailure]);
			} else {
				expect(floatingRejections).toEqual([browserFailure]);
			}
			expect(Promise[name]).toBe(originalCombinator);
		}
	});

	it("preserves native await through a tracked browser-promise combinator", async () => {
		vi.useRealTimers();
		const owner = {};
		const browserFailure = new Error("browser failed");
		const floatingRejections: unknown[] = [];
		const facade = bindRunFacade(
			{
				fail(): Promise<never> {
					return Promise.reject(browserFailure);
				},
			},
			new AbortController().signal,
			owner,
			reason => floatingRejections.push(reason),
		);

		let caught: unknown;
		await withBrowserPromiseCombinatorTracking(
			owner,
			reason => floatingRejections.push(reason),
			async () => {
				try {
					// oxlint-disable-next-line unicorn/no-single-promise-in-promise-methods -- the tracked combinator is under test
					await Promise.all([facade.fail()]);
				} catch (error) {
					caught = error;
				}
				await Bun.sleep(10);
			},
		);

		expect(caught).toBe(browserFailure);
		expect(floatingRejections).toEqual([]);
	});

	it("keeps a real worker alive after floating browser and continuation rejections", async () => {
		vi.useRealTimers();
		using workerDir = TempDir.createSync("@omp-browser-rejections-");
		const workerPath = workerDir.join("worker.ts");
		await Bun.write(
			workerPath,
			`
				import {
					bindRunFacade,
					installBrowserWorkerRejectionGuard,
				} from ${JSON.stringify(runScopeModuleUrl)};

				const failures = [];
				const uninstall = installBrowserWorkerRejectionGuard(reason => {
					failures.push(reason instanceof Error ? reason.message : String(reason));
					return true;
				});
				const facade = bindRunFacade(
					{
						waitForResponse() {
							return Promise.reject(new Error("browser timeout"));
						},
						title() {
							return Promise.resolve("ready");
						},
					},
					new AbortController().signal,
					{},
				);
				void (async () => {
					await facade.waitForResponse();
				})();
				void facade.title().then(() => {
					throw new Error("continuation failed");
				});
				setTimeout(() => {
					uninstall();
					postMessage({ alive: true, failures });
				}, 50);
			`,
		);
		try {
			const script = `
				const worker = new Worker(${JSON.stringify(workerPath)}, { type: "module" });
				const done = Promise.withResolvers();
				worker.onmessage = event => done.resolve(event.data);
				worker.onerror = event => done.reject(new Error(event.message));
				try {
					const result = await Promise.race([
						done.promise,
						Bun.sleep(1000).then(() => {
							throw new Error("worker timed out");
						}),
					]);
					console.log(JSON.stringify(result));
				} finally {
					await worker.terminate();
				}
			`;
			const proc = Bun.spawn([process.execPath, "-e", script], {
				cwd: process.cwd(),
				stdout: "pipe",
				stderr: "pipe",
			});
			const [exitCode, stdout, stderr] = await Promise.all([
				proc.exited,
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);

			expect(exitCode, stderr).toBe(0);
			expect(stdout).toContain("browser timeout");
			expect(stdout).toContain("continuation failed");
		} finally {
			await fs.rm(workerPath, { force: true });
		}
	});

	it("does not mark errors thrown by user continuations", async () => {
		const owner = {};
		const continuationFailure = new Error("continuation failed");
		const floatingRejections: unknown[] = [];
		const facade = bindRunFacade(
			{
				ok: async (): Promise<string> => "ok",
			},
			new AbortController().signal,
			owner,
			reason => floatingRejections.push(reason),
		);

		const root = facade.ok();
		expect(root).toBeInstanceOf(Promise);
		expect(Object.getPrototypeOf(root)).toBe(Promise.prototype);
		const continuation = root.then(() => {
			throw continuationFailure;
		});

		await expect(continuation).rejects.toBe(continuationFailure);
		expect(isBrowserRunRejection(continuationFailure, owner)).toBe(false);
		expect(floatingRejections).toEqual([]);
	});

	it("reports unhandled errors from then, catch, and finally continuations", async () => {
		vi.useRealTimers();
		const owner = {};
		const floatingRejections: unknown[] = [];
		const facade = bindRunFacade(
			{
				fail: async (): Promise<never> => {
					throw new Error("browser failure");
				},
				ok: async (): Promise<string> => "ok",
			},
			new AbortController().signal,
			owner,
			reason => floatingRejections.push(reason),
		);

		void facade.ok().then(() => {
			throw new Error("then failed");
		});
		void facade.fail().catch(() => {
			throw new Error("catch failed");
		});
		void facade.ok().finally(() => {
			throw new Error("finally failed");
		});
		await Bun.sleep(20);

		const messages = floatingRejections
			.map(reason => (reason instanceof Error ? reason.message : String(reason)))
			.sort();
		expect(messages).toEqual(["catch failed", "finally failed", "then failed"]);
	});

	it("reports a browser error rethrown by a user rejection continuation", async () => {
		vi.useRealTimers();
		const owner = {};
		const browserFailure = new Error("browser failure");
		const floatingRejections: unknown[] = [];
		const facade = bindRunFacade(
			{
				fail: (): Promise<never> => Promise.reject(browserFailure),
			},
			new AbortController().signal,
			owner,
			reason => floatingRejections.push(reason),
		);

		void facade.fail().catch(reason => {
			throw reason;
		});
		await Bun.sleep(20);

		expect(isBrowserRunRejection(browserFailure, owner)).toBe(true);
		expect(floatingRejections).toEqual([browserFailure]);
	});

	it("rejects awaited facade method calls that settle after abort", async () => {
		const controller = new AbortController();
		const deferred = Promise.withResolvers<string>();
		const facade = bindRunFacade(
			{
				readTitle(): Promise<string> {
					return deferred.promise;
				},
			},
			controller.signal,
		);

		const pending = facade.readTitle();
		controller.abort(new Error("browser run ended"));
		deferred.resolve("late title");

		await expect(pending).rejects.toBeInstanceOf(ToolAbortError);
	});

	it("aborts run-scoped wait() before a stale continuation can mutate the tab", async () => {
		const runtime = new JsRuntime({ initialCwd: process.cwd(), sessionId: "browser-run-cancellation-test" });
		const timeoutSignal = AbortSignal.timeout(20);
		const runAc = new AbortController();
		const signal = AbortSignal.any([timeoutSignal, runAc.signal]);
		const state: { lateNavigation?: string; displays: string[] } = { displays: [] };
		const { promise: cancelRejection, reject } = Promise.withResolvers<never>();
		const hooks: RuntimeHooks = {
			onText: chunk => state.displays.push(chunk),
			onDisplay: output => state.displays.push(JSON.stringify(output)),
			callTool: async () => undefined,
		};
		timeoutSignal.addEventListener("abort", () => reject(new Error("Browser code execution timed out after 20ms")), {
			once: true,
		});
		runtime.setRunScope({
			wait: (ms: number): Promise<unknown> => waitForRun(ms, signal),
			tab: bindRunFacade(
				{
					goto: async (url: string): Promise<void> => {
						state.lateNavigation = url;
					},
				},
				signal,
			),
		});

		const run = Promise.race([
			runtime.run(
				'try { await wait(60); } catch {} await tab.goto("https://late.example"); display("late display");',
				"browser-run-cancellation-test.js",
				hooks,
			),
			cancelRejection,
		]);
		vi.advanceTimersByTime(20);
		await expect(run).rejects.toThrow("Browser code execution timed out after 20ms");
		runAc.abort(new Error("Browser run ended"));
		vi.advanceTimersByTime(100);
		await Promise.resolve();
		await Promise.resolve();

		expect(state.lateNavigation).toBeUndefined();
		expect(state.displays).toEqual([]);
	});
});
