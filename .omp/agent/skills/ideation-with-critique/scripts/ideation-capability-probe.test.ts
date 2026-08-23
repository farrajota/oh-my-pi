import { describe, expect, test } from "bun:test";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { spawnSync } from "node:child_process";
import puppeteer from "puppeteer-core";
import * as mupdf from "mupdf";

function localCommand(command: string, args: readonly string[]) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 10_000 });
  return Object.freeze({ status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message ?? null });
}

describe("authoring capability prerequisites", () => {
  test("identifies the Linux, Bun, flock, and workspace filesystem prerequisites without writes", async () => {
    expect(platform()).toBe("linux");
    expect(release()).not.toBe("");
    expect(arch()).not.toBe("");
    expect(Bun.version).toMatch(/^\d+\.\d+\.\d+/);
    await expect(access("/usr/bin/flock", constants.X_OK)).resolves.toBeNull();
    expect(localCommand("/usr/bin/flock", ["--version"]).status).toBe(0);
    expect((await stat("/workspace")).isDirectory()).toBe(true);
  });

  test("exposes a local Chromium executable and no-network browser prerequisites", () => {
    const chromium = ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].find((path) => localCommand(path, ["--version"]).status === 0);
    expect(chromium).toBeDefined();
    const version = localCommand(chromium!, ["--version"]);
    expect(version.stdout + version.stderr).toMatch(/Chrom|Chrome/i);
  });

  test("imports browser and PDF dependencies through package exports", () => {
    expect(typeof puppeteer.launch).toBe("function");
    expect(typeof mupdf.Document.openDocument).toBe("function");
  });
});
