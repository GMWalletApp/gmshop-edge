import {
	isRenewalStageStale,
	maskEmail,
	type RenewalStage,
	renderRenewalEmail,
	renewalExpiresAt,
	renewalStages,
} from "../domain";
import { renewalOrigin, renewalSiteDomain } from "./links";
import { loadRenewalSettings } from "./settings";

const dayMs = 86_400_000;
const paidStatuses = "('paid','fulfilling','completed')";
// Later paid order by the same customer (user or order email).
const repurchaseAfter = (from: string, until: string) => `(
 EXISTS (SELECT 1 FROM shop_orders o WHERE r.user_id IS NOT NULL AND o.user_id = r.user_id
  AND o.id <> r.order_id AND o.paid_at > ${from} AND o.paid_at <= ${until} AND o.status IN ${paidStatuses})
 OR EXISTS (SELECT 1 FROM shop_orders o WHERE r.contact_email IS NOT NULL
  AND o.normalized_contact_email = r.contact_email AND o.id <> r.order_id
  AND o.paid_at > ${from} AND o.paid_at <= ${until} AND o.status IN ${paidStatuses}))`;

export type RenewalStageStats = {
	stage: RenewalStage;
	planned: number;
	pending: number;
	sent: number;
	merged: number;
	bounced: number;
	skipped: number;
	failed: number;
	cancelled: number;
	excluded: number;
	clicked: number;
	clickRateBps: number;
	repurchased14d: number;
	repurchase14dRateBps: number;
	returned: number;
	returnRateBps: number;
};

function rate(part: number, total: number) {
	return total > 0 ? Math.round((part / total) * 10_000) : 0;
}

/** Per-stage funnel plus the pre-launch baseline repurchase rate. */
export async function loadRenewalStats(db: D1Database, now = Date.now()) {
	const rows = await db
		.prepare(
			`SELECT s.stage,
			 COUNT(*) AS planned,
			 SUM(s.status = 'pending') AS pending,
			 SUM(s.status = 'sent' AND nd.status IN ('accepted','delivered')) AS sent,
			 SUM(s.status = 'merged') AS merged,
			 SUM(s.status = 'sent' AND nd.status IN ('bounced','rejected')) AS bounced,
			 SUM(s.status = 'skipped') AS skipped,
			 SUM(s.status = 'failed') AS failed,
			 SUM(s.status = 'cancelled') AS cancelled,
			 SUM(s.status IN ('suppressed','unsubscribed')) AS excluded,
			 SUM(s.status = 'sent' AND s.click_count > 0) AS clicked,
			 SUM(s.status = 'sent' AND ${repurchaseAfter("s.sent_at", `s.sent_at + ${14 * dayMs}`)}) AS repurchased14d,
			 SUM(s.status = 'sent' AND ${repurchaseAfter("s.sent_at", String(Number.MAX_SAFE_INTEGER))}) AS returned
			 FROM renewal_reminder_sends s
			 JOIN renewal_reminders r ON r.id = s.reminder_id
			 LEFT JOIN notification_deliveries nd ON nd.id = s.notification_delivery_id
			 GROUP BY s.stage`,
		)
		.all<Record<string, number | string | null>>();
	const byStage = new Map(rows.results.map((row) => [String(row.stage), row]));
	const stages: RenewalStageStats[] = renewalStages.map((stage) => {
		const row = byStage.get(stage) ?? {};
		const value = (key: string) => Number(row[key] ?? 0);
		const sent = value("sent");
		return {
			stage,
			planned: value("planned"),
			pending: value("pending"),
			sent,
			merged: value("merged"),
			bounced: value("bounced"),
			skipped: value("skipped"),
			failed: value("failed"),
			cancelled: value("cancelled"),
			excluded: value("excluded"),
			clicked: value("clicked"),
			clickRateBps: rate(value("clicked"), sent),
			repurchased14d: value("repurchased14d"),
			repurchase14dRateBps: rate(value("repurchased14d"), sent),
			returned: value("returned"),
			returnRateBps: rate(value("returned"), sent),
		};
	});
	const launch = await db
		.prepare("SELECT MIN(created_at) AS launched_at FROM renewal_reminders")
		.first<{ launched_at: number | null }>();
	const launchedAt = launch?.launched_at ?? now;
	// Baseline: direct customers whose first paid order was at least 30 days
	// before launch, and how many of them ordered again before launch.
	const baseline = await db
		.prepare(
			`WITH direct AS (
			  SELECT o.normalized_contact_email AS email, o.paid_at
			  FROM shop_orders o
			  WHERE o.paid_at IS NOT NULL AND o.paid_at < ? AND o.status IN ${paidStatuses}
			  AND o.normalized_contact_email IS NOT NULL
			  AND NOT EXISTS (SELECT 1 FROM supplier_api_orders sa WHERE sa.shop_order_id = o.id)
			 ), customers AS (
			  SELECT email, MIN(paid_at) AS first_paid_at, COUNT(*) AS orders
			  FROM direct GROUP BY email
			 )
			 SELECT COUNT(*) AS customers, SUM(orders > 1) AS repeat_customers
			 FROM customers WHERE first_paid_at <= ?`,
		)
		.bind(launchedAt, launchedAt - 30 * dayMs)
		.first<{ customers: number; repeat_customers: number | null }>();
	const reminders = await db
		.prepare(
			"SELECT status, COUNT(*) AS count FROM renewal_reminders GROUP BY status",
		)
		.all<{ status: string; count: number }>();
	const settings = await loadRenewalSettings(db);
	return {
		settings,
		launchedAt: launch?.launched_at ?? null,
		reminders: Object.fromEntries(
			reminders.results.map((row) => [row.status, Number(row.count)]),
		) as Record<string, number>,
		stages,
		baseline: {
			customers: Number(baseline?.customers ?? 0),
			repeatCustomers: Number(baseline?.repeat_customers ?? 0),
			repeatRateBps: rate(
				Number(baseline?.repeat_customers ?? 0),
				Number(baseline?.customers ?? 0),
			),
		},
	};
}

/**
 * Read-only: what the recall stage would send right now if it were enabled,
 * plus one rendered example of each template with masked addresses.
 */
export async function previewRenewalEmails(db: D1Database, now = Date.now()) {
	const recall = await db
		.prepare(
			`SELECT COUNT(*) AS rows, COUNT(DISTINCT s.recipient_hash) AS recipients
			 FROM renewal_reminder_sends s
			 JOIN renewal_reminders r ON r.id = s.reminder_id
			 WHERE s.stage = 'recall' AND s.status = 'pending' AND s.due_at <= ?
			 AND r.status = 'scheduled'
			 AND NOT EXISTS (SELECT 1 FROM email_unsubscribes u
			  WHERE u.recipient_hash = s.recipient_hash AND u.scope = 'renewal')
			 AND NOT EXISTS (SELECT 1 FROM email_recipient_suppressions x
			  WHERE x.recipient_hash = s.recipient_hash)
			 AND NOT ${repurchaseAfter("r.order_paid_at", String(Number.MAX_SAFE_INTEGER))}`,
		)
		.bind(now)
		.first<{ rows: number; recipients: number }>();
	// Only the public origin is needed; runtime secrets are never read here.
	const urlRow = await db
		.prepare(
			"SELECT value FROM system_settings WHERE key = 'runtime.better_auth_url' LIMIT 1",
		)
		.first<{ value: string }>();
	let betterAuthUrl = "";
	try {
		const parsed: unknown = urlRow ? JSON.parse(urlRow.value) : "";
		if (typeof parsed === "string") betterAuthUrl = parsed;
	} catch {}
	const origin = renewalOrigin({ betterAuthUrl });
	const siteDomain = renewalSiteDomain(origin);
	const brandRow = await db
		.prepare(
			"SELECT value FROM system_settings WHERE key = 'site.name' LIMIT 1",
		)
		.first<{ value: string }>();
	let brand = "老实人AI";
	try {
		const parsed: unknown = brandRow ? JSON.parse(brandRow.value) : null;
		if (typeof parsed === "string" && parsed.trim()) brand = parsed.trim();
	} catch {}
	const examples = [];
	for (const stage of renewalStages) {
		const sample = await db
			.prepare(
				`SELECT s.recipient_email, s.due_at, r.item_name, r.locale, r.anchor_at, r.cycle_days
				 FROM renewal_reminder_sends s JOIN renewal_reminders r ON r.id = s.reminder_id
				 WHERE s.stage = ? AND r.anchor_at IS NOT NULL
				 ORDER BY (s.status = 'pending') DESC, s.due_at DESC LIMIT 1`,
			)
			.bind(stage)
			.first<{
				recipient_email: string;
				due_at: number;
				item_name: string;
				locale: "en-US" | "zh-CN";
				anchor_at: number;
				cycle_days: number;
			}>();
		const anchorAt = sample?.anchor_at ?? now - 27 * dayMs;
		const cycleDays = sample?.cycle_days ?? 30;
		const email = sample?.recipient_email ?? "customer@example.com";
		const rendered = renderRenewalEmail({
			stage,
			locale: sample?.locale ?? "zh-CN",
			itemName: sample?.item_name ?? "ChatGPT Plus 1个月",
			expiresAt: renewalExpiresAt(anchorAt, cycleDays),
			now: sample?.due_at ?? now,
			siteDomain,
			brand,
			renewUrl: `${origin}/r/renew/EXAMPLE_TOKEN`,
			unsubscribeUrl: `${origin}/unsubscribe/renewal?e=${encodeURIComponent(maskEmail(email))}&sig=…`,
			inviteUrl: `${origin}/account`,
			// Eligible recall recipients get a personal code; the preview shows its shape.
			recallCoupon:
				stage === "recall"
					? {
							code: "BACK-EXAMPLE",
							endsAt: (sample?.due_at ?? now) + 7 * dayMs,
						}
					: null,
		});
		examples.push({
			stage,
			to: maskEmail(email),
			stale: sample
				? isRenewalStageStale(stage, sample.due_at, anchorAt, cycleDays, now)
				: false,
			...rendered,
		});
	}
	return {
		recallEnabled: (await loadRenewalSettings(db)).recallEnabled,
		recallDueRows: Number(recall?.rows ?? 0),
		recallDueRecipients: Number(recall?.recipients ?? 0),
		examples,
	};
}
