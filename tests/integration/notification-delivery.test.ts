import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	decryptNotificationMessage,
	encryptNotificationConfig,
} from "#/features/notifications/secrets";
import {
	enqueueEmailNotification,
	processEmailNotification,
	publishPendingNotifications,
} from "#/features/notifications/server/delivery";
import { fanOutPendingCommerceNotifications } from "#/features/notifications/server/fanout";
import { flushPendingCommerceNotifications } from "#/features/notifications/server/flush";
import type { NotificationQueueMessage } from "#/server/queue/types";
import { loadRuntimeConfig } from "#/server/runtime-config";
import { applyMigrations } from "./migrations";

describe("notification delivery", { timeout: 30_000 }, () => {
	let miniflare: Miniflare;
	let database: D1Database;

	beforeEach(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: crypto.randomUUID() },
		});
		database = await miniflare.getD1Database("DB");
		await applyMigrations(database);
		await seed(database);
	});

	afterEach(async () => {
		vi.unstubAllGlobals();
		await miniflare.dispose();
	});

	it("suppresses a reserved recipient without queuing or sending", async () => {
		const created = await enqueueEmailNotification(database, {
			event: "auth.email_verification",
			idempotencyKey: "reserved-recipient",
			message: {
				to: "probe@example.invalid",
				from: "mail@shop.com",
				replyTo: "",
				subject: "Verify",
				text: "private link",
				html: "",
			},
		});
		expect(created.status).toBe("suppressed");
		const send = vi.fn();
		expect(
			await processEmailNotification(database, created.id, {
				cloudflareEmail: { send } as unknown as SendEmail,
			}),
		).toEqual({ duplicate: true, status: "suppressed" });
		expect(send).not.toHaveBeenCalled();
		expect(
			await database
				.prepare(
					"SELECT count(*) AS n FROM outbox_events WHERE aggregate_id = ?",
				)
				.bind(created.id)
				.first("n"),
		).toBe(0);
	});

	it("rechecks disabled auth recipients at dequeue, not only enqueue", async () => {
		const created = await enqueueEmailNotification(database, {
			event: "auth.email_verification",
			idempotencyKey: "disabled-after-queue",
			message: {
				to: "blocked@customer.com",
				from: "mail@shop.com",
				replyTo: "",
				subject: "Verify",
				text: "private",
				html: "",
			},
		});
		await database
			.prepare(
				"INSERT INTO users (id,name,email,email_verified,enabled) VALUES ('blocked','Disabled','blocked@customer.com',0,0)",
			)
			.run();
		const send = vi.fn();
		expect(
			await processEmailNotification(database, created.id, {
				cloudflareEmail: { send } as unknown as SendEmail,
			}),
		).toMatchObject({ status: "suppressed" });
		expect(send).not.toHaveBeenCalled();
	});

	it("keeps message secrets out of D1 plaintext and Queue payloads", async () => {
		const created = await enqueueEmailNotification(database, {
			event: "auth.email_verification",
			idempotencyKey: "verify:user-1:token-digest",
			message: {
				to: "buyer@customer.com",
				from: "GMShop <mail@example.com>",
				replyTo: "",
				subject: "Verify your email",
				text: "Open https://shop.example/verify-email?token=private-token",
				html: "",
			},
		});
		const stored = await database
			.prepare(
				"SELECT message_encrypted FROM notification_deliveries WHERE id = ?",
			)
			.bind(created.id)
			.first<{ message_encrypted: string }>();
		expect(stored?.message_encrypted).not.toContain("buyer@customer.com");
		expect(stored?.message_encrypted).not.toContain("private-token");
		const sent: NotificationQueueMessage[] = [];
		const queue = {
			sendBatch: vi.fn(
				async (messages: Array<{ body: NotificationQueueMessage }>) => {
					sent.push(...messages.map((message) => message.body));
				},
			),
		} as unknown as Queue<NotificationQueueMessage>;
		await expect(publishPendingNotifications(database, queue)).resolves.toEqual(
			{
				published: 1,
			},
		);
		expect(sent).toEqual([
			{
				kind: "commerce.notification",
				version: 1,
				notificationDeliveryId: created.id,
			},
		]);
		expect(JSON.stringify(sent)).not.toContain("private-token");
	});

	it("sends through the fixed provider boundary with idempotency", async () => {
		const created = await enqueueEmailNotification(database, {
			event: "auth.password_reset",
			idempotencyKey: "reset:user-1:token-digest",
			message: {
				to: "buyer@customer.com",
				from: "GMShop <mail@example.com>",
				replyTo: "support@example.com",
				subject: "Reset password",
				text: "Reset link",
				html: "<p>Reset link</p>",
			},
		});
		const fetcher = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe("https://api.resend.com/emails");
				const headers = new Headers(init?.headers);
				expect(headers.get("Authorization")).toBe("Bearer re_test_key");
				expect(JSON.parse(String(init?.body))).toMatchObject({
					to: ["buyer@customer.com"],
					subject: "Reset password",
					headers: {
						"Idempotency-Key": "reset:user-1:token-digest:email-config",
					},
				});
				return Response.json({ id: "provider-message-1" });
			},
		);
		vi.stubGlobal("fetch", fetcher);
		await expect(
			processEmailNotification(database, created.id),
		).resolves.toEqual({ duplicate: false, status: "accepted" });
		await expect(
			processEmailNotification(database, created.id),
		).resolves.toEqual({ duplicate: true, status: "accepted" });
		expect(fetcher).toHaveBeenCalledTimes(1);
		const state = await database
			.prepare(
				`SELECT status, attempt_count, provider_message_id, accepted_at, delivered_at
				 FROM notification_deliveries WHERE id = ?`,
			)
			.bind(created.id)
			.first<Record<string, unknown>>();
		expect(state).toMatchObject({
			status: "accepted",
			attempt_count: 1,
			provider_message_id: "provider-message-1",
			delivered_at: null,
			accepted_at: expect.any(Number),
		});
	});

	it("sends Cloudflare Email through the structured binding without a secret", async () => {
		await configureCloudflareEmail(database);
		const send = vi.fn(async () => ({ messageId: "cloudflare-message-1" }));
		const binding = { send } as unknown as SendEmail;
		const created = await enqueueEmailNotification(database, {
			event: "notification.test",
			idempotencyKey: "cloudflare-email-test",
			message: {
				to: "buyer@customer.com",
				from: "ignored@example.com",
				replyTo: "support@example.com",
				subject: "Cloudflare binding",
				text: "Structured text",
				html: "<p>Structured HTML</p>",
			},
		});
		await expect(
			processEmailNotification(database, created.id, {
				cloudflareEmail: binding,
			}),
		).resolves.toEqual({ duplicate: false, status: "accepted" });
		expect(send).toHaveBeenCalledWith({
			from: { email: "mail@example.com", name: "GMShop" },
			to: "buyer@customer.com",
			replyTo: "support@example.com",
			subject: "Cloudflare binding",
			text: "Structured text",
			html: "<p>Structured HTML</p>",
		});
	});

	it("reports Cloudflare Email as unavailable when the binding is absent", async () => {
		await configureCloudflareEmail(database);
		const created = await enqueueEmailNotification(database, {
			event: "notification.test",
			idempotencyKey: "cloudflare-email-unbound",
			message: {
				to: "buyer@customer.com",
				from: "ignored@example.com",
				replyTo: "",
				subject: "Cloudflare binding",
				text: "Unavailable",
				html: "",
			},
		});
		await expect(
			processEmailNotification(database, created.id),
		).rejects.toMatchObject({
			code: "notification_cloudflare_email_unavailable",
			status: 503,
		});
		const row = await database
			.prepare(
				"SELECT status, error_code FROM notification_deliveries WHERE id = ?",
			)
			.bind(created.id)
			.first<Record<string, unknown>>();
		expect(row).toMatchObject({
			status: "failed",
			error_code: "cloudflare_email_unavailable",
		});
	});

	it("tries every enabled email configuration in fallback order", async () => {
		const backupKey = await encryptNotificationConfig(
			"re_backup_key",
			"data-test-secret",
		);
		await database
			.prepare(
				`INSERT INTO notification_channel_configs
				 (id, channel, name, provider, api_key_encrypted, api_key_version,
				  from_address, sort_order, enabled, created_at, updated_at)
				 VALUES ('email-backup', 'email', 'Backup', 'resend', ?, 1,
				  'Backup <backup@example.com>', 200, 1, 1, 1)`,
			)
			.bind(backupKey)
			.run();
		const created = await enqueueEmailNotification(database, {
			event: "notification.test",
			idempotencyKey: "overall-email-test",
			message: {
				to: "buyer@customer.com",
				from: "ignored@example.com",
				replyTo: "",
				subject: "Fallback test",
				text: "Fallback test",
				html: "",
			},
		});
		const credentials: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
				const credential =
					new Headers(init?.headers).get("Authorization") ?? "";
				credentials.push(credential);
				if (credential === "Bearer re_test_key")
					return Response.json({ message: "unavailable" }, { status: 503 });
				return Response.json({ id: "backup-message" });
			}),
		);

		await expect(
			processEmailNotification(database, created.id),
		).resolves.toEqual({ duplicate: false, status: "accepted" });
		expect(credentials).toEqual(["Bearer re_test_key", "Bearer re_backup_key"]);
		const delivery = await database
			.prepare(
				`SELECT channel_config_id, provider_message_id, status
				 FROM notification_deliveries WHERE id = ?`,
			)
			.bind(created.id)
			.first<Record<string, unknown>>();
		expect(delivery).toMatchObject({
			channel_config_id: "email-backup",
			provider_message_id: "backup-message",
			status: "accepted",
		});
		const health = await database
			.prepare(
				`SELECT id, last_health_status FROM notification_channel_configs
				 WHERE id IN ('email-config', 'email-backup') ORDER BY sort_order`,
			)
			.all<{ id: string; last_health_status: string }>();
		expect(health.results).toEqual([
			{ id: "email-config", last_health_status: "unhealthy" },
			{ id: "email-backup", last_health_status: "healthy" },
		]);
	});

	it("tests one selected email configuration even when it is disabled", async () => {
		await database
			.prepare(
				"UPDATE notification_channel_configs SET enabled = 0 WHERE id = 'email-config'",
			)
			.run();
		const created = await enqueueEmailNotification(database, {
			event: "notification.test",
			idempotencyKey: "individual-email-test",
			configId: "email-config",
			message: {
				to: "buyer@customer.com",
				from: "mail@example.com",
				replyTo: "",
				subject: "Individual test",
				text: "Individual test",
				html: "",
			},
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ id: "individual-message" })),
		);
		await expect(
			processEmailNotification(database, created.id),
		).resolves.toEqual({ duplicate: false, status: "accepted" });
	});

	it("fans commerce outbox events into localized encrypted deliveries", async () => {
		await seedPaidOrder(database);
		await expect(fanOutPendingCommerceNotifications(database)).resolves.toEqual(
			{ processed: 1, deliveries: 1 },
		);
		const state = await database
			.prepare(
				`SELECT nd.message_encrypted, nd.event, oe.status AS source_status
				 FROM notification_deliveries nd JOIN outbox_events oe
				 ON oe.id = 'order-paid-outbox' WHERE nd.event = 'order_paid'`,
			)
			.first<Record<string, unknown>>();
		expect(state).toMatchObject({
			event: "order_paid",
			source_status: "published",
		});
		expect(String(state?.message_encrypted)).not.toContain(
			"buyer@customer.com",
		);
		expect(String(state?.message_encrypted)).not.toContain("ORDER-1001");
	});

	it("adds the owner's WeChat to the payment email of access orders only", async () => {
		await seedPaidOrder(database);
		const readText = async () => {
			const row = await database
				.prepare(
					"SELECT message_encrypted FROM notification_deliveries WHERE event = 'order_paid' ORDER BY created_at DESC LIMIT 1",
				)
				.first<{ message_encrypted: string }>();
			const runtime = await loadRuntimeConfig(database);
			return JSON.parse(
				await decryptNotificationMessage(
					row?.message_encrypted ?? "",
					runtime.commerceSecret,
				),
			).text as string;
		};
		await fanOutPendingCommerceNotifications(database);
		expect(await readText()).not.toContain("owner-wechat-qr");
		await database.batch([
			database.prepare("DELETE FROM notification_deliveries"),
			database.prepare(
				"INSERT INTO users(id,name,email,email_verified,enabled,balance_minor,created_at,updated_at) VALUES ('agent-buyer','Buyer','buyer@customer.com',1,1,'0',1,1)",
			),
			database.prepare(
				`INSERT INTO agent_access_orders (order_item_id,user_id,kind,email,created_at,updated_at)
				 VALUES ('item-1001','agent-buyer','subsite','buyer@customer.com',1,1)`,
			),
			database.prepare(
				"UPDATE outbox_events SET status='pending', idempotency_key='shop-order-paid:order-1001:3' WHERE id='order-paid-outbox'",
			),
		]);
		await fanOutPendingCommerceNotifications(database);
		expect(await readText()).toMatch(
			/(有问题请添加微信联系我|Questions\? Add me on WeChat\.) https:\/\/shop\.example\/owner-wechat-qr\.jpg$/,
		);
	});

	it("publishes customer notifications immediately without waiting for cron", async () => {
		await seedPaidOrder(database);
		const sent: NotificationQueueMessage[] = [];
		const queue = {
			sendBatch: vi.fn(
				async (messages: Array<{ body: NotificationQueueMessage }>) => {
					sent.push(...messages.map((message) => message.body));
				},
			),
		} as unknown as Queue<NotificationQueueMessage>;

		await expect(
			flushPendingCommerceNotifications(database, queue),
		).resolves.toEqual({
			fanout: { processed: 1, deliveries: 1 },
			published: { published: 1 },
		});

		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({
			kind: "commerce.notification",
			version: 1,
		});
		const state = await database
			.prepare(
				`SELECT nd.status AS delivery_status, oe.status AS source_status,
				 notification_outbox.status AS notification_outbox_status
				 FROM notification_deliveries nd
				 JOIN outbox_events oe ON oe.id = 'order-paid-outbox'
				 JOIN outbox_events notification_outbox
				 ON notification_outbox.aggregate_id = nd.id
				 AND notification_outbox.event_type = 'notification.requested'
				 WHERE nd.event = 'order_paid' LIMIT 1`,
			)
			.first<Record<string, unknown>>();
		expect(state).toMatchObject({
			delivery_status: "pending",
			source_status: "published",
			notification_outbox_status: "published",
		});
	});

	it("uses the registered user's preferred language instead of the order locale", async () => {
		await seedPaidOrder(database);
		await database.batch([
			database.prepare(
				`INSERT INTO users
				 (id, name, email, email_verified, preferred_locale, enabled, created_at, updated_at)
				 VALUES ('buyer-user', 'Buyer', 'buyer@customer.com', 1, 'zh-CN', 1, 1, 1)`,
			),
			database.prepare(
				"UPDATE shop_orders SET user_id = 'buyer-user', locale = 'en-US' WHERE id = 'order-1001'",
			),
		]);
		await expect(fanOutPendingCommerceNotifications(database)).resolves.toEqual(
			{ processed: 1, deliveries: 1 },
		);
		const delivery = await database
			.prepare(
				"SELECT locale FROM notification_deliveries WHERE event = 'order_paid' LIMIT 1",
			)
			.first<{ locale: string }>();
		expect(delivery?.locale).toBe("zh-CN");
	});

	it("fans refund and after-sale outbox events through the same notification path", async () => {
		await seedPaidOrder(database);
		await database
			.prepare(
				"UPDATE outbox_events SET status = 'published' WHERE id = 'order-paid-outbox'",
			)
			.run();
		await database.batch([
			database.prepare(
				`INSERT INTO refunds
				 (id, order_id, idempotency_key, amount_minor, currency,
				  payment_amount_minor, payment_currency, payment_currency_decimals,
				  order_status_before, status, reason, attempt_count, created_at, updated_at)
				 VALUES ('refund-1001', 'order-1001', 'refund-notification-1001', '1299',
				  'USD', '1299', 'USD', 2, 'paid', 'succeeded', 'Customer request', 1, 1, 1)`,
			),
			database.prepare(
				`INSERT INTO after_sale_cases
				 (id, order_id, case_number, type, status, reason, resolution, created_at, updated_at)
				 VALUES ('case-1001', 'order-1001', 'AS-1001', 'redelivery', 'resolved',
				  'Credential issue', 'Replacement delivered', 1, 1)`,
			),
			database.prepare(
				`INSERT INTO outbox_events
				 (id, event_type, aggregate_type, aggregate_id, idempotency_key, payload,
				  status, attempt_count, created_at, updated_at) VALUES
				 ('refund-event-1001', 'refund.succeeded', 'refund', 'refund-1001',
				  'refund.succeeded:refund-1001:0', '{"refundId":"refund-1001"}', 'pending', 0, 2, 2),
				 ('case-event-1001', 'after_sale.updated', 'after_sale_case', 'case-1001',
				  'after_sale.updated:case-1001:2', '{"afterSaleCaseId":"case-1001"}', 'pending', 0, 2, 2)`,
			),
		]);
		await expect(fanOutPendingCommerceNotifications(database)).resolves.toEqual(
			{ processed: 2, deliveries: 2 },
		);
		const events = await database
			.prepare(
				`SELECT event FROM notification_deliveries
				 WHERE event IN ('refund_succeeded', 'after_sale_updated') ORDER BY event`,
			)
			.all<{ event: string }>();
		expect(events.results.map(({ event }) => event)).toEqual([
			"after_sale_updated",
			"refund_succeeded",
		]);
	});
});

async function seed(database: D1Database) {
	const apiKeyEncrypted = await encryptNotificationConfig(
		"re_test_key",
		"data-test-secret",
	);
	await database.batch([
		database.prepare(
			`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
			 VALUES ('runtime.better_auth_url', '"https://shop.example"', 0, 1, 1)`,
		),
		database.prepare(
			`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
			 VALUES ('runtime.data_encryption_secret', '"data-test-secret"', 1, 1, 1)`,
		),
		database
			.prepare(
				`INSERT INTO notification_channel_configs
				 (id, channel, name, provider, api_key_encrypted, api_key_version,
				  from_address, reply_to, sort_order, enabled, created_at, updated_at)
				 VALUES ('email-config', 'email', 'Primary', 'resend', ?, 1,
				  'GMShop <mail@example.com>', 'support@example.com', 100, 1, 1, 1)`,
			)
			.bind(apiKeyEncrypted),
	]);
}

async function configureCloudflareEmail(database: D1Database) {
	await database.batch([
		database.prepare(
			"UPDATE notification_channel_configs SET enabled = 0 WHERE channel = 'email'",
		),
		database.prepare(
			`INSERT INTO notification_channel_configs
			 (id, channel, name, provider, api_key_encrypted, api_key_version,
			  from_address, reply_to, sort_order, enabled, created_at, updated_at)
			 VALUES ('cloudflare-email', 'email', 'Cloudflare Email',
			  'cloudflare_email', NULL, NULL, 'GMShop <mail@example.com>',
			  'support@example.com', 10, 1, 1, 1)`,
		),
	]);
}

async function seedPaidOrder(database: D1Database) {
	await database.batch([
		database.prepare(
			`INSERT OR IGNORE INTO products
			 (id, name, description, product_type, status, created_at, updated_at)
			 VALUES ('product-1001', 'Digital product', NULL, 'download', 'active', 1, 1)`,
		),
		database.prepare(
			`INSERT OR IGNORE INTO product_sellable_items
			 (id, product_id, name, price_minor, created_at, updated_at)
			 VALUES ('sellable-1001', 'product-1001', 'Default', '1299', 1, 1)`,
		),
		database.prepare(
			`INSERT INTO shop_orders
			 (id, order_number, contact_email, normalized_contact_email,
			  status, currency, currency_decimals, subtotal_minor, discount_minor,
			  total_minor, paid_minor, version, expires_at, created_at, updated_at)
			 VALUES ('order-1001', 'ORDER-1001', 'buyer@customer.com',
			  'buyer@customer.com', 'paid', 'USD', 2, '1299', '0', '1299', '1299',
			  2, 999999, 1, 1)`,
		),
		database.prepare(
			`INSERT INTO shop_order_items
			 (id, order_id, product_id, sellable_item_id, delivery_component_id,
			  product_name, delivery_component_type, delivery_component_version, sellable_item_name,
			  quantity, unit_price_minor, discount_minor, subtotal_minor,
			  created_at, updated_at)
			 VALUES ('item-1001', 'order-1001', 'product-1001', 'sellable-1001',
			  'sellable-1001', 'Digital product',
			  'download', 1, 'Default', 1, '1299', '0', '1299', 1, 1)`,
		),
		database.prepare(
			`INSERT INTO outbox_events
			 (id, event_type, aggregate_type, aggregate_id, idempotency_key, payload,
			  status, attempt_count, created_at, updated_at)
			 VALUES ('order-paid-outbox', 'shop_order.paid', 'shop_order', 'order-1001',
			  'shop-order-paid:order-1001:2', '{"orderId":"order-1001","version":2}',
			  'pending', 0, 1, 1)`,
		),
	]);
}
