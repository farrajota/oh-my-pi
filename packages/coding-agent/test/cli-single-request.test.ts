import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createServer, type Server } from "node:http";
import { TempDir } from "@oh-my-pi/pi-utils";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const cliEntry = path.join(repoRoot, "packages/coding-agent/src/cli.ts");
const FIXTURE_API_KEY = "single-request-fixture-only";
const PRIMARY_MODEL = "gpt-6.1-sol";
const PRIMARY_SELECTOR = `cliproxy-codex/${PRIMARY_MODEL}:medium`;
const REQUEST_PATH = "/v1/codex/responses";
const GUARD_REPORT =
	"single-request guard effective: adapter=openai-codex-responses dispatch-budget=1 fetch-budget=1 selector-match=true destination-match=false";

type FixtureResponse = "503" | "transport" | "redirect" | "success";

interface CapturedRequest {
	method: string;
	path: string;
	model: string | null;
}

interface LaunchRun {
	exitCode: number;
	stdout: string;
	stderr: string;
}

interface ResponsesFixture {
	baseUrl: string;
	requests: CapturedRequest[];
	close(): Promise<void>;
}

async function createResponsesFixture(reply: FixtureResponse): Promise<ResponsesFixture> {
	const requests: CapturedRequest[] = [];
	const server: Server = createServer((request, response) => {
		void (async () => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) {
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			}
			const body = Buffer.concat(chunks).toString("utf8");
			let model: string | null = null;
			let malformedJson = false;
			if (body.length > 0) {
				try {
					const parsed: unknown = JSON.parse(body);
					if (typeof parsed === "object" && parsed !== null && "model" in parsed) {
						const value = parsed.model;
						model = typeof value === "string" ? value : null;
					}
				} catch {
					malformedJson = true;
				}
			}
			requests.push({ method: request.method ?? "", path: request.url ?? "", model });
			if (malformedJson) {
				response.writeHead(400).end();
				return;
			}
			if (request.method !== "POST" || request.url !== REQUEST_PATH) {
				response.writeHead(404).end();
				return;
			}
			switch (reply) {
				case "503":
					response.writeHead(503, { "content-type": "application/json" });
					response.end(JSON.stringify({ error: { message: "fixture unavailable", type: "server_error" } }));
					return;
				case "transport":
					response.destroy();
					return;
				case "redirect":
					response.writeHead(302, { location: "/v1/codex/redirect-target" }).end();
					return;
				case "success": {
					const text = "HELLO_WORLD";
					const events = [
						{
							type: "response.output_item.added",
							output_index: 0,
							item: {
								type: "message",
								id: "msg_1",
								role: "assistant",
								phase: "final_answer",
								status: "in_progress",
								content: [],
							},
						},
						{
							type: "response.content_part.added",
							item_id: "msg_1",
							output_index: 0,
							content_index: 0,
							part: { type: "output_text", text: "" },
						},
						{
							type: "response.output_text.delta",
							item_id: "msg_1",
							output_index: 0,
							content_index: 0,
							delta: text,
						},
						{
							type: "response.output_item.done",
							output_index: 0,
							item: {
								type: "message",
								id: "msg_1",
								role: "assistant",
								phase: "final_answer",
								status: "completed",
								content: [{ type: "output_text", text }],
							},
						},
						{
							type: "response.completed",
							response: {
								status: "completed",
								usage: {
									input_tokens: 5,
									output_tokens: 1,
									total_tokens: 6,
									input_tokens_details: { cached_tokens: 0 },
								},
							},
						},
					];
					response.writeHead(200, {
						"cache-control": "no-cache",
						connection: "close",
						"content-type": "text/event-stream",
					});
					response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
					return;
				}
			}
		})().catch(() => response.destroy());
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("loopback fixture did not bind a TCP port");
	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		requests,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close(error => (error ? reject(error) : resolve()));
			}),
	};
}

async function configureAgent(
	tempDir: TempDir,
	fixture: ResponsesFixture,
): Promise<{ agentDir: string; home: string }> {
	const agentDir = tempDir.join("agent");
	const home = tempDir.join("home");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(home, { recursive: true });
	await Bun.write(
		path.join(agentDir, "models.yml"),
		[
			"providers:",
			"  cliproxy-codex:",
			`    baseUrl: ${fixture.baseUrl}`,
			`    apiKey: ${FIXTURE_API_KEY}`,
			"    api: openai-codex-responses",
			"    auth: apiKey",
			"    models:",
			`      - id: \"${PRIMARY_MODEL}\"`,
			"        name: Guard fixture primary",
			"        reasoning: true",
			"        input: [text]",
			"        contextWindow: 128000",
			"        maxTokens: 8192",
			"        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }",
			"      - id: gpt-6.1-sol-fallback",
			"        name: Guard fixture fallback",
			"        reasoning: true",
			"        input: [text]",
			"        contextWindow: 128000",
			"        maxTokens: 8192",
			"        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }",
			"",
		].join("\n"),
	);
	await Bun.write(
		path.join(agentDir, "config.yml"),
		[
			"modelRoles:",
			`  default: "${PRIMARY_SELECTOR}"`,
			`  advisor: "${PRIMARY_SELECTOR}"`,
			"retry:",
			"  enabled: true",
			"  maxRetries: 3",
			"  repeated:",
			"    enabled: true",
			"  waitForUsageReset: true",
			"  modelFallback: true",
			"  usageAwareFallback: true",
			"  fallbackChains:",
			"    default:",
			"      - cliproxy-codex/gpt-6.1-sol-fallback",
			"features:",
			"  unexpectedStopDetection: smart",
			"advisor:",
			"  enabled: true",
			"autolearn:",
			"  enabled: true",
			"  autoContinue: true",
			"  minToolCalls: 0",
			"providers:",
			"  cacheWarming: streaming",
			'  openaiWebsockets: "on"',
			"",
		].join("\n"),
	);
	return { agentDir, home };
}

async function runGuardedCli(
	tempDir: TempDir,
	agentDir: string,
	home: string,
	websocketEnv?: string,
): Promise<LaunchRun> {
	const cwd = tempDir.join("cwd");
	fs.mkdirSync(cwd, { recursive: true });
	const env: Record<string, string | undefined> = {
		PATH: process.env.PATH,
		TMPDIR: process.env.TMPDIR,
		TMP: process.env.TMP,
		TEMP: process.env.TEMP,
		SystemRoot: process.env.SystemRoot,
		WINDIR: process.env.WINDIR,
		HOME: home,
		USERPROFILE: home,
		NO_COLOR: "1",
		NODE_ENV: "test",
		AWS_EC2_METADATA_DISABLED: "true",
		OMP_SKIP_SETUP: "1",
		PI_CODING_AGENT_DIR: agentDir,
		PI_SINGLE_REQUEST_TEST_LOOPBACK: "1",
	};
	if (websocketEnv !== undefined) env.PI_CODEX_WEBSOCKET = websocketEnv;
	const proc = Bun.spawn(
		[
			process.execPath,
			cliEntry,
			"--no-session",
			"--no-tools",
			"--no-extensions",
			"--no-skills",
			"--no-rules",
			"--no-title",
			"--single-request",
			"--mode",
			"text",
			"--max-time",
			"60s",
			"-p",
			"say HELLO_WORLD",
		],
		{
			cwd,
			env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

describe("--single-request CLI guard", () => {
	it("does not retry or fall back after an HTTP 503", async () => {
		using tempDir = TempDir.createSync("@omp-single-request-503-");
		const fixture = await createResponsesFixture("503");
		try {
			const { agentDir, home } = await configureAgent(tempDir, fixture);
			const run = await runGuardedCli(tempDir, agentDir, home);
			expect(run.exitCode).not.toBe(0);
			expect(run.stderr).toContain(GUARD_REPORT);
			expect(run.stderr).not.toContain(FIXTURE_API_KEY);
			expect(fixture.requests).toEqual([{ method: "POST", path: REQUEST_PATH, model: PRIMARY_MODEL }]);
		} finally {
			await fixture.close();
		}
	}, 120_000);

	it("does not replay a failed transport request", async () => {
		using tempDir = TempDir.createSync("@omp-single-request-transport-");
		const fixture = await createResponsesFixture("transport");
		try {
			const { agentDir, home } = await configureAgent(tempDir, fixture);
			const run = await runGuardedCli(tempDir, agentDir, home);
			expect(run.exitCode).not.toBe(0);
			expect(run.stderr).toContain(GUARD_REPORT);
			expect(run.stderr).not.toContain(FIXTURE_API_KEY);
			expect(fixture.requests).toEqual([{ method: "POST", path: REQUEST_PATH, model: PRIMARY_MODEL }]);
		} finally {
			await fixture.close();
		}
	}, 120_000);

	it("rejects a redirect without following it or recovering on a second request", async () => {
		using tempDir = TempDir.createSync("@omp-single-request-redirect-");
		const fixture = await createResponsesFixture("redirect");
		try {
			const { agentDir, home } = await configureAgent(tempDir, fixture);
			const run = await runGuardedCli(tempDir, agentDir, home);
			expect(run.exitCode).not.toBe(0);
			expect(run.stderr).toContain(GUARD_REPORT);
			expect(run.stderr).not.toContain(FIXTURE_API_KEY);
			expect(fixture.requests).toEqual([{ method: "POST", path: REQUEST_PATH, model: PRIMARY_MODEL }]);
		} finally {
			await fixture.close();
		}
	}, 120_000);

	it("returns the exact successful response with one primary-model request", async () => {
		using tempDir = TempDir.createSync("@omp-single-request-success-");
		const fixture = await createResponsesFixture("success");
		try {
			const { agentDir, home } = await configureAgent(tempDir, fixture);
			const run = await runGuardedCli(tempDir, agentDir, home);
			expect(run.exitCode, run.stderr).toBe(0);
			expect(run.stdout.split(/\r?\n/).filter(line => line === "HELLO_WORLD")).toHaveLength(1);
			expect(run.stderr).toContain(GUARD_REPORT);
			expect(run.stderr).not.toContain(FIXTURE_API_KEY);
			expect(fixture.requests).toEqual([{ method: "POST", path: REQUEST_PATH, model: PRIMARY_MODEL }]);
		} finally {
			await fixture.close();
		}
	}, 120_000);

	it("fails closed before network when Codex WebSockets are explicitly enabled by the environment", async () => {
		using tempDir = TempDir.createSync("@omp-single-request-websocket-");
		const fixture = await createResponsesFixture("success");
		try {
			const { agentDir, home } = await configureAgent(tempDir, fixture);
			const run = await runGuardedCli(tempDir, agentDir, home, "true");
			expect(run.exitCode).not.toBe(0);
			expect(run.stderr).toContain(
				"Single-request guard cannot use Codex WebSockets when enabled by the environment.",
			);
			expect(run.stderr).not.toContain(FIXTURE_API_KEY);
			expect(fixture.requests).toEqual([]);
		} finally {
			await fixture.close();
		}
	}, 120_000);
});
