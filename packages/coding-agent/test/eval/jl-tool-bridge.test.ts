import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { TodoPhase } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { Settings } from "../../src/config/settings";
import { disposeJuliaKernelSessionsByOwner, executeJulia } from "../../src/eval/jl/executor";
import { checkJuliaKernelAvailability } from "../../src/eval/jl/kernel";
import { SessionManager } from "../../src/session/session-manager";
import { TodoTracker, type TodoTrackerHost } from "../../src/session/todo-tracker";
import { TodoTool, USER_TODO_EDIT_CUSTOM_TYPE } from "../../src/tools/todo";

const repoRoot = path.resolve(import.meta.dir, "../../../..");
const juliaAvailability = await checkJuliaKernelAvailability(repoRoot);

describe("Julia tool bridge producer", () => {
	it.skipIf(!juliaAvailability.ok)(
		"dispatches a real TodoTool mutation and preserves it after journal reopen",
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-julia-tool-bridge-"));
			const kernelOwnerId = `julia-tool-bridge-${crypto.randomUUID()}`;
			let manager: SessionManager | undefined;
			try {
				const sessionManager = SessionManager.create(root, path.join(root, "sessions"));
				manager = sessionManager;
				await sessionManager.ensureOnDisk();
				const sessionFile = sessionManager.getSessionFile();
				if (!sessionFile) throw new Error("Julia bridge test session has no journal file");

				const sessionId = `julia-tool-bridge-session-${crypto.randomUUID()}`;
				let todoPhases: TodoPhase[] = [];
				const settings = Settings.isolated({
					"eval.js": true,
					"eval.tools.enabled": true,
					"tools.xdev": false,
					"async.enabled": false,
				});
				const session: ToolSession = {
					cwd: root,
					hasUI: false,
					settings,
					getSessionFile: () => sessionFile,
					getSessionSpawns: () => "",
					getSessionId: () => sessionId,
					getEvalSessionId: () => sessionId,
					getEvalKernelOwnerId: () => kernelOwnerId,
					getTodoPhases: () => todoPhases,
					setTodoPhases: phases => {
						todoPhases = structuredClone(phases);
					},
					persistTodoPhases: phases => {
						sessionManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: structuredClone(phases) });
					},
				};
				const todo = new TodoTool(session) as unknown as AgentTool;
				session.getToolByName = name => (name === "todo" ? todo : undefined);
				session.getToolForEvalBridge = name => (name === "todo" ? todo : undefined);
				session.getEvalBridgeToolNames = () => ["todo"];

				const options = {
					cwd: root,
					sessionId,
					kernelOwnerId,
					interpreter: juliaAvailability.juliaPath,
					toolSession: session,
				};
				const appended = await executeJulia(
					'tool.todo(op="append", phase="runtime", items=["julia task"])',
					options,
				);
				expect(appended.exitCode).toBe(0);
				expect(
					todoPhases.map(phase => ({ name: phase.name, tasks: phase.tasks.map(task => task.content) })),
				).toEqual([{ name: "runtime", tasks: ["julia task"] }]);
				const committedPhases = structuredClone(todoPhases);
				const committedJournalEntryCount = sessionManager.getEntries().length;

				const assertReopenedTodo = async () => {
					await sessionManager.flush();
					const reopened = await SessionManager.open(sessionFile, path.join(root, "sessions"), undefined, {
						initialCwd: root,
						suppressBreadcrumb: true,
						throwIfMissing: true,
					});
					try {
						expect(reopened.getEntries()).toHaveLength(committedJournalEntryCount);
						const entries = reopened
							.getEntries()
							.filter(entry => entry.type === "custom" && entry.customType === USER_TODO_EDIT_CUSTOM_TYPE);
						expect(entries).toHaveLength(1);
						const tracker = new TodoTracker({ sessionManager: reopened } as TodoTrackerHost);
						tracker.syncFromBranch();
						expect(tracker.phases).toEqual(committedPhases);
					} finally {
						await reopened.close();
					}
				};
				await assertReopenedTodo();

				const unregistered = await executeJulia("tool.unregistered()", options);
				expect(unregistered.exitCode).not.toBe(0);
				expect(unregistered.output).toContain("Unknown tool from js runtime: unregistered");
				expect(todoPhases).toEqual(committedPhases);
				expect(sessionManager.getEntries()).toHaveLength(committedJournalEntryCount);
				await assertReopenedTodo();
			} finally {
				try {
					await disposeJuliaKernelSessionsByOwner(kernelOwnerId);
				} finally {
					try {
						await manager?.close();
					} finally {
						await fs.rm(root, { recursive: true, force: true });
					}
				}
			}
		},
		// Cold Julia initialization/prelude each have a 15s budget; leave headroom for
		// both tool cells, durable journal reopens and nested owner cleanup.
		60_000,
	);
});
