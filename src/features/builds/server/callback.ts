import { z } from "zod";
import { decryptAutomationCallbackSecret } from "#/features/builds/secrets";
import {
	constantTimeEqual,
	hmacSha256Hex,
	parseTimestampedSignature,
} from "#/features/shop-payments/signature";
import { DomainError } from "#/lib/domain-error";
import { loadRuntimeConfig } from "#/server/runtime-config";

const callbackSchema = z.object({
	jobId: z.uuid(),
	status: z.enum(["running", "succeeded", "failed"]),
	providerJobId: z.string().trim().min(1).max(255).optional(),
	runUrl: z.url().max(2_000).optional(),
	failureCode: z.string().trim().min(1).max(120).optional(),
});

const artifactSchema = z.object({
	jobId: z.uuid(),
	artifactId: z.uuid(),
	fileName: z
		.string()
		.trim()
		.min(1)
		.max(255)
		.refine((value) =>
			[...value].every((character) => {
				const codePoint = character.codePointAt(0) ?? 0;
				return (
					codePoint >= 32 &&
					codePoint !== 127 &&
					character !== "/" &&
					character !== "\\"
				);
			}),
		),
	contentType: z.string().trim().min(1).max(255),
});

type CallbackJob = {
	id: string;
	status: string;
	provider: string;
	provider_job_id: string | null;
	callback_secret_encrypted: string;
	artifact_policy: "none" | "optional" | "required";
	output_pattern: string;
};

export async function processAutomationCallback(
	db: D1Database,
	rawBody: string,
	signatureHeader: string,
	now = Date.now(),
) {
	const input = callbackSchema.parse(JSON.parse(rawBody));
	const job = await loadCallbackJob(db, input.jobId);
	const secret = await callbackSecret(db, job);
	await verifySignature(secret, signatureHeader, rawBody, now);
	assertProviderJobOwnership(job, input.providerJobId);
	if (job.status === input.status) {
		await db
			.prepare(
				`UPDATE automation_jobs SET
				 provider_job_id = COALESCE(?, provider_job_id),
				 run_url = COALESCE(?, run_url),
				 started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END,
				 updated_at = ? WHERE id = ? AND status = ?`,
			)
			.bind(
				input.providerJobId ?? null,
				input.runUrl ?? null,
				input.status,
				now,
				now,
				job.id,
				input.status,
			)
			.run();
		return { id: job.id, status: input.status, duplicate: true };
	}
	const completedAt = input.status === "running" ? null : now;
	if (input.status === "succeeded" && job.artifact_policy === "required") {
		const artifact = await db
			.prepare(
				"SELECT 1 AS present FROM automation_artifacts WHERE automation_job_id = ? AND upload_status = 'ready' AND download_enabled = 1 AND deleted_at IS NULL LIMIT 1",
			)
			.bind(job.id)
			.first<{ present: number }>();
		if (!artifact)
			throw new DomainError(
				"automation_artifact_required",
				409,
				"A successful automation run must have an uploaded artifact",
			);
	}
	const nextStatus = input.status;
	const results = await db.batch([
		db
			.prepare(
				`UPDATE automation_jobs SET status = ?, provider_job_id = COALESCE(?, provider_job_id),
				 run_url = COALESCE(?, run_url), failure_code = ?,
				 started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END,
				 completed_at = ?, updated_at = ? WHERE id = ?
				 AND status IN ('dispatching', 'running')`,
			)
			.bind(
				nextStatus,
				input.providerJobId ?? null,
				input.runUrl ?? null,
				input.status === "failed"
					? (input.failureCode ?? "provider_failed")
					: null,
				nextStatus,
				now,
				completedAt,
				now,
				job.id,
			),
		db
			.prepare(
				`INSERT INTO outbox_events
				 (id, event_type, aggregate_type, aggregate_id, idempotency_key, payload,
				  status, attempt_count, created_at, updated_at)
				 SELECT ?, ?, 'automation_job', id, ?, ?, 'pending', 0, ?, ? FROM automation_jobs
				 WHERE id = ? AND status = ? AND ? <> 'running'
				 ON CONFLICT(idempotency_key) DO NOTHING`,
			)
			.bind(
				crypto.randomUUID(),
				`automation.${nextStatus}`,
				`automation-callback:${job.id}:${nextStatus}`,
				JSON.stringify({ automationJobId: job.id, status: nextStatus }),
				now,
				now,
				job.id,
				nextStatus,
				nextStatus,
			),
		db
			.prepare(
				`INSERT INTO shop_order_events
				 (id, order_id, event_type, visibility, actor_type, created_at)
				 SELECT ?, oi.order_id, ?, 'customer', 'system', ? FROM automation_jobs bj
				 JOIN shop_order_items oi ON oi.id = bj.order_item_id
				 WHERE bj.id = ? AND bj.status = ? AND ? <> 'running'
				 ON CONFLICT(id) DO NOTHING`,
			)
			.bind(
				`automation-event:${job.id}:${nextStatus}`,
				`automation_${nextStatus}`,
				now,
				job.id,
				nextStatus,
				nextStatus,
			),
	]);
	if (Number(results[0]?.meta.changes ?? 0) !== 1) {
		throw new DomainError(
			"automation_status_conflict",
			409,
			"Automation status cannot be changed",
		);
	}
	return { id: job.id, status: nextStatus, duplicate: false };
}

export async function uploadAutomationArtifact(
	db: D1Database,
	bucket: {
		put(
			key: string,
			value: Uint8Array<ArrayBuffer>,
			options: { httpMetadata: { contentType: string } },
		): Promise<unknown>;
		delete(key: string): Promise<unknown>;
	},
	rawInput: unknown,
	bodySource: ArrayBuffer | (() => Promise<ArrayBuffer>),
	signatureHeader: string,
	now = Date.now(),
) {
	const input = artifactSchema.parse(rawInput);
	// Everything that can be checked without the body happens first, so an
	// anonymous caller cannot make the server buffer 100 MiB for a job that is
	// unknown, finished, artifact-free or carries an unparsable signature.
	const job = await loadCallbackJob(db, input.jobId);
	if (!parseTimestampedSignature(signatureHeader))
		throw new DomainError(
			"automation_signature_invalid",
			401,
			"Build signature is invalid",
		);
	const existingBeforeUpload = await loadArtifactUpload(
		db,
		job.id,
		input.artifactId,
	);
	if (!existingBeforeUpload) assertJobAcceptsArtifact(job, input.fileName);
	const body =
		typeof bodySource === "function" ? await bodySource() : bodySource;
	if (body.byteLength < 1 || body.byteLength > 100 * 1024 * 1024)
		throw new DomainError(
			"automation_artifact_size_invalid",
			400,
			"Artifact must be between 1 byte and 100 MiB",
		);
	const checksumSha256 = await digestHex(body);
	const secret = await callbackSecret(db, job);
	await verifySignature(
		secret,
		signatureHeader,
		`${job.id}.${input.artifactId}.${input.fileName}.${checksumSha256}`,
		now,
	);
	const existing = await loadArtifactUpload(db, job.id, input.artifactId);
	if (existing) {
		if (
			existing.checksum_sha256 === checksumSha256 &&
			existing.file_name === input.fileName &&
			existing.content_type === input.contentType &&
			existing.upload_status === "ready" &&
			existing.deleted_at === null
		)
			return { id: input.artifactId, checksumSha256, duplicate: true };
		throw new DomainError(
			"automation_artifact_conflict",
			409,
			"Artifact ID is already in use or upload is still in progress",
		);
	}
	const objectKey = `automation/${job.id}/${input.artifactId}`;
	const retentionMs = await loadArtifactRetentionMs(db);
	const reserved = await db
		.prepare(
			`INSERT INTO automation_artifacts
			 (id, automation_job_id, object_key, file_name, content_type, size_bytes,
			  checksum_sha256, upload_status, download_enabled, download_count, delete_after,
			  created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 'uploading', 0, 0, ?, ?, ?)
			 ON CONFLICT(id) DO NOTHING`,
		)
		.bind(
			input.artifactId,
			job.id,
			objectKey,
			input.fileName,
			input.contentType,
			body.byteLength,
			checksumSha256,
			now + retentionMs,
			now,
			now,
		)
		.run();
	if (Number(reserved.meta.changes ?? 0) !== 1) {
		const concurrent = await loadArtifactUpload(db, job.id, input.artifactId);
		if (
			concurrent?.checksum_sha256 === checksumSha256 &&
			concurrent.file_name === input.fileName &&
			concurrent.content_type === input.contentType &&
			concurrent.upload_status === "ready" &&
			concurrent.deleted_at === null
		)
			return { id: input.artifactId, checksumSha256, duplicate: true };
		throw new DomainError(
			"automation_artifact_conflict",
			409,
			"Artifact ID is already in use or upload is still in progress",
		);
	}
	try {
		await bucket.put(objectKey, Uint8Array.from(new Uint8Array(body)), {
			httpMetadata: { contentType: input.contentType },
		});
		const completed = await db.batch([
			db
				.prepare(
					`UPDATE automation_artifacts SET upload_status = 'ready', download_enabled = 1,
					 updated_at = ? WHERE id = ? AND automation_job_id = ? AND upload_status = 'uploading'
					 AND checksum_sha256 = ?`,
				)
				.bind(now, input.artifactId, job.id, checksumSha256),
			db
				.prepare(
					`INSERT INTO audit_logs
					 (id, action, target_type, target_id, after, created_at)
					 SELECT ?, 'automation.artifact_uploaded', 'automation_artifact', id, ?, ?
					 FROM automation_artifacts WHERE id = ? AND upload_status = 'ready'
					 AND checksum_sha256 = ?`,
				)
				.bind(
					crypto.randomUUID(),
					JSON.stringify({
						jobId: job.id,
						fileName: input.fileName,
						sizeBytes: body.byteLength,
						checksumSha256,
					}),
					now,
					input.artifactId,
					checksumSha256,
				),
		]);
		if (Number(completed[0]?.meta.changes ?? 0) !== 1)
			throw new DomainError(
				"automation_artifact_conflict",
				409,
				"Artifact upload reservation was lost",
			);
	} catch (error) {
		await bucket.delete(objectKey);
		await db
			.prepare(
				"DELETE FROM automation_artifacts WHERE id = ? AND automation_job_id = ? AND upload_status = 'uploading'",
			)
			.bind(input.artifactId, job.id)
			.run();
		throw error;
	}
	return { id: input.artifactId, checksumSha256, duplicate: false };
}

function loadArtifactUpload(db: D1Database, jobId: string, artifactId: string) {
	return db
		.prepare(
			`SELECT checksum_sha256, file_name, content_type, upload_status, deleted_at
			 FROM automation_artifacts
			 WHERE id = ? AND automation_job_id = ? LIMIT 1`,
		)
		.bind(artifactId, jobId)
		.first<{
			checksum_sha256: string;
			file_name: string;
			content_type: string;
			upload_status: string;
			deleted_at: number | null;
		}>();
}

async function loadArtifactRetentionMs(db: D1Database) {
	const row = await db
		.prepare(
			"SELECT value FROM system_settings WHERE key = 'automation.artifact_retention_ms' LIMIT 1",
		)
		.first<{ value: string }>();
	if (!row) return 30 * 86_400_000;
	try {
		const value: unknown = JSON.parse(row.value);
		return typeof value === "number" &&
			value >= 86_400_000 &&
			value <= 31_536_000_000
			? value
			: 30 * 86_400_000;
	} catch {
		return 30 * 86_400_000;
	}
}

async function loadCallbackJob(db: D1Database, jobId: string) {
	const job = await db
		.prepare(
			`SELECT id, status, provider, provider_job_id,
			 callback_secret_encrypted, artifact_policy, output_pattern
			 FROM automation_jobs WHERE id = ? LIMIT 1`,
		)
		.bind(jobId)
		.first<CallbackJob>();
	if (!job)
		throw new DomainError(
			"automation_job_not_found",
			404,
			"Automation job not found",
		);
	return job;
}

function assertJobAcceptsArtifact(job: CallbackJob, fileName: string) {
	if (job.status !== "running")
		throw new DomainError(
			"automation_artifact_not_accepted",
			409,
			"Build is not accepting artifacts",
		);
	if (job.artifact_policy === "none")
		throw new DomainError(
			"automation_artifact_not_accepted",
			409,
			"This automation method does not accept artifacts",
		);
	if (!matchesOutputPattern(fileName, job.output_pattern))
		throw new DomainError(
			"automation_artifact_name_invalid",
			400,
			"Artifact does not match the configured output pattern",
		);
}

function assertProviderJobOwnership(
	job: CallbackJob,
	providerJobId: string | undefined,
) {
	if (!providerJobId || !job.provider_job_id) return;
	const githubDispatchPlaceholder =
		job.provider === "github_actions" && job.provider_job_id === job.id;
	if (!githubDispatchPlaceholder && job.provider_job_id !== providerJobId)
		throw new DomainError(
			"automation_provider_job_mismatch",
			409,
			"Build provider job does not match the dispatched run",
		);
}

async function callbackSecret(db: D1Database, job: CallbackJob) {
	const runtime = await loadRuntimeConfig(db);
	if (!runtime.commerceSecret)
		throw new DomainError(
			"automation_secret_unavailable",
			503,
			"Build secret configuration is unavailable",
		);
	return decryptAutomationCallbackSecret(
		job.callback_secret_encrypted,
		runtime.commerceSecret,
	);
}

async function verifySignature(
	secret: string,
	header: string,
	payload: string,
	now: number,
) {
	const parsed = parseTimestampedSignature(header);
	if (!parsed || Math.abs(now - parsed.timestamp) > 300_000)
		throw new DomainError(
			"automation_signature_invalid",
			401,
			"Build signature is invalid",
		);
	const expected = await hmacSha256Hex(
		secret,
		`${parsed.timestamp}.${payload}`,
	);
	if (
		!parsed.signatures.some((signature) =>
			constantTimeEqual(signature, expected),
		)
	)
		throw new DomainError(
			"automation_signature_invalid",
			401,
			"Build signature is invalid",
		);
}

async function digestHex(body: ArrayBuffer) {
	const digest = await crypto.subtle.digest("SHA-256", body);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function matchesOutputPattern(fileName: string, pattern: string) {
	const namePattern = pattern.split("/").at(-1) ?? pattern;
	const expression = `^${[...namePattern]
		.map((character) => {
			if (character === "*") return ".*";
			if (character === "?") return ".";
			return character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		})
		.join("")}$`;
	return new RegExp(expression, "u").test(fileName);
}
