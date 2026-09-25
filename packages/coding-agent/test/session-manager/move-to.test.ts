import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { resolveResumableSession } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { stripOuterDoubleQuotes } from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import { getConfigRootDir, setAgentDir } from "@oh-my-pi/pi-utils";

// -- helpers ----------------------------------------------------------------

import { makeAssistantMessage } from "./helpers";

function getHeader(entries: unknown[]): SessionHeader | undefined {
	return entries.find(
		(e): e is SessionHeader => typeof e === "object" && e !== null && "type" in e && (e as any).type === "session",
	) as SessionHeader | undefined;
}

function hasAssistantEntry(entries: unknown[]): boolean {
	return entries.some(
		e =>
			typeof e === "object" &&
			e !== null &&
			"type" in e &&
			(e as any).type === "message" &&
			"message" in e &&
			(e as any).message?.role === "assistant",
	);
}

// -- stripOuterDoubleQuotes tests -------------------------------------------

describe("stripOuterDoubleQuotes", () => {
	it("strips matching double quotes", () => {
		expect(stripOuterDoubleQuotes('"C:\\Users\\test"')).toBe("C:\\Users\\test");
	});
	it("strips matching double quotes from POSIX paths", () => {
		expect(stripOuterDoubleQuotes('"/home/user/test"')).toBe("/home/user/test");
	});
	it("passes through unquoted paths", () => {
		expect(stripOuterDoubleQuotes("C:\\Users\\test")).toBe("C:\\Users\\test");
	});
	it("does not strip mismatched quotes", () => {
		expect(stripOuterDoubleQuotes('"mismatched')).toBe('"mismatched');
	});
	it("does not strip single quotes", () => {
		expect(stripOuterDoubleQuotes("'foo'")).toBe("'foo'");
	});
	it("does not strip a lone double quote", () => {
		expect(stripOuterDoubleQuotes('"')).toBe('"');
	});
	it("strips empty quoted string to empty", () => {
		expect(stripOuterDoubleQuotes('""')).toBe("");
	});
});

// -- moveTo() tests ---------------------------------------------------------

describe("SessionManager.moveTo", () => {
	let testAgentDir: string;
	let cwdA: string;
	let cwdB: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

	beforeEach(async () => {
		testAgentDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-move-test-"));
		setAgentDir(testAgentDir);
		cwdA = path.join(testAgentDir, "cwd-a");
		cwdB = path.join(testAgentDir, "cwd-b");
		fs.mkdirSync(cwdA, { recursive: true });
		fs.mkdirSync(cwdB, { recursive: true });
	});

	afterEach(async () => {
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await fsp.rm(testAgentDir, { recursive: true, force: true });
	});

	it("moves session file and updates header cwd (baseline)", async () => {
		const session = SessionManager.create(cwdA);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();

		const oldFile = session.getSessionFile()!;
		expect(fs.existsSync(oldFile)).toBe(true);

		await session.moveTo(cwdB);

		expect(session.getCwd()).toBe(path.resolve(cwdB));
		expect(fs.existsSync(oldFile)).toBe(false);

		const newFile = session.getSessionFile()!;
		expect(fs.existsSync(newFile)).toBe(true);

		// Reload and verify content
		const entries = await loadEntriesFromFile(newFile);
		const header = getHeader(entries);
		expect(header?.cwd).toBe(path.resolve(cwdB));
		expect(header?.previousSessionFiles).toEqual([path.resolve(oldFile)]);
		expect(hasAssistantEntry(entries)).toBe(true);
	});
	async function pauseAfterPublication(acrossDevices: boolean, failArtifacts = false) {
		const session = SessionManager.create(cwdA, path.join(testAgentDir, "custom"));
		await session.ensureOnDisk();
		const source = session.getSessionFile()!;
		const artifacts = source.slice(0, -6);
		await fsp.mkdir(artifacts);
		const destinationDir = path.join(testAgentDir, "destination");
		const destination = path.join(destinationDir, path.basename(source));
		const stopped = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const link = fs.linkSync.bind(fs);
		const rename = fs.promises.rename.bind(fs.promises);
		const linkSpy = acrossDevices
			? spyOn(fs, "linkSync").mockImplementation((from, to) => {
					if (from.toString() === source) throw Object.assign(new Error("cross-device move"), { code: "EXDEV" });
					return link(from, to);
				})
			: undefined;
		const renameSpy = spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
			if (from.toString() !== artifacts) return rename(from, to);
			if (!failArtifacts) await rename(from, to);
			stopped.resolve();
			await resume.promise;
			if (failArtifacts) throw Object.assign(new Error("artifact move denied"), { code: "EACCES" });
		});
		const move = session.moveTo(cwdB, destinationDir);
		await stopped.promise;
		return {
			session,
			source,
			destination,
			move,
			resume: () => resume.resolve(),
			restore: () => {
				renameSpy.mockRestore();
				linkSpy?.mockRestore();
			},
		};
	}

	for (const [acrossDevices, mode] of [
		[false, "native"],
		[true, "EXDEV"],
	] as const) {
		it(`keeps post-publication appends off a reoccupied ${mode} source`, async () => {
			const paused = await pauseAfterPublication(acrossDevices);
			const unrelated = "x".repeat(fs.statSync(paused.destination).size);
			try {
				await fsp.writeFile(paused.source, unrelated);
				paused.session.appendMessage({ role: "user", content: "after source reoccupation", timestamp: 2 });
				paused.session.appendMessage({ role: "user", content: "after own rewrite", timestamp: 3 });
				expect(fs.readFileSync(paused.destination, "utf8")).toContain("after own rewrite");
				expect(await fsp.readFile(paused.source, "utf8")).toBe(unrelated);
				paused.resume();
				await paused.move;
			} finally {
				paused.resume();
				await paused.move.catch(() => {});
				paused.restore();
			}
			expect(await fsp.readFile(paused.source, "utf8")).toBe(unrelated);
			expect(await fsp.readFile(paused.destination, "utf8")).toContain("after own rewrite");
		});

		for (const replaceDestination of [false, true]) {
			it(`preserves a source replaced after ${mode} publication with ${replaceDestination ? "an unrelated" : "its own"} destination`, async () => {
				const session = SessionManager.create(cwdA, path.join(testAgentDir, "custom"));
				await session.ensureOnDisk();
				const source = session.getSessionFile()!;
				const original = await fsp.readFile(source);
				const savedSource = path.join(testAgentDir, "original-source.jsonl");
				const replacementSource = path.join(testAgentDir, "replacement-source.jsonl");
				const unrelatedSource = Buffer.alloc(original.length, 0x78);
				await fsp.writeFile(replacementSource, unrelatedSource);
				const sourceIdentity = fs.lstatSync(replacementSource);
				const destinationDir = path.join(testAgentDir, "destination");
				const destination = path.join(destinationDir, path.basename(source));
				const replacementDestination = path.join(testAgentDir, "replacement-destination.jsonl");
				const unrelatedDestination = Buffer.alloc(original.length, 0x79);
				await fsp.writeFile(replacementDestination, unrelatedDestination);
				const destinationIdentity = fs.lstatSync(replacementDestination);
				const link = fs.linkSync.bind(fs);
				const publicationSpy = spyOn(fs, "linkSync").mockImplementation((from, to) => {
					if (acrossDevices && from.toString() === source) {
						throw Object.assign(new Error("cross-device move"), { code: "EXDEV" });
					}
					link(from, to);
					if (to.toString() === destination) {
						fs.renameSync(source, savedSource);
						fs.renameSync(replacementSource, source);
						if (replaceDestination) {
							fs.unlinkSync(destination);
							fs.renameSync(replacementDestination, destination);
						}
					}
				});
				try {
					await expect(session.moveTo(cwdB, destinationDir)).rejects.toThrow("source identity changed");
				} finally {
					publicationSpy.mockRestore();
				}
				expect(session.getSessionFile()).toBe(source);
				expect(session.getCwd()).toBe(cwdA);
				expect(await fsp.readFile(source)).toEqual(unrelatedSource);
				expect(fs.lstatSync(source).dev).toBe(sourceIdentity.dev);
				expect(fs.lstatSync(source).ino).toBe(sourceIdentity.ino);
				expect(await fsp.readFile(savedSource)).toEqual(original);
				if (replaceDestination) {
					expect(await fsp.readFile(destination)).toEqual(unrelatedDestination);
					expect(fs.lstatSync(destination).dev).toBe(destinationIdentity.dev);
					expect(fs.lstatSync(destination).ino).toBe(destinationIdentity.ino);
				}
				expect(await fsp.readdir(destinationDir)).toEqual(replaceDestination ? [path.basename(source)] : []);
				await session.close();
			});
		}

		for (const failArtifacts of [false, true]) {
			it(`rejects a replaced ${mode} destination during ${failArtifacts ? "rollback" : "append"}`, async () => {
				const paused = await pauseAfterPublication(acrossDevices, failArtifacts);
				const unrelated = "x".repeat(fs.statSync(paused.destination).size);
				let replacementIdentity: { dev: number; ino: number };
				try {
					await fsp.rename(paused.destination, path.join(testAgentDir, "published-original.jsonl"));
					await fsp.writeFile(paused.destination, unrelated);
					const replacement = fs.statSync(paused.destination);
					replacementIdentity = { dev: replacement.dev, ino: replacement.ino };
					paused.session.appendMessage({ role: "user", content: "must not reach replacement", timestamp: 2 });
					expect(await fsp.readFile(paused.destination, "utf8")).toBe(unrelated);
					paused.resume();
					await expect(paused.move).rejects.toThrow("identity changed");
				} finally {
					paused.resume();
					await paused.move.catch(() => {});
					paused.restore();
				}
				expect(await fsp.readFile(paused.destination, "utf8")).toBe(unrelated);
				const current = fs.statSync(paused.destination);
				expect({ dev: current.dev, ino: current.ino }).toEqual(replacementIdentity!);
				expect(fs.existsSync(paused.source)).toBe(false);
			});
		}
	}

	it("retains both files when native publication finds an unrelated same-sized destination", async () => {
		const session = SessionManager.create(cwdA, path.join(testAgentDir, "custom"));
		session.appendMessage({ role: "user", content: "before move", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		const source = session.getSessionFile()!;
		const original = await fsp.readFile(source, "utf8");
		const destinationDir = path.join(testAgentDir, "occupied");
		await fsp.mkdir(destinationDir);
		const destination = path.join(destinationDir, path.basename(source));
		const unrelated = "x".repeat(Buffer.byteLength(original, "utf8"));
		await fsp.writeFile(destination, unrelated);
		const sourceIdentity = fs.statSync(source);
		const destinationIdentity = fs.statSync(destination);
		expect(sourceIdentity.dev).toBe(destinationIdentity.dev);
		expect(sourceIdentity.size).toBe(destinationIdentity.size);

		await expect(session.moveTo(cwdB, destinationDir)).rejects.toMatchObject({ code: "EEXIST" });

		expect(session.getSessionFile()).toBe(source);
		expect(session.getCwd()).toBe(cwdA);
		expect(await fsp.readFile(source, "utf8")).toBe(original);
		expect(await fsp.readFile(destination, "utf8")).toBe(unrelated);
		expect(fs.statSync(source).ino).toBe(sourceIdentity.ino);
		expect(fs.statSync(destination).ino).toBe(destinationIdentity.ino);
		expect(await fsp.readdir(destinationDir)).toEqual([path.basename(source)]);
		await session.close();
	});

	it("removes its native publication when source cleanup fails", async () => {
		const session = SessionManager.create(cwdA, path.join(testAgentDir, "custom"));
		await session.ensureOnDisk();
		const source = session.getSessionFile()!;
		const original = await fsp.readFile(source, "utf8");
		const destinationDir = path.join(testAgentDir, "destination");
		const unlink = fs.unlinkSync.bind(fs);
		const unlinkSpy = spyOn(fs, "unlinkSync").mockImplementation(file => {
			if (file.toString() === source) throw Object.assign(new Error("source removal denied"), { code: "EACCES" });
			return unlink(file);
		});
		try {
			await expect(session.moveTo(cwdB, destinationDir)).rejects.toThrow("source removal denied");
		} finally {
			unlinkSpy.mockRestore();
		}
		expect(session.getSessionFile()).toBe(source);
		expect(await fsp.readFile(source, "utf8")).toBe(original);
		expect(await fsp.readdir(destinationDir)).toEqual([]);
		await session.close();
	});

	it("preserves an unrelated replacement when native source cleanup fails", async () => {
		const session = SessionManager.create(cwdA, path.join(testAgentDir, "custom"));
		await session.ensureOnDisk();
		const source = session.getSessionFile()!;
		const original = await fsp.readFile(source, "utf8");
		const destinationDir = path.join(testAgentDir, "destination");
		const destination = path.join(destinationDir, path.basename(source));
		const unrelated = "x".repeat(Buffer.byteLength(original, "utf8"));
		const unlink = fs.unlinkSync.bind(fs);
		const unlinkSpy = spyOn(fs, "unlinkSync").mockImplementation(file => {
			if (file.toString() === source) {
				unlink(destination);
				fs.writeFileSync(destination, unrelated);
				throw Object.assign(new Error("source removal denied"), { code: "EACCES" });
			}
			return unlink(file);
		});
		try {
			await expect(session.moveTo(cwdB, destinationDir)).rejects.toThrow("source removal denied");
		} finally {
			unlinkSpy.mockRestore();
		}
		expect(session.getSessionFile()).toBe(source);
		expect(await fsp.readFile(source, "utf8")).toBe(original);
		expect(await fsp.readFile(destination, "utf8")).toBe(unrelated);
		await session.close();
	});

	it("releases the native source before a queued append can run after publication", async () => {
		const session = SessionManager.create(cwdA, path.join(testAgentDir, "custom"));
		await session.ensureOnDisk();
		const source = session.getSessionFile()!;
		const link = fs.linkSync.bind(fs);
		let sourceAbsentAtAppend = false;
		const publicationSpy = spyOn(fs, "linkSync").mockImplementation((from, to) => {
			link(from, to);
			if (from.toString() === source) {
				queueMicrotask(() => {
					sourceAbsentAtAppend = !fs.existsSync(source);
					session.appendMessage({ role: "user", content: "queued after publication", timestamp: 2 });
				});
			}
		});
		try {
			await session.moveTo(cwdB);
		} finally {
			publicationSpy.mockRestore();
		}
		expect(sourceAbsentAtAppend).toBe(true);
		expect(fs.existsSync(source)).toBe(false);
		const entries = await loadEntriesFromFile(session.getSessionFile()!);
		expect(
			entries.some(
				entry =>
					entry.type === "message" &&
					entry.message.role === "user" &&
					entry.message.content === "queued after publication",
			),
		).toBe(true);
		await session.close();
	});

	it("moves a custom session and artifacts across devices", async () => {
		const session = SessionManager.create(cwdA, path.join(testAgentDir, "custom"));
		await session.ensureOnDisk();
		const oldFile = session.getSessionFile()!;
		const oldArtifacts = oldFile.slice(0, -6);
		await fsp.mkdir(path.join(oldArtifacts, "child"), { recursive: true });
		await Bun.write(path.join(oldArtifacts, "1.bash.log"), "saved output");
		await Bun.write(path.join(oldArtifacts, "child", "2.bash.log"), "nested output");
		const rename = fs.promises.rename.bind(fs.promises);
		const link = fs.promises.link.bind(fs.promises);
		const linkSync = fs.linkSync.bind(fs);
		const publicationSpy = spyOn(fs, "linkSync").mockImplementation((from, to) => {
			if (from.toString() === oldFile) throw Object.assign(new Error("cross-device move"), { code: "EXDEV" });
			return linkSync(from, to);
		});
		const renameSpy = spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
			if (from.toString().startsWith(oldArtifacts)) {
				throw Object.assign(new Error("cross-device move"), { code: "EXDEV" });
			}
			return rename(from, to);
		});
		const linkSpy = spyOn(fs.promises, "link").mockImplementation(async (from, to) => {
			if (from.toString().startsWith(oldArtifacts)) {
				throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
			}
			return link(from, to);
		});
		try {
			await session.moveTo(cwdB);
		} finally {
			renameSpy.mockRestore();
			linkSpy.mockRestore();
			publicationSpy.mockRestore();
		}
		const newFile = session.getSessionFile()!;
		expect(fs.existsSync(oldFile)).toBe(false);
		expect(fs.existsSync(oldArtifacts)).toBe(false);
		expect(getHeader(await loadEntriesFromFile(newFile))?.cwd).toBe(cwdB);
		expect(await Bun.file(path.join(newFile.slice(0, -6), "1.bash.log")).text()).toBe("saved output");
		expect(await Bun.file(path.join(newFile.slice(0, -6), "child", "2.bash.log")).text()).toBe("nested output");
		await session.close();
	});

	it("retains the source when cross-device publication finds an occupied destination", async () => {
		const session = SessionManager.create(cwdA, path.join(testAgentDir, "custom"));
		await session.ensureOnDisk();
		const oldFile = session.getSessionFile()!;
		const destinationDir = path.join(testAgentDir, "occupied");
		await fsp.mkdir(destinationDir);
		const destination = path.join(destinationDir, path.basename(oldFile));
		await Bun.write(destination, "another session");
		const link = fs.linkSync.bind(fs);
		const publicationSpy = spyOn(fs, "linkSync").mockImplementation((from, to) => {
			if (from.toString() === oldFile) throw Object.assign(new Error("cross-device move"), { code: "EXDEV" });
			return link(from, to);
		});
		try {
			await expect(session.moveTo(cwdB, destinationDir)).rejects.toThrow();
		} finally {
			publicationSpy.mockRestore();
		}
		expect(session.getSessionFile()).toBe(oldFile);
		expect(getHeader(await loadEntriesFromFile(oldFile))?.cwd).toBe(cwdA);
		expect(await Bun.file(destination).text()).toBe("another session");
		expect(await fsp.readdir(destinationDir)).toEqual([path.basename(oldFile)]);
		await session.close();
	});

	it("does not overwrite an occupied destination during publication with a completed append", async () => {
		const session = SessionManager.create(cwdA, path.join(testAgentDir, "custom"));
		session.appendMessage({ role: "user", content: "before move", timestamp: 1 });
		await session.flush();
		await session.ensureOnDisk();
		const source = session.getSessionFile()!;
		const destinationDir = path.join(testAgentDir, "occupied");
		await fsp.mkdir(destinationDir);
		const destination = path.join(destinationDir, path.basename(source));
		const unrelated = "x".repeat(fs.statSync(source).size);
		await fsp.writeFile(destination, unrelated);

		const link = fs.linkSync.bind(fs);
		const publicationSpy = spyOn(fs, "linkSync").mockImplementation((from, to) => {
			if (from.toString() === source && to.toString() === destination) {
				session.appendMessage({ role: "user", content: "during failed move", timestamp: 2 });
			}
			return link(from, to);
		});
		try {
			await expect(session.moveTo(cwdB, destinationDir)).rejects.toMatchObject({ code: "EEXIST" });
		} finally {
			publicationSpy.mockRestore();
		}

		expect(session.getSessionFile()).toBe(source);
		expect(await fsp.readFile(destination, "utf8")).toBe(unrelated);
		const entries = await loadEntriesFromFile(source);
		expect(
			entries.some(
				entry =>
					entry.type === "message" &&
					entry.message.role === "user" &&
					entry.message.content === "during failed move",
			),
		).toBe(true);
		await session.close();
	});

	it("does not write to an occupied destination after the source disappears before publication", async () => {
		const session = SessionManager.create(cwdA, path.join(testAgentDir, "custom"));
		session.appendMessage({ role: "user", content: "before move", timestamp: 1 });
		await session.flush();
		await session.ensureOnDisk();
		const source = session.getSessionFile()!;
		const destinationDir = path.join(testAgentDir, "occupied");
		await fsp.mkdir(destinationDir);
		const destination = path.join(destinationDir, path.basename(source));
		const unrelated = "x".repeat(fs.statSync(source).size);
		await fsp.writeFile(destination, unrelated);
		const link = fs.linkSync.bind(fs);
		const publicationSpy = spyOn(fs, "linkSync").mockImplementation((from, to) => {
			if (from.toString() === source && to.toString() === destination) {
				fs.unlinkSync(source);
				session.appendMessage({ role: "user", content: "must not reach destination", timestamp: 2 });
				expect(fs.existsSync(source)).toBe(false);
				expect(fs.readFileSync(destination, "utf8")).toBe(unrelated);
			}
			return link(from, to);
		});
		try {
			await expect(session.moveTo(cwdB, destinationDir)).rejects.toMatchObject({ code: "ENOENT" });
			expect(fs.existsSync(source)).toBe(false);
		} finally {
			publicationSpy.mockRestore();
		}
		expect(await fsp.readFile(destination, "utf8")).toBe(unrelated);
	});

	for (const replaceDuringCopy of [false, true]) {
		it(`rejects a stable same-sized source replacement ${replaceDuringCopy ? "during" : "before"} EXDEV staged copying`, async () => {
			const session = SessionManager.create(cwdA, path.join(testAgentDir, "custom"));
			await session.ensureOnDisk();
			const source = session.getSessionFile()!;
			const original = await fsp.readFile(source);
			const savedSource = path.join(testAgentDir, "original-source.jsonl");
			const replacementSource = path.join(testAgentDir, "replacement-source.jsonl");
			const unrelated = Buffer.alloc(original.length, 0x78);
			await fsp.writeFile(replacementSource, unrelated);
			const replacementIdentity = fs.lstatSync(replacementSource);
			const destinationDir = path.join(testAgentDir, "destination");
			const link = fs.linkSync.bind(fs);
			const copyFile = fs.promises.copyFile.bind(fs.promises);
			const publicationSpy = spyOn(fs, "linkSync").mockImplementation((from, to) => {
				if (from.toString() === source) {
					if (!replaceDuringCopy) {
						fs.renameSync(source, savedSource);
						fs.renameSync(replacementSource, source);
					}
					throw Object.assign(new Error("cross-device move"), { code: "EXDEV" });
				}
				return link(from, to);
			});
			let replaced = false;
			const copySpy = spyOn(fs.promises, "copyFile").mockImplementation(async (from, to, flags) => {
				await copyFile(from, to, flags);
				if (replaceDuringCopy && from.toString() === source && !replaced) {
					replaced = true;
					fs.renameSync(source, savedSource);
					fs.renameSync(replacementSource, source);
				}
			});
			try {
				await expect(session.moveTo(cwdB, destinationDir)).rejects.toThrow("source identity changed");
			} finally {
				publicationSpy.mockRestore();
				copySpy.mockRestore();
			}
			expect(session.getSessionFile()).toBe(source);
			expect(session.getCwd()).toBe(cwdA);
			expect(await fsp.readFile(source)).toEqual(unrelated);
			expect(fs.lstatSync(source).dev).toBe(replacementIdentity.dev);
			expect(fs.lstatSync(source).ino).toBe(replacementIdentity.ino);
			expect(await fsp.readFile(savedSource)).toEqual(original);
			expect(await fsp.readdir(destinationDir)).toEqual([]);
			await session.close();
		});
	}

	it("includes completed appends made while a cross-device copy is staged", async () => {
		const session = SessionManager.create(cwdA, path.join(testAgentDir, "custom"));
		await session.ensureOnDisk();
		const oldFile = session.getSessionFile()!;
		const link = fs.linkSync.bind(fs);
		const copyFile = fs.promises.copyFile.bind(fs.promises);
		let appended = false;
		const publicationSpy = spyOn(fs, "linkSync").mockImplementation((from, to) => {
			if (from.toString() === oldFile) throw Object.assign(new Error("cross-device move"), { code: "EXDEV" });
			return link(from, to);
		});
		const copySpy = spyOn(fs.promises, "copyFile").mockImplementation(async (from, to, flags) => {
			await copyFile(from, to, flags);
			if (from.toString() === oldFile && !appended) {
				appended = true;
				session.appendMessage({ role: "user", content: "during staged copy", timestamp: 2 });
			}
		});
		try {
			await session.moveTo(cwdB);
		} finally {
			publicationSpy.mockRestore();
			copySpy.mockRestore();
		}
		const entries = await loadEntriesFromFile(session.getSessionFile()!);
		expect(
			entries.some(
				entry =>
					entry.type === "message" &&
					entry.message.role === "user" &&
					entry.message.content === "during staged copy",
			),
		).toBe(true);
		expect(fs.existsSync(oldFile)).toBe(false);
		await session.close();
	});

	it("persists an EXDEV append queued after staged publication before cleanup completes", async () => {
		const session = SessionManager.create(cwdA, path.join(testAgentDir, "custom"));
		await session.ensureOnDisk();
		const source = session.getSessionFile()!;
		const link = fs.linkSync.bind(fs);
		let queued = false;
		let sourceAbsentAtAppend = false;
		const publicationSpy = spyOn(fs, "linkSync").mockImplementation((from, to) => {
			if (from.toString() === source) throw Object.assign(new Error("cross-device move"), { code: "EXDEV" });
			link(from, to);
			if (from.toString().endsWith(".move")) {
				queueMicrotask(() => {
					queued = true;
					sourceAbsentAtAppend = !fs.existsSync(source);
					session.appendMessage({ role: "user", content: "after staged publication", timestamp: 2 });
				});
			}
		});
		try {
			await session.moveTo(cwdB);
			await session.flush();
		} finally {
			publicationSpy.mockRestore();
		}
		expect(queued).toBe(true);
		expect(sourceAbsentAtAppend).toBe(true);
		expect(fs.existsSync(source)).toBe(false);
		const entries = await loadEntriesFromFile(session.getSessionFile()!);
		expect(
			entries.some(
				entry =>
					entry.type === "message" &&
					entry.message.role === "user" &&
					entry.message.content === "after staged publication",
			),
		).toBe(true);
		await session.close();
	});

	it("rolls a cross-device session back when its artifacts cannot be relocated", async () => {
		const session = SessionManager.create(cwdA, path.join(testAgentDir, "custom"));
		await session.ensureOnDisk();
		const oldFile = session.getSessionFile()!;
		const oldArtifacts = oldFile.slice(0, -6);
		await fsp.mkdir(oldArtifacts);
		await Bun.write(path.join(oldArtifacts, "1.bash.log"), "saved output");
		const destinationDir = path.join(testAgentDir, "destination");
		const destinationFile = path.join(destinationDir, path.basename(oldFile));
		const rename = fs.promises.rename.bind(fs.promises);
		const link = fs.linkSync.bind(fs);
		const publicationSpy = spyOn(fs, "linkSync").mockImplementation((from, to) => {
			if (from.toString() === oldFile || from.toString() === destinationFile) {
				throw Object.assign(new Error("cross-device move"), { code: "EXDEV" });
			}
			return link(from, to);
		});
		const renameSpy = spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
			if (from.toString() === oldArtifacts) {
				throw Object.assign(new Error("artifact move denied"), { code: "EACCES" });
			}
			return rename(from, to);
		});
		try {
			await expect(session.moveTo(cwdB, destinationDir)).rejects.toThrow("artifact move denied");
		} finally {
			renameSpy.mockRestore();
			publicationSpy.mockRestore();
		}
		expect(session.getSessionFile()).toBe(oldFile);
		expect(getHeader(await loadEntriesFromFile(oldFile))?.cwd).toBe(cwdA);
		expect(await Bun.file(path.join(oldArtifacts, "1.bash.log")).text()).toBe("saved output");
		expect(await fsp.readdir(destinationDir)).toEqual([]);
		await session.close();
	});

	it("retains the source when cross-device source cleanup fails", async () => {
		const session = SessionManager.create(cwdA, path.join(testAgentDir, "custom"));
		await session.ensureOnDisk();
		const oldFile = session.getSessionFile()!;
		const destinationDir = path.join(testAgentDir, "destination");
		const link = fs.linkSync.bind(fs);
		const unlink = fs.unlinkSync.bind(fs);
		const publicationSpy = spyOn(fs, "linkSync").mockImplementation((from, to) => {
			if (from.toString() === oldFile) throw Object.assign(new Error("cross-device move"), { code: "EXDEV" });
			return link(from, to);
		});
		const unlinkSpy = spyOn(fs, "unlinkSync").mockImplementation(file => {
			if (file.toString() === oldFile) throw Object.assign(new Error("source removal denied"), { code: "EACCES" });
			return unlink(file);
		});
		try {
			await expect(session.moveTo(cwdB, destinationDir)).rejects.toThrow("source removal denied");
		} finally {
			publicationSpy.mockRestore();
			unlinkSpy.mockRestore();
		}
		expect(session.getSessionFile()).toBe(oldFile);
		expect(getHeader(await loadEntriesFromFile(oldFile))?.cwd).toBe(cwdA);
		expect(await fsp.readdir(destinationDir)).toEqual([]);
		await session.close();
	});

	it("preserves an unrelated replacement when EXDEV source cleanup fails", async () => {
		const session = SessionManager.create(cwdA, path.join(testAgentDir, "custom"));
		await session.ensureOnDisk();
		const source = session.getSessionFile()!;
		const original = await fsp.readFile(source);
		const sourceIdentity = fs.statSync(source);
		const destinationDir = path.join(testAgentDir, "destination");
		const destination = path.join(destinationDir, path.basename(source));
		const unrelated = Buffer.alloc(original.length, 0x78);
		let replacementIdentity: { dev: number; ino: number } | undefined;
		const link = fs.linkSync.bind(fs);
		const unlink = fs.unlinkSync.bind(fs);
		const publicationSpy = spyOn(fs, "linkSync").mockImplementation((from, to) => {
			if (from.toString() === source) throw Object.assign(new Error("cross-device move"), { code: "EXDEV" });
			return link(from, to);
		});
		const unlinkSpy = spyOn(fs, "unlinkSync").mockImplementation(file => {
			if (file.toString() === source) {
				unlink(destination);
				fs.writeFileSync(destination, unrelated);
				const replacement = fs.statSync(destination);
				replacementIdentity = { dev: replacement.dev, ino: replacement.ino };
				throw Object.assign(new Error("source removal denied"), { code: "EACCES" });
			}
			return unlink(file);
		});
		try {
			await expect(session.moveTo(cwdB, destinationDir)).rejects.toThrow("source removal denied");
		} finally {
			publicationSpy.mockRestore();
			unlinkSpy.mockRestore();
		}
		expect(session.getSessionFile()).toBe(source);
		expect(await fsp.readFile(source)).toEqual(original);
		expect(fs.statSync(source).dev).toBe(sourceIdentity.dev);
		expect(fs.statSync(source).ino).toBe(sourceIdentity.ino);
		expect(await fsp.readFile(destination)).toEqual(unrelated);
		if (!replacementIdentity) throw new Error("Expected replacement identity");
		const destinationStat = fs.statSync(destination);
		expect({ dev: destinationStat.dev, ino: destinationStat.ino }).toEqual(replacementIdentity);
		await session.close();
	});

	it("persists the captured header and workspace roots after a rollback relocation", async () => {
		const session = SessionManager.create(cwdA);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.addWorkspaceDirectory(cwdB);
		await session.flush();
		const originalFile = session.getSessionFile()!;
		const snapshot = session.captureState();

		// Move to a target that is also an additional workspace root: moveTo
		// filters it from #additionalDirectories in the rewritten header.
		await session.moveTo(cwdB);
		await session.rollbackMove(snapshot);

		// Reopen the restored source file: disk must carry the captured header,
		// including the workspace root the forward move filtered out.
		const entries = await loadEntriesFromFile(originalFile);
		const header = getHeader(entries);
		expect(header?.cwd).toBe(path.resolve(cwdA));
		expect(header?.additionalDirectories ?? []).toContain(path.resolve(cwdB));
		expect(session.getCwd()).toBe(path.resolve(cwdA));
	});
	it("relocates a fallback session whose bucket matches the runtime cwd", async () => {
		const deniedDir = path.join(testAgentDir, "denied-project");
		const deniedFile = path.join(deniedDir, "session.jsonl");
		await fsp.mkdir(deniedDir);
		await Bun.write(
			deniedFile,
			`${JSON.stringify({
				type: "session",
				id: "019e84ed-b4cc-7000-9c87-5afe6df992c1",
				cwd: deniedDir,
				timestamp: new Date(0).toISOString(),
			})}\n`,
		);
		const realAccess = fs.promises.access.bind(fs.promises);
		const access = spyOn(fs.promises, "access").mockImplementation(async (target, mode) => {
			if (path.resolve(String(target)) === path.resolve(deniedDir)) {
				throw Object.assign(new Error("permission denied"), { code: "EACCES" });
			}
			return realAccess(target, mode);
		});
		try {
			const session = await SessionManager.open(deniedFile, undefined, undefined, { initialCwd: cwdA });
			try {
				const snapshot = session.captureState();
				await session.moveTo(cwdA);
				const movedFile = session.getSessionFile()!;
				expect(movedFile).not.toBe(deniedFile);

				await session.rollbackMove(snapshot);

				expect(fs.existsSync(deniedFile)).toBe(true);
				expect(fs.existsSync(movedFile)).toBe(false);
				expect(session.getSessionFile()).toBe(deniedFile);
			} finally {
				await session.close();
			}
		} finally {
			access.mockRestore();
		}
	});

	it("succeeds on fresh session without ENOENT, then deferred persistence works", async () => {
		const session = SessionManager.create(cwdA);
		// No messages — file never written to disk
		const oldFile = session.getSessionFile()!;
		expect(fs.existsSync(oldFile)).toBe(false);

		await session.moveTo(cwdB);

		expect(session.getCwd()).toBe(path.resolve(cwdB));
		const newFile = session.getSessionFile()!;
		// Lazy-persist preserved: no header-only .jsonl created
		expect(fs.existsSync(newFile)).toBe(false);

		// Verify deferred persistence at the new path
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();

		expect(fs.existsSync(newFile)).toBe(true);
		const entries = await loadEntriesFromFile(newFile);
		const header = getHeader(entries);
		expect(header?.cwd).toBe(path.resolve(cwdB));
		expect(header?.previousSessionFiles).toBeUndefined();
	});

	it("recreates file from memory when old file is deleted (assistant exists)", async () => {
		const session = SessionManager.create(cwdA);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		await session.close();

		const oldFile = session.getSessionFile()!;
		// Delete the file to simulate unexpected removal
		await fsp.unlink(oldFile);
		expect(fs.existsSync(oldFile)).toBe(false);

		await session.moveTo(cwdB);

		expect(session.getCwd()).toBe(path.resolve(cwdB));
		const newFile = session.getSessionFile()!;
		expect(fs.existsSync(newFile)).toBe(true);

		// Verify content recreated from memory
		const entries = await loadEntriesFromFile(newFile);
		const header = getHeader(entries);
		expect(header?.cwd).toBe(path.resolve(cwdB));
		expect(hasAssistantEntry(entries)).toBe(true);
	});

	it("moves header-only session and rewrites cwd", async () => {
		// Create a header-only session via open() with a non-existent explicit path
		const explicitPath = path.join(cwdA, "explicit-session.jsonl");
		const session = await SessionManager.open(explicitPath);

		expect(fs.existsSync(explicitPath)).toBe(true);

		await session.moveTo(cwdB);

		expect(session.getCwd()).toBe(path.resolve(cwdB));
		expect(fs.existsSync(explicitPath)).toBe(false);

		const newFile = session.getSessionFile()!;
		expect(fs.existsSync(newFile)).toBe(true);

		const entries = await loadEntriesFromFile(newFile);
		const header = getHeader(entries);
		expect(header?.cwd).toBe(path.resolve(cwdB));
	});

	it("moves header-only session with pending user message (#flushed regression)", async () => {
		// Create a header-only session
		const explicitPath = path.join(cwdA, "explicit-session-2.jsonl");
		const session = await SessionManager.open(explicitPath);

		expect(fs.existsSync(explicitPath)).toBe(true);

		// Add a user message only — _persist() sets #flushed=false (line 1827)
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });

		await session.moveTo(cwdB);

		expect(session.getCwd()).toBe(path.resolve(cwdB));
		expect(fs.existsSync(explicitPath)).toBe(false);

		const newFile = session.getSessionFile()!;
		expect(fs.existsSync(newFile)).toBe(true);

		// Rewrite must have run (hadSessionFile=true) even though #flushed was reset
		const entries = await loadEntriesFromFile(newFile);
		const header = getHeader(entries);
		expect(header?.cwd).toBe(path.resolve(cwdB));
	});

	it("moves artifact dir independently when session file does not exist", async () => {
		const session = SessionManager.create(cwdA);
		// Allocate an artifact — creates dir via ArtifactManager
		const { path: artifactPath } = await session.allocateArtifactPath("bash");
		if (!artifactPath) throw new Error("Expected artifact path");

		const oldArtifactDir = path.dirname(artifactPath);
		expect(fs.existsSync(oldArtifactDir)).toBe(true);

		// No messages — session file doesn't exist
		const oldFile = session.getSessionFile()!;
		expect(fs.existsSync(oldFile)).toBe(false);

		await session.moveTo(cwdB);

		expect(session.getCwd()).toBe(path.resolve(cwdB));
		// Old artifact dir moved
		expect(fs.existsSync(oldArtifactDir)).toBe(false);
		// New artifact dir exists
		const newFile = session.getSessionFile()!;
		const newArtifactDir = newFile.slice(0, -6); // strip .jsonl
		expect(fs.existsSync(newArtifactDir)).toBe(true);
	});
	it("does not orphan appends that race the session file publication", async () => {
		const session = SessionManager.create(cwdA);
		session.appendMessage({ role: "user", content: "before move", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();

		const oldFile = session.getSessionFile();
		if (!oldFile) throw new Error("Expected session file");
		const oldArtifactsDir = oldFile.slice(0, -6);
		await fsp.mkdir(oldArtifactsDir);

		const renameFinished = Promise.withResolvers<void>();
		const allowMoveToResume = Promise.withResolvers<void>();
		const rename = fs.promises.rename.bind(fs.promises);
		const renameSpy = spyOn(fs.promises, "rename").mockImplementation(async (source, target) => {
			await rename(source, target);
			if (path.resolve(source.toString()) !== path.resolve(oldArtifactsDir)) return;
			renameFinished.resolve();
			await allowMoveToResume.promise;
		});

		try {
			const move = session.moveTo(cwdB);
			await renameFinished.promise;
			session.appendMessage({ role: "user", content: "during move", timestamp: 2 });
			allowMoveToResume.resolve();
			await move;
			await session.flush();
		} finally {
			allowMoveToResume.resolve();
			renameSpy.mockRestore();
		}

		expect(fs.existsSync(oldFile)).toBe(false);
		const movedFile = session.getSessionFile();
		if (!movedFile) throw new Error("Expected moved session file");
		const entries = await loadEntriesFromFile(movedFile);
		expect(
			entries.some(
				entry =>
					entry.type === "message" && entry.message.role === "user" && entry.message.content === "during move",
			),
		).toBe(true);
	});

	it("does not orphan a flushSync that races the session file publication", async () => {
		const session = SessionManager.create(cwdA);
		session.appendMessage({ role: "user", content: "before move", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();

		const oldFile = session.getSessionFile();
		if (!oldFile) throw new Error("Expected session file");
		const oldArtifactsDir = oldFile.slice(0, -6);
		await fsp.mkdir(oldArtifactsDir);

		const renameFinished = Promise.withResolvers<void>();
		const allowMoveToResume = Promise.withResolvers<void>();
		const rename = fs.promises.rename.bind(fs.promises);
		const renameSpy = spyOn(fs.promises, "rename").mockImplementation(async (source, target) => {
			await rename(source, target);
			if (path.resolve(source.toString()) !== path.resolve(oldArtifactsDir)) return;
			renameFinished.resolve();
			await allowMoveToResume.promise;
		});

		try {
			const move = session.moveTo(cwdB);
			await renameFinished.promise;
			// A fenced append followed by a Ctrl+C flushSync in the post-publication,
			// pre-repoint window must not recreate the old JSONL path.
			session.appendMessage({ role: "user", content: "during move", timestamp: 2 });
			session.flushSync();
			allowMoveToResume.resolve();
			await move;
			await session.flush();
		} finally {
			allowMoveToResume.resolve();
			renameSpy.mockRestore();
		}

		expect(fs.existsSync(oldFile)).toBe(false);
		const movedFile = session.getSessionFile();
		if (!movedFile) throw new Error("Expected moved session file");
		const entries = await loadEntriesFromFile(movedFile);
		expect(
			entries.some(
				entry =>
					entry.type === "message" && entry.message.role === "user" && entry.message.content === "during move",
			),
		).toBe(true);
	});

	it("does not orphan title changes that race the session file publication", async () => {
		const session = SessionManager.create(cwdA);
		session.appendMessage({ role: "user", content: "before move", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();

		const oldFile = session.getSessionFile();
		if (!oldFile) throw new Error("Expected session file");
		const oldArtifactsDir = oldFile.slice(0, -6);
		await fsp.mkdir(oldArtifactsDir);

		const renameFinished = Promise.withResolvers<void>();
		const allowMoveToResume = Promise.withResolvers<void>();
		const rename = fs.promises.rename.bind(fs.promises);
		const renameSpy = spyOn(fs.promises, "rename").mockImplementation(async (source, target) => {
			await rename(source, target);
			if (path.resolve(source.toString()) !== path.resolve(oldArtifactsDir)) return;
			renameFinished.resolve();
			await allowMoveToResume.promise;
		});

		try {
			const move = session.moveTo(cwdB);
			await renameFinished.promise;
			await session.setSessionName("during move", "user");
			allowMoveToResume.resolve();
			await move;
			await session.flush();
		} finally {
			allowMoveToResume.resolve();
			renameSpy.mockRestore();
		}

		expect(fs.existsSync(oldFile)).toBe(false);
		const movedFile = session.getSessionFile();
		if (!movedFile) throw new Error("Expected moved session file");
		const entries = await loadEntriesFromFile(movedFile);
		expect(entries.some(entry => entry.type === "title_change" && entry.title === "during move")).toBe(true);
	});

	it("materializes an ensureOnDisk session when moveTo races the queued rewrite", async () => {
		// A header-only session (ACP session/new, drafts) forces creation via
		// ensureOnDisk(), which schedules its materializing rewrite on the disk
		// chain. Starting moveTo() before that task runs must not cancel it, or
		// the explicitly materialized session is lost and never discoverable.
		const session = SessionManager.create(cwdA);
		const ensure = session.ensureOnDisk();
		await session.moveTo(cwdB);
		await ensure;
		await session.flush();

		const movedFile = session.getSessionFile();
		if (!movedFile) throw new Error("Expected moved session file");
		expect(fs.existsSync(movedFile)).toBe(true);

		// An explicit ensureOnDisk() stub stays on disk even though the picker
		// hides untitled empties; resolveResumableSession keeps it discoverable.
		const sessionId = path.basename(movedFile, ".jsonl").split("_").at(-1) ?? "";
		const resolved = await resolveResumableSession(sessionId, cwdB);
		expect(resolved?.session.path).toBe(movedFile);
	});

	it("keeps post-publication fenced appends durable before trailing rewrite", async () => {
		// Crash window: session file has been published to dest, `#sessionFile` is
		// still the source path, and the trailing atomic rewrite has not run.
		// Completed entries appended in this window must land on dest (not recreate
		// source) and survive a crash-equivalent snapshot + reopen.
		const session = SessionManager.create(cwdA);
		session.appendMessage({ role: "user", content: "before move", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();

		const oldFile = session.getSessionFile();
		if (!oldFile) throw new Error("Expected session file");
		const oldArtifactsDir = oldFile.slice(0, -6);
		await fsp.mkdir(oldArtifactsDir);

		const renameFinished = Promise.withResolvers<{ dest: string }>();
		const allowMoveToResume = Promise.withResolvers<void>();
		const rename = fs.promises.rename.bind(fs.promises);
		const renameSpy = spyOn(fs.promises, "rename").mockImplementation(async (source, target) => {
			await rename(source, target);
			if (path.resolve(source.toString()) !== path.resolve(oldArtifactsDir)) return;
			renameFinished.resolve({ dest: `${path.resolve(target.toString())}.jsonl` });
			await allowMoveToResume.promise;
		});

		let dest = "";
		try {
			const move = session.moveTo(cwdB);
			({ dest } = await renameFinished.promise);

			session.appendMessage({ role: "user", content: "during move crash window", timestamp: 2 });
			session.appendCustomEntry("tool_execution_start", {
				toolCallId: "move-call",
				toolName: "bash",
			});
			session.appendMessage({
				role: "toolResult",
				toolCallId: "move-call",
				toolName: "bash",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: 3,
			});

			// Crash-equivalent: only dest bytes exist; source must stay absent.
			expect(fs.existsSync(oldFile)).toBe(false);
			expect(fs.existsSync(dest)).toBe(true);
			const crashBytes = fs.readFileSync(dest, "utf8");
			expect(crashBytes).toContain("during move crash window");
			expect(crashBytes).toContain('"customType":"tool_execution_start"');
			expect(crashBytes).toContain("move-call");

			const crashPath = path.join(testAgentDir, "crashed-move.jsonl");
			fs.writeFileSync(crashPath, crashBytes);
			const reopened = await SessionManager.open(crashPath);
			const reopenedEntries = reopened.getEntries();
			expect(
				reopenedEntries.some(
					entry =>
						entry.type === "message" &&
						entry.message.role === "user" &&
						entry.message.content === "during move crash window",
				),
			).toBe(true);
			expect(
				reopenedEntries.some(
					entry =>
						entry.type === "message" &&
						entry.message.role === "toolResult" &&
						entry.message.toolCallId === "move-call",
				),
			).toBe(true);
			expect(
				reopenedEntries.some(entry => entry.type === "custom" && entry.customType === "tool_execution_start"),
			).toBe(true);

			allowMoveToResume.resolve();
			await move;
			await session.flush();
		} finally {
			allowMoveToResume.resolve();
			renameSpy.mockRestore();
		}

		expect(fs.existsSync(oldFile)).toBe(false);
		const movedFile = session.getSessionFile();
		if (!movedFile) throw new Error("Expected moved session file");
		const entries = await loadEntriesFromFile(movedFile);
		expect(
			entries.some(
				entry =>
					entry.type === "message" &&
					entry.message.role === "user" &&
					entry.message.content === "during move crash window",
			),
		).toBe(true);
	});

	it("keeps the manager pointed at the moved file when the inverse relocation fails", async () => {
		const session = SessionManager.create(cwdA);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		const snapshot = session.captureState();
		await session.moveTo(cwdB);
		const movedFile = session.getSessionFile()!;

		// Make the inverse relocation fail on the rollback call.
		const moveTo = spyOn(session, "moveTo").mockRejectedValueOnce(new Error("publication denied"));
		try {
			await expect(session.rollbackMove(snapshot)).rejects.toThrow("the session file remains at");
		} finally {
			moveTo.mockRestore();
		}

		// The manager must keep pointing at the actual on-disk file so later
		// appends continue there instead of splitting the transcript.
		expect(session.getSessionFile()).toBe(movedFile);
	});

	/**
	 * A session that lived in cwdA, moved to cwdB, and comes back: the home
	 * bucket's `<stem>/` is repopulated by a stale writer meanwhile. Returns the
	 * two artifact directories; the caller seeds the collision it wants.
	 */
	async function sessionAwayFromHome(): Promise<{
		session: SessionManager;
		homeArtifactsDir: string;
		awayArtifactsDir: string;
	}> {
		const session = SessionManager.create(cwdA);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		const homeArtifactsDir = session.getSessionFile()!.slice(0, -6);
		await session.moveTo(cwdB);
		const awayArtifactsDir = session.getSessionFile()!.slice(0, -6);
		await fsp.mkdir(homeArtifactsDir, { recursive: true });
		return { session, homeArtifactsDir, awayArtifactsDir };
	}

	it("merges into an artifacts dir that already exists at the destination", async () => {
		// A session that returns to a bucket it lived in before finds its own
		// `<stem>/` still there whenever a writer holding the old path (subagents
		// adopt the parent's ArtifactManager) kept writing after the move away.
		// rename(2) onto a non-empty dir is ENOTEMPTY and used to abort the
		// resume; the move must merge instead, including directories that exist
		// on both sides.
		const session = SessionManager.create(cwdA);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		const homeArtifactsDir = session.getSessionFile()!.slice(0, -6);
		const firstId = (await session.saveArtifact("first", "bash"))!;

		await session.moveTo(cwdB);
		const awayArtifactsDir = session.getSessionFile()!.slice(0, -6);
		expect(fs.existsSync(homeArtifactsDir)).toBe(false);
		const secondId = (await session.saveArtifact("second", "read"))!;
		await fsp.mkdir(path.join(awayArtifactsDir, "Sub"));
		await fsp.writeFile(path.join(awayArtifactsDir, "Sub", "away.md"), "written away");

		// Stale writer repopulates the home bucket while the session is away.
		await fsp.mkdir(path.join(homeArtifactsDir, "Sub"), { recursive: true });
		await fsp.writeFile(path.join(homeArtifactsDir, "Sub", "home.md"), "written at home");
		await fsp.writeFile(path.join(homeArtifactsDir, "SubagentA.md"), "stale summary");

		await session.moveTo(cwdA);

		expect(session.getSessionFile()!.slice(0, -6)).toBe(homeArtifactsDir);
		expect(fs.existsSync(awayArtifactsDir)).toBe(false);
		expect(await session.getArtifactPath(firstId)).toBe(path.join(homeArtifactsDir, `${firstId}.bash.log`));
		expect(await session.getArtifactPath(secondId)).toBe(path.join(homeArtifactsDir, `${secondId}.read.log`));
		expect((await fsp.readdir(path.join(homeArtifactsDir, "Sub"))).sort()).toEqual(["away.md", "home.md"]);
		expect(await fsp.readFile(path.join(homeArtifactsDir, "SubagentA.md"), "utf8")).toBe("stale summary");
	});

	it("keeps both copies when a merged artifact name collides", async () => {
		// Two buckets can each hold `0.bash.log` (ids are seeded per directory),
		// and `artifact://0` resolves by `0.` prefix, so the merge must neither
		// overwrite the destination copy nor stack a renamed duplicate beside
		// it: the colliding source entry stays where it was. Same for a nested
		// name that exists on both sides.
		const { session, homeArtifactsDir, awayArtifactsDir } = await sessionAwayFromHome();
		const id = (await session.saveArtifact("written by a stale writer", "bash"))!;
		await fsp.cp(
			path.join(awayArtifactsDir, ".artifact-state-v1", id),
			path.join(homeArtifactsDir, ".artifact-state-v1", id),
			{
				recursive: true,
			},
		);
		await fsp.writeFile(path.join(homeArtifactsDir, `${id}.bash.log`), "written by a stale writer");
		await fsp.writeFile(path.join(awayArtifactsDir, `${id}.bash.log`), "written while away");
		await fsp.writeFile(path.join(awayArtifactsDir, "unique.md"), "moves fine");
		for (const dir of [homeArtifactsDir, awayArtifactsDir]) {
			await fsp.mkdir(path.join(dir, "Sub"));
			await fsp.writeFile(path.join(dir, "Sub", "same.md"), dir === homeArtifactsDir ? "home copy" : "away copy");
		}

		await session.moveTo(cwdA);

		expect(await session.getArtifactPath(id)).toBe(path.join(homeArtifactsDir, `${id}.bash.log`));
		expect(await fsp.readFile(path.join(homeArtifactsDir, `${id}.bash.log`), "utf8")).toBe(
			"written by a stale writer",
		);
		expect((await fsp.readdir(homeArtifactsDir)).filter(name => !name.startsWith(".artifact-")).sort()).toEqual([
			`${id}.bash.log`,
			"Sub",
			"unique.md",
		]);
		expect(await fsp.readFile(path.join(homeArtifactsDir, "Sub", "same.md"), "utf8")).toBe("home copy");
		expect((await fsp.readdir(awayArtifactsDir)).filter(name => !name.startsWith(".artifact-")).sort()).toEqual([
			`${id}.bash.log`,
			"Sub",
		]);
		expect(await fsp.readFile(path.join(awayArtifactsDir, `${id}.bash.log`), "utf8")).toBe("written while away");
		expect(await fsp.readdir(path.join(awayArtifactsDir, "Sub"))).toEqual(["same.md"]);
	});

	it("treats the same artifact id under a different tool suffix as a collision", async () => {
		// `artifact://7` is resolved by the `7.` prefix, so `7.bash.log` arriving
		// beside an existing `7.read.log` would make the lookup depend on readdir
		// order. The id is the collision key, not the file name.
		const { session, homeArtifactsDir, awayArtifactsDir } = await sessionAwayFromHome();
		const id = (await session.saveArtifact("written while away", "bash"))!;
		await fsp.writeFile(path.join(homeArtifactsDir, `${id}.read.log`), "written by a stale writer");

		await session.moveTo(cwdA);

		expect((await fsp.readdir(homeArtifactsDir)).filter(name => !name.startsWith(".artifact-"))).toEqual([
			`${id}.read.log`,
		]);
		expect((await fsp.readdir(awayArtifactsDir)).filter(name => !name.startsWith(".artifact-"))).toEqual([
			`${id}.bash.log`,
		]);
		expect(await fsp.readFile(path.join(homeArtifactsDir, `${id}.read.log`), "utf8")).toBe(
			"written by a stale writer",
		);
		expect(await fsp.readFile(path.join(awayArtifactsDir, `${id}.bash.log`), "utf8")).toBe("written while away");
	});

	it("finishes the merge and keeps the session at the destination when one entry cannot move", async () => {
		// Once entries have started moving, a failure on one of them must not
		// abort the relocation: rolling the session file back would leave it
		// pointing away from the artifacts that already moved. The entry stays
		// at the source and the rest of the merge completes.
		const { session, homeArtifactsDir, awayArtifactsDir } = await sessionAwayFromHome();
		const id = (await session.saveArtifact("written while away", "bash"))!;
		await fsp.writeFile(path.join(awayArtifactsDir, "stuck.md"), "cannot move");
		await fsp.writeFile(path.join(homeArtifactsDir, "stale.md"), "already here");
		// Both the no-replace link and its exclusive-copy fallback refuse this one
		// entry; everything else, including the session file publication, goes through.
		const denied = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
		const link = fs.promises.link.bind(fs.promises);
		const copyFile = fs.promises.copyFile.bind(fs.promises);
		const linkSpy = spyOn(fs.promises, "link").mockImplementation(async (existing, target) => {
			if (path.basename(existing.toString()) === "stuck.md") throw denied;
			return link(existing, target);
		});
		const copySpy = spyOn(fs.promises, "copyFile").mockImplementation(async (source, target, mode) => {
			if (path.basename(source.toString()) === "stuck.md") throw denied;
			return copyFile(source, target, mode);
		});

		try {
			await session.moveTo(cwdA);
		} finally {
			linkSpy.mockRestore();
			copySpy.mockRestore();
		}

		expect(session.getSessionFile()!.slice(0, -6)).toBe(homeArtifactsDir);
		expect(await session.getArtifactPath(id)).toBe(path.join(homeArtifactsDir, `${id}.bash.log`));
		expect(await fsp.readFile(path.join(homeArtifactsDir, "stale.md"), "utf8")).toBe("already here");
		expect(await fsp.readdir(awayArtifactsDir)).toEqual(["stuck.md"]);
	});

	it("notices an artifact id a writer publishes after the destination was listed", async () => {
		// The destination is listed before moving; a writer landing `1.read.log`
		// after that listing does not collide by name with the source's
		// `1.bash.log`, so both would arrive and `artifact://1` would depend on
		// readdir order. The occupancy must be re-read before an id-bearing move.
		const { session, homeArtifactsDir, awayArtifactsDir } = await sessionAwayFromHome();
		const id = (await session.saveArtifact("written while away", "bash"))!;
		await fsp.writeFile(path.join(homeArtifactsDir, "stale.md"), "already here");
		const readdir = fs.promises.readdir.bind(fs.promises);
		let published = false;
		// The relocation only ever lists with `withFileTypes: true`; satisfy the
		// overload set with that shape.
		const listing = async (target: fs.PathLike, options: { withFileTypes: true }) => {
			const entries = await readdir(target, options);
			if (!published && path.resolve(target.toString()) === homeArtifactsDir) {
				published = true;
				await fsp.writeFile(path.join(homeArtifactsDir, `${id}.read.log`), "published after the listing");
			}
			return entries;
		};
		const readdirSpy = spyOn(fs.promises, "readdir").mockImplementation(listing as typeof fs.promises.readdir);
		try {
			await session.moveTo(cwdA);
		} finally {
			readdirSpy.mockRestore();
		}

		expect((await fsp.readdir(homeArtifactsDir)).filter(name => !name.startsWith(".artifact-")).sort()).toEqual([
			`${id}.read.log`,
			"stale.md",
		]);
		expect((await fsp.readdir(awayArtifactsDir)).filter(name => !name.startsWith(".artifact-"))).toEqual([
			`${id}.bash.log`,
		]);
		expect(await fsp.readFile(path.join(homeArtifactsDir, `${id}.read.log`), "utf8")).toBe(
			"published after the listing",
		);
		expect(await fsp.readFile(path.join(awayArtifactsDir, `${id}.bash.log`), "utf8")).toBe("written while away");
	});

	it("does not merge through a symlink on either side", async () => {
		// A symlink where an artifacts directory should be would make the merge
		// move files into, or out of, whatever it points at. That is a
		// relocation failure, not a merge: the move fails and the session stays
		// where it was.
		const { session, homeArtifactsDir, awayArtifactsDir } = await sessionAwayFromHome();
		const id = (await session.saveArtifact("written while away", "bash"))!;
		const awaySessionFile = session.getSessionFile()!;
		const elsewhere = path.join(testAgentDir, "elsewhere");
		await fsp.mkdir(elsewhere);
		await fsp.writeFile(path.join(elsewhere, "unrelated.md"), "untouched");

		// Destination is a symlink.
		await fsp.rmdir(homeArtifactsDir);
		await fsp.symlink(elsewhere, homeArtifactsDir);
		await expect(session.moveTo(cwdA)).rejects.toThrow();
		expect(await fsp.readdir(elsewhere)).toEqual(["unrelated.md"]);
		expect(session.getSessionFile()).toBe(awaySessionFile);
		expect(await session.getArtifactPath(id)).toBe(path.join(awayArtifactsDir, `${id}.bash.log`));

		// Source is a symlink and the destination is an occupied real directory.
		await fsp.unlink(homeArtifactsDir);
		await fsp.mkdir(homeArtifactsDir);
		await fsp.writeFile(path.join(homeArtifactsDir, "stale.md"), "already here");
		await fsp.rename(awayArtifactsDir, path.join(testAgentDir, "moved-away"));
		await fsp.symlink(elsewhere, awayArtifactsDir);
		await expect(session.moveTo(cwdA)).rejects.toThrow();
		expect(await fsp.readdir(elsewhere)).toEqual(["unrelated.md"]);
		expect(await fsp.readdir(homeArtifactsDir)).toEqual(["stale.md"]);
		expect(session.getSessionFile()).toBe(awaySessionFile);
	});

	it("strands an entry whose occupancy re-read fails instead of aborting the merge", async () => {
		// The re-read before an id-bearing move is a syscall that can fail like
		// the move itself; once entries have moved it must not throw out of the
		// merge, or the session file is rolled back away from them.
		const { session, homeArtifactsDir, awayArtifactsDir } = await sessionAwayFromHome();
		const id = (await session.saveArtifact("written while away", "bash"))!;
		await fsp.writeFile(path.join(awayArtifactsDir, "unique.md"), "moves fine");
		await fsp.writeFile(path.join(homeArtifactsDir, "stale.md"), "already here");
		const readdir = fs.promises.readdir.bind(fs.promises);
		let homeListings = 0;
		const listing = async (target: fs.PathLike, options: { withFileTypes: true }) => {
			if (path.resolve(target.toString()) === homeArtifactsDir && ++homeListings === 2) {
				throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
			}
			return readdir(target, options);
		};
		const readdirSpy = spyOn(fs.promises, "readdir").mockImplementation(listing as typeof fs.promises.readdir);
		try {
			await session.moveTo(cwdA);
		} finally {
			readdirSpy.mockRestore();
		}

		expect(session.getSessionFile()!.slice(0, -6)).toBe(homeArtifactsDir);
		expect((await fsp.readdir(homeArtifactsDir)).filter(name => !name.startsWith(".artifact-")).sort()).toEqual([
			"stale.md",
			"unique.md",
		]);
		expect(await fsp.readdir(awayArtifactsDir)).toEqual([`${id}.bash.log`]);
	});

	it("keeps the no-replace guarantee when hard links are unavailable", async () => {
		// Without link(2), the fallback must still refuse a file a writer
		// published between the listing and the move, rather than replacing it.
		const { session, homeArtifactsDir, awayArtifactsDir } = await sessionAwayFromHome();
		await fsp.mkdir(awayArtifactsDir, { recursive: true });
		await fsp.writeFile(path.join(awayArtifactsDir, "unique.md"), "moves fine");
		await fsp.writeFile(path.join(awayArtifactsDir, "raced.md"), "source copy");
		await fsp.writeFile(path.join(homeArtifactsDir, "stale.md"), "already here");
		const noLinks = Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
		const linkSpy = spyOn(fs.promises, "link").mockRejectedValue(noLinks);
		const readdir = fs.promises.readdir.bind(fs.promises);
		let published = false;
		const listing = async (target: fs.PathLike, options: { withFileTypes: true }) => {
			const entries = await readdir(target, options);
			if (!published && path.resolve(target.toString()) === homeArtifactsDir) {
				published = true;
				await fsp.writeFile(path.join(homeArtifactsDir, "raced.md"), "published after the listing");
			}
			return entries;
		};
		const readdirSpy = spyOn(fs.promises, "readdir").mockImplementation(listing as typeof fs.promises.readdir);
		try {
			await session.moveTo(cwdA);
		} finally {
			linkSpy.mockRestore();
			readdirSpy.mockRestore();
		}

		expect(await fsp.readFile(path.join(homeArtifactsDir, "raced.md"), "utf8")).toBe("published after the listing");
		expect(await fsp.readFile(path.join(homeArtifactsDir, "unique.md"), "utf8")).toBe("moves fine");
		expect(await fsp.readdir(awayArtifactsDir)).toEqual(["raced.md"]);
	});

	it("restores a copied session file when artifact relocation fails", async () => {
		const session = SessionManager.create(cwdA);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();

		const oldFile = session.getSessionFile()!;
		const oldArtifactsDir = oldFile.slice(0, -6);
		await session.saveArtifact("keep me", "bash");

		const realRename = fs.promises.rename.bind(fs.promises);
		const link = fs.linkSync.bind(fs);
		const publicationSpy = spyOn(fs, "linkSync").mockImplementation((source, target) => {
			if (path.resolve(source.toString()) === path.resolve(oldFile)) {
				throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
			}
			return link(source, target);
		});
		const renameSpy = spyOn(fs.promises, "rename").mockImplementation(async (source, target) => {
			const resolvedSource = path.resolve(source.toString());
			if (resolvedSource === path.resolve(oldArtifactsDir)) {
				throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
			}
			return realRename(source, target);
		});
		try {
			await expect(session.moveTo(cwdB)).rejects.toThrow("EACCES");
		} finally {
			renameSpy.mockRestore();
			publicationSpy.mockRestore();
		}

		expect(fs.existsSync(oldFile)).toBe(true);
		expect(hasAssistantEntry(await loadEntriesFromFile(oldFile))).toBe(true);
	});
});
