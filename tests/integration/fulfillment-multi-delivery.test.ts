import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { processDelivery } from "#/features/fulfillment/server/process";
import type { PaymentWebhookEvent } from "#/features/shop-payments/provider";
import { processShopPaymentEvent } from "#/features/shop-payments/server/service";
import { encryptSecret } from "#/lib/secrets";
import { applyMigrations } from "./migrations";

const orderId = "11111111-1111-4111-8111-111111111111";
const channelId = "33333333-3333-4333-8333-333333333333";
const attemptId = "44444444-4444-4444-8444-444444444444";

describe("multi-item order fulfillment", { timeout: 60_000 }, () => {
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
		await seed(database, ["a", "b", "c"]);
	});

	afterEach(async () => miniflare.dispose());

	it("delivers every item of a three-item order and completes the order", async () => {
		await processShopPaymentEvent(database, channelId, succeededEvent("3000"));
		const deliveries = await pendingDeliveries(database);
		expect(deliveries).toHaveLength(3);
		const outcomes = [];
		for (const delivery of deliveries)
			outcomes.push(await processDelivery(database, delivery.id));
		expect(outcomes.map((outcome) => outcome.orderStatus)).toEqual([
			"fulfilling",
			"fulfilling",
			"completed",
		]);
		const state = await database
			.prepare(
				`SELECT o.status,
				 (SELECT GROUP_CONCAT(status) FROM delivery_records) AS delivery_statuses,
				 (SELECT COUNT(*) FROM shop_order_events WHERE order_id = o.id
				  AND event_type = 'delivery_progressed') AS progress_events,
				 (SELECT COUNT(*) FROM shop_order_events WHERE order_id = o.id
				  AND event_type = 'delivery_progressed' AND from_status IS NULL) AS unchanged_events,
				 (SELECT COUNT(*) FROM stock_entries WHERE status = 'delivered') AS delivered_stock
				 FROM shop_orders o WHERE o.id = ?`,
			)
			.bind(orderId)
			.first<Record<string, unknown>>();
		expect(state).toMatchObject({
			status: "completed",
			delivery_statuses: "delivered,delivered,delivered",
			progress_events: 3,
			unchanged_events: 1,
			delivered_stock: 3,
		});
	});

	it("marks a delivery failed instead of delivering after the order was refunded", async () => {
		await processShopPaymentEvent(database, channelId, succeededEvent("3000"));
		const [first] = await pendingDeliveries(database);
		await database
			.prepare(
				"UPDATE shop_orders SET status = 'refunded', version = version + 1 WHERE id = ?",
			)
			.bind(orderId)
			.run();
		await expect(
			processDelivery(database, first?.id ?? ""),
		).resolves.toMatchObject({
			status: "failed",
			errorCode: "order_not_fulfillable",
			duplicate: false,
		});
		const delivery = await database
			.prepare("SELECT status, error_code FROM delivery_records WHERE id = ?")
			.bind(first?.id)
			.first<Record<string, unknown>>();
		expect(delivery).toEqual({
			status: "failed",
			error_code: "order_not_fulfillable",
		});
	});

	it("reserves restocked cards when a failed delivery is retried", async () => {
		await database
			.prepare("DELETE FROM stock_entries WHERE sellable_item_id = 'si-b'")
			.run();
		await processShopPaymentEvent(database, channelId, succeededEvent("3000"));
		const failed = await database
			.prepare(
				`SELECT dr.id FROM delivery_records dr JOIN shop_order_items oi ON oi.id = dr.order_item_id
				 WHERE oi.sellable_item_id = 'si-b'`,
			)
			.first<{ id: string }>();
		expect(
			await database
				.prepare("SELECT status, error_code FROM delivery_records WHERE id = ?")
				.bind(failed?.id)
				.first(),
		).toEqual({ status: "failed", error_code: "inventory_unavailable" });
		// Operator restocks and retries: the retry path flips the record back to
		// pending and re-requests it; processing must reserve the new card.
		await database
			.prepare(
				`INSERT INTO stock_entries
				 (id, sellable_item_id, content_encrypted, key_version, content_fingerprint,
				  content_mask, status, created_at, updated_at)
				 VALUES ('card-b-restock', 'si-b', ?, 1, 'fp-restock', '••••b', 'available', 1, 1)`,
			)
			.bind(
				await encryptSecret(
					"SECRET-restock",
					"commerce-test-secret",
					"stock-entry",
				),
			)
			.run();
		await database
			.prepare(
				"UPDATE delivery_records SET status = 'pending', error_code = NULL WHERE id = ?",
			)
			.bind(failed?.id)
			.run();
		await expect(
			processDelivery(database, failed?.id ?? ""),
		).resolves.toMatchObject({ status: "delivered", duplicate: false });
		expect(
			await database
				.prepare(
					"SELECT status, order_item_id IS NOT NULL AS bound FROM stock_entries WHERE id = 'card-b-restock'",
				)
				.first(),
		).toEqual({ status: "delivered", bound: 1 });
	});
});

async function pendingDeliveries(database: D1Database) {
	const rows = await database
		.prepare(
			`SELECT dr.id FROM delivery_records dr JOIN shop_order_items oi ON oi.id = dr.order_item_id
			 ORDER BY oi.sellable_item_id`,
		)
		.all<{ id: string }>();
	return rows.results;
}

function succeededEvent(amountMinor: string): PaymentWebhookEvent {
	return {
		providerEventId: `evt_${amountMinor}`,
		providerPaymentId: "cs_test_1",
		type: "payment_succeeded",
		amountMinor,
		currency: "CNY",
		payloadDigest: `digest-${amountMinor}`,
	};
}

async function seed(database: D1Database, plans: string[]) {
	const credential = await encryptSecret(
		JSON.stringify({
			secretKey: "sk_test_payment",
			webhookSecret: "whsec_test_payment",
		}),
		"commerce-test-secret",
		"payment-credential",
	);
	const total = String(1000 * plans.length);
	const statements = [
		database.prepare(
			`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
			 VALUES ('runtime.data_encryption_secret', '"commerce-test-secret"', 1, 1, 1)`,
		),
		database.prepare(
			`INSERT INTO products (id, name, product_type, status, sort_order, created_at, updated_at)
			 VALUES ('product-card', 'Card', 'stock', 'active', 100, 1, 1)`,
		),
		database.prepare(
			`INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
			 VALUES ('customer-1', 'Buyer', 'buyer@example.com', 1, 1, 1)`,
		),
		database
			.prepare(
				`INSERT INTO shop_orders
				 (id, order_number, user_id, contact_email, normalized_contact_email, status, currency,
				  currency_decimals, subtotal_minor, discount_minor, total_minor, paid_minor, version,
				  expires_at, created_at, updated_at)
				 VALUES (?, 'GM100001', 'customer-1', 'buyer@example.com', 'buyer@example.com',
				  'pending_payment', 'CNY', 2, ?, '0', ?, '0', 1, 9999999999999, 1, 1)`,
			)
			.bind(orderId, total, total),
		database
			.prepare(
				`INSERT INTO payment_channels
				 (id, provider, name, currency, credential_encrypted, fee_bps, fixed_fee_minor, sort_order,
				  enabled, last_health_status, created_at, updated_at)
				 VALUES (?, 'stripe', 'Stripe', 'CNY', ?, 0, '0', 100, 1, 'healthy', 1, 1)`,
			)
			.bind(channelId, credential),
		database
			.prepare(
				`INSERT INTO payment_attempts
				 (id, order_id, channel_id, provider_payment_id, idempotency_key, status, amount_minor,
				  currency, created_at, updated_at)
				 VALUES (?, ?, ?, 'cs_test_1', 'payment-attempt-1', 'pending', ?, 'CNY', 1, 1)`,
			)
			.bind(attemptId, orderId, channelId, total),
	];
	for (const plan of plans) {
		statements.push(
			database.prepare(
				`INSERT INTO product_sellable_items
				 (id, product_id, name, currency, currency_decimals, price_minor, minimum_quantity,
				  maximum_quantity, sort_order, enabled, created_at, updated_at)
				 VALUES ('si-${plan}', 'product-card', 'Plan ${plan}', 'CNY', 2, '1000', 1, 1, 100, 1, 1, 1)`,
			),
			database.prepare(
				`INSERT INTO shop_order_items
				 (id, order_id, product_id, sellable_item_id, product_name, delivery_component_id,
				  delivery_component_type, delivery_component_version, sellable_item_name, quantity,
				  unit_price_minor, discount_minor, subtotal_minor, created_at, updated_at)
				 VALUES ('item-${plan}', '${orderId}', 'product-card', 'si-${plan}', 'Card', 'si-${plan}',
				  'stock', 1, 'Plan ${plan}', 1, '1000', '0', '1000', 1, 1)`,
			),
			database
				.prepare(
					`INSERT INTO stock_entries
					 (id, sellable_item_id, content_encrypted, key_version, content_fingerprint,
					  content_mask, status, created_at, updated_at)
					 VALUES ('card-${plan}', 'si-${plan}', ?, 1, 'fp-${plan}', '••••${plan}', 'available', 1, 1)`,
				)
				.bind(
					await encryptSecret(
						`SECRET-${plan}`,
						"commerce-test-secret",
						"stock-entry",
					),
				),
		);
	}
	await database.batch(statements);
}
