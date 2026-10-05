import * as path from "node:path";
import { describe, expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { formatEvalStateContext, getEvalState } from "../../../src/eval/state";
import type { ToolSession } from "../../../src/tools";
import { disposeKernelSessionsByOwner, executePython } from "../../../src/eval/py/executor";

function toolSession(sessionId: string, ownerId: string, cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getEvalSessionId: () => sessionId,
		getEvalKernelOwnerId: () => ownerId,
	} as ToolSession;
}

describe("Python retained runtime lifecycle publication", () => {
	it("publishes real identity through errors, reset, and final-owner disposal", async () => {
		using workspace = TempDir.createSync("@omp-py-lifecycle-");
		const sessionId = `py-lifecycle:${crypto.randomUUID()}`;
		const firstOwner = `py-owner:${crypto.randomUUID()}`;
		const secondOwner = `py-owner:${crypto.randomUUID()}`;
		const first = toolSession(sessionId, firstOwner, workspace.path());
		const second = toolSession(sessionId, secondOwner, workspace.path());
		const options = { cwd: workspace.path(), sessionId, kernelOwnerId: firstOwner, toolSession: first };
		try {
			const initial = await executePython("retained_value = 1", {
				...options,
				filename: path.join(workspace.path(), "retained.py"),
			});
			expect(initial.exitCode).toBe(0);
			const born = getEvalState(first)?.runtimes.find(runtime => runtime.language === "python");
			expect(born).toMatchObject({ alive: true, generation: 1, cwd: workspace.path() });
			expect(born?.kernelId).toBeTruthy();
			expect(getEvalState(first)?.sessionId).toBe(sessionId);
			expect(born?.loadedPaths).toContain(path.resolve(workspace.path(), "retained.py"));
			expect(formatEvalStateContext(first)).toContain(`kernel=${born?.kernelId}`);
			expect(born?.interpreter).toBeTruthy();
			expect(path.isAbsolute(born?.interpreter ?? "")).toBe(true);

			const failed = await executePython("raise ValueError('retained error')", options);
			expect(failed.exitCode).toBe(1);
			const afterError = getEvalState(first)?.runtimes.find(runtime => runtime.language === "python");
			expect(afterError).toMatchObject({
				alive: true,
				generation: born?.generation,
				kernelId: born?.kernelId,
			});

			const reset = await executePython("retained_value = 2", { ...options, reset: true });
			expect(reset.exitCode).toBe(0);
			const restarted = getEvalState(first)?.runtimes.find(runtime => runtime.language === "python");
			expect(restarted?.alive).toBe(true);
			expect(restarted?.generation).toBe((born?.generation ?? 0) + 1);
			expect(restarted?.kernelId).not.toBe(born?.kernelId);
			expect(restarted?.loadedPaths).toEqual([]);

			const shared = await executePython("print(retained_value)", {
				cwd: workspace.path(),
				sessionId,
				kernelOwnerId: secondOwner,
				toolSession: second,
			});
			expect(shared.exitCode).toBe(0);
			await disposeKernelSessionsByOwner(firstOwner);
			expect(getEvalState(second)?.runtimes.find(runtime => runtime.language === "python")).toMatchObject({
				alive: true,
				kernelId: restarted?.kernelId,
			});

			await disposeKernelSessionsByOwner(secondOwner);
			expect(getEvalState(second)?.runtimes.find(runtime => runtime.language === "python")).toMatchObject({
				alive: false,
				kernelId: restarted?.kernelId,
			});
		} finally {
			await disposeKernelSessionsByOwner(firstOwner);
			await disposeKernelSessionsByOwner(secondOwner);
		}
	});
});
