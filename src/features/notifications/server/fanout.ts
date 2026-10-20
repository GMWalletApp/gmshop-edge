import { agentOwnerWeChat } from "#/features/agent-access/products";
import { decryptDeliveryContent } from "#/features/fulfillment/secrets";
import {
	redeemUrlForOrder,
	withRedeemHost,
} from "#/features/redeem-warehouse/redeem-host";
import { formatMinorAmount } from "#/lib/format";
import { type SupportedLocale, supportedLocales } from "#/lib/locales";
import { loadRuntimeConfig } from "#/server/runtime-config";
import {
	builtinNotificationTemplate,
	type CommerceNotificationEvent,
	renderNotificationTemplate,
} from "../templates";
import { enqueueConfiguredEmailNotification } from "./delivery";

const customerOutboxEvents = [
	"shop_order.paid",
	"delivery.ready",
	"automation.succeeded",
	"automation.failed",
	"refund.succeeded",
	"refund.failed",
	"after_sale.updated",
	"after_sale.opened",
	"entitlement.expiring",
] as const;

const outboxEvents = customerOutboxEvents;

type CommerceOutboxEvent = (typeof outboxEvents)[number];
type CustomerOutboxEvent = (typeof customerOutboxEvents)[number];

const eventNames: Record<CustomerOutboxEvent, CommerceNotificationEvent> = {
	"shop_order.paid": "order_paid",
	"delivery.ready": "delivery_ready",
	"automation.succeeded": "automation_ready",
	"automation.failed": "automation_failed",
	"refund.succeeded": "refund_succeeded",
	"refund.failed": "refund_failed",
	"after_sale.updated": "after_sale_updated",
	"after_sale.opened": "after_sale_updated",
	"entitlement.expiring": "entitlement_expiring",
};

export async function fanOutPendingCommerceNotifications(
	db: D1Database,
	limit = 25,
) {
	const rows = await db
		.prepare(
			`SELECT id, event_type, aggregate_type, aggregate_id FROM outbox_events
			 WHERE event_type IN (${outboxEvents.map(() => "?").join(", ")})
			 AND status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
			 ORDER BY created_at, id LIMIT ?`,
		)
		.bind(
			...outboxEvents,
			Date.now(),
			Math.max(1, Math.min(100, Math.trunc(limit))),
		)
		.all<OutboxRow>();
	const emailAvailable = await hasEnabledEmailChannel(db);
	let delivered = 0;
	for (const row of rows.results) {
		const event = eventNames[row.event_type];
		const order = await loadOrderForEvent(db, row);
		if (!order) {
			await markOutboxFailed(db, row.id, "notification_order_missing");
			continue;
		}
		const buildNotificationChannel = row.event_type.startsWith("automation.")
			? await loadBuildNotificationChannel(db, row.aggregate_id)
			: null;
		if (buildNotificationChannel === "none") {
			await markOutboxPublished(db, row.id);
			continue;
		}
		const storedEmailPreference = order.user_id
			? await loadEmailPreference(db, order.user_id, event)
			: null;
		const emailPreference =
			buildNotificationChannel === "email"
				? {
						enabled: 1,
					}
				: storedEmailPreference;
		if (buildNotificationChannel === "email" && !emailAvailable) {
			await markOutboxFailed(db, row.id, "automation_email_unavailable");
			continue;
		}
		if (
			buildNotificationChannel === "email" &&
			!order.normalized_contact_email
		) {
			await markOutboxFailed(
				db,
				row.id,
				"notification_destination_unavailable",
			);
			continue;
		}
		if (
			!emailAvailable ||
			!order.normalized_contact_email ||
			emailPreference?.enabled === 0
		) {
			await markOutboxPublished(db, row.id);
			continue;
		}
		const runtime = await loadRuntimeConfig(db);
		const locale = supportedLocale(order.preferred_locale ?? order.locale);
		const orderPath = order.user_id
			? `/account/orders/${encodeURIComponent(order.order_number)}`
			: `/orders/${encodeURIComponent(order.order_number)}`;
		const values = {
			site_name: await loadSiteName(db),
			order_number: order.order_number,
			product_name: order.product_name ?? order.order_number,
			status: order.status,
			amount: formatMinorAmount(
				order.total_minor,
				order.currency,
				order.currency_decimals,
				locale,
			),
			order_url: new URL(
				orderPath,
				runtime.betterAuthUrl || "https://localhost",
			).toString(),
			case_number: order.case_number ?? "",
			resolution: order.resolution ?? "",
		};
		const deliveryPolicy =
			row.event_type === "delivery.ready"
				? await loadDeliveryPresentation(db, row.aggregate_id)
				: null;
		if (
			emailAvailable &&
			emailPreference?.enabled !== 0 &&
			deliveryPolicy?.emailMode !== "none"
		) {
			const template = await selectTemplate(db, event, locale);
			let deliveryContent: string | null = null;
			if (
				deliveryPolicy?.emailMode === "content" &&
				deliveryPolicy.contentEncrypted &&
				runtime.commerceSecret
			)
				deliveryContent = withRedeemHost(
					await decryptDeliveryContent(
						deliveryPolicy.contentEncrypted,
						runtime.commerceSecret,
					),
					await redeemUrlForOrder(db, order.id),
				);
			const rendered =
				renderNotificationTemplate(template.body, values) +
				(event === "order_paid" && (await isAgentAccessOrder(db, order.id))
					? `\n\n${agentOwnerWeChat[locale]} ${new URL(agentOwnerWeChat.imagePath, runtime.betterAuthUrl || "https://localhost")}`
					: "");
			await enqueueConfiguredEmailNotification(db, {
				event,
				idempotencyKey: `commerce-event:${row.id}:email:${order.normalized_contact_email}`,
				to: order.normalized_contact_email,
				subject: renderNotificationTemplate(
					template.subject ??
						builtinNotificationTemplate(event, locale).subject,
					values,
				),
				text: deliveryContent ? `${rendered}\n\n${deliveryContent}` : rendered,
				locale,
				asset: deliveryPolicy
					? {
							entitlementId: deliveryPolicy.entitlementId,
							assetType: deliveryPolicy.assetType,
							assetId: row.aggregate_id,
							accessEventType: deliveryContent
								? "email_content_sent"
								: "link_sent",
						}
					: undefined,
			});
			delivered += 1;
		}
		await markOutboxPublished(db, row.id);
	}
	return { processed: rows.results.length, deliveries: delivered };
}

// Sub-site / API openings carry no separate activation email; the payment
// confirmation is where their buyers get the owner's WeChat.
async function isAgentAccessOrder(db: D1Database, orderId: string) {
	const row = await db
		.prepare(
			`SELECT 1 AS found FROM agent_access_orders agent
			 JOIN shop_order_items item ON item.id = agent.order_item_id
			 WHERE item.order_id = ? LIMIT 1`,
		)
		.bind(orderId)
		.first<{ found: number }>();
	return row?.found === 1;
}

async function loadBuildNotificationChannel(
	db: D1Database,
	automationJobId: string,
) {
	const row = await db
		.prepare(
			"SELECT notification_channel FROM automation_jobs WHERE id = ? LIMIT 1",
		)
		.bind(automationJobId)
		.first<{ notification_channel: "none" | "email" }>();
	return row?.notification_channel ?? "none";
}

async function loadDeliveryPresentation(db: D1Database, deliveryId: string) {
	const row = await db
		.prepare(
			`SELECT item.delivery_component_type, item.duration_ms, item.usage_limit, item.access_limit,
			 item.email_mode, delivery.content_encrypted, grant_row.entitlement_id
			 FROM delivery_records delivery
			 JOIN shop_order_items item ON item.id = delivery.order_item_id
			 JOIN entitlement_grants grant_row ON grant_row.source_order_item_id = item.id
			 WHERE delivery.id = ? AND delivery.status = 'delivered' LIMIT 1`,
		)
		.bind(deliveryId)
		.first<{
			delivery_component_type: "stock" | "download" | "automation";
			duration_ms: number | null;
			usage_limit: number | null;
			access_limit: number | null;
			email_mode: "none" | "link" | "content";
			content_encrypted: string | null;
			entitlement_id: string;
		}>();
	if (!row) return null;
	const contentAllowed =
		row.delivery_component_type === "stock" &&
		row.duration_ms === null &&
		row.usage_limit === null &&
		row.access_limit === null;
	return {
		entitlementId: row.entitlement_id,
		assetType: deliveryAssetType(row.delivery_component_type),
		emailMode:
			row.email_mode === "content" && !contentAllowed ? "link" : row.email_mode,
		contentEncrypted: contentAllowed ? row.content_encrypted : null,
	};
}

function deliveryAssetType(type: "stock" | "download" | "automation") {
	if (type === "stock") return "stock_secret" as const;
	if (type === "download") return "download_asset" as const;
	return "automation_artifact" as const;
}

async function hasEnabledEmailChannel(db: D1Database) {
	const row = await db
		.prepare(
			`SELECT 1 AS enabled FROM notification_channel_configs
			 WHERE channel = 'email' AND enabled = 1 LIMIT 1`,
		)
		.first<{ enabled: number }>();
	return row?.enabled === 1;
}

async function loadOrderForEvent(db: D1Database, event: OutboxRow) {
	if (event.aggregate_type === "shop_order")
		return loadOrder(db, "o.id = ?", event.aggregate_id);
	if (event.aggregate_type === "delivery")
		return loadOrder(
			db,
			"o.id = (SELECT oi.order_id FROM delivery_records dr JOIN shop_order_items oi ON oi.id = dr.order_item_id WHERE dr.id = ?)",
			event.aggregate_id,
		);
	if (event.aggregate_type === "automation_job")
		return loadOrder(
			db,
			"o.id = (SELECT oi.order_id FROM automation_jobs bj JOIN shop_order_items oi ON oi.id = bj.order_item_id WHERE bj.id = ?)",
			event.aggregate_id,
		);
	if (event.aggregate_type === "refund")
		return loadOrder(
			db,
			"o.id = (SELECT order_id FROM refunds WHERE id = ?)",
			event.aggregate_id,
		);
	if (event.aggregate_type === "after_sale_case") {
		const order = await loadOrder(
			db,
			"o.id = (SELECT order_id FROM after_sale_cases WHERE id = ?)",
			event.aggregate_id,
		);
		if (!order) return null;
		const afterSale = await db
			.prepare(
				"SELECT case_number, resolution FROM after_sale_cases WHERE id = ? LIMIT 1",
			)
			.bind(event.aggregate_id)
			.first<{ case_number: string; resolution: string | null }>();
		return { ...order, ...afterSale };
	}
	if (event.aggregate_type === "customer_entitlement")
		return loadOrder(
			db,
			"o.id = (SELECT oi.order_id FROM customer_entitlements ce JOIN shop_order_items oi ON oi.id = ce.order_item_id WHERE ce.id = ?)",
			event.aggregate_id,
		);
	return null;
}

function loadOrder(db: D1Database, condition: string, id: string) {
	return db
		.prepare(
			`SELECT o.id, o.order_number, o.user_id, o.normalized_contact_email,
			 o.locale, u.preferred_locale,
			 o.status, o.currency, o.currency_decimals, o.total_minor,
			 (SELECT product_name FROM shop_order_items WHERE order_id = o.id
			  ORDER BY created_at, id LIMIT 1) AS product_name
			 FROM shop_orders o
			 LEFT JOIN users u ON u.id = o.user_id
			 WHERE ${condition} LIMIT 1`,
		)
		.bind(id)
		.first<OrderRow>();
}

function loadEmailPreference(
	db: D1Database,
	userId: string,
	event: CommerceNotificationEvent,
) {
	return db
		.prepare(
			`SELECT enabled FROM notification_subscriptions
			 WHERE user_id = ? AND event = ? AND channel = 'email' LIMIT 1`,
		)
		.bind(userId, event)
		.first<{ enabled: number }>();
}

async function selectTemplate(
	db: D1Database,
	event: CommerceNotificationEvent,
	locale: SupportedLocale,
) {
	const templates = await db
		.prepare(
			`SELECT locale, subject, body FROM notification_templates
			 WHERE event = ? AND channel = ? AND enabled = 1
			 AND locale IN (?, 'en-US') ORDER BY CASE WHEN locale = ? THEN 0 ELSE 1 END
			 LIMIT 1`,
		)
		.bind(event, "email", locale, locale)
		.first<{ locale: string; subject: string | null; body: string }>();
	if (templates?.subject)
		return { subject: templates.subject, body: templates.body };
	return builtinNotificationTemplate(event, locale);
}

async function loadSiteName(db: D1Database) {
	const row = await db
		.prepare(
			"SELECT value FROM system_settings WHERE key = 'site.name' LIMIT 1",
		)
		.first<{ value: string }>();
	if (!row) return "GMShop Edge";
	try {
		const value: unknown = JSON.parse(row.value);
		return typeof value === "string" && value.trim()
			? value.slice(0, 80)
			: "GMShop Edge";
	} catch {
		return "GMShop Edge";
	}
}

function supportedLocale(value?: string | null): SupportedLocale {
	return supportedLocales.find((locale) => locale === value) ?? "en-US";
}

function markOutboxPublished(db: D1Database, id: string) {
	const now = Date.now();
	return db
		.prepare(
			`UPDATE outbox_events SET status = 'published', published_at = ?,
			 updated_at = ? WHERE id = ? AND status = 'pending'`,
		)
		.bind(now, now, id)
		.run();
}

function markOutboxFailed(db: D1Database, id: string, code: string) {
	const now = Date.now();
	return db
		.prepare(
			`UPDATE outbox_events SET status = 'failed', last_error_code = ?,
			 attempt_count = attempt_count + 1, updated_at = ?
			 WHERE id = ? AND status = 'pending'`,
		)
		.bind(code, now, id)
		.run();
}

type OutboxRow = {
	id: string;
	event_type: CommerceOutboxEvent;
	aggregate_type: string;
	aggregate_id: string;
};

type OrderRow = {
	id: string;
	order_number: string;
	user_id: string | null;
	normalized_contact_email: string | null;
	locale: string;
	preferred_locale: string | null;
	status: string;
	currency: string;
	currency_decimals: number;
	total_minor: string;
	product_name: string | null;
	case_number?: string | null;
	resolution?: string | null;
};
