import { z } from "zod";
import {
	decryptAutomationCallbackSecret,
	decryptBuildConfigSecret,
	decryptBuildInput,
} from "#/features/builds/secrets";
import { DomainError } from "#/lib/domain-error";
import { encryptSecret } from "#/lib/secrets";
import { isSafeWebhookUrl } from "#/lib/webhook-url";
import { fetchOutbound } from "#/server/outbound-fetch";
import { loadRuntimeConfig } from "#/server/runtime-config";

const providerTimeoutMs = 10_000;
const maxProviderResponseBytes = 256 * 1024;

type Job = {
	id: string;
	status: string;
	automation_config_id: string;
	repository_owner: string;
	repository_name: string;
	branch: string;
	workflow_file: string;
	callback_secret_encrypted: string;
	timeout_at: number;
	attempt_count: number;
	credential_encrypted: string;
	provider: "github_actions" | "gitlab_ci";
	provider_base_url: string;
};

export async function dispatchBuild(
	db: D1Database,
	automationJobId: string,
	fetcher: typeof fetch = fetch,
) {
	const now = Date.now();
	const job = await db
		.prepare(
			`SELECT bj.id, bj.status, bj.sellable_item_id AS automation_config_id,
			 bj.provider, bj.provider_base_url,
			 bj.repository_owner,
			 bj.repository_name, bj.branch, bj.workflow_file,
			 bj.callback_secret_encrypted, bj.timeout_at, bj.attempt_count,
			 item.automation_credential_encrypted AS credential_encrypted
			 FROM automation_jobs bj
			 JOIN product_sellable_items item ON item.id = bj.sellable_item_id
			 WHERE bj.id = ? LIMIT 1`,
		)
		.bind(automationJobId)
		.first<Job>();
	if (!job)
		throw new DomainError(
			"automation_job_not_found",
			404,
			"Automation job not found",
		);
	if (job.status === "running" || job.status === "succeeded")
		return { id: job.id, status: job.status, duplicate: true };
	if (job.timeout_at <= now) {
		await db
			.prepare(
				"UPDATE automation_jobs SET status = 'expired', completed_at = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'dispatching')",
			)
			.bind(now, now, job.id)
			.run();
		throw new DomainError(
			"automation_job_expired",
			409,
			"Automation job expired",
		);
	}
	const claimed = await db
		.prepare(
			`UPDATE automation_jobs SET status = 'dispatching', attempt_count = attempt_count + 1,
			 updated_at = ? WHERE id = ? AND status IN ('queued', 'failed')
			 AND (next_attempt_at IS NULL OR next_attempt_at <= ?) AND attempt_count < 5`,
		)
		.bind(now, job.id, now)
		.run();
	if (Number(claimed.meta.changes ?? 0) !== 1) {
		// A failed claim is either a concurrent dispatcher (retry later) or a job
		// that can no longer be dispatched at all (exhausted attempts, terminal
		// state, not yet due) — only the former is worth another attempt.
		const current = await db
			.prepare(
				"SELECT status, attempt_count, next_attempt_at FROM automation_jobs WHERE id = ? LIMIT 1",
			)
			.bind(job.id)
			.first<{
				status: string;
				attempt_count: number;
				next_attempt_at: number | null;
			}>();
		const dispatchable =
			current !== null &&
			(current.status === "queued" || current.status === "failed") &&
			current.attempt_count < 5;
		if (!dispatchable)
			throw new DomainError(
				"automation_job_not_dispatchable",
				409,
				"Automation job can no longer be dispatched",
			);
		throw new DomainError(
			"automation_job_busy",
			409,
			"Automation job is being dispatched by another worker",
			{ retryable: true },
		);
	}
	const runtime = await loadRuntimeConfig(db);
	if (!runtime.commerceSecret || !runtime.betterAuthUrl)
		throw new DomainError(
			"automation_runtime_unavailable",
			503,
			"Build runtime configuration is unavailable",
		);
	const callbackUrl = callbackBaseUrl(runtime.betterAuthUrl);
	const [credential, callbackSecret, inputBundle] = await Promise.all([
		decryptBuildConfigSecret(job.credential_encrypted, runtime.commerceSecret),
		decryptAutomationCallbackSecret(
			job.callback_secret_encrypted,
			runtime.commerceSecret,
		),
		loadBuildInputs(db, job.id, runtime.commerceSecret),
	]);
	const encryptedPayload = await encryptSecret(
		JSON.stringify(inputBundle.inputs),
		callbackSecret,
	);
	const request = providerDispatchRequest(
		job,
		credential,
		callbackUrl,
		encryptedPayload,
	);
	let response: Response;
	try {
		response = await fetchOutbound(request.url, request.init, {
			fetcher,
			timeoutMs: providerTimeoutMs,
			maxResponseBytes: maxProviderResponseBytes,
			// Injected fetchers (tests) never reach the network; the real fetch
			// must prove the administrator-configured host is public.
			validateDestination: fetcher === fetch,
		});
	} catch (error) {
		await recordDispatchFailure(
			db,
			job,
			dispatchFailureCode(error instanceof DomainError ? error.code : null),
		);
		throw new DomainError(
			"automation_provider_unreachable",
			503,
			"Build provider is unreachable",
		);
	}
	if (!request.acceptedStatuses.includes(response.status)) {
		await recordDispatchFailure(db, job, `provider_http_${response.status}`);
		throw new DomainError(
			"automation_provider_rejected",
			502,
			"Build provider rejected the request",
		);
	}
	const providerResult = await providerDispatchResult(job, response);
	await db.batch([
		db
			.prepare(
				`UPDATE automation_jobs SET status = 'running', provider_job_id = ?, started_at = ?,
				 run_url = ?, failure_code = NULL, next_attempt_at = NULL, updated_at = ?
				 WHERE id = ? AND status = 'dispatching'`,
			)
			.bind(
				providerResult.providerJobId,
				now,
				providerResult.runUrl,
				now,
				job.id,
			),
		db
			.prepare(
				`INSERT INTO audit_logs
				 (id, action, target_type, target_id, after, created_at)
				 SELECT ?, 'automation.authorization_consumed', 'automation_job', id, ?, ?
				 FROM automation_jobs WHERE id = ? AND status = 'running'`,
			)
			.bind(
				crypto.randomUUID(),
				JSON.stringify({ authorizationKeys: inputBundle.authorizationKeys }),
				now,
				job.id,
			),
	]);
	return { id: job.id, status: "running", duplicate: false };
}

export const dispatchGitHubActionsBuild = dispatchBuild;

const gitLabPipelineSchema = z.object({
	id: z.union([z.string(), z.number()]),
	web_url: z.url(),
});

type ProviderDispatchRequest = {
	url: string;
	acceptedStatuses: number[];
	init: RequestInit;
};

function providerDispatchRequest(
	job: Job,
	credential: string,
	callbackUrl: string,
	encryptedPayload: string,
): ProviderDispatchRequest {
	const baseUrl = new URL(job.provider_base_url);
	if (baseUrl.protocol !== "https:" || !isSafeWebhookUrl(job.provider_base_url))
		throw new DomainError(
			"automation_provider_url_invalid",
			503,
			"Build provider URL must be a safe public HTTPS URL",
		);
	const callback = `${callbackUrl}/api/shop/automation/callback`;
	const artifactUploadUrl = `${callbackUrl}/api/shop/automation/${encodeURIComponent(job.id)}/artifacts`;
	if (job.provider === "gitlab_ci") {
		const project = encodeURIComponent(
			`${job.repository_owner}/${job.repository_name}`,
		);
		return {
			url: new URL(`/api/v4/projects/${project}/pipeline`, baseUrl).toString(),
			acceptedStatuses: [201],
			init: {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"PRIVATE-TOKEN": credential,
					"User-Agent": "GMShop-Edge",
				},
				body: JSON.stringify({
					ref: job.branch,
					variables: [
						{ key: "GMSHOP_JOB_ID", value: job.id },
						{ key: "GMSHOP_CALLBACK_URL", value: callback },
						{
							key: "GMSHOP_ARTIFACT_UPLOAD_URL",
							value: artifactUploadUrl,
						},
						{ key: "GMSHOP_PAYLOAD_ENCRYPTED", value: encryptedPayload },
					],
				}),
			} satisfies RequestInit,
		};
	}
	return {
		url: new URL(
			`/repos/${encodeURIComponent(job.repository_owner)}/${encodeURIComponent(job.repository_name)}/actions/workflows/${encodeURIComponent(job.workflow_file)}/dispatches`,
			baseUrl,
		).toString(),
		acceptedStatuses: [204],
		init: {
			method: "POST",
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${credential}`,
				"Content-Type": "application/json",
				"User-Agent": "GMShop-Edge",
				"X-GitHub-Api-Version": "2022-11-28",
			},
			body: JSON.stringify({
				ref: job.branch,
				inputs: {
					gmshop_job_id: job.id,
					gmshop_callback_url: callback,
					gmshop_artifact_upload_url: artifactUploadUrl,
					gmshop_payload_encrypted: encryptedPayload,
				},
			}),
		} satisfies RequestInit,
	};
}

async function providerDispatchResult(job: Job, response: Response) {
	if (job.provider === "gitlab_ci") {
		const pipeline = gitLabPipelineSchema.parse(await response.json());
		return { providerJobId: String(pipeline.id), runUrl: pipeline.web_url };
	}
	return {
		providerJobId: job.id,
		runUrl: `https://github.com/${encodeURIComponent(job.repository_owner)}/${encodeURIComponent(job.repository_name)}/actions`,
	};
}

async function loadBuildInputs(
	db: D1Database,
	jobId: string,
	commerceSecret: string,
) {
	const rows = await db
		.prepare(
			`SELECT inputs_json, sensitive_inputs_json FROM automation_jobs
			 WHERE id = ? LIMIT 1`,
		)
		.bind(jobId)
		.first<{ inputs_json: string; sensitive_inputs_json: string }>();
	if (!rows)
		throw new DomainError(
			"automation_job_not_found",
			404,
			"Automation job not found",
		);
	const stored = parseInputObject(rows.inputs_json);
	const sensitive = parseInputObject(rows.sensitive_inputs_json);
	const inputs: Record<string, string> = {};
	const authorizationKeys: string[] = [];
	const authorizationIds = Object.entries(stored).flatMap(([key, value]) => {
		const authorizationValueId =
			value &&
			typeof value === "object" &&
			typeof (value as { authorizationValueId?: unknown })
				.authorizationValueId === "string"
				? String(
						(value as { authorizationValueId: string }).authorizationValueId,
					)
				: null;
		return authorizationValueId ? [{ key, id: authorizationValueId }] : [];
	});
	if (authorizationIds.length) {
		const values = await db
			.prepare(
				`SELECT id, value_encrypted FROM entitlement_authorization_values
				 WHERE id IN (${authorizationIds.map(() => "?").join(", ")})`,
			)
			.bind(...authorizationIds.map((item) => item.id))
			.all<{ id: string; value_encrypted: string }>();
		const encryptedById = new Map(
			values.results.map((value) => [value.id, value.value_encrypted]),
		);
		for (const authorization of authorizationIds) {
			const encrypted = encryptedById.get(authorization.id);
			if (!encrypted)
				throw new DomainError(
					"automation_authorization_unavailable",
					409,
					"Automation authorization is unavailable",
				);
			inputs[authorization.key] = await decryptBuildInput(
				encrypted,
				commerceSecret,
			);
			authorizationKeys.push(authorization.key);
		}
	}
	for (const [key, value] of Object.entries(stored))
		if (
			!authorizationKeys.includes(key) &&
			value &&
			typeof value === "object" &&
			typeof (value as { value?: unknown }).value === "string"
		)
			inputs[key] = String((value as { value: string }).value);
	for (const [key, value] of Object.entries(sensitive)) {
		const envelope =
			value &&
			typeof value === "object" &&
			typeof (value as { envelope?: unknown }).envelope === "string"
				? String((value as { envelope: string }).envelope)
				: null;
		if (envelope)
			inputs[key] = await decryptBuildInput(envelope, commerceSecret);
	}
	return { inputs, authorizationKeys };
}

function parseInputObject(value: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(value);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
			return parsed as Record<string, unknown>;
	} catch {
		// Corrupt job snapshots fail closed.
	}
	throw new DomainError(
		"automation_input_snapshot_invalid",
		500,
		"Automation input snapshot is invalid",
	);
}

function dispatchFailureCode(outboundCode: string | null) {
	switch (outboundCode) {
		case "outbound_redirect_rejected":
			return "provider_redirect_rejected";
		case "outbound_destination_rejected":
		case "outbound_url_rejected":
			return "provider_destination_rejected";
		case "outbound_dns_unavailable":
			return "provider_dns_unavailable";
		case "outbound_response_too_large":
			return "provider_response_too_large";
		default:
			return "provider_unreachable";
	}
}

async function recordDispatchFailure(db: D1Database, job: Job, code: string) {
	const now = Date.now();
	const attempt = job.attempt_count + 1;
	const terminal = attempt >= 5;
	await db
		.prepare(
			`UPDATE automation_jobs SET status = ?, failure_code = ?, next_attempt_at = ?,
			 completed_at = CASE WHEN ? THEN ? ELSE completed_at END, updated_at = ?
			 WHERE id = ? AND status = 'dispatching'`,
		)
		.bind(
			terminal ? "failed" : "queued",
			code,
			terminal ? null : now + Math.min(60_000, 2 ** attempt * 1_000),
			terminal ? 1 : 0,
			now,
			now,
			job.id,
		)
		.run();
}

function callbackBaseUrl(value: string) {
	const url = new URL(value);
	const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
	if (url.protocol !== "https:" && !(local && url.protocol === "http:"))
		throw new DomainError(
			"automation_callback_url_invalid",
			503,
			"Build callback URL must use HTTPS",
		);
	return url.origin;
}
