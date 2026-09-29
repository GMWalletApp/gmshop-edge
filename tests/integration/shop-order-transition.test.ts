import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { transitionShopOrder } from "#/features/shop-orders/server/transition";
import { applyMigrations } from "./migrations";

const orderId = "11111111-1111-4111-8111-111111111111";
const actorUserId = "22222222-2222-4222-8222-222222222222";

describe("atomic shop order transitions", { timeout: 30_000 }, () => {
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
		await database.batch([
			database.prepare(
				`INSERT INTO users
				 (id, name, email, email_verified, enabled, created_at, updated_at)
				 VALUES ('${actorUserId}', 'Admin', 'admin@example.com', 1, 1, 1, 1)`,
			),
			database.prepare(
				`INSERT INTO shop_orders
				 (id, order_number, contact_email, normalized_contact_email,
				  status, currency, currency_decimals, subtotal_minor, discount_minor,
				  total_minor, paid_minor, version, expires_at, created_at, updated_at)
				 VALUES ('${orderId}', 'GM10001', 'buyer@example.com',
				  'buyer@example.com', 'pending_payment', 'CNY', 2, '1200', '200',
				  '1000', '0', 1, 9999999999999, 1, 1)`,
			),
		]);
	});

	afterEach(async () => miniflare.dispose());

	it("changes status, money, event and outbox together", async () => {
		await expect(
			transitionShopOrder(database, {
				id: orderId,
				version: 1,
				toStatus: "paid",
				note: "manual confirmation",
				actorType: "admin",
				actorUserId,
			}),
		).resolves.toMatchObject({
			fromStatus: "pending_payment",
			toStatus: "paid",
			version: 2,
		});
		const state = await database
			.prepare(
				`SELECT status, version, paid_minor, paid_at,
				 (SELECT COUNT(*) FROM shop_order_events WHERE order_id = shop_orders.id
				  AND order_version = 2) AS events,
				 (SELECT COUNT(*) FROM outbox_events WHERE aggregate_id = shop_orders.id) AS outbox,
				 (SELECT COUNT(*) FROM audit_logs WHERE target_id = shop_orders.id) AS audits
				 FROM shop_orders WHERE id = ?`,
			)
			.bind(orderId)
			.first<Record<string, unknown>>();
		expect(state).toMatchObject({
			status: "paid",
			version: 2,
			paid_minor: "1000",
			events: 1,
			outbox: 1,
			audits: 1,
		});
		expect(Number(state?.paid_at)).toBeGreaterThan(0);
		await expect(
			transitionShopOrder(database, {
				id: orderId,
				version: 1,
				toStatus: "paid",
				note: null,
				actorType: "admin",
				actorUserId,
			}),
		).rejects.toMatchObject({ code: "order_version_conflict" });
	});

	it("runs fulfillment when an administrator marks an order paid", async () => {
		await database.batch([
			database.prepare(
				`INSERT INTO products (id, name, product_type, status, sort_order, created_at, updated_at)
				 VALUES ('product-card', 'Card', 'stock', 'active', 100, 1, 1)`,
			),
			database.prepare(
				`INSERT INTO product_sellable_items
				 (id, product_id, name, currency, currency_decimals, price_minor, minimum_quantity,
				  maximum_quantity, sort_order, enabled, created_at, updated_at)
				 VALUES ('item-card', 'product-card', 'Default', 'CNY', 2, '1000', 1, 1, 100, 1, 1, 1)`,
			),
			database.prepare(
				`INSERT INTO shop_order_items
				 (id, order_id, product_id, sellable_item_id, product_name, delivery_component_id,
				  delivery_component_type, delivery_component_version, sellable_item_name, quantity,
				  unit_price_minor, discount_minor, subtotal_minor, created_at, updated_at)
				 VALUES ('order-item', '${orderId}', 'product-card', 'item-card', 'Card', 'item-card',
				  'stock', 1, 'Default', 1, '1000', '0', '1000', 1, 1)`,
			),
			database.prepare(
				`INSERT INTO stock_entries
				 (id, sellable_item_id, content_encrypted, key_version, content_fingerprint, content_mask,
				  status, created_at, updated_at)
				 VALUES ('card-1', 'item-card', 'ciphertext', 1, 'fp-1', '••••1', 'available', 1, 1)`,
			),
			database.prepare(
				`INSERT INTO payment_channels (id, provider, name, currency, enabled, created_at, updated_at)
				 VALUES ('channel-1', 'mock', 'Mock', 'CNY', 1, 1, 1)`,
			),
			database.prepare(
				`INSERT INTO payment_attempts
				 (id, order_id, channel_id, provider_payment_id, idempotency_key, status, amount_minor,
				  currency, created_at, updated_at)
				 VALUES ('attempt-1', '${orderId}', 'channel-1', 'provider-1', 'attempt-key-1', 'pending',
				  '1000', 'CNY', 1, 1)`,
			),
		]);
		await expect(
			transitionShopOrder(database, {
				id: orderId,
				version: 1,
				toStatus: "paid",
				note: "offline bank transfer",
				actorType: "admin",
				actorUserId,
			}),
		).resolves.toMatchObject({ toStatus: "paid", version: 2 });
		const state = await database
			.prepare(
				`SELECT o.status,
				 (SELECT COUNT(*) FROM delivery_records) AS deliveries,
				 (SELECT COUNT(*) FROM stock_entries WHERE status = 'reserved') AS reserved,
				 (SELECT COUNT(*) FROM outbox_events WHERE event_type = 'delivery.requested') AS requests,
				 (SELECT status FROM payment_attempts WHERE id = 'attempt-1') AS attempt_status,
				 (SELECT failure_code FROM payment_attempts WHERE id = 'attempt-1') AS attempt_failure
				 FROM shop_orders o WHERE o.id = ?`,
			)
			.bind(orderId)
			.first<Record<string, unknown>>();
		expect(state).toEqual({
			status: "paid",
			deliveries: 1,
			reserved: 1,
			requests: 1,
			attempt_status: "expired",
			attempt_failure: "manual_payment",
		});
	});

	it("releases the coupon reservation and open attempts when an order is cancelled manually", async () => {
		await database.batch([
			database.prepare(
				`INSERT INTO coupons
				 (id, code, name, type, currency, currency_decimals, value_minor, usage_limit, used_count,
				  enabled, created_at, updated_at)
				 VALUES ('coupon-1', 'SAVE2', 'Save', 'fixed', 'CNY', 2, '200', 5, 1, 1, 1, 1)`,
			),
			database.prepare(
				`INSERT INTO coupon_redemptions
				 (id, coupon_id, order_id, normalized_email, discount_minor, status, created_at, updated_at)
				 VALUES ('redemption-1', 'coupon-1', '${orderId}', 'buyer@example.com', '200', 'reserved', 1, 1)`,
			),
			database.prepare(
				`INSERT INTO payment_channels (id, provider, name, currency, enabled, created_at, updated_at)
				 VALUES ('channel-1', 'mock', 'Mock', 'CNY', 1, 1, 1)`,
			),
			database.prepare(
				`INSERT INTO payment_attempts
				 (id, order_id, channel_id, provider_payment_id, idempotency_key, status, amount_minor,
				  currency, created_at, updated_at)
				 VALUES ('attempt-1', '${orderId}', 'channel-1', 'provider-1', 'attempt-key-1', 'pending',
				  '1000', 'CNY', 1, 1)`,
			),
		]);
		await transitionShopOrder(database, {
			id: orderId,
			version: 1,
			toStatus: "cancelled",
			note: null,
			actorType: "admin",
			actorUserId,
		});
		const state = await database
			.prepare(
				`SELECT (SELECT status FROM shop_orders WHERE id = ?) AS status,
				 (SELECT used_count FROM coupons WHERE id = 'coupon-1') AS used_count,
				 (SELECT status FROM coupon_redemptions WHERE id = 'redemption-1') AS redemption,
				 (SELECT status FROM payment_attempts WHERE id = 'attempt-1') AS attempt_status`,
			)
			.bind(orderId)
			.first<Record<string, unknown>>();
		expect(state).toEqual({
			status: "cancelled",
			used_count: 0,
			redemption: "released",
			attempt_status: "expired",
		});
	});

	it("allows only one concurrent transition from the same version", async () => {
		const attempts = await Promise.allSettled([
			transitionShopOrder(database, {
				id: orderId,
				version: 1,
				toStatus: "paid",
				note: null,
				actorType: "admin",
				actorUserId,
			}),
			transitionShopOrder(database, {
				id: orderId,
				version: 1,
				toStatus: "expired",
				note: null,
				actorType: "admin",
				actorUserId,
			}),
		]);
		expect(
			attempts.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			attempts.filter((result) => result.status === "rejected"),
		).toHaveLength(1);
		const counts = await database
			.prepare(
				`SELECT (SELECT COUNT(*) FROM shop_order_events) AS events,
				 (SELECT COUNT(*) FROM outbox_events) AS outbox,
				 (SELECT COUNT(*) FROM audit_logs) AS audits,
				 version FROM shop_orders WHERE id = ?`,
			)
			.bind(orderId)
			.first<Record<string, number>>();
		expect(counts).toEqual({ events: 1, outbox: 1, audits: 1, version: 2 });
	});
});
