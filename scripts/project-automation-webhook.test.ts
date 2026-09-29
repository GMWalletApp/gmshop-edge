import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = join(
	dirname(fileURLToPath(import.meta.url)),
	"project-automation-webhook.ts",
);
const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

async function runWebhook(
	eventName: string,
	context: Record<string, unknown> = {},
	dryRun = false,
) {
	const cwd = mkdtempSync(join(tmpdir(), "project-automation-"));
	temporaryDirectories.push(cwd);
	mkdirSync(join(cwd, ".automation"));
	writeFileSync(join(cwd, ".automation/context.json"), JSON.stringify(context));

	let captured: { headers: Headers; body: string } | undefined;
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk) => chunks.push(chunk));
		request.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			captured = {
				headers: new Headers(request.headers as Record<string, string>),
				body,
			};
			response.writeHead(202, { "content-type": "application/json" });
			response.end('{"ok":true,"accepted":true}');
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Test server did not bind");

	const child = spawn(process.execPath, ["run", scriptPath], {
		cwd,
		env: {
			...process.env,
			AUTOMATION_WEBHOOK_URL: `http://127.0.0.1:${address.port}/webhook`,
			AUTOMATION_WEBHOOK_SECRET: "test-secret",
			AUTOMATION_DRY_RUN: String(dryRun),
			GITHUB_EVENT_NAME: eventName,
			GITHUB_EVENT_ACTION: "opened",
			GITHUB_REPOSITORY: "GMWalletApp/gmshop-edge",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const exitCode = await new Promise<number | null>((resolve) =>
		child.on("exit", resolve),
	);
	server.close();
	if (exitCode !== 0) throw new Error(stderr);
	if (!captured) throw new Error("Webhook request was not captured");
	return { ...captured, payload: JSON.parse(captured.body) };
}

describe("project automation webhook", () => {
	test("signs the exact body with the generic signature header", async () => {
		const request = await runWebhook("issues", { trigger: {} });
		const expected = `sha256=${createHmac("sha256", "test-secret").update(request.body).digest("hex")}`;
		expect(request.headers.get("x-webhook-signature-256")).toBe(expected);
		expect(request.payload.routeId).toBe("gmwalletapp-gmshop-edge-triage");
		expect(request.payload.eventType).toBe("triage.issue");
	});

	test("classifies pull request comments as pull request triage", async () => {
		const request = await runWebhook("issue_comment", {
			trigger: { issue: { pullRequest: true } },
		});
		expect(request.payload.eventType).toBe("triage.pull_request");
	});

	test("classifies scheduled scans and makes dry runs non-dispatching", async () => {
		const request = await runWebhook(
			"workflow_dispatch",
			{ trigger: {} },
			true,
		);
		expect(request.payload.eventType).toBe("triage.repository");
		expect(request.payload.dryRun).toBe(true);
		expect(request.payload.context.test).toBe(true);
	});

	test("bounds large GitHub context before dispatch", async () => {
		const hugeBody = "x".repeat(200_000);
		const request = await runWebhook("pull_request_target", {
			trigger: {
				pullRequest: { number: 42, title: "Dependency update", body: hugeBody },
			},
			openIssues: Array.from({ length: 100 }, (_, index) => ({
				number: index + 1,
				title: `Issue ${index + 1}`,
				body: hugeBody,
				url: `https://example.test/issues/${index + 1}`,
			})),
			openPullRequests: [],
		});

		expect(Buffer.byteLength(request.body)).toBeLessThanOrEqual(32 * 1024);
		expect(request.payload.context.trigger.pullRequest.number).toBe(42);
		expect(request.payload.context.trigger.pullRequest.body).toEndWith(
			"\n[truncated]",
		);
		expect(request.payload.context.openIssues[0]).not.toHaveProperty("body");
	});
});
