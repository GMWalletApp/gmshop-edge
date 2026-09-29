import type { z } from "zod";
import { consumeEntitlementAccess } from "#/features/entitlements/server/ledger";
import { emailMessageSchema } from "#/features/notifications/schema";
import {
	decryptNotificationConfig,
	decryptNotificationMessage,
	encryptNotificationMessage,
} from "#/features/notifications/secrets";
import {
	type EmailProviderId,
	sendProviderEmail,
} from "#/features/notifications/server/email-provider";
import { DomainError } from "#/lib/domain-error";
import type { SupportedLocale } from "#/lib/locales";
import type { NotificationQueueMessage } from "#/server/queue/types";
import { loadRuntimeConfig } from "#/server/runtime-config";

type EmailMessage = z.output<typeof emailMessageSchema>;
type NotificationAsset = {
	entitlementId: string;
	assetType: "stock_secret" | "download_asset" | "automation_artifact";
	assetId: string;
	accessEventType: "email_content_sent" | "link_sent";
};

export async function enqueueConfiguredEmailNotification(
	db: D1Database,
	input: {
		event: string;
		idempotencyKey: string;
		to: string;
		subject: string;
		text: string;
		locale?: SupportedLocale;
		html?: string;
		asset?: NotificationAsset;
	},
) {
	const config = await db
		.prepare(
			`SELECT from_address, reply_to FROM notification_channel_configs
			 WHERE channel = 'email' AND enabled = 1 ORDER BY sort_order, id LIMIT 1`,
		)
		.first<{ from_address: string; reply_to: string | null }>();
	if (!config)
		throw new DomainError(
			"email_channel_unavailable",
			503,
			"Email delivery is unavailable",
		);
	return enqueueEmailNotification(db, {
		event: input.event,
		idempotencyKey: input.idempotencyKey,
		message: {
			to: input.to,
			from: config.from_address,
			replyTo: config.reply_to ?? "",
			subject: input.subject,
			text: input.text,
			html: input.html ?? "",
		},
		locale: input.locale ?? "en-US",
		asset: input.asset,
	});
}

export async function enqueueEmailNotification(
	db: D1Database,
	input: {
		event: string;
		idempotencyKey: string;
		message: EmailMessage;
		locale?: SupportedLocale;
		configId?: string | null;
		templateId?: string | null;
		subscriptionId?: string | null;
		asset?: NotificationAsset;
	},
) {
	const message = emailMessageSchema.parse(input.message);
	if (!input.configId) {
		const enabled = await db
			.prepare(
				"SELECT 1 AS available FROM notification_channel_configs WHERE channel = 'email' AND enabled = 1 LIMIT 1",
			)
			.first<{ available: number }>();
		if (!enabled)
			throw new DomainError(
				"email_channel_unavailable",
				503,
				"Email delivery is unavailable",
			);
	}
	const existing = await db
		.prepare(
			"SELECT id, status FROM notification_deliveries WHERE idempotency_key = ? LIMIT 1",
		)
		.bind(input.idempotencyKey)
		.first<{ id: string; status: string }>();
	if (existing) return { ...existing, duplicate: true };
	const runtime = await loadRuntimeConfig(db);
	if (!runtime.commerceSecret)
		throw new DomainError(
			"notification_secret_unavailable",
			503,
			"Notification encryption is unavailable",
		);
	const id = crypto.randomUUID();
	const now = Date.now();
	const encrypted = await encryptNotificationMessage(
		JSON.stringify(message),
		runtime.commerceSecret,
	);
	await db.batch([
		db
			.prepare(
				`INSERT INTO notification_deliveries
				 (id, template_id, subscription_id, channel_config_id, event, channel, idempotency_key,
				  entitlement_id, asset_type, asset_id, access_event_type,
				  locale, message_encrypted, message_key_version, status, attempt_count,
				  next_attempt_at, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, 'email', ?, ?, ?, ?, ?, ?, ?, 1, 'pending', 0, ?, ?, ?)`,
			)
			.bind(
				id,
				input.templateId ?? null,
				input.subscriptionId ?? null,
				input.configId ?? null,
				input.event,
				input.idempotencyKey,
				input.asset?.entitlementId ?? null,
				input.asset?.assetType ?? null,
				input.asset?.assetId ?? null,
				input.asset?.accessEventType ?? null,
				input.locale ?? "en-US",
				encrypted,
				now,
				now,
				now,
			),
		db
			.prepare(
				`INSERT INTO outbox_events
				 (id, event_type, aggregate_type, aggregate_id, idempotency_key, payload,
				  status, attempt_count, created_at, updated_at)
				 VALUES (?, 'notification.requested', 'notification_delivery', ?, ?, ?,
				  'pending', 0, ?, ?)`,
			)
			.bind(
				crypto.randomUUID(),
				id,
				`notification-requested:${id}`,
				JSON.stringify({ notificationDeliveryId: id }),
				now,
				now,
			),
	]);
	return { id, status: "pending", duplicate: false };
}

export async function processNotificationDelivery(
	db: D1Database,
	deliveryId: string,
	options: { cloudflareEmail?: SendEmail | null } = {},
) {
	const delivery = await db
		.prepare("SELECT channel FROM notification_deliveries WHERE id = ? LIMIT 1")
		.bind(deliveryId)
		.first<{ channel: "email" }>();
	if (!delivery)
		throw new DomainError(
			"notification_delivery_unavailable",
			404,
			"Notification delivery is unavailable",
		);
	return processEmailNotification(db, deliveryId, options);
}

export async function publishPendingNotifications(
	db: D1Database,
	queue: Queue<NotificationQueueMessage>,
	limit = 25,
) {
	const rows = await db
		.prepare(
			`SELECT id, aggregate_id FROM outbox_events
			 WHERE event_type = 'notification.requested' AND status = 'pending'
			 AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
			 ORDER BY created_at, id LIMIT ?`,
		)
		.bind(Date.now(), Math.max(1, Math.min(100, Math.trunc(limit))))
		.all<{ id: string; aggregate_id: string }>();
	if (!rows.results.length) return { published: 0 };
	await queue.sendBatch(
		rows.results.map((row) => ({
			body: {
				kind: "commerce.notification",
				version: 1,
				notificationDeliveryId: row.aggregate_id,
			},
		})),
	);
	const now = Date.now();
	await db.batch(
		rows.results.map((row) =>
			db
				.prepare(
					`UPDATE outbox_events SET status = 'published', published_at = ?,
					 updated_at = ? WHERE id = ? AND status = 'pending'`,
				)
				.bind(now, now, row.id),
		),
	);
	return { published: rows.results.length };
}

export async function processEmailNotification(
	db: D1Database,
	deliveryId: string,
	options: { cloudflareEmail?: SendEmail | null } = {},
) {
	const row = await db
		.prepare(
			`SELECT nd.id, nd.status, nd.idempotency_key, nd.message_encrypted,
			 nd.attempt_count, nd.entitlement_id, nd.asset_type, nd.asset_id,
			 nd.access_event_type, nd.channel_config_id
			 FROM notification_deliveries nd
			 WHERE nd.id = ? AND nd.channel = 'email' LIMIT 1`,
		)
		.bind(deliveryId)
		.first<DeliveryRow>();
	if (!row)
		throw new DomainError(
			"notification_delivery_unavailable",
			404,
			"Notification delivery is unavailable",
		);
	if (row.status === "delivered") {
		await recordDeliveredNotificationAccess(db, row);
		return { duplicate: true, status: "delivered" };
	}
	const configs = await loadEmailDeliveryConfigs(db, row.channel_config_id);
	if (!configs.length)
		throw new DomainError(
			"notification_delivery_unavailable",
			404,
			"Notification delivery is unavailable",
		);
	const runtime = await loadRuntimeConfig(db);
	if (!runtime.commerceSecret)
		throw new DomainError(
			"notification_secret_unavailable",
			503,
			"Notification encryption is unavailable",
		);
	const message = await decryptNotificationMessage(
		row.message_encrypted,
		runtime.commerceSecret,
	).then((value) => emailMessageSchema.parse(JSON.parse(value)));
	const now = Date.now();
	const claimed = await db
		.prepare(
			`UPDATE notification_deliveries SET status = 'sending',
			 attempt_count = attempt_count + 1, updated_at = ?
			 WHERE id = ? AND status IN ('pending', 'failed')
			 AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`,
		)
		.bind(now, row.id, now)
		.run();
	if (Number(claimed.meta.changes ?? 0) !== 1)
		throw new DomainError(
			"notification_delivery_busy",
			409,
			"Notification delivery is already processing",
			{ retryable: true },
		);
	let cloudflareBindingError: DomainError | null = null;
	for (const config of configs) {
		const result = await tryEmailConfig(
			runtime.commerceSecret,
			config,
			{
				...message,
				from: config.from_address,
				replyTo: config.reply_to ?? "",
				idempotencyKey: `${row.idempotency_key}:${config.id}`,
			},
			options.cloudflareEmail ?? null,
		);
		if (!result.success) {
			if (
				result.error instanceof DomainError &&
				result.error.code === "notification_cloudflare_email_unavailable"
			)
				cloudflareBindingError = result.error;
			await updateEmailHealth(db, config.id, "unhealthy");
			continue;
		}
		const deliveredAt = Date.now();
		await db
			.prepare(
				`UPDATE notification_deliveries SET status = 'delivered',
				 channel_config_id = ?, provider_message_id = ?, delivered_at = ?,
				 next_attempt_at = NULL, error_code = NULL, updated_at = ?
				 WHERE id = ? AND status = 'sending'`,
			)
			.bind(
				config.id,
				result.data?.messageId?.slice(0, 200) ?? null,
				deliveredAt,
				deliveredAt,
				row.id,
			)
			.run();
		await recordDeliveredNotificationAccess(db, row, deliveredAt);
		await updateEmailHealth(db, config.id, "healthy");
		return { duplicate: false, status: "delivered" };
	}
	await recordFailure(
		db,
		row.id,
		row.attempt_count + 1,
		cloudflareBindingError
			? "cloudflare_email_unavailable"
			: "providers_unavailable",
	);
	if (cloudflareBindingError) throw cloudflareBindingError;
	throw new DomainError(
		"notification_provider_unavailable",
		503,
		"Notification providers are unavailable",
	);
}

async function tryEmailConfig(
	secret: string,
	config: EmailConfigRow,
	message: EmailMessage & { idempotencyKey: string },
	cloudflareEmail: SendEmail | null,
) {
	try {
		const apiKey =
			config.provider === "cloudflare_email"
				? null
				: config.api_key_encrypted
					? await decryptNotificationConfig(config.api_key_encrypted, secret)
					: null;
		return await sendProviderEmail(
			{
				provider: config.provider,
				apiKey,
				domain: config.domain,
				region: config.region,
				smtpHost: config.smtp_host,
				smtpPort: config.smtp_port,
				smtpUser: config.smtp_user,
				cloudflareEmail,
			},
			message,
		);
	} catch (error) {
		return { success: false, error } as const;
	}
}

async function loadEmailDeliveryConfigs(
	db: D1Database,
	configId: string | null,
) {
	const rows = await db
		.prepare(
			`SELECT id, provider, api_key_encrypted, domain, region, smtp_host,
			 smtp_port, smtp_user, from_address, reply_to
			 FROM notification_channel_configs WHERE channel = 'email'
			 AND ((? IS NOT NULL AND id = ?) OR (? IS NULL AND enabled = 1))
			 ORDER BY sort_order, id`,
		)
		.bind(configId, configId, configId)
		.all<EmailConfigRow>();
	return rows.results;
}

async function recordDeliveredNotificationAccess(
	db: D1Database,
	row: DeliveryRow,
	deliveredAt = Date.now(),
) {
	if (!row.entitlement_id || !row.asset_type || !row.asset_id) return;
	if (row.access_event_type === "email_content_sent") {
		await consumeEntitlementAccess(db, {
			entitlementId: row.entitlement_id,
			assetType: row.asset_type,
			assetId: row.asset_id,
			eventType: "email_content_sent",
			actorType: "system",
			idempotencyKey: `notification-access:${row.id}`,
		});
		return;
	}
	if (row.access_event_type === "link_sent")
		await db
			.prepare(
				`INSERT INTO entitlement_events
				 (id, kind, entitlement_id, asset_type, asset_id, event_type, consumed,
				  actor_type, idempotency_key, created_at)
				 VALUES (?, 'access', ?, ?, ?, 'link_sent', 0, 'system', ?, ?)
				 ON CONFLICT(idempotency_key) DO NOTHING`,
			)
			.bind(
				crypto.randomUUID(),
				row.entitlement_id,
				row.asset_type,
				row.asset_id,
				`notification-access:${row.id}`,
				deliveredAt,
			)
			.run();
}

async function recordFailure(
	db: D1Database,
	id: string,
	attempt: number,
	errorCode: string,
	retryable = true,
) {
	const now = Date.now();
	const delayMs = Math.min(3_600_000, 5_000 * 2 ** Math.min(attempt - 1, 9));
	await db
		.prepare(
			`UPDATE notification_deliveries SET status = 'failed', error_code = ?,
			 next_attempt_at = ?, updated_at = ? WHERE id = ? AND status = 'sending'`,
		)
		.bind(errorCode, retryable ? now + delayMs : null, now, id)
		.run();
}

function updateEmailHealth(
	db: D1Database,
	configId: string,
	status: "healthy" | "unhealthy",
) {
	const now = Date.now();
	return db
		.prepare(
			`UPDATE notification_channel_configs SET last_health_status = ?,
			 last_checked_at = ?, updated_at = ? WHERE id = ? AND channel = 'email'`,
		)
		.bind(status, now, now, configId)
		.run();
}

type DeliveryRow = {
	id: string;
	status: string;
	idempotency_key: string;
	message_encrypted: string;
	attempt_count: number;
	channel_config_id: string | null;
	entitlement_id: string | null;
	asset_type: NotificationAsset["assetType"] | null;
	asset_id: string | null;
	access_event_type: NotificationAsset["accessEventType"] | null;
};

type EmailConfigRow = {
	id: string;
	provider: EmailProviderId;
	api_key_encrypted: string | null;
	domain: string | null;
	region: "us" | "eu";
	smtp_host: string | null;
	smtp_port: number | null;
	smtp_user: string | null;
	from_address: string;
	reply_to: string | null;
};
