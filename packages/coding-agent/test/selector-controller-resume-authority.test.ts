import { afterEach, describe, expect, it, vi } from "bun:test";
import * as foreignSessionImport from "@oh-my-pi/pi-coding-agent/session/foreign-session-import";
import type { ForeignSessionInfo } from "@oh-my-pi/pi-coding-agent/session/foreign-session-store";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import * as SessionSelector from "@oh-my-pi/pi-tui/overlays/session-selector";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import * as operationLease from "@oh-my-pi/pi-coding-agent/registry/operation-lease";
function createContext(sessionFile: string) {
	const calls: string[] = [];
	let currentSessionFile = sessionFile;
	const editor = {};
	const context = {
		settings: { flush: vi.fn(async () => calls.push("flush")) },
		prepareSessionSwitch: vi.fn(async () => calls.push("prepare")),
		resetObserverRegistry: vi.fn(() => calls.push("reset-observers")),
		sessionManager: {
			getCwd: () => "/tmp/current-project",
			getSessionDir: () => "/tmp",
			getSessionFile: () => currentSessionFile,
			getSessionId: () => "current-session",
		},
		session: {
			switchSession: vi.fn(async (target: string) => {
				calls.push("switch");
				currentSessionFile = target;
				return true;
			}),
		},
		clearTransientSessionUi: vi.fn(() => calls.push("clear-ui")),
		updateEditorBorderColor: vi.fn(() => calls.push("border")),
		renderInitialMessages: vi.fn(async () => calls.push("render")),
		reloadTodos: vi.fn(async () => calls.push("todos")),
		showStatus: vi.fn(() => calls.push("status")),
		showError: vi.fn(() => calls.push("error")),
		ui: {
			requestRender: vi.fn(),
			setFocus: vi.fn(),
			terminal: { rows: 24 },
			showOverlay: vi.fn(() => ({ hide: vi.fn(), setHidden: vi.fn(), isHidden: () => false })),
		},
		editor,
		editorContainer: { children: [editor] },
	} as unknown as InteractiveModeContext;
	return { context, calls, getCurrentSessionFile: () => currentSessionFile };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("SelectorController bound resume guard", () => {
	it("reports bound resume refusal without rejecting before settings flush or session-switch preparation", async () => {
		const source = "/tmp/current/session.jsonl";
		const target = "/tmp/other project/target session.jsonl";
		const harness = createContext(source);
		const guard = vi.spyOn(operationLease, "hasBoundSessionOperationAuthority").mockReturnValue(true);

		await expect(new SelectorController(harness.context).handleResumeSession(target)).resolves.toBe(false);
		expect(harness.context.showError).toHaveBeenCalledWith(expect.stringContaining("--resume"));
		expect(harness.context.showError).toHaveBeenCalledWith(expect.stringContaining("fresh process"));
		expect(harness.calls).toEqual(["error"]);
		expect(harness.getCurrentSessionFile()).toBe(source);
		expect(harness.context.settings.flush).not.toHaveBeenCalled();
		expect(harness.context.prepareSessionSwitch).not.toHaveBeenCalled();
		expect(harness.context.session.switchSession).not.toHaveBeenCalled();
		expect(guard).toHaveBeenCalledWith(harness.context.sessionManager);
	});

	it("keeps same-session reload compatible even when the operation authority is bound", async () => {
		const current = "/tmp/current/session.jsonl";
		const harness = createContext(current);
		vi.spyOn(operationLease, "hasBoundSessionOperationAuthority").mockReturnValue(true);

		expect(await new SelectorController(harness.context).handleResumeSession(current)).toBe(true);
		expect(harness.calls).toContain("prepare");
		expect(harness.context.session.switchSession).toHaveBeenCalledWith(current, expect.any(Object));
		expect(harness.getCurrentSessionFile()).toBe(current);
	});

	it("rejects a foreign import before settings flush or transcript persistence", async () => {
		const source = "/tmp/current/session.jsonl";
		const harness = createContext(source);
		const foreignSession: ForeignSessionInfo = {
			source: "codex",
			id: "foreign-session",
			path: "/tmp/codex/session.jsonl",
			cwd: "/tmp/codex",
			created: new Date("2026-01-01T00:00:00Z"),
			modified: new Date("2026-01-01T00:00:00Z"),
		};
		vi.spyOn(operationLease, "hasBoundSessionOperationAuthority").mockReturnValue(true);
		vi.spyOn(foreignSessionImport, "createForeignSessionStore").mockReturnValue({
			source: "codex",
			list: async () => [foreignSession],
			load: async () => {
				throw new Error("foreign transcript must not load");
			},
		});
		const persist = vi.spyOn(foreignSessionImport, "persistForeignSession");

		let select: ((session: SessionInfo) => Promise<void>) | undefined;
		vi.spyOn(SessionSelector, "SessionSelectorComponent").mockImplementation(((
			_sessions: SessionInfo[],
			onSelect: (session: SessionInfo) => Promise<void>,
		) => {
			select = onSelect;
			return { lockInput: vi.fn(), unlockInput: vi.fn(), setOnRequestRender: vi.fn() };
		}) as never);
		const controller = new SelectorController(harness.context);
		await controller.showSessionSelector("codex");
		if (!select) throw new Error("Expected foreign session selection callback");
		await select({
			...foreignSession,
			messageCount: 0,
			size: 0,
			firstMessage: "(no messages)",
			allMessagesText: "(no messages)",
		});

		expect(harness.context.showError).toHaveBeenCalledWith(expect.stringContaining("--from-codex"));
		expect(harness.calls).toEqual(["error"]);
		expect(harness.context.settings.flush).not.toHaveBeenCalled();
		expect(persist).not.toHaveBeenCalled();
		expect(harness.context.prepareSessionSwitch).not.toHaveBeenCalled();
		expect(harness.context.session.switchSession).not.toHaveBeenCalled();
	});
});
