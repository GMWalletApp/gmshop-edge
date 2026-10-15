import { z } from "zod";
import { isInternalIdentityEmail } from "#/features/auth/identity-email";
import { decryptDeliveryContent } from "#/features/fulfillment/secrets";
import { enqueueConfiguredEmailNotification } from "#/features/notifications/server/delivery";
import {
	isReservedEmailRecipient,
	recipientHash,
	recipientSuppressionReason,
} from "#/features/notifications/server/recipient-policy";
import {
	loadDeliveryWarehouseToken,
	requestWarehouse,
} from "#/features/redeem-warehouse/server/warehouse-client";
import type { SupportedLocale } from "#/lib/locales";
import { loadRuntimeConfig, type RuntimeConfig } from "#/server/runtime-config";
import {
	beijingDayStart,
	extractWarehouseCodes,
	isEmailAddress,
	isRenewalSendWindow,
	isRenewalStageStale,
	type RenewalStage,
	redeemCodeHash,
	renderRenewalEmail,
	renewalBackfillSince,
	renewalExpiresAt,
	renewalRedeemWaitMs,
	renewalStageDueAt,
	renewalStages,
} from "../domain";
import {
	renewalOrigin,
	renewalSiteDomain,
	renewalUnsubscribeUrl,
} from "./links";
import { loadRenewalSettings } from "./settings";

const runIntervalMs = 570_000;
const lookupRetryMs = 6 * 3_600_000;
const sendingTimeoutMs = 15 * 60_000;
const paidStatuses = "('paid','fulfilling','completed')";
/**
 * Hard ceiling on D1 calls (each statement or batch) one pass may make, so the
 * shared cron invocation stays far below the Workers subrequest/query limits.
 */
export const renewalD1Budget = 300;
/** D1 calls kept back for anchors, cancellations and at least a few sends. */
const discoveryReserve = 150;
/** Worst-case D1 calls one due row can take (exclusion, merge, claim, enqueue). */
const sendRowCost = 25;
/** Full refunds, refunds in progress, and any succeeded (partial) refund row. */
const refundedOrderCondition = (alias: string) =>
	`(${alias}.status IN ('refunding','refunded') OR ${alias}.refunded_at IS NOT NULL
	  OR EXISTS (SELECT 1 FROM refunds rf WHERE rf.order_id = ${alias}.id
	   AND rf.status = 'succeeded'))`;

/** Orders placed by staff (any role other than customer/guest), by account or by email. */
const staffOrderCondition = (userId: string, email: string) =>
	`EXISTS (SELECT 1 FROM users su, json_each(su.role_ids) assigned
	  JOIN roles sr ON sr.id = assigned.value
	  WHERE sr.name NOT IN ('customer','guest')
	  AND (su.id = ${userId} OR (${email} IS NOT NULL AND lower(su.email) = ${email})))`;

export const renewalEmailEvents: Record<RenewalStage, string> = {
	remind_3d: "renewal_remind_3d",
	remind_due: "renewal_remind_due",
	recall: "renewal_recall",
};

export type RedeemLookupItem = {
	code_hash: string;
	found: boolean;
	status?: string | null;
	completed_at?: string | null;
	account_email?: string | null;
};
export type RedeemLookup = (hashes: string[]) => Promise<RedeemLookupItem[]>;

const lookupResponseSchema = z.object({
	success: z.literal(true),
	data: z.object({
		items: z
			.array(
				z.object({
					code_hash: z.string().regex(/^[0-9a-f]{64}$/),
					found: z.boolean(),
					status: z.string().nullish(),
					completed_at: z.string().nullish(),
					account_email: z.string().nullish(),
				}),
			)
			.max(500),
	}),
});

/** POST /api/internal/redemptions/lookup with the existing warehouse token. */
export function warehouseRedeemLookup(
	db: D1Database,
	commerceSecret: string,
	requester: typeof requestWarehouse = requestWarehouse,
): RedeemLookup {
	return async (hashes) => {
		const token = await loadDeliveryWarehouseToken(db, commerceSecret);
		const body = await requester(token, "/api/internal/redemptions/lookup", {
			method: "POST",
			body: JSON.stringify({ code_hashes: hashes }),
		});
		return lookupResponseSchema.parse(body).data.items;
	};
}

/**
 * Cron entry: discovers delivered direct orders, resolves the redemption
 * anchor, cancels invalidated reminders and sends due stages. Cheap guard keeps
 * it to one pass about every ten minutes; every step is bounded.
 */
export async function runRenewalReminders(
	db: D1Database,
	options: {
		now?: number;
		force?: boolean;
		lookup?: RedeemLookup;
		discoverLimit?: number;
		lookupLimit?: number;
		sendLimit?: number;
		d1Budget?: number;
	} = {},
) {
	const now = options.now ?? Date.now();
	const meter = meteredD1(db, options.d1Budget ?? renewalD1Budget);
	const metered = meter.db;
	if (!options.force && !(await claimRun(metered, now)))
		return { status: "throttled" as const };
	const settings = await loadRenewalSettings(metered);
	if (!settings.remindersEnabled) return { status: "disabled" as const };
	const runtime = await loadRuntimeConfig(metered);
	const recovered = await recoverStuckSends(metered, now);
	const discovered = await discoverReminders(
		metered,
		runtime,
		now,
		options.discoverLimit ?? 50,
		() => meter.remaining() > discoveryReserve,
	);
	const lookup =
		options.lookup ?? warehouseRedeemLookup(metered, runtime.commerceSecret);
	const anchors = await resolveAnchors(
		metered,
		lookup,
		now,
		options.lookupLimit ?? 100,
	);
	const cancelled = await cancelInvalidatedReminders(metered, now);
	const sends = isRenewalSendWindow(now)
		? await sendDueReminders(metered, runtime, now, {
				recallEnabled: settings.recallEnabled,
				limit: options.sendLimit ?? 40,
				canContinue: () => meter.remaining() >= sendRowCost,
			})
		: { sent: 0, merged: 0, skipped: 0, excluded: 0, deferred: 0 };
	return {
		status: "ran" as const,
		discovered,
		...anchors,
		cancelled,
		recovered,
		...sends,
		d1Calls: meter.used(),
	};
}

/**
 * Wraps a D1 binding and counts every executed statement and batch. Statements
 * are unwrapped before reaching the real batch() so the binding sees its own
 * objects.
 */
export function meteredD1(db: D1Database, budget: number) {
	let used = 0;
	const originals = new WeakMap<object, D1PreparedStatement>();
	const count = () => {
		used += 1;
		if (used > budget)
			throw new Error(`renewal pass exceeded its D1 budget of ${budget}`);
	};
	const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
		const proxy = new Proxy(statement, {
			get(target, key) {
				if (key === "bind")
					return (...values: unknown[]) => wrap(target.bind(...values));
				if (key === "run" || key === "first" || key === "all" || key === "raw")
					return async (...args: unknown[]) => {
						count();
						return await (target[key] as (...a: unknown[]) => unknown)(...args);
					};
				const value = Reflect.get(target, key, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		originals.set(proxy, statement);
		return proxy;
	};
	const metered = new Proxy(db, {
		get(target, key) {
			if (key === "prepare")
				return (query: string) => wrap(target.prepare(query));
			if (key === "batch")
				return async (statements: D1PreparedStatement[]) => {
					count();
					return await target.batch(
						statements.map(
							(statement) => originals.get(statement) ?? statement,
						),
					);
				};
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return {
		db: metered,
		used: () => used,
		remaining: () => budget - used,
	};
}

/**
 * A crash between claiming a send and recording it leaves the row in
 * 'sending'. It may or may not have been enqueued, so it is never resent:
 * after the timeout it is marked failed and shows up in the stats.
 */
async function recoverStuckSends(db: D1Database, now: number) {
	const result = await db
		.prepare(
			`UPDATE renewal_reminder_sends SET status = 'failed',
			 status_reason = 'stuck_sending', updated_at = ?
			 WHERE status = 'sending' AND updated_at <= ?`,
		)
		.bind(now, now - sendingTimeoutMs)
		.run();
	return Number(result.meta.changes ?? 0);
}

async function claimRun(db: D1Database, now: number) {
	const result = await db
		.prepare(
			`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
			 VALUES ('renewal.scheduler_state', ?, 0, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value,
			 updated_at = excluded.updated_at
			 WHERE system_settings.updated_at <= ?`,
		)
		.bind(JSON.stringify({ lastRunAt: now }), now, now, now - runIntervalMs)
		.run();
	return Number(result.meta.changes ?? 0) === 1;
}

type DiscoveryRow = {
	delivery_id: string;
	content_encrypted: string | null;
	delivered_at: number;
	order_item_id: string;
	order_id: string;
	product_id: string;
	sellable_item_id: string;
	sellable_item_name: string;
	product_name: string;
	cycle_days: number;
	user_id: string | null;
	contact_email: string | null;
	locale: string;
	preferred_locale: string | null;
	paid_at: number;
	refunded: number;
};

async function discoverReminders(
	db: D1Database,
	runtime: RuntimeConfig,
	now: number,
	limit: number,
	canContinue: () => boolean = () => true,
) {
	const rows = await db
		.prepare(
			`SELECT d.id AS delivery_id, d.content_encrypted, d.delivered_at,
			 d.order_item_id, i.order_id, i.product_id, i.sellable_item_id,
			 i.sellable_item_name, i.product_name, s.reminder_cycle_days AS cycle_days,
			 o.user_id, o.normalized_contact_email AS contact_email, o.locale,
			 u.preferred_locale, COALESCE(o.paid_at, o.created_at) AS paid_at,
			 ${refundedOrderCondition("o")} AS refunded
			 FROM delivery_records d
			 JOIN shop_order_items i ON i.id = d.order_item_id
			 JOIN shop_orders o ON o.id = i.order_id
			 JOIN product_sellable_items s ON s.id = i.sellable_item_id
			 LEFT JOIN users u ON u.id = o.user_id
			 WHERE d.status = 'delivered' AND d.delivered_at >= ?
			 AND s.reminder_cycle_days IS NOT NULL
			 AND NOT EXISTS (SELECT 1 FROM supplier_api_orders sa WHERE sa.shop_order_id = o.id)
			 AND NOT ${staffOrderCondition("o.user_id", "o.normalized_contact_email")}
			 AND NOT EXISTS (SELECT 1 FROM renewal_reminders r WHERE r.delivery_record_id = d.id)
			 ORDER BY d.delivered_at, d.id LIMIT ?`,
		)
		.bind(renewalBackfillSince, Math.max(1, Math.min(100, limit)))
		.all<DiscoveryRow>();
	let created = 0;
	for (const row of rows.results) {
		if (!canContinue()) break;
		let codes: string[] = [];
		if (row.content_encrypted && runtime.commerceSecret)
			try {
				codes = extractWarehouseCodes(
					await decryptDeliveryContent(
						row.content_encrypted,
						runtime.commerceSecret,
					),
				);
			} catch {
				codes = [];
			}
		const base = {
			order_id: row.order_id,
			order_item_id: row.order_item_id,
			delivery_record_id: row.delivery_id,
			user_id: row.user_id,
			contact_email: normalizedRecipient(row.contact_email),
			product_id: row.product_id,
			sellable_item_id: row.sellable_item_id,
			item_name: itemName(row),
			locale: reminderLocale(row.preferred_locale ?? row.locale),
			cycle_days: row.cycle_days,
			order_paid_at: row.paid_at,
			delivered_at: row.delivered_at,
		};
		const reminders: ReminderInsert[] = codes.length
			? await Promise.all(
					codes.map(async (code) => {
						const hash = await redeemCodeHash(code);
						return {
							...base,
							id: crypto.randomUUID(),
							source_key: `${row.delivery_id}:${hash}`,
							code_hash: hash,
							anchor_at: null,
							anchor_source: null,
							status: "awaiting_redeem" as const,
							next_lookup_at: now,
						};
					}),
				)
			: [
					{
						...base,
						id: crypto.randomUUID(),
						source_key: `${row.delivery_id}:delivery`,
						code_hash: null,
						anchor_at: row.delivered_at,
						anchor_source: "delivery",
						status: "scheduled",
						next_lookup_at: null,
					},
				];
		const statements: D1PreparedStatement[] = [];
		for (const reminder of reminders) {
			if (row.refunded) {
				reminder.status = "cancelled";
				reminder.status_reason = "refunded";
			}
			statements.push(insertReminder(db, reminder, now));
			if (reminder.status === "scheduled")
				statements.push(
					...(await sendStatements(db, reminder, null, now)).statements,
				);
		}
		await db.batch(statements);
		created += reminders.length;
	}
	return created;
}

type ReminderInsert = {
	id: string;
	source_key: string;
	order_id: string;
	order_item_id: string;
	delivery_record_id: string;
	code_hash: string | null;
	user_id: string | null;
	contact_email: string | null;
	product_id: string;
	sellable_item_id: string;
	item_name: string;
	locale: SupportedLocale;
	cycle_days: number;
	order_paid_at: number;
	delivered_at: number;
	anchor_at: number | null;
	anchor_source: string | null;
	status: "awaiting_redeem" | "scheduled" | "cancelled";
	status_reason?: string;
	next_lookup_at: number | null;
};

function insertReminder(db: D1Database, r: ReminderInsert, now: number) {
	return db
		.prepare(
			`INSERT OR IGNORE INTO renewal_reminders
			 (id, source_key, order_id, order_item_id, delivery_record_id, code_hash,
			  user_id, contact_email, account_email, product_id, sellable_item_id,
			  item_name, locale, cycle_days, order_paid_at, delivered_at, anchor_at,
			  anchor_source, status, status_reason, lookup_attempts, next_lookup_at,
			  created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
		)
		.bind(
			r.id,
			r.source_key,
			r.order_id,
			r.order_item_id,
			r.delivery_record_id,
			r.code_hash,
			r.user_id,
			r.contact_email,
			r.product_id,
			r.sellable_item_id,
			r.item_name,
			r.locale,
			r.cycle_days,
			r.order_paid_at,
			r.delivered_at,
			r.anchor_at,
			r.anchor_source,
			r.status,
			r.status_reason ?? null,
			r.next_lookup_at,
			now,
			now,
		);
}

/** Stage rows for every distinct, deliverable recipient of a scheduled reminder. */
async function sendStatements(
	db: D1Database,
	reminder: {
		id: string;
		contact_email: string | null;
		anchor_at: number | null;
		cycle_days: number;
	},
	accountEmail: string | null,
	now: number,
) {
	const recipients: Array<{ email: string; kind: "order" | "account" }> = [];
	for (const [email, kind] of [
		[reminder.contact_email, "order"],
		[accountEmail, "account"],
	] as const) {
		const normalized = normalizedRecipient(email);
		if (!normalized || recipients.some((entry) => entry.email === normalized))
			continue;
		recipients.push({ email: normalized, kind });
	}
	const statements: D1PreparedStatement[] = [];
	if (reminder.anchor_at === null) return { statements };
	for (const recipient of recipients) {
		const hash = await recipientHash(recipient.email);
		for (const stage of renewalStages)
			statements.push(
				db
					.prepare(
						`INSERT OR IGNORE INTO renewal_reminder_sends
						 (id, reminder_id, stage, recipient_email, recipient_hash,
						  recipient_kind, due_at, status, click_token, created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
					)
					.bind(
						crypto.randomUUID(),
						reminder.id,
						stage,
						recipient.email,
						hash,
						recipient.kind,
						renewalStageDueAt(reminder.anchor_at, reminder.cycle_days, stage),
						clickToken(),
						now,
						now,
					),
			);
	}
	return { statements };
}

async function resolveAnchors(
	db: D1Database,
	lookup: RedeemLookup,
	now: number,
	limit: number,
) {
	const rows = await db
		.prepare(
			`SELECT id, code_hash, contact_email, cycle_days, delivered_at
			 FROM renewal_reminders INDEXED BY renewal_reminders_status_lookup_idx
			 WHERE status = 'awaiting_redeem' AND next_lookup_at <= ?
			 ORDER BY next_lookup_at, id LIMIT ?`,
		)
		.bind(now, Math.max(1, Math.min(100, limit)))
		.all<{
			id: string;
			code_hash: string;
			contact_email: string | null;
			cycle_days: number;
			delivered_at: number;
		}>();
	if (!rows.results.length) return { redeemed: 0, abandoned: 0, waiting: 0 };
	let items: RedeemLookupItem[];
	try {
		items = await lookup([
			...new Set(rows.results.map((row) => row.code_hash)),
		]);
	} catch {
		return { redeemed: 0, abandoned: 0, waiting: 0, lookupFailed: true };
	}
	const byHash = new Map(items.map((item) => [item.code_hash, item]));
	let redeemed = 0;
	let abandoned = 0;
	let waiting = 0;
	// One batch per chunk of rows instead of one D1 call per row.
	const pending: D1PreparedStatement[][] = [];
	for (const row of rows.results) {
		const item = byHash.get(row.code_hash);
		const completedAt =
			item?.found && item.status === "completed" && item.completed_at
				? Date.parse(item.completed_at)
				: Number.NaN;
		if (Number.isFinite(completedAt)) {
			const accountEmail = isEmailAddress(item?.account_email)
				? item.account_email.trim().toLowerCase()
				: null;
			const { statements } = await sendStatements(
				db,
				{ ...row, anchor_at: completedAt },
				accountEmail,
				now,
			);
			pending.push([
				db
					.prepare(
						`UPDATE renewal_reminders SET status = 'scheduled', anchor_at = ?,
						 anchor_source = 'redeem', account_email = ?, next_lookup_at = NULL,
						 lookup_attempts = lookup_attempts + 1, updated_at = ?
						 WHERE id = ? AND status = 'awaiting_redeem'`,
					)
					.bind(completedAt, accountEmail, now, row.id),
				...statements,
			]);
			redeemed += 1;
		} else if (now - row.delivered_at > renewalRedeemWaitMs) {
			pending.push([
				db
					.prepare(
						`UPDATE renewal_reminders SET status = 'abandoned',
						 status_reason = 'not_redeemed', next_lookup_at = NULL,
						 lookup_attempts = lookup_attempts + 1, updated_at = ?
						 WHERE id = ? AND status = 'awaiting_redeem'`,
					)
					.bind(now, row.id),
			]);
			abandoned += 1;
		} else {
			pending.push([
				db
					.prepare(
						`UPDATE renewal_reminders SET next_lookup_at = ?,
						 lookup_attempts = lookup_attempts + 1, updated_at = ?
						 WHERE id = ? AND status = 'awaiting_redeem'`,
					)
					.bind(now + lookupRetryMs, now, row.id),
			]);
			waiting += 1;
		}
	}
	// A row's statements stay in one batch so its update and sends are atomic.
	for (let index = 0; index < pending.length; index += 25)
		await db.batch(pending.slice(index, index + 25).flat());
	return { redeemed, abandoned, waiting };
}

/** Refunds, revoked entitlements and any later paid order end a reminder. */
export async function cancelInvalidatedReminders(db: D1Database, now: number) {
	const reasons = [
		[
			"refunded",
			`EXISTS (SELECT 1 FROM shop_orders o WHERE o.id = r.order_id
			 AND ${refundedOrderCondition("o")})`,
		],
		["staff", staffOrderCondition("r.user_id", "r.contact_email")],
		[
			"revoked",
			`EXISTS (SELECT 1 FROM customer_entitlements ce
			 WHERE ce.order_item_id = r.order_item_id AND ce.status = 'revoked')`,
		],
		[
			"repurchased",
			`(EXISTS (SELECT 1 FROM shop_orders o WHERE r.user_id IS NOT NULL
			  AND o.user_id = r.user_id AND o.id <> r.order_id
			  AND o.paid_at > r.order_paid_at AND o.status IN ${paidStatuses})
			 OR EXISTS (SELECT 1 FROM shop_orders o WHERE r.contact_email IS NOT NULL
			  AND o.normalized_contact_email = r.contact_email AND o.id <> r.order_id
			  AND o.paid_at > r.order_paid_at AND o.status IN ${paidStatuses}))`,
		],
	] as const;
	let cancelled = 0;
	for (const [reason, condition] of reasons) {
		const changed = await db
			.prepare(
				`UPDATE renewal_reminders AS r SET status = 'cancelled',
				 status_reason = ?, next_lookup_at = NULL, updated_at = ?
				 WHERE r.status IN ('awaiting_redeem','scheduled') AND ${condition}
				 RETURNING id`,
			)
			.bind(reason, now)
			.all<{ id: string }>();
		const ids = changed.results.map((row) => row.id);
		for (let index = 0; index < ids.length; index += 50) {
			const chunk = ids.slice(index, index + 50);
			await db
				.prepare(
					`UPDATE renewal_reminder_sends SET status = 'cancelled',
					 status_reason = ?, updated_at = ?
					 WHERE status = 'pending' AND reminder_id IN (${chunk.map(() => "?").join(",")})`,
				)
				.bind(reason, now, ...chunk)
				.run();
		}
		cancelled += ids.length;
	}
	return cancelled;
}

type DueRow = {
	id: string;
	reminder_id: string;
	stage: RenewalStage;
	recipient_email: string;
	recipient_hash: string;
	recipient_kind: "order" | "account";
	due_at: number;
	click_token: string;
	user_id: string | null;
	product_id: string;
	sellable_item_id: string;
	item_name: string;
	locale: SupportedLocale;
	cycle_days: number;
	anchor_at: number;
};

async function sendDueReminders(
	db: D1Database,
	runtime: RuntimeConfig,
	now: number,
	options: {
		recallEnabled: boolean;
		limit: number;
		canContinue?: () => boolean;
	},
) {
	const rows = await db
		.prepare(
			`SELECT s.id, s.reminder_id, s.stage, s.recipient_email, s.recipient_hash,
			 s.recipient_kind, s.due_at, s.click_token, r.user_id, r.product_id,
			 r.sellable_item_id, r.item_name, r.locale, r.cycle_days, r.anchor_at
			 FROM renewal_reminder_sends s INDEXED BY renewal_reminder_sends_due_idx
			 JOIN renewal_reminders r ON r.id = s.reminder_id
			 WHERE s.status = 'pending' AND s.due_at <= ? AND r.status = 'scheduled'
			 ${options.recallEnabled ? "" : "AND s.stage <> 'recall'"}
			 ORDER BY s.due_at, s.id LIMIT ?`,
		)
		.bind(now, Math.max(1, Math.min(200, options.limit * 3)))
		.all<DueRow>();
	const result = { sent: 0, merged: 0, skipped: 0, excluded: 0, deferred: 0 };
	if (!rows.results.length) return result;
	const dayStart = beijingDayStart(now);
	const origin = renewalOrigin(runtime);
	const siteDomain = renewalSiteDomain(origin);
	const brand = await loadBrand(db);
	const sentToday = new Map<string, string | null>();
	for (const row of rows.results) {
		if (result.sent >= options.limit) break;
		if (options.canContinue && !options.canContinue()) break;
		if (
			isRenewalStageStale(
				row.stage,
				row.due_at,
				row.anchor_at,
				row.cycle_days,
				now,
			)
		) {
			await finish(db, row.id, "skipped", "stale", now);
			result.skipped += 1;
			continue;
		}
		const exclusion = await recipientExclusion(db, row);
		if (exclusion) {
			await finish(db, row.id, exclusion.status, exclusion.reason, now);
			result.excluded += 1;
			continue;
		}
		// The same item for the same recipient on the same day (e.g. quantity 2)
		// is covered by the email already sent.
		const sibling = await db
			.prepare(
				`SELECT s.notification_delivery_id FROM renewal_reminder_sends s
				 JOIN renewal_reminders r ON r.id = s.reminder_id
				 WHERE s.recipient_hash = ? AND s.stage = ? AND s.due_at = ?
				 AND s.status = 'sent' AND r.sellable_item_id = ? LIMIT 1`,
			)
			.bind(row.recipient_hash, row.stage, row.due_at, row.sellable_item_id)
			.first<{ notification_delivery_id: string | null }>();
		if (sibling) {
			await db
				.prepare(
					`UPDATE renewal_reminder_sends SET status = 'merged',
					 status_reason = 'same_item_same_day', notification_delivery_id = ?,
					 updated_at = ? WHERE id = ? AND status = 'pending'`,
				)
				.bind(sibling.notification_delivery_id, now, row.id)
				.run();
			result.merged += 1;
			continue;
		}
		if (!sentToday.has(row.recipient_hash)) {
			const today = await db
				.prepare(
					`SELECT id FROM renewal_reminder_sends INDEXED BY renewal_reminder_sends_recipient_idx
					 WHERE recipient_hash = ? AND sent_at >= ? LIMIT 1`,
				)
				.bind(row.recipient_hash, dayStart)
				.first<{ id: string }>();
			if (today) sentToday.set(row.recipient_hash, today.id);
		}
		if (sentToday.has(row.recipient_hash)) {
			result.deferred += 1;
			continue;
		}
		const claimed = await db
			.prepare(
				`UPDATE renewal_reminder_sends SET status = 'sending', updated_at = ?
				 WHERE id = ? AND status = 'pending'`,
			)
			.bind(now, row.id)
			.run();
		if (Number(claimed.meta.changes ?? 0) !== 1) continue;
		const content = renderRenewalEmail({
			stage: row.stage,
			locale: row.locale,
			itemName: row.item_name,
			expiresAt: renewalExpiresAt(row.anchor_at, row.cycle_days),
			now,
			siteDomain,
			brand,
			renewUrl: `${origin}/r/renew/${row.click_token}`,
			unsubscribeUrl: await renewalUnsubscribeUrl(runtime, row.recipient_email),
		});
		const oneClick = await renewalUnsubscribeUrl(
			runtime,
			row.recipient_email,
			"/api/shop/renewal/unsubscribe",
		);
		try {
			const delivery = await enqueueConfiguredEmailNotification(db, {
				event: renewalEmailEvents[row.stage],
				idempotencyKey: `renewal:${row.id}`,
				to: row.recipient_email,
				subject: content.subject,
				text: content.text,
				locale: row.locale,
				headers: {
					"List-Unsubscribe": `<${oneClick}>`,
					"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
				},
			});
			await db
				.prepare(
					`UPDATE renewal_reminder_sends SET status = 'sent', sent_at = ?,
					 notification_delivery_id = ?, updated_at = ?
					 WHERE id = ? AND status = 'sending'`,
				)
				.bind(now, delivery.id, now, row.id)
				.run();
		} catch {
			// The email channel is unavailable; retry on the next run.
			await db
				.prepare(
					"UPDATE renewal_reminder_sends SET status = 'pending', updated_at = ? WHERE id = ? AND status = 'sending'",
				)
				.bind(now, row.id)
				.run();
			break;
		}
		sentToday.set(row.recipient_hash, row.id);
		result.sent += 1;
	}
	return result;
}

async function recipientExclusion(
	db: D1Database,
	row: Pick<
		DueRow,
		| "recipient_email"
		| "recipient_hash"
		| "recipient_kind"
		| "user_id"
		| "stage"
	>,
) {
	const unsubscribed = await db
		.prepare(
			"SELECT 1 AS found FROM email_unsubscribes WHERE recipient_hash = ? AND scope = 'renewal' LIMIT 1",
		)
		.bind(row.recipient_hash)
		.first<{ found: number }>();
	if (unsubscribed)
		return { status: "unsubscribed" as const, reason: "unsubscribed" };
	if (row.recipient_kind === "order" && row.user_id) {
		const preference = await db
			.prepare(
				`SELECT enabled FROM notification_subscriptions WHERE user_id = ?
				 AND event = 'entitlement_expiring' AND channel = 'email' LIMIT 1`,
			)
			.bind(row.user_id)
			.first<{ enabled: number }>();
		if (preference?.enabled === 0)
			return { status: "unsubscribed" as const, reason: "preference" };
	}
	const suppression = await recipientSuppressionReason(
		db,
		row.recipient_email,
		renewalEmailEvents[row.stage],
	);
	if (suppression)
		return { status: "suppressed" as const, reason: suppression };
	return null;
}

function finish(
	db: D1Database,
	id: string,
	status: "skipped" | "suppressed" | "unsubscribed",
	reason: string,
	now: number,
) {
	return db
		.prepare(
			`UPDATE renewal_reminder_sends SET status = ?, status_reason = ?, updated_at = ?
			 WHERE id = ? AND status = 'pending'`,
		)
		.bind(status, reason, now, id)
		.run();
}

async function loadBrand(db: D1Database) {
	const row = await db
		.prepare(
			"SELECT value FROM system_settings WHERE key = 'site.name' LIMIT 1",
		)
		.first<{ value: string }>();
	try {
		const value: unknown = row ? JSON.parse(row.value) : null;
		return typeof value === "string" && value.trim()
			? value.trim().slice(0, 80)
			: "老实人AI";
	} catch {
		return "老实人AI";
	}
}

function normalizedRecipient(email: string | null | undefined) {
	const normalized = email?.trim().toLowerCase();
	if (
		!normalized ||
		!isEmailAddress(normalized) ||
		isInternalIdentityEmail(normalized) ||
		isReservedEmailRecipient(normalized)
	)
		return null;
	return normalized;
}

function itemName(row: { sellable_item_name: string; product_name: string }) {
	const name = row.sellable_item_name.trim();
	return (name && name !== "Default" ? name : row.product_name).slice(0, 120);
}

export function reminderLocale(locale: string | null): SupportedLocale {
	return locale === "en-US" ? "en-US" : "zh-CN";
}

function clickToken() {
	const bytes = crypto.getRandomValues(new Uint8Array(18));
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}
