import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { BlobStore, isBlobRef } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import type { FileEntry, SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { closeSessionIndex } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { findSessionFiles } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { loadEntriesFromFile, resolveBlobRefsInEntries } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { registryDurableStateForSession } from "@oh-my-pi/pi-coding-agent/registry/authority";
import { readAuthorityDescriptor } from "@oh-my-pi/pi-coding-agent/registry/authority/descriptor";
import { authorityPaths } from "@oh-my-pi/pi-coding-agent/registry/authority/ownership";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	packSession,
	SESSION_TRANSFER_MESSAGE_TYPE,
	unpackSession,
} from "@oh-my-pi/pi-coding-agent/session/session-transfer";
import { getBlobsDir, getConfigRootDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { readArchiveEntries, writeArchive } from "@oh-my-pi/pi-utils/ar";
import { makeAssistantMessage } from "./session-manager/helpers";

const IMAGE_DATA = Buffer.alloc(4096, 7).toString("base64");

function headerOf(entries: FileEntry[]): SessionHeader {
	const header = entries[0];
	if (header?.type !== "session") throw new Error("missing session header");
	return header;
}

function userImage(entries: FileEntry[]): ImageContent | undefined {
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "user") continue;
		const content = message.content;
		if (typeof content === "string") continue;
		const image = content.find((block): block is ImageContent => block.type === "image");
		if (image) return image;
	}
	return undefined;
}

describe("omp session pack/unpack archive", () => {
	let root: string;
	let agentA: string;
	let agentB: string;
	let cwdA: string;
	let cwdB: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

	beforeEach(async () => {
		root = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-session-transfer-"));
		agentA = path.join(root, "agent-a");
		agentB = path.join(root, "agent-b");
		cwdA = path.join(root, "laptop", "project");
		cwdB = path.join(root, "cloud", "project");
		fs.mkdirSync(cwdA, { recursive: true });
		fs.mkdirSync(cwdB, { recursive: true });
		setAgentDir(agentA);
	});

	afterEach(async () => {
		closeSessionIndex();
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(path.join(getConfigRootDir(), "agent"));
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await fsp.rm(root, { recursive: true, force: true });
	});

	/** A laptop session with an image turn, a subagent transcript, and a tool artifact; returns its file. */
	async function createLaptopSession(withAuthority = false): Promise<string> {
		const session = SessionManager.create(cwdA);
		session.appendMessage({
			role: "user",
			content: [
				{ type: "text", text: "what is in this screenshot?" },
				{ type: "image", data: IMAGE_DATA, mimeType: "image/png" },
			],
			timestamp: 1,
		});
		session.appendMessage(makeAssistantMessage());
		await session.ensureOnDisk();
		const file = session.getSessionFile();
		if (!file) throw new Error("session has no file");
		if (withAuthority) {
			const store = await registryDurableStateForSession(file, {
				backend: "jsonl",
				owningSessionId: session.getSessionId(),
				create: true,
			});
			await store.close();
		}
		await session.close();
		const artifacts = file.slice(0, -".jsonl".length);
		await Bun.write(path.join(artifacts, "0-Explore.jsonl"), '{"type":"session","id":"sub","cwd":"/x"}\n');
		await Bun.write(path.join(artifacts, "1.bash.log"), "build output");
		return file;
	}

	it("lands a complete authority bundle with a fresh incarnation and unchanged transcript history", async () => {
		const source = await createLaptopSession(true);
		const before = await loadEntriesFromFile(source);
		const sourceId = headerOf(before).id;
		const sourceDescriptor = await readAuthorityDescriptor(source);
		if (!sourceDescriptor) throw new Error("Expected a source authority descriptor");
		const archive = path.join(root, "out", "session.tar");
		const packed = await packSession(source, archive);
		expect(packed.missingBlobs).toEqual([]);

		setAgentDir(agentB);
		const result = await unpackSession(archive, { cwd: cwdB });
		const restoredDescriptor = await readAuthorityDescriptor(result.sessionFile);
		if (!restoredDescriptor) throw new Error("Expected a restored authority descriptor");
		expect(restoredDescriptor.owningSessionId).toBe(sourceId);
		expect(restoredDescriptor.incarnation).not.toBe(sourceDescriptor.incarnation);
		expect(await Bun.file(authorityPaths(result.sessionFile).jsonl).exists()).toBe(true);

		expect(result.mode).toBe("created");
		expect(path.dirname(result.sessionFile)).toBe(SessionManager.getDefaultSessionDir(cwdB));
		const after = await loadEntriesFromFile(result.sessionFile);
		expect(headerOf(after).id).toBe(headerOf(before).id);
		expect(headerOf(after).cwd).toBe(path.resolve(cwdB));
		expect(after.slice(1, -1)).toEqual(before.slice(1));
		const arrived = after.at(-1);
		expect(arrived?.type).toBe("custom_message");
		if (arrived?.type !== "custom_message") throw new Error("expected a transfer marker");
		expect(arrived.customType).toBe(SESSION_TRANSFER_MESSAGE_TYPE);
		expect(arrived.display).toBe(true);
		expect(arrived.details).toEqual({ kind: "arrived", fromCwd: path.resolve(cwdA), cwd: path.resolve(cwdB) });

		const artifacts = result.sessionFile.slice(0, -".jsonl".length);
		expect(await Bun.file(path.join(artifacts, "1.bash.log")).text()).toBe("build output");
		expect(await Bun.file(path.join(artifacts, "0-Explore.jsonl")).text()).toContain('"id":"sub"');

		// The journal keeps a blob ref; the bytes come from this machine's blob store.
		expect(isBlobRef(userImage(after)?.data ?? "")).toBe(true);
		await resolveBlobRefsInEntries(after, new BlobStore(getBlobsDir()));
		expect(userImage(after)?.data).toBe(IMAGE_DATA);
	});
	it("keeps diverged imported authority as provenance on a grant-free fork", async () => {
		const source = await createLaptopSession(true);
		const archive = path.join(root, "diverged.tar");
		await packSession(source, archive);
		const local = await SessionManager.open(source);
		local.appendMessage({ role: "user", content: "local divergence", timestamp: 2 });
		await local.flush();
		await local.close();
		const result = await unpackSession(archive, { cwd: cwdA, sessionDir: path.dirname(source) });
		expect(result.mode).toBe("forked");
		const fork = await registryDurableStateForSession(result.sessionFile, { owningSessionId: result.id });
		try {
			expect(await fork.getRoot("Main")).toBeUndefined();
		} finally {
			await fork.close();
		}
		const names = await fsp.readdir(path.dirname(result.sessionFile));
		expect(names.some(name => name.startsWith(`${path.basename(result.sessionFile)}.authority.backup.`))).toBe(true);
	});

	it("rejects a tampered blob before writing anything", async () => {
		const source = await createLaptopSession();
		const id = headerOf(await loadEntriesFromFile(source)).id;
		const archive = path.join(root, "session.tar");
		await packSession(source, archive);
		const members = await readArchiveEntries({ path: archive, format: "tar" });
		const blobName = [...members.keys()].find(name => name.startsWith("blobs/"));
		if (!blobName) throw new Error("archive has no blob");
		const tampered = new Uint8Array(members.get(blobName) ?? []);
		tampered[0] ^= 0xff;
		members.set(blobName, tampered);
		const tamperedArchive = path.join(root, "tampered.tar");
		await writeArchive(tamperedArchive, "tar", members);

		setAgentDir(agentB);
		await expect(unpackSession(tamperedArchive, { cwd: cwdB })).rejects.toThrow(/sha256/);

		expect(await findSessionFiles(id)).toEqual([]);
		expect(await new BlobStore(getBlobsDir()).has(blobName.slice("blobs/".length))).toBe(false);
	});

	it("rejects an archive from a newer format version", async () => {
		const source = await createLaptopSession();
		const archive = path.join(root, "session.tar");
		await packSession(source, archive);
		const members = await readArchiveEntries({ path: archive, format: "tar" });
		const manifest = JSON.parse(new TextDecoder().decode(members.get("manifest.json")));
		members.set("manifest.json", new TextEncoder().encode(JSON.stringify({ ...manifest, version: 2 })));
		const future = path.join(root, "future.tar");
		await writeArchive(future, "tar", members);

		setAgentDir(agentB);
		await expect(unpackSession(future, { cwd: cwdB })).rejects.toThrow(/version 2/);
		expect(await findSessionFiles(manifest.id)).toEqual([]);
	});
});
