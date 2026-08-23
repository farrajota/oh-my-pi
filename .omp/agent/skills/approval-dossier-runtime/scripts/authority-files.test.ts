import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	type AuthorityFileError,
	IdeationLineageLockError,
	installImmutableAuthorityFile,
	readAuthorityFile,
	withIdeationLineageLock,
	writeAuthorityFile,
} from "./authority-files.ts";

const temporaryRoots: string[] = [];

afterEach(async () => Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true }))));

async function temporaryRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "authority-files-"));
	temporaryRoots.push(root);
	return root;
}

function expectAuthorityFailure(
	promise: Promise<unknown>,
	code: AuthorityFileError["code"],
	path: string,
): Promise<void> {
	return expect(promise).rejects.toMatchObject({ code, path });
}

describe("descriptor-relative authority files", () => {
	test("reads exact bytes from a regular leaf", async () => {
		const root = await temporaryRoot();
		await mkdir(join(root, "records"));
		const expected = Uint8Array.from([0, 255, 17, 42]);
		await writeFile(join(root, "records", "authority.bin"), expected);

		await expect(readAuthorityFile(root, "records/authority.bin")).resolves.toEqual(expected);
	});

	test("rejects static symlink roots, parents, and leaves", async () => {
		const root = await temporaryRoot();
		const outside = await temporaryRoot();
		await writeFile(join(outside, "authority.txt"), "outside");
		await symlink(root, join(outside, "root-link"), "dir");
		await symlink(outside, join(root, "linked-parent"), "dir");
		await symlink(join(outside, "authority.txt"), join(root, "linked-leaf"), "file");

		await expectAuthorityFailure(readAuthorityFile(join(outside, "root-link"), "linked-leaf"), "PATH_ESCAPE", ".");
		await expectAuthorityFailure(
			readAuthorityFile(root, "linked-parent/authority.txt"),
			"PATH_ESCAPE",
			"linked-parent/authority.txt",
		);
		await expectAuthorityFailure(readAuthorityFile(root, "linked-leaf"), "PATH_ESCAPE", "linked-leaf");
	});

	test("atomically replaces a repository leaf without following an existing symlink", async () => {
		const root = await temporaryRoot();
		const outside = await temporaryRoot();
		await mkdir(join(root, "records"));
		const outsidePath = join(outside, "outside.txt");
		await writeFile(outsidePath, "unchanged outside bytes");
		await symlink(outsidePath, join(root, "records", "receipt.json"), "file");

		const bytes = Buffer.from("canonical receipt bytes\n", "utf8");
		await writeAuthorityFile(root, "records/receipt.json", bytes, 0o600);

		await expect(readFile(outsidePath, "utf8")).resolves.toBe("unchanged outside bytes");
		await expect(readAuthorityFile(root, "records/receipt.json")).resolves.toEqual(Uint8Array.from(bytes));
	});

	test("does not create through a symlinked parent or accept escaped paths", async () => {
		const root = await temporaryRoot();
		const outside = await temporaryRoot();
		await symlink(outside, join(root, "linked-parent"), "dir");

		await expectAuthorityFailure(
			writeAuthorityFile(root, "linked-parent/receipt.json", Buffer.from("x")),
			"PATH_ESCAPE",
			"linked-parent/receipt.json",
		);
		await expectAuthorityFailure(
			writeAuthorityFile(root, "../outside.json", Buffer.from("x")),
			"PATH_ESCAPE",
			"../outside.json",
		);
	});

	test("atomically adopts concurrent identical immutable bytes", async () => {
		const root = await temporaryRoot();
		const bytes = Buffer.from("immutable authority\n", "utf8");
		const outcomes = await Promise.all([
			installImmutableAuthorityFile(root, "records/candidate.json", bytes),
			installImmutableAuthorityFile(root, "records/candidate.json", bytes),
		]);
		expect([...outcomes].sort()).toEqual(["adopted-identical", "created"]);
		await expect(readAuthorityFile(root, "records/candidate.json")).resolves.toEqual(Uint8Array.from(bytes));
	});

	test("rejects concurrent immutable byte conflicts without replacing the winner", async () => {
		const root = await temporaryRoot();
		const first = Buffer.from("first immutable authority\n", "utf8");
		const second = Buffer.from("second immutable authority\n", "utf8");
		const outcomes = await Promise.allSettled([
			installImmutableAuthorityFile(root, "records/candidate.json", first),
			installImmutableAuthorityFile(root, "records/candidate.json", second),
		]);
		expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
		expect(outcomes.filter(outcome => outcome.status === "rejected")).toHaveLength(1);
		const stored = await readAuthorityFile(root, "records/candidate.json");
		expect([Buffer.from(first), Buffer.from(second)]).toContainEqual(Buffer.from(stored));
		const rejection = outcomes.find(outcome => outcome.status === "rejected");
		if (rejection?.status === "rejected")
			expect(rejection.reason).toMatchObject({ code: "DESTINATION_COLLISION", path: "records/candidate.json" });
	});

	test("holds the Ideation lineage lock for the complete async operation", async () => {
		const root = await temporaryRoot();
		let release!: () => void;
		const blocked = new Promise<void>(resolve => { release = resolve; });
		let entered!: () => void;
		const active = new Promise<void>(resolve => { entered = resolve; });
		const first = withIdeationLineageLock(root, "bounded-run", async () => {
			entered();
			await blocked;
		});
		await active;
		await expect(withIdeationLineageLock(root, "bounded-run", async () => undefined)).rejects.toMatchObject({
			code: "IDEATION_LINEAGE_LOCKED",
			slug: "bounded-run",
			path: "ai_docs/ideation/.bounded-run.lineage.lock",
		});
		release();
		await first;
		await expect(withIdeationLineageLock(root, "bounded-run", async () => "released")).resolves.toBe("released");
	});

	test("reports lineage lock setup failures as typed lock I/O errors", async () => {
		const root = await temporaryRoot();
		const outside = await temporaryRoot();
		await symlink(outside, join(root, "ai_docs"), "dir");

		const failure = await withIdeationLineageLock(root, "failed-open", async () => undefined)
			.then(() => undefined, error => error);
		expect(failure).toBeInstanceOf(IdeationLineageLockError);
		expect(failure).toMatchObject({
			code: "IDEATION_LOCK_IO_FAILURE",
			slug: "failed-open",
			path: "ai_docs/ideation/.failed-open.lineage.lock",
			operation: "open",
		});
	});

	test("rejects a pre-positioned non-regular lineage lock leaf", async () => {
		const root = await temporaryRoot();
		const lockDirectory = join(root, "ai_docs", "ideation", ".nonregular.lineage.lock");
		await mkdir(lockDirectory, { recursive: true });
		await expect(withIdeationLineageLock(root, "nonregular", async () => undefined)).rejects.toMatchObject({
			code: "IDEATION_LOCK_IO_FAILURE",
			slug: "nonregular",
			path: "ai_docs/ideation/.nonregular.lineage.lock",
			operation: "open",
		});
	});

	test("rejects a nonempty regular lineage lock inode", async () => {
		const root = await temporaryRoot();
		const lockPath = join(root, "ai_docs", "ideation", ".occupied.lineage.lock");
		await mkdir(dirname(lockPath), { recursive: true });
		await writeFile(lockPath, "not an empty permanent lock inode");
		await expect(withIdeationLineageLock(root, "occupied", async () => undefined)).rejects.toMatchObject({
			code: "IDEATION_LOCK_IO_FAILURE",
			operation: "open",
		});
	});

	test("retains the same empty regular lock inode across acquisitions", async () => {
    const root = await temporaryRoot();
    await withIdeationLineageLock(root, "permanent", async () => undefined);
    const path = join(root, "ai_docs", "ideation", ".permanent.lineage.lock");
    const first = await stat(path);
    expect(await readFile(path)).toEqual(Buffer.alloc(0));
    await withIdeationLineageLock(root, "permanent", async () => undefined);
    const second = await stat(path);
    expect(second.ino).toBe(first.ino);
  });


	test("releases the Ideation lineage lock when an operation throws", async () => {
		const root = await temporaryRoot();
		await expect(withIdeationLineageLock(root, "throwing-run", async () => {
			throw new Error("operation failed");
		})).rejects.toThrow("operation failed");
		await expect(withIdeationLineageLock(root, "throwing-run", async () => "released")).resolves.toBe("released");
	});

});
