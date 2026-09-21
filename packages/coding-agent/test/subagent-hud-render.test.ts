/**
 * Contract: the anchored subagent HUD (rendered above the editor, next to the
 * Todos block) lists every live subagent as an animated metadata row with
 * spinner, id, model, role, elapsed time, input tokens, output tokens, and
 * cost; detached background spawns and sync task calls alike are included.
 * The block self-clears once nothing qualifies.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { PINNED_HUD_TOGGLE_ID } from "@oh-my-pi/pi-tui/prompt/composer";
import {
	InteractiveMode,
	layoutPinnedHud,
	renderSubagentHudLines,
	SubagentHudComponent,
} from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { type ObservableSession, SessionObserverRegistry } from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { type AgentProgress } from "@oh-my-pi/pi-tui/tools/task";
import {
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

function makeSession(overrides: Partial<ObservableSession> & { id: string }): ObservableSession {
	return {
		kind: "subagent",
		label: overrides.id,
		status: "active",
		detached: true,
		lastUpdate: Date.now(),
		...overrides,
	};
}

function makeProgress(overrides: Partial<AgentProgress> & { id: string }): AgentProgress {
	return {
		index: 0,
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		...overrides,
	};
}

function makeLifecycle(id: string, index: number, description: string, detached?: boolean): SubagentLifecyclePayload {
	return {
		id,
		index,
		agent: "task",
		agentSource: "bundled",
		description,
		status: "started",
		parentToolCallId: "tool-call",
		detached,
	};
}

function makeProgressPayload(
	id: string,
	index: number,
	description: string,
	detached?: boolean,
): SubagentProgressPayload {
	return {
		index,
		agent: "task",
		agentSource: "bundled",
		task: description,
		parentToolCallId: "tool-call",
		detached,
		progress: makeProgress({ id, index, description, task: description }),
	};
}

function render(sessions: ObservableSession[], columns = 120): string {
	return Bun.stripANSI(renderSubagentHudLines(sessions, columns).join("\n"));
}
function liveRow(sessions: ObservableSession[], id: string, columns = 120): string {
	return (
		render(sessions, columns)
			.split("\n")
			.find(line => line.includes(id)) ?? ""
	);
}

describe("subagent HUD lines", () => {
	beforeAll(async () => {
		await initTheme();
	});

	describe("live metadata rows", () => {
		beforeEach(async () => {
			resetSettingsForTest();
			await Settings.init({ inMemory: true, overrides: { "task.showResolvedModelBadge": true } });
		});

		afterEach(() => {
			resetSettingsForTest();
		});

		it("orders spinner, id, model, role, elapsed time, tokens, and cost", () => {
			const session = makeSession({
				id: "LiveWorker",
				agent: "reviewer",
				progress: makeProgress({
					id: "LiveWorker",
					agent: "reviewer",
					resolvedModelIdentity: "openai/gpt-5",
					startedAtMs: Date.now() - 65_000,
					usage: {
						input: 123,
						output: 456,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 579,
						reasoningTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0421 },
					},
					cost: 0.0421,
				}),
			});
			const row = liveRow([session], "LiveWorker");
			const ordered = ["LiveWorker", "gpt-5", "reviewer", "1m", "123", "456", "$0.042"];
			expect(theme.spinnerFrames.some(frame => row.includes(frame))).toBe(true);
			for (let index = 0; index < ordered.length - 1; index++) {
				const before = ordered[index]!;
				const after = ordered[index + 1]!;
				expect(row.indexOf(before)).toBeGreaterThanOrEqual(0);
				expect(row.indexOf(before)).toBeLessThan(row.indexOf(after));
			}
			expect(row).toContain("$0.042");
		});

		it("keeps live metadata visible when the resolved model badge setting is disabled", () => {
			const session = makeSession({
				id: "HiddenBadge",
				agent: "reviewer",
				progress: makeProgress({ id: "HiddenBadge", agent: "reviewer", resolvedModelIdentity: "openai/gpt-5" }),
			});
			Settings.instance.override("task.showResolvedModelBadge", false);
			const row = liveRow([session], "HiddenBadge");
			expect(row).toContain("HiddenBadge");
			expect(row).toContain("gpt-5");
			expect(row).toContain("reviewer");
		});

		it("preserves the agent name and a bounded model prefix in live rows", () => {
			const metadata = {
				resolvedModelIdentity: `provider/${"shared-prefix-".repeat(8)}variant-z`,
				durationMs: 12_000,
			};
			const sessions = [
				makeSession({
					id: "Description",
					agent: "reviewer",
					progress: makeProgress({ id: "Description", agent: "reviewer", ...metadata }),
				}),
				makeSession({
					id: "TaskPreview",
					agent: "reviewer",
					progress: makeProgress({ id: "TaskPreview", agent: "reviewer", ...metadata }),
				}),
			];
			const wide = render(sessions, 120);
			for (const id of ["Description", "TaskPreview"]) {
				const row = wide.split("\n").find(line => line.includes(id))!;
				expect(row).toContain(id);
				expect(row).toContain("shared-prefix");
				expect(row).not.toContain(":high");
			}
			const lines = render(sessions, 60).split("\n");
			for (const line of lines) {
				expect(Bun.stringWidth(line)).toBeLessThanOrEqual(60);
			}
		});

		it("reserves custom tree prefixes, outer indent and roles before live details", () => {
			const priorTree = Object.getOwnPropertyDescriptor(theme, "tree");
			try {
				Object.defineProperty(theme, "tree", {
					configurable: true,
					value: { ...theme.tree, branch: "界├", last: "界界└" },
				});
				const sessions = [
					makeSession({
						id: `LongWorker${"界".repeat(30)}`,
						agent: `custom-role-${"extended-".repeat(10)}`,
						progress: makeProgress({
							id: "LongWorker",
							agent: "custom-role",
							resolvedModelIdentity: "provider/model",
						}),
					}),
					makeSession({
						id: "ShortWorker",
						agent: "scout",
						progress: makeProgress({ id: "ShortWorker", agent: "scout" }),
					}),
				];
				for (const enabled of [true, false]) {
					Settings.instance.override("task.showResolvedModelBadge", enabled);
					for (const width of [40, 120, 40]) {
						const rows = render(sessions, width).split("\n");
						expect(rows.find(row => row.includes("LongWorker"))).toStartWith(" 界├ ");
						expect(rows.find(row => row.includes("ShortWorker"))).toStartWith(" 界界└ ");
						for (const row of rows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width);
						expect(rows.find(row => row.includes("LongWorker"))).toContain("LongWorker");
						expect(rows.find(row => row.includes("ShortWorker"))).toContain("scout");
					}
				}
			} finally {
				if (priorTree) Object.defineProperty(theme, "tree", priorTree);
			}
		});

		it("preserves a legacy selector without inventing a thinking glyph", () => {
			const row = liveRow(
				[
					makeSession({
						id: "LegacyWorker",
						agent: "task",
						progress: makeProgress({ id: "LegacyWorker", agent: "task", resolvedModel: "custom/model:high" }),
					}),
				],
				"LegacyWorker",
			);
			expect(row).toContain("model:high");
			expect(row).not.toContain(theme.thinking.high.split(" ")[0]);
		});
	});

	it("renders running subagents as live metadata rows under a Subagents header", () => {
		const out = render([
			makeSession({
				id: "AuthLoader",
				agent: "reviewer",
				progress: makeProgress({ id: "AuthLoader", agent: "reviewer" }),
			}),
			makeSession({
				id: "SchemaMigrator",
				agent: "reviewer",
				progress: makeProgress({ id: "SchemaMigrator", agent: "reviewer" }),
			}),
		]);
		expect(out).toContain("Subagents");
		expect(
			liveRow(
				[
					makeSession({
						id: "AuthLoader",
						agent: "reviewer",
						progress: makeProgress({ id: "AuthLoader", agent: "reviewer" }),
					}),
				],
				"AuthLoader",
			),
		).toContain("AuthLoader");
		expect(
			liveRow(
				[
					makeSession({
						id: "SchemaMigrator",
						agent: "reviewer",
						progress: makeProgress({ id: "SchemaMigrator", agent: "reviewer" }),
					}),
				],
				"SchemaMigrator",
			),
		).toContain("SchemaMigrator");
	});

	it("shows progress roles without duplicating ids", () => {
		const withRole = liveRow(
			[
				makeSession({
					id: "AuthLoader",
					agent: "scout",
					progress: makeProgress({ id: "AuthLoader", agent: "scout" }),
				}),
			],
			"AuthLoader",
		);
		expect(withRole).toMatch(/AuthLoader.*scout/);

		const echoed = liveRow(
			[
				makeSession({
					id: "AuthLoader",
					agent: "scout",
					progress: makeProgress({ id: "AuthLoader", agent: "scout" }),
				}),
			],
			"AuthLoader",
		);
		expect(echoed).not.toContain("AuthLoader: AuthLoader");

		const collision = liveRow(
			[
				makeSession({
					id: "AuthLoader-3",
					agent: "scout",
					progress: makeProgress({ id: "AuthLoader-3", agent: "scout" }),
				}),
			],
			"AuthLoader-3",
		);
		expect(collision).toMatch(/AuthLoader-3.*scout/);

		const defaultWorker = liveRow(
			[
				makeSession({
					id: "SchemaMigrator",
					agent: "task",
					progress: makeProgress({ id: "SchemaMigrator", agent: "task" }),
				}),
			],
			"SchemaMigrator",
		);
		expect(defaultWorker).toMatch(/SchemaMigrator.*task/);
	});

	it("only shows active subagents and clears once everything finished", () => {
		const finishedStates = ["completed", "failed", "aborted"] as const;
		const sessions: ObservableSession[] = [
			{ id: "main", kind: "main", label: "Main Session", status: "active", lastUpdate: Date.now() },
			...finishedStates.map(status => makeSession({ id: `Done-${status}`, status, description: "old work" })),
		];
		expect(renderSubagentHudLines(sessions, 120)).toEqual([]);

		const out = render([
			...sessions,
			makeSession({
				id: "StillRunning",
				agent: "reviewer",
				progress: makeProgress({ id: "StillRunning", agent: "reviewer" }),
			}),
		]);
		expect(out).toContain("StillRunning");
		expect(out).not.toContain("Done-");
		expect(out).not.toContain("Main Session");
	});

	it("uses progress metadata for each live row", () => {
		const sessions = [
			makeSession({
				id: "ReviewShell",
				agent: "scout",
				progress: makeProgress({
					id: "ReviewShell",
					agent: "scout",
					resolvedModelIdentity: "anthropic/claude",
					usage: {
						input: 12,
						output: 34,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 46,
						reasoningTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				}),
			}),
			makeSession({
				id: "Worker",
				agent: "reviewer",
				progress: makeProgress({ id: "Worker", agent: "reviewer", resolvedModelIdentity: "openai/gpt-5" }),
			}),
		];
		const reviewRow = liveRow(sessions, "ReviewShell");
		expect(reviewRow).toContain("ReviewShell");
		expect(reviewRow).toContain("claude");
		expect(reviewRow).toContain("scout");
		expect(reviewRow).toContain("12 in");
		expect(reviewRow).toContain("34 out");
		expect(liveRow(sessions, "Worker")).toContain("gpt-5");
	});
	it("lists sync and detached spawns alike", () => {
		const sessions = [
			makeSession({
				id: "SyncSpawn",
				agent: "task",
				progress: makeProgress({ id: "SyncSpawn", agent: "task" }),
				detached: false,
			}),
			makeSession({
				id: "EvalSpawn",
				agent: "task",
				progress: makeProgress({ id: "EvalSpawn", agent: "task" }),
				detached: undefined,
			}),
			makeSession({
				id: "BackgroundSpawn",
				agent: "task",
				progress: makeProgress({ id: "BackgroundSpawn", agent: "task" }),
			}),
		];
		const out = render(sessions);
		for (const id of ["BackgroundSpawn", "SyncSpawn", "EvalSpawn"]) expect(out).toContain(id);
		const hud = new SubagentHudComponent(renderSubagentHudLines(sessions, 120), [
			"SyncSpawn",
			"EvalSpawn",
			"BackgroundSpawn",
		]);
		hud.render(120);
		expect(hud.getClickAgentAtRow(2)).toBe("SyncSpawn");
		expect(hud.getClickAgentAtRow(3)).toBe("EvalSpawn");
		expect(hud.getClickAgentAtRow(4)).toBe("BackgroundSpawn");
	});
	it("threads the detached flag from lifecycle and progress payloads", () => {
		const eventBus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(eventBus, eventBus);

		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("Detached", 0, "background work", true));
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("Inline", 1, "sync work"));
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, makeProgressPayload("FromProgress", 2, "background work", true));

		const out = render(registry.getSessions());
		for (const id of ["Detached", "FromProgress", "Inline"]) expect(out).toContain(id);
	});

	it("renders nested ids as a breadcrumb and truncates live rows to the viewport", () => {
		const out = render(
			[
				makeSession({
					id: "Anna.Bob",
					agent: "reviewer",
					progress: makeProgress({
						id: "Anna.Bob",
						agent: "reviewer",
						resolvedModelIdentity: `provider/${"x".repeat(300)}`,
					}),
				}),
			],
			60,
		);
		expect(out).toContain("Anna>Bob");
		expect(out).not.toContain("x".repeat(300));
		for (const line of out.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(60);
		}
	});

	it("dedupes frames dual-published on the session bus and the shared bus", () => {
		const eventBus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(eventBus, eventBus);
		const kinds: string[] = [];
		registry.onChange(kind => kinds.push(kind));
		const payload = makeLifecycle("DualPublished", 0, "dual-published frame");
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, payload);
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, payload);
		expect(kinds).toEqual(["lifecycle"]);
		expect(registry.getActiveSubagentCount()).toBe(1);
		registry.dispose();
	});

	it("keeps subagent registry order stable while progress arrives out of order", () => {
		const eventBus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(eventBus, eventBus);
		const activeIds = () =>
			registry
				.getSessions()
				.filter(session => session.kind === "subagent" && session.status === "active")
				.map(session => session.id);

		eventBus.emit(
			TASK_SUBAGENT_LIFECYCLE_CHANNEL,
			makeLifecycle("BlastRadius", 1, "Survey id-keyed downstream consumers"),
		);
		eventBus.emit(
			TASK_SUBAGENT_LIFECYCLE_CHANNEL,
			makeLifecycle("SelectorSurfaces", 0, "Map model-selector resolution surfaces"),
		);
		eventBus.emit(
			TASK_SUBAGENT_LIFECYCLE_CHANNEL,
			makeLifecycle("VariantsSurvey", 2, "Survey tier-variant ids across catalog"),
		);

		expect(activeIds()).toEqual(["SelectorSurfaces", "BlastRadius", "VariantsSurvey"]);

		eventBus.emit(
			TASK_SUBAGENT_PROGRESS_CHANNEL,
			makeProgressPayload("VariantsSurvey", 2, "Survey tier-variant ids across catalog"),
		);
		eventBus.emit(
			TASK_SUBAGENT_PROGRESS_CHANNEL,
			makeProgressPayload("BlastRadius", 1, "Survey id-keyed downstream consumers"),
		);

		expect(activeIds()).toEqual(["SelectorSurfaces", "BlastRadius", "VariantsSurvey"]);
	});

	it("renders every live agent when expanded, with a collapse row", () => {
		const active = Array.from({ length: 10 }, (_, index) =>
			makeSession({
				id: `Worker${index}`,
				description: `job ${index}`,
			}),
		);

		const out = Bun.stripANSI(renderSubagentHudLines(active, 120, true).join("\n"));

		for (const session of active) {
			expect(out).toContain(session.id);
		}
		expect(out).not.toContain("more running");
		expect(out).toContain("show less");
	});

	it("collapses to a few rows with an expander by default", () => {
		const active = Array.from({ length: 10 }, (_, index) =>
			makeSession({
				id: `Worker${index}`,
				description: `job ${index}`,
			}),
		);

		const out = render(active, 120);
		expect(out).toContain("Worker0");
		expect(out).toContain("Worker2");
		expect(out).not.toContain("Worker3");
		expect(out).toContain("7 more — expand");
		expect(out).not.toContain("show less");
	});
});

describe("SubagentHudComponent click rows", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("maps item rows to session ids and chrome rows nowhere", () => {
		const lines = renderSubagentHudLines([makeSession({ id: "Alpha" }), makeSession({ id: "Beta" })], 120);
		const hud = new SubagentHudComponent(lines, ["Alpha", "Beta"]);

		const rendered = hud.render(120);
		expect(rendered).toHaveLength(lines.length);
		expect(Bun.stripANSI(rendered[2] ?? "")).toContain("Alpha");
		expect(Bun.stripANSI(rendered[3] ?? "")).toContain("Beta");

		expect(hud.getClickAgentAtRow(0)).toBeUndefined();
		expect(hud.getClickAgentAtRow(1)).toBeUndefined();
		expect(hud.getClickAgentAtRow(2)).toBe("Alpha");
		expect(hud.getClickAgentAtRow(3)).toBe("Beta");
		expect(hud.getClickAgentAtRow(4)).toBeUndefined();
		expect(hud.getClickAgentAtRow(-1)).toBeUndefined();
	});

	it("resolves the expander row to the toggle sentinel", () => {
		const hud = new SubagentHudComponent(["", "Subagents", "row", "toggle"], ["Only"], 3);
		hud.render(120);
		expect(hud.getClickAgentAtRow(3)).toBe(PINNED_HUD_TOGGLE_ID);
		expect(hud.getClickAgentAtRow(2)).toBe("Only");
	});

	it("maps wrapped continuation rows to the agent that started them", () => {
		const long = ` ${"x".repeat(200)}`;
		const hud = new SubagentHudComponent(["", "Subagents", long, "short"], ["Long", "Short"]);
		const rendered = hud.render(40);
		expect(rendered.length).toBeGreaterThan(4);
		const shortRow = rendered.findIndex(line => Bun.stripANSI(line).includes("short"));
		expect(shortRow).toBeGreaterThan(3);
		expect(hud.getClickAgentAtRow(2)).toBe("Long");
		expect(hud.getClickAgentAtRow(3)).toBe("Long");
		expect(hud.getClickAgentAtRow(shortRow)).toBe("Short");
		expect(hud.getClickAgentAtRow(shortRow + 1)).toBeUndefined();
	});
});

describe("layoutPinnedHud", () => {
	it("fits small lists without an expander", () => {
		expect(layoutPinnedHud(0, false)).toEqual({ itemRows: 0, toggle: undefined, toggleRow: undefined });
		expect(layoutPinnedHud(3, false)).toEqual({ itemRows: 3, toggle: undefined, toggleRow: undefined });
		expect(layoutPinnedHud(3, true)).toEqual({ itemRows: 3, toggle: undefined, toggleRow: undefined });
	});

	it("collapses longer lists behind an expander", () => {
		expect(layoutPinnedHud(4, false)).toEqual({ itemRows: 3, toggle: "expand", toggleRow: 5 });
		expect(layoutPinnedHud(10, false)).toEqual({ itemRows: 3, toggle: "expand", toggleRow: 5 });
	});

	it("expands to every row with a collapse row", () => {
		expect(layoutPinnedHud(5, true)).toEqual({ itemRows: 5, toggle: "collapse", toggleRow: 7 });
		expect(layoutPinnedHud(10, true)).toEqual({ itemRows: 10, toggle: "collapse", toggleRow: 12 });
	});
});

describe("InteractiveMode subagent observer UI sync", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let eventBus: EventBus;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-subagent-observer-");
		await Settings.init({
			inMemory: true,
			cwd: tempDir.path(),
			overrides: { "startup.quiet": true },
		});
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");

		eventBus = new EventBus();
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "startup.quiet": true }),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, eventBus);
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		vi.useRealTimers();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("coalesces a burst of progress observer changes into one HUD rebuild and render request", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		const requestRender = vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});
		const rebuildHud = vi.spyOn(mode.subagentContainer, "clear");
		vi.useFakeTimers();

		for (let index = 0; index < 6; index++) {
			eventBus.emit(
				TASK_SUBAGENT_PROGRESS_CHANNEL,
				makeProgressPayload(`BurstAgent${index}`, index, `Burst job ${index}`, true),
			);
		}

		await Promise.resolve();
		vi.advanceTimersByTime(100);
		await Promise.resolve();

		const hud = Bun.stripANSI(mode.subagentContainer.render(120).join("\n"));
		expect(hud).toContain("BurstAgent0");
		expect(hud).toContain("BurstAgent2");
		expect(hud).not.toContain("BurstAgent3");
		expect(hud).toContain("3 more — expand");
		expect(rebuildHud).toHaveBeenCalledTimes(1);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("updates mounted HUD output on one tick and stops after settlement and disposal", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		vi.useFakeTimers();
		const requestRender = vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});
		const rebuildHud = vi.spyOn(mode.subagentContainer, "clear");

		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, makeProgressPayload("TickingAgent", 0, "ticker work", true));
		await Promise.resolve();
		const beforeTick = Bun.stripANSI(mode.subagentContainer.render(120).join("\n"));
		vi.advanceTimersByTime(100);
		await Promise.resolve();
		const afterTick = Bun.stripANSI(mode.subagentContainer.render(120).join("\n"));
		expect(afterTick).not.toBe(beforeTick);

		const settled = makeLifecycle("TickingAgent", 0, "ticker work", true);
		settled.status = "completed";
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, settled);
		await Promise.resolve();
		vi.advanceTimersByTime(100);
		await Promise.resolve();
		const rebuildsAfterSettlement = rebuildHud.mock.calls.length;
		const rendersAfterSettlement = requestRender.mock.calls.length;
		vi.advanceTimersByTime(100);
		await Promise.resolve();
		expect(rebuildHud).toHaveBeenCalledTimes(rebuildsAfterSettlement);
		expect(requestRender).toHaveBeenCalledTimes(rendersAfterSettlement);

		mode.stop();
		const rebuildsAfterStop = rebuildHud.mock.calls.length;
		const rendersAfterStop = requestRender.mock.calls.length;
		vi.advanceTimersByTime(100);
		await Promise.resolve();
		expect(rebuildHud).toHaveBeenCalledTimes(rebuildsAfterStop);
		expect(requestRender).toHaveBeenCalledTimes(rendersAfterStop);
	});

	it("applies the setting over a clicked expand override", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		for (let index = 0; index < 5; index++) {
			eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle(`Override${index}`, index, `job ${index}`));
		}
		await Promise.resolve();
		const hudText = () => Bun.stripANSI(mode.subagentContainer.render(120).join("\n"));

		mode.togglePinnedHudExpanded();
		expect(hudText()).toContain("Override4");

		mode.applyPinnedAgentsSetting();
		expect(hudText()).not.toContain("Override4");
		expect(hudText()).toContain("more — expand");
	});
});
