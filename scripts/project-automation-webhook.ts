import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const webhookUrl = process.env.AUTOMATION_WEBHOOK_URL;
const webhookSecret = process.env.AUTOMATION_WEBHOOK_SECRET;
const repo = process.env.GITHUB_REPOSITORY || "GMWalletApp/gmshop-edge";

if (!(webhookUrl && webhookSecret)) {
	throw new Error(
		"AUTOMATION_WEBHOOK_URL and AUTOMATION_WEBHOOK_SECRET are required",
	);
}

type JsonRecord = Record<string, unknown>;

const MAX_BODY_CHARS = 8_000;
const MAX_CONTEXT_BYTES = 32 * 1024;

const originalContext = JSON.parse(
	readFileSync(".automation/context.json", "utf8"),
) as JsonRecord;
const triggerKind = process.env.GITHUB_EVENT_NAME || "unknown";

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateText(value: unknown, maxChars = MAX_BODY_CHARS) {
	if (typeof value !== "string" || value.length <= maxChars) return value;
	return `${value.slice(0, maxChars)}\n[truncated]`;
}

function copyRecord(value: unknown) {
	return isRecord(value) ? { ...value } : null;
}

function withoutBody(value: unknown) {
	const item = copyRecord(value);
	if (!item) return value;
	delete item.body;
	return item;
}

function withTruncatedBody(value: unknown) {
	const item = copyRecord(value);
	if (!item) return value;
	item.body = truncateText(item.body);
	return item;
}

function compactContext(context: JsonRecord, includeTest: boolean) {
	const compacted: JsonRecord = { ...context };
	const trigger = copyRecord(context.trigger);
	if (trigger) {
		compacted.trigger = {
			...trigger,
			issue: withTruncatedBody(trigger.issue),
			pullRequest: withTruncatedBody(trigger.pullRequest),
			comment: withTruncatedBody(trigger.comment),
		};
	}
	compacted.openIssues = Array.isArray(context.openIssues)
		? context.openIssues.map(withoutBody)
		: context.openIssues;
	compacted.openPullRequests = Array.isArray(context.openPullRequests)
		? context.openPullRequests.map(withoutBody)
		: context.openPullRequests;
	if (includeTest) compacted.test = true;
	return compacted;
}

const dryRun = process.env.AUTOMATION_DRY_RUN === "true";
const context = compactContext(originalContext, dryRun);
const trigger = copyRecord(context.trigger);
const triggerIssue = copyRecord(trigger?.issue);
const isPullRequest =
	triggerKind === "pull_request_target" ||
	Boolean(trigger?.pullRequest) ||
	Boolean(triggerIssue?.pullRequest);
const eventType = ["schedule", "workflow_dispatch"].includes(triggerKind)
	? "triage.repository"
	: isPullRequest
		? "triage.pull_request"
		: "triage.issue";

const payload = {
	routeId: "gmwalletapp-gmshop-edge-triage",
	eventType,
	repo,
	dryRun,
	source: "github-actions",
	trigger: {
		kind: triggerKind,
		eventName: triggerKind,
		eventAction: process.env.GITHUB_EVENT_ACTION || "",
	},
	context,
};

const rawBody = JSON.stringify(payload);
if (Buffer.byteLength(rawBody) > MAX_CONTEXT_BYTES) {
	throw new Error(
		`Automation webhook payload exceeds ${MAX_CONTEXT_BYTES} bytes after compaction`,
	);
}
const signature = `sha256=${createHmac("sha256", webhookSecret).update(rawBody).digest("hex")}`;

for (let attempt = 1; attempt <= 3; attempt++) {
	try {
		const response = await fetch(webhookUrl, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-webhook-signature-256": signature,
			},
			body: rawBody,
			signal: AbortSignal.timeout(30_000),
		});

		if (response.ok) {
			console.log(await response.text());
			process.exit(0);
		}

		const text = await response.text();
		if (response.status < 500 || attempt === 3) {
			throw new Error(`Webhook request failed: ${response.status} ${text}`);
		}
	} catch (error) {
		if (attempt === 3) throw error;
	}

	await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
}
