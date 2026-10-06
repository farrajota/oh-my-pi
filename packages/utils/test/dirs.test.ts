import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as nativePath from "@oh-my-pi/pi-natives/path";
import {
	__resetDirsFromEnvForTests,
	__resetProjectDirCacheForTests,
	directoryIsMissing,
	getAgentDir,
	getConfigRootDir,
	getLogPath,
	getPluginsDir,
	getProfileRootDir,
	getProjectDir,
	localDay,
	relativePathWithinRoot,
	setProjectDir,
} from "@oh-my-pi/pi-utils/dirs";
import { Snowflake } from "@oh-my-pi/pi-utils/snowflake";

const originalProjectDir = fs.realpathSync(process.cwd()).replace(/^\/private(?=\/)/, "");

afterEach(() => {
	vi.restoreAllMocks();
	setProjectDir(originalProjectDir);
});
describe("project directory state", () => {
	it("enters an accessible fallback when process.cwd fails", () => {
		__resetProjectDirCacheForTests();
		const originalPwd = process.env.PWD;
		const cwd = spyOn(process, "cwd").mockImplementation(() => {
			throw new Error("cwd unavailable");
		});
		process.env.PWD = os.tmpdir();
		try {
			getProjectDir();
			cwd.mockRestore();
			expect(fs.realpathSync(process.cwd())).toBe(fs.realpathSync(getProjectDir()));
		} finally {
			cwd.mockRestore();
			if (originalPwd === undefined) delete process.env.PWD;
			else process.env.PWD = originalPwd;
		}
	});

	it.skipIf(process.platform !== "win32")(
		"surfaces a native path-expansion failure instead of relocating the process",
		() => {
			__resetProjectDirCacheForTests();
			const before = process.cwd();
			spyOn(nativePath, "expandWindowsLongPath").mockImplementation(() => {
				throw new Error("stale addon");
			});
			expect(() => getProjectDir()).toThrow("stale addon");
			expect(process.cwd()).toBe(before);
		},
	);

	it("treats denied stat as probeable rather than missing", async () => {
		const stat = spyOn(fs.promises, "stat").mockRejectedValue(
			Object.assign(new Error("operation not permitted"), { code: "EACCES" }),
		);
		try {
			expect(await directoryIsMissing(path.join(os.tmpdir(), "blocked"))).toBe(false);
		} finally {
			stat.mockRestore();
		}
	});

	it("normalizes each containment operand only once", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-dirs-containment-"));
		const candidate = path.join(root, "child");
		fs.mkdirSync(candidate);
		const realpath = spyOn(fs, "realpathSync");
		try {
			expect(relativePathWithinRoot(root, candidate)).toBe("child");
			expect(realpath).toHaveBeenCalledTimes(2);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps the previous directory when chdir fails", () => {
		const chdir = spyOn(process, "chdir").mockImplementation(() => {
			throw new Error("operation not permitted");
		});

		expect(() => setProjectDir("/blocked/project")).toThrow("operation not permitted");
		expect(getProjectDir()).toBe(originalProjectDir);
		chdir.mockRestore();
	});
});

describe("dated log path", () => {
	it("names log files with the local day, matching the rotating sink", () => {
		// Local 2026-05-31 02:30: in UTC+8 the UTC day is still 2026-05-30, so a
		// toISOString()-derived name points at a file the local-day rotating
		// sink (logger/rotating-file.ts) never creates.
		const date = new Date(2026, 4, 31, 2, 30);
		expect(localDay(date)).toBe("2026-05-31");
		expect(path.basename(getLogPath(date, 123))).toBe("omp.2026-05-31.123.log");
	});

	it("keeps the local-day key under a forced non-UTC timezone", () => {
		// On a UTC runner `toISOString()` and the local day agree, so the
		// in-process assertion above cannot catch a revert there. Run the probe
		// in a UTC+8 child process, where the two days differ for this fixture.
		const probe = path.join(import.meta.dir, "fixtures", "local-day-probe.ts");
		const proc = Bun.spawnSync([process.execPath, probe], {
			env: { ...process.env, TZ: "Asia/Shanghai" },
			stdout: "pipe",
			stderr: "pipe",
		});
		if (proc.exitCode === 2) return; // TZ not honored on this platform
		if (proc.exitCode !== 0) console.error(proc.stderr.toString());
		expect(proc.exitCode).toBe(0);
	});
});

describe("absolute PI_CONFIG_DIR", () => {
	const ENV_KEYS = [
		"OMP_PROFILE",
		"PI_PROFILE",
		"PI_CONFIG_DIR",
		"PI_CODING_AGENT_DIR",
		"XDG_DATA_HOME",
		"XDG_STATE_HOME",
		"XDG_CACHE_HOME",
	] as const;
	let originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
	let configDir = "";

	function useAbsoluteConfigDir(agentDirOverride?: string): void {
		originalEnv = {};
		for (const key of ENV_KEYS) {
			originalEnv[key] = process.env[key];
			delete process.env[key];
		}
		configDir = path.join(os.tmpdir(), "pi-utils-abs-config", Snowflake.next(), ".omp-amgr");
		process.env.PI_CONFIG_DIR = configDir;
		if (agentDirOverride) process.env.PI_CODING_AGENT_DIR = agentDirOverride;
		__resetDirsFromEnvForTests();
	}

	afterEach(() => {
		for (const key of ENV_KEYS) {
			const value = originalEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		__resetDirsFromEnvForTests();
	});

	it("uses the absolute path as the config root instead of nesting it under home", () => {
		useAbsoluteConfigDir();
		expect(getConfigRootDir()).toBe(configDir);
		expect(getAgentDir()).toBe(path.join(configDir, "agent"));
		expect(getProfileRootDir("work")).toBe(path.join(configDir, "profiles", "work"));
		expect(getPluginsDir(path.join(os.tmpdir(), "some-other-home"))).toBe(path.join(configDir, "plugins"));
	});

	it("lets PI_CODING_AGENT_DIR override the agent dir under an absolute config root", () => {
		const agentOverride = path.join(os.tmpdir(), "pi-utils-abs-config", Snowflake.next(), "custom-agent");
		useAbsoluteConfigDir(agentOverride);
		expect(getConfigRootDir()).toBe(configDir);
		expect(getAgentDir()).toBe(agentOverride);
	});
});
