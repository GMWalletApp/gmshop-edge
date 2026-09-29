import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PaymentWebhookEvent } from "#/features/shop-payments/provider";
import { processShopPaymentEvent } from "#/features/shop-payments/server/service";
import { encryptSecret } from "#/lib/secrets";
import { applyMigrations } from "./migrations";

const orderId = "11111111-1111-4111-8111-111111111111";
const orderItemId = "22222222-2222-4222-8222-222222222222";
const channelId = "33333333-3333-4333-8333-333333333333";
const attemptId = "44444444-4444-4444-8444-444444444444";
const couponId = "55555555-5555-4555-8555-555555555555";

describe("late and unmatched payment events", { timeout: 60_000 }, () => {
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

	afterEach(async () => miniflare.dispose());

	it("revives an expired order when the verified payment arrives late", async () => {
		await database.batch([
			database
				.prepare(
					`UPDATE shop_orders SET status = 'expired', cancelled_at = 5, version = 2 WHERE id = ?`,
				)
				.bind(orderId),
			database
				.prepare(
					"UPDATE payment_attempts SET status = 'expired', failure_code = 'order_expired' WHERE id = ?",
				)
				.bind(attemptId),
			database
				.prepare(
					"UPDATE coupon_redemptions SET status = 'released', released_at = 5 WHERE order_id = ?",
				)
				.bind(orderId),
			database
				.prepare("UPDATE coupons SET used_count = 0 WHERE id = ?")
				.bind(couponId),
		]);
		await expect(
			processShopPaymentEvent(database, channelId, event("evt_late")),
		).resolves.toEqual({ duplicate: false, status: "succeeded" });
		const state = await database
			.prepare(
				`SELECT o.status, o.version, o.cancelled_at, pa.status AS attempt_status,
				 (SELECT status FROM coupon_redemptions WHERE order_id = o.id) AS redemption,
				 (SELECT used_count FROM coupons WHERE id = ?) AS used_count,
				 (SELECT COUNT(*) FROM delivery_records) AS deliveries,
				 (SELECT COUNT(*) FROM stock_entries WHERE status = 'reserved') AS reserved,
				 (SELECT from_status FROM shop_order_events WHERE order_id = o.id
				  AND event_type = 'payment_succeeded') AS event_from,
				 (SELECT status FROM replay_receipts WHERE external_id = 'evt_late') AS receipt
				 FROM shop_orders o JOIN payment_attempts pa ON pa.id = ? WHERE o.id = ?`,
			)
			.bind(couponId, attemptId, orderId)
			.first<Record<string, unknown>>();
		expect(state).toMatchObject({
			status: "paid",
			version: 3,
			cancelled_at: null,
			attempt_status: "succeeded",
			redemption: "consumed",
			used_count: 1,
			deliveries: 1,
			reserved: 1,
			event_from: "expired",
			receipt: "processed",
		});
	});

	it("records a verified payment for a cancelled order as unmatched without touching stock", async () => {
		await database.batch([
			database
				.prepare(
					"UPDATE shop_orders SET status = 'cancelled', cancelled_at = 5, version = 2 WHERE id = ?",
				)
				.bind(orderId),
			database
				.prepare(
					"UPDATE payment_attempts SET status = 'expired', failure_code = 'order_closed' WHERE id = ?",
				)
				.bind(attemptId),
		]);
		const first = await processShopPaymentEvent(
			database,
			channelId,
			event("evt_unmatched"),
		);
		expect(first).toMatchObject({
			duplicate: false,
			status: "rejected",
			reason: "order_not_payable",
		});
		const replay = await processShopPaymentEvent(
			database,
			channelId,
			event("evt_unmatched"),
		);
		expect(replay).toEqual({ duplicate: true, status: "rejected" });
		const state = await database
			.prepare(
				`SELECT o.status, pa.status AS attempt_status, pa.failure_code,
				 (SELECT COUNT(*) FROM stock_entries WHERE status = 'reserved') AS reserved,
				 (SELECT COUNT(*) FROM delivery_records) AS deliveries,
				 (SELECT COUNT(*) FROM replay_receipts WHERE external_id = 'evt_unmatched'
				  AND status = 'rejected') AS receipts,
				 (SELECT after FROM audit_logs WHERE action = 'payment.unmatched') AS audit
				 FROM shop_orders o JOIN payment_attempts pa ON pa.id = ? WHERE o.id = ?`,
			)
			.bind(attemptId, orderId)
			.first<Record<string, unknown>>();
		expect(state).toMatchObject({
			status: "cancelled",
			attempt_status: "expired",
			failure_code: "unmatched_payment",
			reserved: 0,
			deliveries: 0,
			receipts: 1,
		});
		expect(JSON.parse(String(state?.audit))).toMatchObject({
			reason: "order_not_payable",
			orderId,
			orderStatus: "cancelled",
			providerEventId: "evt_unmatched",
			amountMinor: "1000",
		});
	});

	it("does not leak stock or a processed receipt when the order changed before the batch", async () => {
		// Simulate an order that was already paid through a different attempt.
		await database.batch([
			database
				.prepare(
					"UPDATE shop_orders SET status = 'paid', paid_minor = total_minor, version = 2 WHERE id = ?",
				)
				.bind(orderId),
		]);
		await expect(
			processShopPaymentEvent(database, channelId, event("evt_double")),
		).resolves.toMatchObject({ status: "rejected" });
		const state = await database
			.prepare(
				`SELECT (SELECT COUNT(*) FROM stock_entries WHERE status = 'reserved') AS reserved,
				 (SELECT COUNT(*) FROM delivery_records) AS deliveries,
				 (SELECT status FROM replay_receipts WHERE external_id = 'evt_double') AS receipt,
				 (SELECT COUNT(*) FROM audit_logs WHERE action = 'payment.unmatched') AS audits`,
			)
			.first<Record<string, unknown>>();
		expect(state).toEqual({
			reserved: 0,
			deliveries: 0,
			receipt: "rejected",
			audits: 1,
		});
	});

	it("lets exactly one of two concurrent success events fulfil the order and records the other as unmatched", async () => {
		const outcomes = await Promise.allSettled([
			processShopPaymentEvent(database, channelId, event("evt_race_a")),
			processShopPaymentEvent(database, channelId, event("evt_race_b")),
		]);
		const settled = outcomes.map((outcome) =>
			outcome.status === "fulfilled"
				? outcome.value.status
				: (outcome.reason as { code?: string }).code,
		);
		expect(settled.sort()).toEqual(["rejected", "succeeded"]);
		const state = await database
			.prepare(
				`SELECT o.status, o.version,
				 (SELECT COUNT(*) FROM delivery_records) AS deliveries,
				 (SELECT COUNT(*) FROM customer_entitlements) AS entitlements,
				 (SELECT COUNT(*) FROM stock_entries WHERE status = 'reserved') AS reserved
				 FROM shop_orders o WHERE o.id = ?`,
			)
			.bind(orderId)
			.first<Record<string, unknown>>();
		expect(state).toMatchObject({
			status: "paid",
			version: 2,
			deliveries: 1,
			entitlements: 1,
			reserved: 1,
		});
	});

	it("credits a top-up whose provider expired it before the money arrived", async () => {
		await database.batch([
			database.prepare(
				`INSERT INTO wallet_topups
				 (id, user_id, amount_minor, currency, currency_decimals, status, idempotency_key,
				  created_at, updated_at)
				 VALUES ('66666666-6666-4666-8666-666666666666', 'customer-1', '250', 'CNY', 2,
				  'expired', 'topup-1', 1, 1)`,
			),
			database
				.prepare(
					`INSERT INTO payment_attempts
				 (id, wallet_topup_id, channel_id, provider_payment_id, idempotency_key, status,
				  failure_code, amount_minor, currency, currency_decimals, created_at, updated_at)
				 VALUES ('77777777-7777-4777-8777-777777777777', '66666666-6666-4666-8666-666666666666',
				  ?, 'cs_topup_1', 'topup-attempt-1', 'expired', 'payment_expired', '250', 'CNY', 2, 1, 1)`,
				)
				.bind(channelId),
		]);
		// The account was suspended while the payment was in flight: the money
		// is still booked to its balance.
		await database
			.prepare("UPDATE users SET enabled = 0 WHERE id = 'customer-1'")
			.run();
		await expect(
			processShopPaymentEvent(database, channelId, {
				...event("evt_topup"),
				providerPaymentId: "cs_topup_1",
				amountMinor: "250",
			}),
		).resolves.toEqual({ duplicate: false, status: "succeeded" });
		const state = await database
			.prepare(
				`SELECT (SELECT balance_minor FROM users WHERE id = 'customer-1') AS balance,
				 (SELECT status FROM wallet_topups WHERE id = '66666666-6666-4666-8666-666666666666') AS topup,
				 (SELECT status FROM payment_attempts WHERE id = '77777777-7777-4777-8777-777777777777') AS attempt,
				 (SELECT COUNT(*) FROM wallet_entries) AS entries`,
			)
			.first<Record<string, unknown>>();
		expect(state).toEqual({
			balance: "250",
			topup: "paid",
			attempt: "succeeded",
			entries: 1,
		});
	});
});

function event(providerEventId: string): PaymentWebhookEvent {
	return {
		providerEventId,
		providerPaymentId: "cs_test_1",
		type: "payment_succeeded",
		amountMinor: "1000",
		currency: "CNY",
		payloadDigest: `digest-${providerEventId}`,
	};
}

async function seed(database: D1Database) {
	const encryptedCard = await encryptSecret(
		"CARD-SECRET-1234",
		"commerce-test-secret",
		"stock-entry",
	);
	const encryptedCredential = await encryptSecret(
		JSON.stringify({
			secretKey: "sk_test_payment",
			webhookSecret: "whsec_test_payment",
		}),
		"commerce-test-secret",
		"payment-credential",
	);
	await database.batch([
		database.prepare(
			`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
			 VALUES ('runtime.data_encryption_secret', '"commerce-test-secret"', 1, 1, 1),
			        ('commerce.default_currency', '"CNY"', 0, 1, 1)`,
		),
		database.prepare(
			`INSERT INTO products (id, name, product_type, status, sort_order, created_at, updated_at)
			 VALUES ('product-card', 'Card', 'stock', 'active', 100, 1, 1)`,
		),
		database.prepare(
			`INSERT INTO product_sellable_items
			 (id, product_id, name, currency, currency_decimals, price_minor, minimum_quantity,
			  maximum_quantity, sort_order, enabled, created_at, updated_at)
			 VALUES ('sellableItem-card', 'product-card', 'Default', 'CNY', 2, '1200', 1, 1, 100, 1, 1, 1)`,
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
				  'pending_payment', 'CNY', 2, '1200', '200', '1000', '0', 1, 9999999999999, 1, 1)`,
			)
			.bind(orderId),
		database
			.prepare(
				`INSERT INTO shop_order_items
				 (id, order_id, product_id, sellable_item_id, product_name, delivery_component_id,
				  delivery_component_type, delivery_component_version, sellable_item_name, quantity,
				  unit_price_minor, discount_minor, subtotal_minor, created_at, updated_at)
				 VALUES (?, ?, 'product-card', 'sellableItem-card', 'Card', 'sellableItem-card', 'stock', 1,
				  'Default', 1, '1200', '200', '1000', 1, 1)`,
			)
			.bind(orderItemId, orderId),
		database
			.prepare(
				`INSERT INTO coupons
				 (id, code, name, type, currency, currency_decimals, value_minor, usage_limit, used_count,
				  enabled, created_at, updated_at)
				 VALUES (?, 'SAVE2', 'Save 2', 'fixed', 'CNY', 2, '200', 10, 1, 1, 1, 1)`,
			)
			.bind(couponId),
		database
			.prepare(
				`INSERT INTO coupon_redemptions
				 (id, coupon_id, order_id, user_id, normalized_email, discount_minor, status, created_at, updated_at)
				 VALUES ('redemption-1', ?, ?, 'customer-1', 'buyer@example.com', '200', 'reserved', 1, 1)`,
			)
			.bind(couponId, orderId),
		database
			.prepare(
				`INSERT INTO payment_channels
				 (id, provider, name, currency, credential_encrypted, fee_bps, fixed_fee_minor, sort_order,
				  enabled, last_health_status, created_at, updated_at)
				 VALUES (?, 'stripe', 'Stripe', 'CNY', ?, 0, '0', 100, 1, 'healthy', 1, 1)`,
			)
			.bind(channelId, encryptedCredential),
		database
			.prepare(
				`INSERT INTO payment_attempts
				 (id, order_id, channel_id, provider_payment_id, idempotency_key, status, amount_minor,
				  currency, created_at, updated_at)
				 VALUES (?, ?, ?, 'cs_test_1', 'payment-attempt-1', 'pending', '1000', 'CNY', 1, 1)`,
			)
			.bind(attemptId, orderId, channelId),
		database
			.prepare(
				`INSERT INTO stock_entries
				 (id, sellable_item_id, content_encrypted, key_version, content_fingerprint, content_mask,
				  status, created_at, updated_at)
				 VALUES ('card-1', 'sellableItem-card', ?, 1, 'fingerprint-1', '••••1234', 'available', 1, 1)`,
			)
			.bind(encryptedCard),
	]);
}
