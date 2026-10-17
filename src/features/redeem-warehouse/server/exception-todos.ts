import { z } from "zod";
import {
	deliverOwnerAlert,
	ownerAlertErrorCode,
} from "#/features/telegram/server/owner-alerts";
import { loadRuntimeConfig } from "#/server/runtime-config";
import {
	loadDeliveryWarehouseToken,
	requestWarehouse,
} from "./warehouse-client";

export const exceptionTodoSettingKey = "commerce.redemption.exception_todos";
const pollStateKey = "commerce.redemption.exception_poll_state";
const eventType = "redeem.exception_todo";
const configSchema = z
	.object({ enabled: z.literal(true), since: z.number().int().nonnegative() })
	.strict();
const safeText = (max: number) =>
	z
		.string()
		.max(max)
		.refine(
			(value) =>
				!/(?:https?:\/\/|[\w.+-]+@[\w.-]+\.[A-Za-z]+|(?:sk-|Bearer\s)[A-Za-z0-9_.-]{8,}|(?:[A-Z0-9]{4}-){3}[A-Z0-9]{4})/.test(
					value,
				),
			"unsafe notification text",
		);
const diagnosisSchema = z
	.object({
		stage: z.enum([
			"卡密校验",
			"账号校验",
			"充值提交",
			"结果核查",
			"提交前检查",
			"尚未定位",
		]),
		submission: z.enum(["not_submitted", "rejected", "submitted", "unknown"]),
		card_usage: z.enum(["used", "unused", "unknown"]),
		next_step: safeText(600),
	})
	.strict();
const snapshotSchema = z
	.object({
		id: z.string().uuid(),
		reference: z.string().uuid(),
		sku: z.string().regex(/^[A-Z0-9_]{1,64}$/),
		product_name: safeText(160),
		storefront: z.enum(["laoshirenvip", "lsrai"]),
		state: z.enum(["open", "resolved", "waiting"]),
		severity: z.union([z.literal(1), z.literal(2)]),
		reason_code: z
			.string()
			.regex(/^[a-z_]+\.[a-z_]+$/)
			.max(100),
		reason: safeText(600),
		resolution: z.enum(["completed", "voided", "customer_action"]).nullable(),
		diagnosis: diagnosisSchema.nullable(),
	})
	.strict();
const feedSchema = z
	.object({
		observed_at: z.number().int().nonnegative(),
		next_cursor: z.string().uuid().nullable(),
		cases: z.array(snapshotSchema).max(200),
		missing_ids: z.array(z.string().uuid()).max(100),
	})
	.strict()
	.refine(
		(v) => new Set(v.cases.map((c) => c.id)).size === v.cases.length,
		"duplicate cases",
	)
	.refine(
		(v) =>
			v.cases.every(
				(c) => (c.state === "resolved") === (c.resolution !== null),
			),
		"resolution mismatch",
	);
type Snapshot = z.infer<typeof snapshotSchema>;
type Config = z.infer<typeof configSchema>;
type Todo = {
	code_id: string;
	reference: string;
	state: "open" | "resolved";
	severity: number;
	fingerprint: string;
	revision: number;
	alert_attempted: number;
	observed_at: number;
};
type PollState = {
	cursor?: string | null;
	since?: number;
	lease?: string;
	lease_until?: number;
	last_error_code?: string | null;
};
const submissionLabels = {
	not_submitted: "尚未提交充值",
	rejected: "提交被明确拒绝",
	submitted: "已关联充值结果",
	unknown: "是否受理尚未确认",
};
const usageLabels = {
	used: "已使用",
	unused: "已确认未使用",
	unknown: "尚未确认，不能据此重充或换卡",
};

async function setting(db: D1Database, key: string): Promise<unknown> {
	const row = await db
		.prepare("SELECT value FROM system_settings WHERE key=?")
		.bind(key)
		.first<{ value: string }>();
	try {
		return row ? JSON.parse(row.value) : null;
	} catch {
		return null;
	}
}
async function config(db: D1Database, now: number): Promise<Config | null> {
	const parsed = configSchema.safeParse(
		await setting(db, exceptionTodoSettingKey),
	);
	return parsed.success && parsed.data.since <= now ? parsed.data : null;
}
async function stillEnabled(db: D1Database, since: number, now: number) {
	return (await config(db, now))?.since === since;
}

export function formatExceptionTodo(
	snapshot: Snapshot,
	change: "new" | "changed" | "resolved",
) {
	const title =
		change === "resolved"
			? "已收尾"
			: change === "new"
				? "新增"
				: "状态变化 / 需处理";
	const resolution = {
		completed: "已确认充值完成",
		voided: "卡密已作废，待办关闭；不代表已退款",
		customer_action: "已转为客户可自行继续处理；不代表充值完成",
	};
	return [
		`【兑换异常待办 · ${title}】`,
		`核查编号：${snapshot.reference}`,
		`商品：${snapshot.product_name}`,
		`规格：${snapshot.sku}`,
		`发码归属：${snapshot.storefront === "lsrai" ? "代理卡网" : "老实人VIP"}`,
		...(snapshot.resolution
			? [`结果：${resolution[snapshot.resolution]}`]
			: [
					`优先级：${snapshot.severity === 2 ? "高" : "普通"}`,
					`原因：${snapshot.reason}`,
					`阶段：${snapshot.diagnosis?.stage || "尚未定位"}`,
					`提交情况：${snapshot.diagnosis ? submissionLabels[snapshot.diagnosis.submission] : "未确认"}`,
					`卡密使用：${snapshot.diagnosis ? usageLabels[snapshot.diagnosis.card_usage] : "未确认"}`,
					`建议：${snapshot.diagnosis?.next_step || "核对原订单，不要重复充值"}`,
					"需要决定：无法确认结果时先查证；退款、换卡或重充仍须另行授权。",
				]),
		"同一客户卡仅一条待办；可用核查编号在内部查单，无需发送卡密或登录信息。",
	].join("\n");
}

// State and outbox transition commit atomically. Absence from a page never resolves a case.
async function applySnapshot(
	db: D1Database,
	s: Snapshot,
	observedAt: number,
	now: number,
	lease: string,
) {
	const previous = await db
		.prepare("SELECT * FROM redeem_exception_todos WHERE code_id=?")
		.bind(s.id)
		.first<Todo>();
	if (previous && previous.observed_at > observedAt) return false;
	const guard =
		"EXISTS (SELECT 1 FROM system_settings WHERE key=? AND json_extract(value,'$.lease')=?)";
	if (s.state === "waiting" || (!previous && s.state === "resolved")) {
		if (previous)
			await db
				.prepare(
					`UPDATE redeem_exception_todos SET last_checked_at=? WHERE code_id=? AND ${guard}`,
				)
				.bind(now, s.id, pollStateKey, lease)
				.run();
		return false;
	}
	const fingerprint = JSON.stringify([
		s.state,
		s.severity,
		s.reason_code,
		s.resolution,
		s.diagnosis?.stage,
		s.diagnosis?.submission,
	]);
	if (previous?.fingerprint === fingerprint) {
		await db
			.prepare(`UPDATE redeem_exception_todos SET reference=?,snapshot=?,observed_at=?,last_checked_at=?
      WHERE code_id=? AND revision=? AND ${guard}`)
			.bind(
				s.reference,
				JSON.stringify(s),
				observedAt,
				now,
				s.id,
				previous.revision,
				pollStateKey,
				lease,
			)
			.run();
		return false;
	}
	const revision = (previous?.revision ?? 0) + 1;
	const change =
		s.state === "resolved"
			? "resolved"
			: !previous || previous.state === "resolved"
				? "new"
				: "changed";
	const payload = JSON.stringify({
		revision,
		state: s.state,
		text: formatExceptionTodo(s, change),
	});
	const stateWrite = previous
		? db
				.prepare(`UPDATE redeem_exception_todos SET reference=?,state=?,severity=?,fingerprint=?,snapshot=?,revision=?,observed_at=?,last_checked_at=?,resolved_at=?
        WHERE code_id=? AND revision=? AND ${guard}`)
				.bind(
					s.reference,
					s.state,
					s.severity,
					fingerprint,
					JSON.stringify(s),
					revision,
					observedAt,
					now,
					s.state === "resolved" ? now : null,
					s.id,
					previous.revision,
					pollStateKey,
					lease,
				)
		: db
				.prepare(`INSERT OR IGNORE INTO redeem_exception_todos (code_id,reference,state,severity,fingerprint,snapshot,revision,observed_at,first_seen_at,last_checked_at)
        SELECT ?,?,?,?,?,?,1,?,?,? WHERE ${guard}`)
				.bind(
					s.id,
					s.reference,
					s.state,
					s.severity,
					fingerprint,
					JSON.stringify(s),
					observedAt,
					now,
					now,
					pollStateKey,
					lease,
				);
	const results = await db.batch([
		stateWrite,
		db
			.prepare(`INSERT OR IGNORE INTO outbox_events (id,event_type,aggregate_type,aggregate_id,idempotency_key,payload,status,attempt_count,created_at,updated_at)
      SELECT ?,?,'redeem_exception',?,?,?,'pending',0,?,? FROM redeem_exception_todos
      WHERE code_id=? AND revision=? AND fingerprint=? AND ${guard}`)
			.bind(
				crypto.randomUUID(),
				eventType,
				s.id,
				`redeem-exception:${s.id}:${revision}`,
				payload,
				now,
				now,
				s.id,
				revision,
				fingerprint,
				pollStateKey,
				lease,
			),
	]);
	return Number(results[0]?.meta.changes ?? 0) === 1;
}

type Input = {
	db: D1Database;
	now?: number;
	readFeed?: (body: {
		since: number;
		cursor: string | null;
		limit: number;
		tracked_ids: string[];
	}) => Promise<unknown>;
	deliver?: (text: string, uuid: string) => Promise<void>;
};

export async function runRedemptionExceptionTodos(input: Input) {
	const now = input.now ?? Date.now();
	const active = await config(input.db, now);
	if (!active) return { status: "disabled", changed: 0, accepted: 0 };
	const previousState = ((await setting(input.db, pollStateKey)) ||
		{}) as PollState;
	const cursor =
		previousState.since === active.since &&
		typeof previousState.cursor === "string"
			? previousState.cursor
			: null;
	const lease = crypto.randomUUID();
	const state = {
		cursor,
		since: active.since,
		lease,
		lease_until: now + 120_000,
		last_error_code: null,
	};
	const claimed = await input.db
		.prepare(`INSERT INTO system_settings (key,value,is_secret,created_at,updated_at) VALUES (?,?,0,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
    WHERE COALESCE(json_extract(system_settings.value,'$.lease_until'),0)<=?`)
		.bind(pollStateKey, JSON.stringify(state), now, now, now)
		.run();
	if (Number(claimed.meta.changes ?? 0) !== 1)
		return { status: "busy", changed: 0, accepted: 0 };
	let changed = 0,
		nextCursor = cursor,
		errorCode: string | null = null;
	let observedIds: string[] = [];
	try {
		const tracked = await input.db
			.prepare(
				"SELECT code_id FROM redeem_exception_todos WHERE state='open' OR code_id IN (SELECT aggregate_id FROM outbox_events WHERE event_type='redeem.exception_todo' AND status='pending') ORDER BY last_checked_at,code_id LIMIT 50",
			)
			.all<{ code_id: string }>();
		const body = {
			since: active.since,
			cursor,
			limit: 50,
			tracked_ids: tracked.results.map((r) => r.code_id),
		};
		let raw: unknown;
		if (input.readFeed) raw = await input.readFeed(body);
		else {
			const runtime = await loadRuntimeConfig(input.db);
			const token = await loadDeliveryWarehouseToken(
				input.db,
				runtime.commerceSecret,
			);
			const reply = await requestWarehouse(
				token,
				"/api/internal/attempts/exceptions",
				{ method: "POST", body: JSON.stringify(body) },
			);
			const envelope = z
				.object({ success: z.literal(true), data: feedSchema })
				.safeParse(reply);
			if (!envelope.success) throw new Error("exception_feed_invalid");
			raw = envelope.data.data;
		}
		const feed = feedSchema.parse(raw);
		if (feed.observed_at > now + 300_000 || feed.observed_at < now - 120_000)
			throw new Error("exception_feed_clock");
		const found = new Set(feed.cases.map((row) => row.id));
		const missing = new Set(feed.missing_ids);
		if (
			body.tracked_ids.some((id) => !found.has(id) && !missing.has(id)) ||
			feed.missing_ids.some(
				(id) => !body.tracked_ids.includes(id) || found.has(id),
			)
		)
			throw new Error("exception_feed_incomplete");
		observedIds = feed.cases
			.filter((row) => row.state !== "waiting")
			.map((row) => row.id);
		if (!(await stillEnabled(input.db, active.since, now)))
			return { status: "disabled", changed: 0, accepted: 0 };
		for (const row of feed.cases)
			if (await applySnapshot(input.db, row, feed.observed_at, now, lease))
				changed++;
		nextCursor = feed.next_cursor;
		for (const id of feed.missing_ids)
			await input.db
				.prepare(`UPDATE redeem_exception_todos SET last_checked_at=?
          WHERE code_id=? AND EXISTS (SELECT 1 FROM system_settings WHERE key=? AND json_extract(value,'$.lease')=?)`)
				.bind(now, id, pollStateKey, lease)
				.run();
		if (feed.missing_ids.length) errorCode = "exception_source_records_missing";
	} catch {
		errorCode = "exception_feed_unavailable";
	} finally {
		await input.db
			.prepare(
				`UPDATE system_settings SET value=?,updated_at=? WHERE key=? AND json_extract(value,'$.lease')=?`,
			)
			.bind(
				JSON.stringify({
					...state,
					cursor: nextCursor,
					lease_until: 0,
					last_error_code: errorCode,
				}),
				now,
				pollStateKey,
				lease,
			)
			.run();
	}
	if (errorCode === "exception_feed_unavailable")
		return { status: "source_unavailable", changed, accepted: 0 };
	const published = await publishExceptionAlerts(
		input,
		active,
		now,
		observedIds,
	);
	if (published.failed > 0)
		await input.db
			.prepare(`UPDATE system_settings SET value=json_set(value,'$.last_error_code','exception_delivery_failed')
      WHERE key=? AND json_extract(value,'$.lease')=?`)
			.bind(pollStateKey, lease)
			.run();
	return {
		status:
			published.failed > 0 ? "delivery_failed" : errorCode ? "partial" : "ok",
		changed,
		...published,
	};
}

async function publishExceptionAlerts(
	input: Input,
	active: Config,
	now: number,
	observedIds: string[],
) {
	if (!observedIds.length) return { accepted: 0, failed: 0 };
	// Keep one current revision, and never replay ambiguous sends beyond the bounded retry window.
	await input.db.batch([
		input.db
			.prepare(`UPDATE outbox_events SET status='published',last_error_code='superseded',updated_at=?
      WHERE event_type=? AND status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?)
        AND CAST(json_extract(payload,'$.revision') AS INTEGER)<(SELECT revision FROM redeem_exception_todos WHERE code_id=aggregate_id)`)
			.bind(now, eventType, now),
		input.db
			.prepare(`UPDATE outbox_events SET status='failed',last_error_code='exception_alert_retry_exhausted',updated_at=?
      WHERE event_type=? AND status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?) AND (attempt_count>=3 OR created_at<?)`)
			.bind(now, eventType, now, now - 15 * 60_000),
	]);
	const rows = await input.db
		.prepare(`SELECT e.id,e.aggregate_id,e.payload,e.attempt_count,t.alert_attempted FROM outbox_events e
    JOIN redeem_exception_todos t ON t.code_id=e.aggregate_id AND t.revision=CAST(json_extract(e.payload,'$.revision') AS INTEGER)
    WHERE e.event_type=? AND e.status='pending' AND (e.next_attempt_at IS NULL OR e.next_attempt_at<=?)
      AND e.aggregate_id IN (${observedIds.map(() => "?").join(",")})
      AND NOT EXISTS (SELECT 1 FROM outbox_events other WHERE other.aggregate_id=e.aggregate_id AND other.event_type=e.event_type
        AND other.id<>e.id AND other.status='pending' AND other.attempt_count>0 AND other.next_attempt_at>?)
    ORDER BY e.created_at,e.id LIMIT 10`)
		.bind(eventType, now, ...observedIds, now)
		.all<{
			id: string;
			aggregate_id: string;
			payload: string;
			attempt_count: number;
			alert_attempted: number;
		}>();
	let accepted = 0,
		failed = 0;
	for (const row of rows.results) {
		const sendAt = input.now ?? Date.now();
		if (!(await stillEnabled(input.db, active.since, sendAt))) break;
		const payload = z
			.object({
				revision: z.number().int().positive(),
				state: z.enum(["open", "resolved"]),
				text: z.string().max(4000),
			})
			.parse(JSON.parse(row.payload));
		if (payload.state === "resolved" && !row.alert_attempted) {
			await input.db
				.prepare(
					"UPDATE outbox_events SET status='published',last_error_code='resolved_before_alert',updated_at=? WHERE id=? AND status='pending'",
				)
				.bind(now, row.id)
				.run();
			continue;
		}
		const leaseUntil = sendAt + 120_000;
		const claim = await input.db
			.prepare(`UPDATE outbox_events SET next_attempt_at=?,attempt_count=attempt_count+1,updated_at=?
      WHERE id=? AND status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?)
      AND EXISTS (SELECT 1 FROM redeem_exception_todos WHERE code_id=? AND revision=?)`)
			.bind(
				leaseUntil,
				sendAt,
				row.id,
				sendAt,
				row.aggregate_id,
				payload.revision,
			)
			.run();
		if (Number(claim.meta.changes ?? 0) !== 1) continue;
		try {
			if (
				!(await stillEnabled(input.db, active.since, input.now ?? Date.now()))
			)
				throw new Error("exception_alert_disabled");
			await input.db
				.prepare(
					"UPDATE redeem_exception_todos SET alert_attempted=1 WHERE code_id=?",
				)
				.bind(row.aggregate_id)
				.run();
			if (input.deliver) await input.deliver(payload.text, row.id);
			else await deliverOwnerAlert(input.db, payload.text, { uuid: row.id });
			await input.db
				.prepare(`UPDATE outbox_events SET status='published',published_at=?,last_error_code=NULL,next_attempt_at=NULL,updated_at=?
        WHERE id=? AND status='pending' AND next_attempt_at=?`)
				.bind(now, now, row.id, leaseUntil)
				.run();
			accepted++;
		} catch (error) {
			const code = ownerAlertErrorCode(error);
			await input.db
				.prepare(`UPDATE outbox_events SET status=CASE WHEN attempt_count>=3 THEN 'failed' ELSE 'pending' END,
        next_attempt_at=?,last_error_code=?,updated_at=? WHERE id=? AND status='pending' AND next_attempt_at=?`)
				.bind(now + 60_000, code, now, row.id, leaseUntil)
				.run();
			failed++;
		}
	}
	return { accepted, failed };
}
