import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { adaptSchemaForStrict, toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { astEdit } from "@oh-my-pi/pi-natives";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolChoiceQueue } from "@oh-my-pi/pi-coding-agent/session/tool-choice-queue";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { SessionPathScope } from "../../src/internal/session-path-scope";
import {
	bindSessionOperationAuthority,
	installSessionOperationLedger,
	issueBoundSessionOperationAuthority,
	runFilesystemOperation,
} from "../../src/registry/operation-lease";
import type { EffectiveSubagentPermissions } from "../../src/task/permission-profiles";

function createAstEditPermissionScope(allowPaths: string[], denyPaths: string[] = []): EffectiveSubagentPermissions {
	return {
		mode: "enforce",
		toolsEnabled: true,
		pathsEnabled: true,
		actorId: "AstEditPathScopeTest",
		actorKind: "sub",
		profiles: [],
		tools: ["ast_edit"],
		denyTools: [],
		allowPaths,
		denyPaths,
		guardrails: { noNetwork: false, secretsBlind: false },
	};
}

type ScopedAstEditFixture = {
	session: ToolSession;
	manager: object;
	pathScope: SessionPathScope;
	close(): Promise<void>;
	operationNumber: number;
};

function createScopedAstEditFixture(
	cwd: string,
	permissionScope: EffectiveSubagentPermissions,
	queue?: ToolChoiceQueue,
): ScopedAstEditFixture {
	const manager = {};
	const operationControl = installSessionOperationLedger(manager);
	const authority = issueBoundSessionOperationAuthority(
		{
			capability: {},
			actorId: permissionScope.actorId,
			rootId: "AstEditPathScopeTestRoot",
			generation: 1,
			sessionFile: null,
			validate: () => true,
		},
		manager,
	);
	bindSessionOperationAuthority(manager, authority);

	const pathScope = new SessionPathScope({
		actorId: () => permissionScope.actorId,
		sessionId: () => "ast-edit-path-scope-test",
		cwd: () => cwd,
		permissionScope: () => permissionScope,
		operationManager: () => manager,
	});
	return {
		session: createTestSession(cwd, {
			pathScope,
			getPermissionScope: () => permissionScope,
			...(queue
				? {
						getToolChoiceQueue: () => queue,
						buildToolChoice: () => ({ type: "tool" as const, name: "resolve" }),
						steer: () => {},
					}
				: {}),
		}),
		manager,
		pathScope,
		close: () => operationControl.close(),
		operationNumber: 0,
	};
}

async function withScopedAstEditOperation<T>(fixture: ScopedAstEditFixture, run: () => Promise<T>): Promise<T> {
	const operationId = `ast_edit:ast-edit-path-scope-${++fixture.operationNumber}`;
	return runFilesystemOperation(fixture.manager, operationId, () =>
		fixture.pathScope.withOperationLease(operationId, run),
	);
}

type InvokedToolResult = {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
	isError?: boolean;
};

function createTestSession(cwd = "/tmp/test", overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		// xdev mounting (default-on) would unmount the discoverable ast_edit
		// into xd://; these tests need it in the returned toolset.
		settings: Settings.isolated({ "tools.xdev": false }),
		...overrides,
	};
}

function asSchemaObject(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Expected object schema");
	}
	return value as Record<string, unknown>;
}

describe("ast_edit tool schema", () => {
	it("uses op entries as [{ pat, out }]", async () => {
		const tools = await createTools(createTestSession(), ["ast_edit"]);
		const tool = tools.find(entry => entry.name === "ast_edit");
		expect(tool).toBeDefined();
		const schema = toolWireSchema(tool!);
		const properties = asSchemaObject(schema.properties);
		const ops = asSchemaObject(properties.ops);

		expect(ops.type).toBe("array");
		const items = asSchemaObject(ops.items);
		expect(items.type).toBe("object");
		expect(items.required).toEqual(["pat", "out"]);
		const itemProperties = asSchemaObject(items.properties);
		expect(asSchemaObject(itemProperties.pat).type).toBe("string");
		expect(asSchemaObject(itemProperties.out).type).toBe("string");
		expect(properties.preview).toBeUndefined();
	});

	it("remains strict-representable after strict adaptation", async () => {
		const tools = await createTools(createTestSession(), ["ast_edit"]);
		const tool = tools.find(entry => entry.name === "ast_edit");
		expect(tool).toBeDefined();
		const schema = toolWireSchema(tool!);

		const strict = adaptSchemaForStrict(schema, true);
		expect(strict.strict).toBe(true);
	});

	it("renders +/- lines with numbered hashline prefixes", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-render-"));
		try {
			const filePath = path.join(tempDir, "legacy.ts");
			await Bun.write(filePath, "legacyWrap(x, value)\n");

			const tools = await createTools(createTestSession(tempDir), ["ast_edit"]);
			const tool = tools.find(entry => entry.name === "ast_edit");
			expect(tool).toBeDefined();

			const result = await tool!.execute("ast-edit-test", {
				ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
				paths: [filePath],
			});
			const text = result.content.find(content => content.type === "text")?.text ?? "";
			const lines = text.split("\n");
			const removedLine = lines.find(line => line.startsWith("-"));
			const addedLine = lines.find(line => line.startsWith("+"));

			expect(removedLine).toBeDefined();
			expect(addedLine).toBeDefined();
			expect(removedLine).toMatch(/^-\d+:/);
			expect(addedLine).toMatch(/^\+\d+:/);
			expect(removedLine?.split(":", 1)[0].length).toBe(addedLine?.split(":", 1)[0].length);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("registers a pending action that apply writes changes", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-pending-"));
		try {
			const filePath = path.join(tempDir, "legacy.ts");
			await Bun.write(filePath, "legacyWrap(x, value)\n");
			const queue = new ToolChoiceQueue();

			const tools = await createTools(
				createTestSession(tempDir, {
					getToolChoiceQueue: () => queue,
					buildToolChoice: () => ({ type: "tool" as const, name: "resolve" }),
					steer: () => {},
				}),
				["ast_edit"],
			);
			const tool = tools.find(entry => entry.name === "ast_edit");
			expect(tool).toBeDefined();

			const previewResult = await tool!.execute("ast-edit-preview", {
				ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
				paths: [filePath],
			});
			expect(previewResult.details).toBeDefined();
			expect((previewResult.details as { applied?: boolean }).applied).toBe(false);

			expect(queue.hasPendingInvoker).toBe(true);
			const invoker = queue.peekPendingInvoker()!;
			const applyResult = (await invoker({
				action: "apply",
				reason: "apply previewed AST edit",
			})) as InvokedToolResult;
			const applyText = applyResult.content.find(content => content.type === "text")?.text ?? "";
			expect(applyResult.isError).toBeUndefined();
			expect(applyText).toContain("Applied 1 replacement in 1 file.");
			expect(
				(applyResult.details as { sourceResultDetails?: { totalReplacements?: number } } | undefined)
					?.sourceResultDetails?.totalReplacements,
			).toBe(1);
			const updated = await Bun.file(filePath).text();
			expect(updated).toContain("modernWrap(x, value)");
		} finally {
			await removeWithRetries(tempDir);
		}
	});
	it("keeps ordinary session AST preview and apply usable with a path scope", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-ordinary-scope-"));
		try {
			const filePath = path.join(tempDir, "legacy.ts");
			await Bun.write(filePath, "legacyWrap(x, value)\n");
			const queue = new ToolChoiceQueue();
			const pathScope = new SessionPathScope({
				actorId: () => "main",
				sessionId: () => "ordinary-ast-edit",
				cwd: () => tempDir,
				permissionScope: () => undefined,
			});
			const tools = await createTools(
				createTestSession(tempDir, {
					pathScope,
					getToolChoiceQueue: () => queue,
					buildToolChoice: () => ({ type: "tool" as const, name: "resolve" }),
					steer: () => {},
				}),
				["ast_edit"],
			);
			const tool = tools.find(entry => entry.name === "ast_edit");
			expect(tool).toBeDefined();
			const preview = await tool!.execute("ast-edit-ordinary-preview", {
				ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
				paths: [filePath],
			});
			expect((preview.details as { totalReplacements?: number } | undefined)?.totalReplacements).toBe(1);
			expect(await Bun.file(filePath).text()).toBe("legacyWrap(x, value)\n");
			const result = (await queue.peekPendingInvoker()!({
				action: "apply",
				reason: "apply preview",
			})) as InvokedToolResult;
			expect(result.isError).toBeUndefined();
			expect(await Bun.file(filePath).text()).toBe("modernWrap(x, value)\n");
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("fails stale pending apply when preview no longer matches", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-stale-"));
		try {
			const filePath = path.join(tempDir, "legacy.ts");
			await Bun.write(filePath, "legacyWrap(x, value)\n");
			const queue = new ToolChoiceQueue();

			const tools = await createTools(
				createTestSession(tempDir, {
					getToolChoiceQueue: () => queue,
					buildToolChoice: () => ({ type: "tool" as const, name: "resolve" }),
					steer: () => {},
				}),
				["ast_edit"],
			);
			const tool = tools.find(entry => entry.name === "ast_edit");
			expect(tool).toBeDefined();

			const previewResult = await tool!.execute("ast-edit-preview", {
				ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
				paths: [filePath],
			});
			expect((previewResult.details as { totalReplacements?: number } | undefined)?.totalReplacements).toBe(1);

			const mutatedContent = "otherWrap(x, value)\n";
			await Bun.write(filePath, mutatedContent);

			const invoker = queue.peekPendingInvoker()!;
			const applyResult = (await invoker({ action: "apply", reason: "apply stale preview" })) as InvokedToolResult;
			const applyText = applyResult.content.find(content => content.type === "text")?.text ?? "";

			expect(applyResult.isError).toBe(true);
			expect(applyText).toContain("Preview is stale / no longer matches");
			expect(applyText).toContain("no replacements were applied");
			expect(
				(applyResult.details as { sourceResultDetails?: { totalReplacements?: number } } | undefined)
					?.sourceResultDetails?.totalReplacements,
			).toBe(0);
			expect(await Bun.file(filePath).text()).toBe(mutatedContent);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("combines globbing from path and glob parameters", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-glob-"));
		try {
			const packagesDir = path.join(tempDir, "packages");
			const sourceDir = path.join(packagesDir, "pkg-123", "src");
			const nestedDir = path.join(sourceDir, "nested");
			await fs.mkdir(nestedDir, { recursive: true });
			await Bun.write(path.join(sourceDir, "root.ts"), "legacyWrap(rootValue, rootArg)\n");
			await Bun.write(path.join(nestedDir, "child.ts"), "legacyWrap(childValue, childArg)\n");
			await Bun.write(path.join(sourceDir, "ignore.js"), "legacyWrap(ignoreValue, ignoreArg)\n");
			await Bun.write(path.join(tempDir, "outside.ts"), "legacyWrap(outsideValue, outsideArg)\n");
			const queue = new ToolChoiceQueue();

			const tools = await createTools(
				createTestSession(tempDir, {
					getToolChoiceQueue: () => queue,
					buildToolChoice: () => ({ type: "tool" as const, name: "resolve" }),
					steer: () => {},
				}),
				["ast_edit"],
			);
			const tool = tools.find(entry => entry.name === "ast_edit");
			expect(tool).toBeDefined();

			const previewResult = await tool!.execute("ast-edit-glob", {
				ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
				paths: [`${packagesDir}/pkg-*/src/**/*.ts`],
			});

			const text = previewResult.content.find(content => content.type === "text")?.text ?? "";
			const details = previewResult.details as
				| { totalReplacements?: number; fileReplacements?: Array<{ path: string; count: number }> }
				| undefined;

			// Multi-level tree output: `# packages/pkg-…/src/`, `## root.ts#<hash>`, then a
			// nested `## nested/` directory with `### child.ts#<hash>` under it.
			expect(text).toMatch(/^## root\.ts#[0-9A-F]{4} \(\d+ replacement[s]?\)$/m);
			expect(text).toMatch(/^### child\.ts#[0-9A-F]{4} \(\d+ replacement[s]?\)$/m);
			expect(text).not.toContain("ignore.js");
			expect(text).not.toContain("outside.ts");
			expect(details?.totalReplacements).toBe(2);
			expect(details?.fileReplacements).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ path: "packages/pkg-123/src/root.ts", count: 1 }),
					expect.objectContaining({ path: "packages/pkg-123/src/nested/child.ts", count: 1 }),
				]),
			);

			const invoker = queue.peekPendingInvoker()!;
			await invoker({ action: "apply", reason: "apply previewed AST edit with combined globs" });

			expect(await Bun.file(path.join(sourceDir, "root.ts")).text()).toContain("modernWrap(rootValue, rootArg)");
			expect(await Bun.file(path.join(nestedDir, "child.ts")).text()).toContain("modernWrap(childValue, childArg)");
			expect(await Bun.file(path.join(sourceDir, "ignore.js")).text()).toContain(
				"legacyWrap(ignoreValue, ignoreArg)",
			);
			expect(await Bun.file(path.join(tempDir, "outside.ts")).text()).toContain(
				"legacyWrap(outsideValue, outsideArg)",
			);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("infers tlaplus from .tla files for AST edits", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-tlaplus-"));
		try {
			const filePath = path.join(tempDir, "Spec.tla");
			await Bun.write(filePath, `---- MODULE Spec ----\nVARIABLE x\n\nInit == x = 0\n\nNext == x' = x + 1\n====\n`);
			const queue = new ToolChoiceQueue();

			const tools = await createTools(
				createTestSession(tempDir, {
					getToolChoiceQueue: () => queue,
					buildToolChoice: () => ({ type: "tool" as const, name: "resolve" }),
					steer: () => {},
				}),
				["ast_edit"],
			);
			const tool = tools.find(entry => entry.name === "ast_edit");
			expect(tool).toBeDefined();

			const previewResult = await tool!.execute("ast-edit-tlaplus", {
				ops: [{ pat: "Init", out: "Start" }],
				paths: [filePath],
			});

			const text = previewResult.content.find(content => content.type === "text")?.text ?? "";
			const details = previewResult.details as { totalReplacements?: number; parseErrors?: string[] } | undefined;
			expect(text).toContain("Start");
			expect(details?.totalReplacements).toBe(1);
			expect(details?.parseErrors).toBeUndefined();

			const invoker = queue.peekPendingInvoker()!;
			await invoker({ action: "apply", reason: "apply tlaplus AST edit" });
			expect(await Bun.file(filePath).text()).toContain("Start == x = 0");
		} finally {
			await removeWithRetries(tempDir);
		}
	});
});

describe("ast_edit scoped filesystem authorization", () => {
	it("matches native multi-rule variadic-capture rewrites", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-scoped-parity-"));
		const scopedFile = path.join(tempDir, "scoped.ts");
		const nativeFile = path.join(tempDir, "native.ts");
		const source = "const result = legacyWrap(alpha, beta, gamma);\n";
		const ops = [
			{ pat: "legacyWrap($$$ARGS)", out: "intermediateWrap($$$ARGS)" },
			{ pat: "intermediateWrap($$$ARGS)", out: "modernWrap($$$ARGS)" },
		];
		const queue = new ToolChoiceQueue();
		const fixture = createScopedAstEditFixture(tempDir, createAstEditPermissionScope([scopedFile]), queue);
		try {
			await fs.writeFile(scopedFile, source);
			await fs.writeFile(nativeFile, source);
			const native = await astEdit({
				path: nativeFile,
				rewrites: Object.fromEntries(ops.map(op => [op.pat, op.out])),
				dryRun: false,
			});
			const tools = await createTools(fixture.session, ["ast_edit"]);
			const tool = tools.find(entry => entry.name === "ast_edit");
			expect(tool).toBeDefined();
			const preview = await withScopedAstEditOperation(fixture, () =>
				tool!.execute("ast-edit-scoped-parity-preview", { ops, paths: [scopedFile] }),
			);
			expect(preview.details).toMatchObject({ totalReplacements: native.totalReplacements });
			const invoker = queue.peekPendingInvoker()!;
			const applied = await withScopedAstEditOperation(
				fixture,
				async () =>
					(await invoker({ action: "apply", reason: "compare native capture rewrite" })) as InvokedToolResult,
			);
			expect(applied.isError).toBeUndefined();
			expect(await fs.readFile(scopedFile, "utf8")).toBe(await fs.readFile(nativeFile, "utf8"));
		} finally {
			await fixture.close();
			await removeWithRetries(tempDir);
		}
	});

	it("rejects a same-inode source change even when rewrite counts are unchanged", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-scoped-stale-"));
		const sourceFile = path.join(tempDir, "source.ts");
		const queue = new ToolChoiceQueue();
		const fixture = createScopedAstEditFixture(tempDir, createAstEditPermissionScope([sourceFile]), queue);
		try {
			await fs.writeFile(sourceFile, "legacyWrap(a, b)\n");
			const tools = await createTools(fixture.session, ["ast_edit"]);
			const tool = tools.find(entry => entry.name === "ast_edit");
			expect(tool).toBeDefined();
			const preview = await withScopedAstEditOperation(fixture, () =>
				tool!.execute("ast-edit-scoped-stale-preview", {
					ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
					paths: [sourceFile],
				}),
			);
			expect(preview.details).toMatchObject({ totalReplacements: 1 });
			const originalStat = await fs.stat(sourceFile);
			await fs.writeFile(sourceFile, "legacyWrap(c, d)\n");
			expect((await fs.stat(sourceFile)).ino).toBe(originalStat.ino);
			const invoker = queue.peekPendingInvoker()!;
			await expect(
				withScopedAstEditOperation(
					fixture,
					async () => await invoker({ action: "apply", reason: "attempt stale AST rewrite" }),
				),
			).rejects.toThrow("AST edit preview is stale");
			expect(await fs.readFile(sourceFile, "utf8")).toBe("legacyWrap(c, d)\n");
		} finally {
			await fixture.close();
			await removeWithRetries(tempDir);
		}
	});

	it("does not parse a denied no-match nested child during preview or apply", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-scoped-nested-"));
		const sourceDir = path.join(tempDir, "src");
		const nestedDir = path.join(sourceDir, "nested");
		const allowedFile = path.join(sourceDir, "allowed.ts");
		const noMatchFile = path.join(nestedDir, "no-match.ts");
		const malformedFile = path.join(nestedDir, "malformed.ts");
		const queue = new ToolChoiceQueue();
		const fixture = createScopedAstEditFixture(
			tempDir,
			createAstEditPermissionScope([sourceDir, nestedDir, allowedFile]),
			queue,
		);
		try {
			await fs.mkdir(nestedDir, { recursive: true });
			await Bun.write(allowedFile, "legacyWrap(allowedValue, allowedArg)\n");
			await Bun.write(noMatchFile, "export const untouched = 1;\n");
			await Bun.write(malformedFile, "export const = ;\n");

			const tools = await createTools(fixture.session, ["ast_edit"]);
			const tool = tools.find(entry => entry.name === "ast_edit");
			expect(tool).toBeDefined();

			const previewResult = await withScopedAstEditOperation(fixture, () =>
				tool!.execute("ast-edit-scoped-preview", {
					ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
					paths: [sourceDir],
				}),
			);
			const previewDetails = previewResult.details as
				| {
						totalReplacements?: number;
						filesSearched?: number;
						parseErrors?: string[];
						fileReplacements?: Array<{ path: string; count: number }>;
				  }
				| undefined;
			expect(previewDetails?.totalReplacements).toBe(1);
			expect(previewDetails?.filesSearched).toBe(1);
			expect(previewDetails?.parseErrors).toBeUndefined();
			expect(previewDetails?.fileReplacements).toEqual([
				expect.objectContaining({ path: expect.stringMatching(/(?:^|\/)allowed\.ts$/), count: 1 }),
			]);

			const invoker = queue.peekPendingInvoker()!;
			const applyResult = (await withScopedAstEditOperation(
				fixture,
				async () =>
					(await invoker({ action: "apply", reason: "apply authorized AST preview" })) as InvokedToolResult,
			)) as InvokedToolResult;
			const applyText = applyResult.content.find(content => content.type === "text")?.text ?? "";
			const applyDetails = applyResult.details as
				| {
						sourceResultDetails?: { filesSearched?: number; parseErrors?: string[]; totalReplacements?: number };
				  }
				| undefined;
			expect(applyResult.isError).toBeUndefined();
			expect(applyText).toContain("Applied 1 replacement in 1 file.");
			expect(applyDetails?.sourceResultDetails?.totalReplacements).toBe(1);
			expect(applyDetails?.sourceResultDetails?.filesSearched).toBe(1);
			expect(applyDetails?.sourceResultDetails?.parseErrors).toBeUndefined();
			expect(await Bun.file(allowedFile).text()).toContain("modernWrap(allowedValue, allowedArg)");
			expect(await Bun.file(noMatchFile).text()).toBe("export const untouched = 1;\n");
			expect(await Bun.file(malformedFile).text()).toBe("export const = ;\n");
		} finally {
			await fixture.close();
			await removeWithRetries(tempDir);
		}
	});

	it("skips denied nested children under every AST edit root", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-scoped-multi-root-"));
		const firstRoot = path.join(tempDir, "first");
		const secondRoot = path.join(tempDir, "second");
		const firstNested = path.join(firstRoot, "nested");
		const secondNested = path.join(secondRoot, "nested");
		const firstChild = path.join(firstNested, "first.ts");
		const secondChild = path.join(secondNested, "second.ts");
		const fixture = createScopedAstEditFixture(
			tempDir,
			createAstEditPermissionScope([firstRoot, firstNested, secondRoot, secondNested]),
		);
		try {
			await fs.mkdir(firstNested, { recursive: true });
			await fs.mkdir(secondNested, { recursive: true });
			await Bun.write(firstChild, "legacyWrap(firstSecret, firstArg)\n");
			await Bun.write(secondChild, "legacyWrap(secondSecret, secondArg)\n");

			const tools = await createTools(fixture.session, ["ast_edit"]);
			const tool = tools.find(entry => entry.name === "ast_edit");
			expect(tool).toBeDefined();

			const result = await withScopedAstEditOperation(fixture, () =>
				tool!.execute("ast-edit-scoped-multi-root", {
					ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
					paths: [firstRoot, secondRoot],
				}),
			);
			const details = result.details as
				| { totalReplacements?: number; filesSearched?: number; parseErrors?: string[] }
				| undefined;
			expect(details?.totalReplacements).toBe(0);
			expect(details?.filesSearched).toBe(0);
			expect(details?.parseErrors).toBeUndefined();
			expect(await Bun.file(firstChild).text()).toBe("legacyWrap(firstSecret, firstArg)\n");
			expect(await Bun.file(secondChild).text()).toBe("legacyWrap(secondSecret, secondArg)\n");
		} finally {
			await fixture.close();
			await removeWithRetries(tempDir);
		}
	});

	it("authorizes a symlink child by its canonical sensitive target before parsing", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-scoped-canonical-"));
		const sourceDir = path.join(tempDir, "src");
		const nestedDir = path.join(sourceDir, "nested");
		const secretDir = path.join(tempDir, "credentials");
		const aliasPath = path.join(nestedDir, "ordinary.ts");
		const secretPath = path.join(secretDir, "private_key.ts");
		const fixture = createScopedAstEditFixture(
			tempDir,
			createAstEditPermissionScope([sourceDir, nestedDir, aliasPath, secretPath], [secretPath]),
		);
		try {
			await fs.mkdir(nestedDir, { recursive: true });
			await fs.mkdir(secretDir, { recursive: true });
			await Bun.write(secretPath, "legacyWrap(secretValue, secretArg)\n");
			await fs.symlink(secretPath, aliasPath);

			const tools = await createTools(fixture.session, ["ast_edit"]);
			const tool = tools.find(entry => entry.name === "ast_edit");
			expect(tool).toBeDefined();

			const result = await withScopedAstEditOperation(fixture, () =>
				tool!.execute("ast-edit-scoped-canonical-child", {
					ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
					paths: [sourceDir],
				}),
			);
			const details = result.details as
				| { totalReplacements?: number; filesSearched?: number; parseErrors?: string[] }
				| undefined;
			expect(details?.totalReplacements).toBe(0);
			expect(details?.filesSearched).toBe(0);
			expect(details?.parseErrors).toBeUndefined();
			expect(await Bun.file(secretPath).text()).toBe("legacyWrap(secretValue, secretArg)\n");
		} finally {
			await fixture.close();
			await removeWithRetries(tempDir);
		}
	});
});
