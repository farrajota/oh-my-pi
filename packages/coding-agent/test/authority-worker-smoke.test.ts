import { describe, expect, it } from "bun:test";
import { smokeTestAuthorityWorker } from "../src/cli/authority-worker-smoke";

describe("authority worker CLI smoke", () => {
	it("opens, recovers, and closes a real authority worker for an isolated root", async () => {
		await expect(smokeTestAuthorityWorker()).resolves.toBeUndefined();
	}, 30_000);
});
