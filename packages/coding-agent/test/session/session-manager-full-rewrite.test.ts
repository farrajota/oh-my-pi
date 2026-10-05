import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

function assistantMessage(text: string) {
	return {
		role: "assistant" as const,
		provider: "anthropic",
		model: "claude-3-7-sonnet",
		content: [{ type: "text" as const, text }],
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		},
		api: "anthropic-messages" as const,
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

describe("SessionManager full rewrite durability", () => {
	it("allows an atomic transcript rewrite immediately after first materializing the file", async () => {
		using tempDir = TempDir.createSync("@omp-session-sync-rewrite-");
		const storage = new FileSessionStorage();
		const manager = SessionManager.create(tempDir.path(), tempDir.path(), storage);
		try {
			manager.appendMessage(assistantMessage("first complete turn"));
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("expected a session file");

			await manager.rewriteEntries();
			expect(fs.readFileSync(sessionFile, "utf8")).toContain("first complete turn");
		} finally {
			await manager.close();
		}
	});

	it("adopts a concurrent entry and retries an atomic rewrite after its size CAS conflicts", async () => {
		using tempDir = TempDir.createSync("@omp-session-atomic-rewrite-");
		const manager = SessionManager.create(tempDir.path(), tempDir.path(), new FileSessionStorage());
		try {
			manager.appendMessage(assistantMessage("local transcript"));
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("expected a session file");
			const latest = manager.getEntries().at(-1);
			if (!latest || latest.type !== "message" || latest.message.role !== "assistant") {
				throw new Error("expected a durable assistant entry");
			}

			const foreignEntry = {
				...latest,
				id: `${latest.id}-peer`,
				parentId: latest.id,
				timestamp: new Date().toISOString(),
				message: {
					...latest.message,
					content: [{ type: "text" as const, text: "concurrent transcript entry" }],
					timestamp: Date.now(),
				},
			};
			fs.appendFileSync(sessionFile, `${JSON.stringify(foreignEntry)}\n`, "utf8");

			await manager.rewriteEntries();
			const body = fs.readFileSync(sessionFile, "utf8");
			expect(body).toContain("local transcript");
			expect(body).toContain("concurrent transcript entry");
		} finally {
			await manager.close();
		}
	});
});
