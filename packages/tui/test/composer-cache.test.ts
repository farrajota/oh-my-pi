import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { COMPOSER_DEFAULTS, Composer, type ComposerStatusCache } from "@oh-my-pi/pi-tui/prompt/composer";
import { ComposerCache } from "@oh-my-pi/pi-tui/prompt/composer-cache";
import { createStartupStatusLine } from "@oh-my-pi/pi-tui/status-line/startup";
import { VirtualTerminal } from "./virtual-terminal";

function statusFor(thinkingLevel: ThinkingLevel): ComposerStatusCache {
	return {
		borderColor: { prefix: "\x1b[36m", suffix: "\x1b[39m" },
		statusLine: {
			settings: { leftSegments: ["model", "path", "git"], contextLine: "embedded" },
			gitEnabled: true,
			thinkingLevel,
			autoThinking: false,
			fastMode: false,
			usingSubscription: true,
			autoCompactEnabled: true,
			compactionBoundaries: { thresholdPercent: 80, speculationPercent: null },
		},
	};
}

function statusLineFrom(status: ComposerStatusCache) {
	return createStartupStatusLine(status.statusLine);
}

describe("composer startup cache", () => {
	let root: string;
	let dbPath: string;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-composer-cache-"));
		dbPath = path.join(root, "cache", "composer.db");
	});

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	it("round-trips per-project speculation and serves settings-derived rows to projects without their own", () => {
		const project = path.join(root, "project");
		const other = path.join(root, "other");
		const preferences = { ...COMPOSER_DEFAULTS, composerShape: "rail", autocompleteMaxVisible: 7 };
		const theme = { symbolPreset: "ascii" as const, colorBlindMode: true, darkTheme: "dark", lightTheme: "light" };
		const sessions = ["a", "b", "c", "d", "e"].map(name => ({ name, timeAgo: "3m ago" }));
		const lspServers = [{ name: "rust-analyzer", status: "connecting" as const, fileTypes: [".rs"] }];
		const status = statusFor(ThinkingLevel.High);

		const writer = ComposerCache.open(dbPath);
		writer.writeUi(project, preferences, theme);
		writer.writeWelcome(project, { modelName: "Claude Fable 5", providerName: "anthropic" });
		writer.writeRecentSessions(project, sessions);
		writer.writeLspServers(project, lspServers);
		writer.writeStatus(project, status);
		writer.close();

		// A separate connection sees everything: the next launch reads what this one wrote.
		const reader = ComposerCache.open(dbPath);
		expect(reader.read(project)).toEqual({
			preferences,
			theme,
			welcome: { modelName: "Claude Fable 5", providerName: "anthropic" },
			recentSessions: sessions.slice(0, 4),
			lspServers,
			status,
		});
		// Theme, model labels, and status follow the user; sessions and LSP rows are project facts.
		expect(reader.read(other)).toEqual({
			preferences,
			theme,
			welcome: { modelName: "Claude Fable 5", providerName: "anthropic" },
			recentSessions: [],
			lspServers: [],
			status,
		});

		// Disabling LSP must replace the cached rows so the next prepaint hides the section.
		reader.writeLspServers(project, null);
		expect(reader.read(project).lspServers).toBeNull();
		reader.close();
	});

	it("prefers a project's own status over the last status written elsewhere", () => {
		const cache = ComposerCache.open(dbPath);
		cache.writeStatus(path.join(root, "a"), statusFor(ThinkingLevel.Low));
		cache.writeStatus(path.join(root, "b"), statusFor(ThinkingLevel.High));

		expect(cache.read(path.join(root, "a")).status?.statusLine.thinkingLevel).toBe(ThinkingLevel.Low);
		expect(cache.read(path.join(root, "fresh")).status?.statusLine.thinkingLevel).toBe(ThinkingLevel.High);
		cache.close();
	});

	it("drops a store written in an older payload format", async () => {
		const project = path.join(root, "project");
		await fs.mkdir(path.dirname(dbPath), { recursive: true });
		const legacy = new Database(dbPath);
		legacy.run(
			"CREATE TABLE entries (project TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (project, kind)) WITHOUT ROWID",
		);
		legacy
			.prepare("INSERT INTO entries VALUES (?, ?, ?)")
			.run(project, "welcome", JSON.stringify({ modelName: "Stale", providerName: "stale" }));
		legacy.close();

		const cache = ComposerCache.open(dbPath);
		expect(cache.read(project).welcome).toBeUndefined();
		cache.close();
	});

	it("loads XDG_CACHE_HOME from the home .env before the first cache access", async () => {
		if (process.platform === "win32") return;

		const home = path.join(root, "home");
		const xdgCache = path.join(root, "xdg-cache");
		const project = path.join(root, "project");
		await Promise.all([
			fs.mkdir(home, { recursive: true }),
			fs.mkdir(path.join(xdgCache, "omp"), { recursive: true }),
		]);
		await Bun.write(path.join(home, ".env"), `XDG_CACHE_HOME=${xdgCache}\n`);

		const composerCacheModule = Bun.resolveSync("@oh-my-pi/pi-tui/prompt/composer-cache", import.meta.dir);
		const script = [
			'import * as path from "node:path";',
			`import { ComposerCache } from ${JSON.stringify(composerCacheModule)};`,
			"const cache = ComposerCache.open();",
			`cache.writeWelcome(${JSON.stringify(project)}, { modelName: "model", providerName: "provider" });`,
			"cache.close();",
			`const expected = path.join(${JSON.stringify(xdgCache)}, "omp", "cache", "composer.db");`,
			"process.stdout.write(String(await Bun.file(expected).exists()));",
		].join("\n");
		const proc = Bun.spawn([process.execPath, "--no-env-file", "--no-install", "--eval", script], {
			cwd: root,
			env: {
				...process.env,
				HOME: home,
				XDG_CACHE_HOME: undefined,
				PI_CODING_AGENT_DIR: undefined,
				OMP_PROFILE: undefined,
				PI_PROFILE: undefined,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		expect(exitCode, stderr).toBe(0);
		expect(stdout).toBe("true");
	});
});

describe("composer status handoff", () => {
	it("clears speculative top-border continuation rows when the session status line mounts", () => {
		const terminal = new VirtualTerminal(80, 24);
		const composer = new Composer({
			terminal,
			preferences: { ...COMPOSER_DEFAULTS, composerShape: "band", quiet: true },
			status: statusFor(ThinkingLevel.High),
		});
		composer.start();
		try {
			const frameText = (): string =>
				composer.renderFrame({ columns: terminal.columns, rows: terminal.rows }).viewport.join("\n");
			// Interactive mode installs wrapped status rows below the top chrome; they belong to the
			// status line that is being replaced and must not outlive the handoff.
			composer.editor.setTopBorderContinuationProvider(() => ["STALE-CONTINUATION"]);
			expect(frameText()).toContain("STALE-CONTINUATION");

			composer.setStatusComponent(statusLineFrom(statusFor(ThinkingLevel.Low)));
			expect(frameText()).not.toContain("STALE-CONTINUATION");
		} finally {
			composer.stop();
		}
	});
});
