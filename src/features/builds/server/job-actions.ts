import { DomainError } from "#/lib/domain-error";
import { clientIp } from "#/server/client-ip";

type BuildActionContext = {
	orderId?: string;
	actorUserId: string | null;
	request?: Request;
};

export async function cancelBuildJob(
	db: D1Database,
	jobId: string,
	context: BuildActionContext,
) {
	const job = await loadActionJob(db, jobId, context.orderId);
	if (!job)
		throw new DomainError(
			"automation_job_not_found",
			404,
			"Automation job not found",
		);
	if (!(["queued", "dispatching", "running"] as string[]).includes(job.status))
		throw new DomainError(
			"automation_cancel_invalid",
			409,
			"Automation job cannot be cancelled",
		);
	const now = Date.now();
	const results = await db.batch([
		db
			.prepare(
				`UPDATE automation_jobs SET status = 'cancelled', completed_at = ?,
				 usage_restored_at = CASE WHEN status = 'queued' THEN ? ELSE usage_restored_at END,
				 next_attempt_at = NULL, updated_at = ? WHERE id = ?
				 AND status IN ('queued', 'dispatching', 'running')`,
			)
			.bind(now, now, now, job.id),
		db
			.prepare(
				`INSERT INTO shop_order_events
				 (id, order_id, event_type, visibility, note, actor_type,
				  actor_user_id, created_at)
				 SELECT ?, ?, 'automation_cancelled', 'customer', ?, ?, ?, ?
				 FROM automation_jobs WHERE id = ? AND status = 'cancelled'
				 AND updated_at = ? AND changes() = 1`,
			)
			.bind(
				crypto.randomUUID(),
				job.order_id,
				job.id,
				context.orderId ? "customer" : "admin",
				context.actorUserId,
				now,
				job.id,
				now,
			),
		actionAuditStatement(
			db,
			job.id,
			"automation_job.cancelled",
			"cancelled",
			context,
			now,
			true,
		),
		db
			.prepare(
				`UPDATE customer_entitlements SET
				 usage_count = usage_count - 1,
				 status = CASE
				  WHEN status = 'exhausted'
				   AND (expires_at IS NULL OR expires_at > ?)
				   AND (access_limit IS NULL OR access_count < access_limit)
				   AND (usage_limit IS NULL OR usage_count - 1 < usage_limit)
				  THEN 'active'
				  ELSE status
				 END,
				 updated_at = ?
				 WHERE id = ? AND usage_count > 0 AND EXISTS (
				  SELECT 1 FROM automation_jobs WHERE id = ? AND status = 'cancelled'
				  AND usage_restored_at = ?) AND changes() = 1`,
			)
			.bind(now, now, job.entitlement_id, job.id, now),
		db
			.prepare(
				`INSERT INTO entitlement_events
				 (id, kind, entitlement_id, event_type, amount, source_type, source_id,
				  idempotency_key, created_at)
				 SELECT ?, 'usage', ?, 'restored', 1, 'automation_job', ?, ?, ? FROM automation_jobs
				 WHERE id = ? AND usage_restored_at = ?`,
			)
			.bind(
				crypto.randomUUID(),
				job.entitlement_id,
				job.id,
				`entitlement-usage:automation-restore:${job.id}:${now}`,
				now,
				job.id,
				now,
			),
	]);
	if (Number(results[0]?.meta.changes ?? 0) !== 1)
		throw new DomainError(
			"automation_cancel_invalid",
			409,
			"Automation job cannot be cancelled",
		);
	return { id: job.id, status: "cancelled" as const };
}

export async function retryBuildJob(
	db: D1Database,
	jobId: string,
	context: BuildActionContext,
) {
	const job = await loadActionJob(db, jobId, context.orderId);
	if (!job)
		throw new DomainError(
			"automation_job_not_found",
			404,
			"Automation job not found",
		);
	if (!(["failed", "expired", "cancelled"] as string[]).includes(job.status))
		throw new DomainError(
			"automation_retry_invalid",
			409,
			"Automation job cannot be retried",
		);
	if (
		job.entitlement_status !== "active" ||
		(job.entitlement_expires_at !== null &&
			job.entitlement_expires_at <= Date.now()) ||
		job.product_status !== "active" ||
		job.config_enabled !== 1
	)
		throw new DomainError(
			"automation_entitlement_unavailable",
			409,
			"Build entitlement is unavailable",
		);
	const now = Date.now();
	const restored = job.usage_restored_at !== null;
	const statements: D1PreparedStatement[] = [];
	if (restored)
		statements.push(
			db
				.prepare(
					`UPDATE customer_entitlements SET
					 usage_count = usage_count + 1,
					 status = CASE
					  WHEN usage_limit IS NOT NULL AND usage_count + 1 >= usage_limit
					  THEN 'exhausted'
					  ELSE status
					 END,
					 updated_at = ? WHERE id = ? AND status = 'active'
					 AND (expires_at IS NULL OR expires_at > ?)
					 AND (usage_limit IS NULL OR usage_count < usage_limit)`,
				)
				.bind(now, job.entitlement_id, now),
		);
	statements.push(
		db
			.prepare(
				`UPDATE automation_jobs SET status = 'queued', attempt_count = 0,
				 next_attempt_at = ?, timeout_at = ?, started_at = NULL, completed_at = NULL,
				 provider_job_id = NULL, run_url = NULL, failure_code = NULL,
				 usage_restored_at = NULL, updated_at = ?
				 WHERE id = ? AND status = ?${restored ? " AND changes() = 1" : ""}`,
			)
			.bind(now, now + 86_400_000, now, job.id, job.status),
	);
	if (restored)
		statements.push(
			db
				.prepare(
					`INSERT INTO entitlement_events
					 (id, kind, entitlement_id, event_type, amount, source_type, source_id,
					  idempotency_key, created_at)
					 SELECT ?, 'usage', ?, 'consumed', 1, 'automation_job', ?, ?, ? FROM automation_jobs
					 WHERE id = ? AND status = 'queued' AND updated_at = ?`,
				)
				.bind(
					crypto.randomUUID(),
					job.entitlement_id,
					job.id,
					`entitlement-usage:automation-reconsume:${job.id}:${now}`,
					now,
					job.id,
					now,
				),
		);
	statements.push(
		db
			.prepare(
				`INSERT INTO outbox_events
				 (id, event_type, aggregate_type, aggregate_id, idempotency_key, payload,
				  status, attempt_count, created_at, updated_at)
				 SELECT ?, 'automation.requested', 'automation_job', id, ?, ?, 'pending', 0, ?, ?
				 FROM automation_jobs WHERE id = ? AND status = 'queued' AND updated_at = ?`,
			)
			.bind(
				crypto.randomUUID(),
				`automation-retry:${job.id}:${now}`,
				JSON.stringify({ automationJobId: job.id }),
				now,
				now,
				job.id,
				now,
			),
		db
			.prepare(
				`INSERT INTO shop_order_events
				 (id, order_id, event_type, visibility, note, actor_type,
				  actor_user_id, created_at)
				 SELECT ?, ?, 'automation_retried', 'customer', ?, ?, ?, ?
				 FROM automation_jobs WHERE id = ? AND status = 'queued' AND updated_at = ?`,
			)
			.bind(
				crypto.randomUUID(),
				job.order_id,
				job.id,
				context.orderId ? "customer" : "admin",
				context.actorUserId,
				now,
				job.id,
				now,
			),
		actionAuditStatement(
			db,
			job.id,
			"automation_job.retried",
			"queued",
			context,
			now,
		),
	);
	const results = await db.batch(statements);
	const jobResultIndex = restored ? 1 : 0;
	if (restored && Number(results[0]?.meta.changes ?? 0) !== 1)
		throw new DomainError(
			"automation_capacity_unavailable",
			409,
			"Build quota is exhausted",
		);
	if (Number(results[jobResultIndex]?.meta.changes ?? 0) !== 1)
		throw new DomainError(
			"automation_status_conflict",
			409,
			"Automation job changed",
		);
	return { id: job.id, status: "queued" as const };
}

function loadActionJob(
	db: D1Database,
	jobId: string,
	orderId: string | undefined,
) {
	return db
		.prepare(
			`SELECT bj.id, bj.status, bj.sellable_item_id AS automation_config_id,
			 bj.entitlement_id, bj.usage_restored_at,
			 item.enabled AS config_enabled, oi.order_id,
			 ce.status AS entitlement_status, ce.expires_at AS entitlement_expires_at,
			 p.status AS product_status
			 FROM automation_jobs bj
			 JOIN product_sellable_items item ON item.id = bj.sellable_item_id
			 JOIN customer_entitlements ce ON ce.id = bj.entitlement_id
			 JOIN shop_order_items oi ON oi.id = bj.order_item_id
			 JOIN products p ON p.id = ce.product_id
			 WHERE bj.id = ? AND (? IS NULL OR oi.order_id = ?) LIMIT 1`,
		)
		.bind(jobId, orderId ?? null, orderId ?? null)
		.first<ActionJob>();
}

function actionAuditStatement(
	db: D1Database,
	jobId: string,
	action: string,
	status: string,
	context: BuildActionContext,
	now: number,
	requirePreviousChange = false,
) {
	return db
		.prepare(
			`INSERT INTO audit_logs
			 (id, actor_user_id, action, target_type, target_id, request_id,
			  ip_address, created_at)
			 SELECT ?, ?, ?, 'automation_job', id, ?, ?, ? FROM automation_jobs
			 WHERE id = ? AND status = ? AND updated_at = ?
			 ${requirePreviousChange ? "AND changes() = 1" : ""}`,
		)
		.bind(
			crypto.randomUUID(),
			context.actorUserId,
			action,
			context.request?.headers.get("x-request-id") ?? null,
			clientIp(context.request),
			now,
			jobId,
			status,
			now,
		);
}

type ActionJob = {
	id: string;
	status: string;
	automation_config_id: string;
	entitlement_id: string;
	usage_restored_at: number | null;
	config_enabled: number;
	order_id: string;
	entitlement_status: string;
	entitlement_expires_at: number | null;
	product_status: string;
};
