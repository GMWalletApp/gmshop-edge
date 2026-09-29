import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireAdmin } from "#/features/access/server/require-admin";
import {
	type SystemPermission,
	systemPermission,
} from "#/features/access/system-rbac";
import { sensitiveProofSchema } from "#/features/auth/reauthentication-schema";
import { verifySensitiveAdminAction } from "#/features/auth/server/reauthenticate";
import { loadExchangeRateSyncSettings } from "#/features/exchange-rates/server/sync";
import { exportAuditLogsToR2 } from "#/features/operations/server/audit-export";
import { retryQueueWorkload } from "#/features/operations/server/retry-queue";
import {
	operationsTasks,
	runOperationsTask,
} from "#/features/operations/server/run-task";
import { DomainError } from "#/lib/domain-error";
import { redactedAuditJson } from "#/server/audit-redaction";
import { clientIp } from "#/server/client-ip";
import { getCloudflareEnv } from "#/server/db.server";
import { loadOperationalSettings } from "#/server/operational-settings";

const auditQuery = z.object({
	page: z.number().int().min(1).default(1),
	pageSize: z.number().int().min(10).max(100).default(25),
	search: z.string().trim().max(100).default(""),
	beforeCreatedAt: z.number().int().positive().optional(),
});

type AuditRow = {
	id: string;
	action: string;
	target_type: string;
	target_id: string | null;
	request_id: string | null;
	ip_address: string | null;
	before: string | null;
	after: string | null;
	created_at: number;
	actor_name: string | null;
	actor_email: string | null;
};

export type AuditLogRecord = {
	id: string;
	action: string;
	targetType: string;
	targetId: string | null;
	requestId: string | null;
	ipAddress: string | null;
	before: string | null;
	after: string | null;
	createdAt: string;
	actorName: string | null;
	actorEmail: string | null;
};

export const listAuditLogsFn = createServerFn({ method: "GET" })
	.validator((input: z.input<typeof auditQuery>) => auditQuery.parse(input))
	.handler(async ({ data }) => {
		const { db } = await adminContext(systemPermission("audit", "read"));
		const pattern = `%${data.search}%`;
		const filters: string[] = [];
		const bindings: Array<string | number> = [];
		if (data.search) {
			filters.push(
				"(al.action LIKE ? OR al.target_type LIKE ? OR al.target_id LIKE ? OR u.email LIKE ?)",
			);
			bindings.push(pattern, pattern, pattern, pattern);
		}
		if (data.beforeCreatedAt !== undefined) {
			filters.push("al.created_at <= ?");
			bindings.push(data.beforeCreatedAt);
		}
		const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
		const [countResult, rowsResult] = await db.batch([
			db
				.prepare(
					`SELECT COUNT(*) AS count FROM audit_logs al LEFT JOIN users u ON u.id = al.actor_user_id ${where}`,
				)
				.bind(...bindings),
			db
				.prepare(`SELECT al.id, al.action, al.target_type, al.target_id,
			 al.request_id, al.ip_address, al.before, al.after, al.created_at,
			 u.name AS actor_name, u.email AS actor_email
			 FROM audit_logs al LEFT JOIN users u ON u.id = al.actor_user_id
				 ${where}
			 ORDER BY al.created_at DESC, al.id DESC LIMIT ? OFFSET ?`)
				.bind(...bindings, data.pageSize, (data.page - 1) * data.pageSize),
		]);
		const count = countResult?.results?.[0] as { count: number } | undefined;
		const rows = rowsResult as D1Result<AuditRow>;
		return {
			items: rows.results.map((row) => ({
				id: row.id,
				action: row.action,
				targetType: row.target_type,
				targetId: row.target_id,
				requestId: row.request_id,
				ipAddress: row.ip_address,
				before: redactedAuditJson(row.before),
				after: redactedAuditJson(row.after),
				createdAt: new Date(row.created_at).toISOString(),
				actorName: row.actor_name,
				actorEmail: row.actor_email,
			})),
			total: count?.count ?? 0,
			page: data.page,
			pageSize: data.pageSize,
		};
	});

export const exportAuditLogsFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof sensitiveProofSchema>) =>
		sensitiveProofSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const { db, env, request, user } = await adminContext(
			systemPermission("audit", "create"),
		);
		await verifySensitiveAdminAction(request, user.id, data);
		if (!env.FILES)
			throw new DomainError(
				"binding_unavailable",
				503,
				"R2 binding FILES is unavailable",
			);
		const settings = await loadOperationalSettings(db);
		return exportAuditLogsToR2({
			db,
			bucket: env.FILES,
			actorUserId: user.id,
			retentionMs: settings.retentionAuditMs,
		});
	});

export const getOperationsOverviewFn = createServerFn({
	method: "GET",
}).handler(async () => {
	const { db } = await adminContext(systemPermission("operations", "read"));
	const [taskRuns, exchangeRateSync] = await Promise.all([
		db
			.prepare(
				`SELECT id, task, trigger, schedule, status, started_at, completed_at,
				 duration_ms, error_code FROM (
				  SELECT id, task, trigger, schedule, status, started_at, completed_at,
				   duration_ms, error_code,
				   ROW_NUMBER() OVER (PARTITION BY task ORDER BY started_at DESC) AS position
				  FROM operation_task_runs
				 ) WHERE position = 1 ORDER BY task`,
			)
			.all<{
				id: string;
				task: string;
				trigger: "manual" | "scheduled";
				schedule: string | null;
				status: "running" | "succeeded" | "failed";
				started_at: number;
				completed_at: number | null;
				duration_ms: number | null;
				error_code: string | null;
			}>(),
		loadExchangeRateSyncSettings(db),
	]);
	return {
		exchangeRateSync: {
			enabled: exchangeRateSync.enabled,
			intervalMs: exchangeRateSync.intervalMs,
			lastSyncedAt: exchangeRateSync.lastSyncedAt,
		},
		taskRuns: taskRuns.results.map((run) => ({
			invocationId: run.id,
			task: run.task,
			trigger: run.trigger,
			schedule: run.schedule,
			status: run.status,
			startedAt: new Date(run.started_at).toISOString(),
			completedAt: run.completed_at
				? new Date(run.completed_at).toISOString()
				: null,
			durationMs: run.duration_ms,
			errorCode: run.error_code,
		})),
	};
});

export const runOperationsTaskFn = createServerFn({ method: "POST" })
	.validator((input: { task: (typeof operationsTasks)[number] }) =>
		z.object({ task: z.enum(operationsTasks) }).parse(input),
	)
	.handler(async ({ data }) => {
		const { env, request, user } = await adminContext(
			systemPermission("operations", "update"),
		);
		return runOperationsTask(env as Env, {
			task: data.task,
			actorUserId: user.id,
			requestId: request.headers.get("x-request-id"),
			ipAddress: clientIp(request),
		});
	});

export const getQueueOverviewFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const { db, env } = await adminContext(
			systemPermission("operations", "read"),
		);
		const [outbox, notifications, builds, refunds, lastProcessed, recentError] =
			await Promise.all([
				db
					.prepare(
						`SELECT status, COUNT(*) AS count FROM outbox_events
					 WHERE status IN ('pending', 'processing', 'failed') GROUP BY status`,
					)
					.all<{ status: string; count: number }>(),
				db
					.prepare(
						`SELECT status, COUNT(*) AS count FROM notification_deliveries
					 WHERE status IN ('pending', 'sending', 'failed') GROUP BY status`,
					)
					.all<{ status: string; count: number }>(),
				db
					.prepare(
						`SELECT status, COUNT(*) AS count FROM automation_jobs
					 WHERE status IN ('queued', 'dispatching', 'failed') GROUP BY status`,
					)
					.all<{ status: string; count: number }>(),
				db
					.prepare(
						`SELECT status, COUNT(*) AS count FROM refunds
					 WHERE status IN ('pending', 'processing', 'failed') GROUP BY status`,
					)
					.all<{ status: string; count: number }>(),
				db
					.prepare(
						`SELECT MAX(updated_at) AS consumed_at FROM (
					 SELECT updated_at FROM delivery_records WHERE status = 'delivered'
					 UNION ALL SELECT updated_at FROM automation_jobs WHERE status IN ('running', 'succeeded')
					 UNION ALL SELECT updated_at FROM notification_deliveries WHERE status = 'delivered'
					 UNION ALL SELECT updated_at FROM refunds WHERE status = 'succeeded'
					)`,
					)
					.first<{ consumed_at: number | null }>(),
				db
					.prepare(
						`SELECT after FROM audit_logs WHERE action = 'queue.message_rejected'
					 ORDER BY created_at DESC, id DESC LIMIT 1`,
					)
					.first<{ after: string | null }>(),
			]);
		const counts = [
			...outbox.results,
			...notifications.results,
			...builds.results,
			...refunds.results,
		];
		const count = (...statuses: string[]) =>
			counts.reduce(
				(total, row) => total + (statuses.includes(row.status) ? row.count : 0),
				0,
			);
		return [
			{
				id: "commerce" as const,
				name: "Commerce Queue",
				available: Boolean(env.COMMERCE_QUEUE),
				pending: count("pending", "queued"),
				processing: count("processing", "sending", "dispatching"),
				failed: count("failed"),
				lastConsumedAt: lastProcessed?.consumed_at
					? new Date(lastProcessed.consumed_at).toISOString()
					: null,
				lastError: redactedAuditJson(recentError?.after ?? null),
			},
		];
	},
);

export const retryQueueFn = createServerFn({ method: "POST" })
	.validator((input: { queue: "commerce" }) =>
		z.object({ queue: z.literal("commerce") }).parse(input),
	)
	.handler(async () => {
		const { env, request, user } = await adminContext(
			systemPermission("operations", "update"),
		);
		return retryQueueWorkload(env as Env, {
			actorUserId: user.id,
			requestId: request.headers.get("x-request-id"),
			ipAddress: clientIp(request),
		});
	});

async function adminContext(permission: SystemPermission) {
	const request = getRequest();
	const user = await requireAdmin(request, permission);
	const env = getCloudflareEnv(request);
	if (!env.DB)
		throw new DomainError(
			"binding_unavailable",
			503,
			"D1 binding DB is unavailable",
		);
	return { db: env.DB, env, request, user };
}
