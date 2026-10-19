import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expireStoreOrders } from "#/features/shop-orders/server/expiration";
import {
	completeFreeStoreOrder,
	createShopPayment,
} from "#/features/shop-payments/server/service";
import { createMultiStoreOrder } from "#/features/storefront/server/multi-order";
import { getStoreOrder } from "#/features/storefront/server/order-query";
import { applyMigrations } from "./migrations";

const productId = "22222222-2222-4222-8222-222222222222";
const sellableItemId = "33333333-3333-4333-8333-333333333333";
const couponId = "44444444-4444-4444-8444-444444444444";
const secondProductId = "55555555-5555-4555-8555-555555555555";
const secondItemId = "66666666-6666-4666-8666-666666666666";
const cardComponentId = sellableItemId;
const secondComponentId = secondItemId;
const downloadProductId = "99999999-9999-4999-8999-999999999999";
const downloadItemId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const downloadComponentId = downloadItemId;
const automationProductId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const automationItemId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const channelId = "dddddddd-1111-4ddd-8ddd-dddddddddddd";

async function createStoreOrder(
	database: D1Database,
	input: {
		sellableItemId: string;
		quantity: number;
		email: string;
		couponCode?: string;
		idempotencyKey: string;
		customerNote: string;
		inputValues?: Record<string, unknown>;
	},
	access: {
		userId?: string;
		pricingChannelId?: string;
		clientIp?: string;
	} = {},
) {
	const { sellableItemId, quantity, inputValues = {}, ...checkout } = input;
	return createMultiStoreOrder(
		database,
		{ ...checkout, items: [{ sellableItemId, quantity, inputValues }] },
		access,
	);
}

describe("storefront order creation", { timeout: 30_000 }, () => {
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
		await seedStorefront(database);
	}, 30_000);

	afterEach(async () => miniflare.dispose());

	it("creates an authoritative snapshot with integer totals and a high-entropy order number", async () => {
		const result = await createStoreOrder(database, {
			sellableItemId,
			quantity: 2,
			email: "Buyer@Example.com",
			couponCode: "SAVE25",
			idempotencyKey: "checkout-order-1",
			customerNote: "Please deliver quickly",
		});
		expect(result).toMatchObject({
			status: "pending_payment",
			duplicate: false,
		});
		expect(result.orderNumber).toMatch(/^GM[0-9A-F]{32}$/);
		const state = await database
			.prepare(
				`SELECT o.subtotal_minor, o.discount_minor, o.total_minor,
				 o.normalized_contact_email, oi.product_name,
				 oi.sellable_item_name, oi.quantity, c.used_count,
				 (SELECT COUNT(*) FROM coupon_redemptions WHERE order_id = o.id) AS redemptions
				 FROM shop_orders o JOIN shop_order_items oi ON oi.order_id = o.id
				 JOIN coupons c ON c.id = o.coupon_id WHERE o.id = ?`,
			)
			.bind(result.id)
			.first<Record<string, unknown>>();
		expect(state).toMatchObject({
			subtotal_minor: "2000",
			discount_minor: "500",
			total_minor: "1500",
			normalized_contact_email: "buyer@example.com",
			product_name: "Card Product",
			sellable_item_name: "Card plan",
			quantity: 2,
			used_count: 1,
			redemptions: 1,
		});
		const users = await database
			.prepare("SELECT COUNT(*) AS count FROM users")
			.first<{ count: number }>();
		expect(users?.count).toBe(0);
	});

	it("snapshots the fixed price selected for a payment channel", async () => {
		await database.batch([
			database
				.prepare(
					`INSERT INTO payment_channels
				 (id,provider,name,currency,fee_bps,fixed_fee_minor,enabled,created_at,updated_at)
				 VALUES (?,'gmpay','USDT','CNY',300,'0',1,1,1)`,
				)
				.bind(channelId),
			database
				.prepare(
					`INSERT INTO sellable_item_channel_prices
				 (id,sellable_item_id,channel_id,price_minor,enabled,created_at,updated_at)
				 VALUES ('channel-price-test',?,?, '1200',1,1,1)`,
				)
				.bind(sellableItemId, channelId),
		]);

		const result = await createStoreOrder(
			database,
			{
				sellableItemId,
				quantity: 2,
				email: "channel-price@example.com",
				idempotencyKey: "checkout-channel-price",
				customerNote: "",
			},
			{ pricingChannelId: channelId },
		);
		const snapshot = await database
			.prepare(
				`SELECT o.subtotal_minor,o.total_minor,oi.unit_price_minor
				 FROM shop_orders o JOIN shop_order_items oi ON oi.order_id=o.id
				 WHERE o.id=?`,
			)
			.bind(result.id)
			.first<Record<string, unknown>>();
		expect(snapshot).toMatchObject({
			subtotal_minor: "2400",
			total_minor: "2400",
			unit_price_minor: "1200",
		});

		// The cheaper channel's quote cannot be paid through another channel.
		await database
			.prepare(
				`INSERT INTO payment_channels
				 (id,provider,name,currency,fee_bps,fixed_fee_minor,enabled,created_at,updated_at)
				 VALUES ('7a1c2b3d-0000-4000-8000-000000000001','gmpay','Other','CNY',300,'0',1,1,1)`,
			)
			.run();
		await expect(
			createShopPayment(database, {
				orderId: result.id,
				channelId: "7a1c2b3d-0000-4000-8000-000000000001",
				paymentCurrency: "CNY",
				idempotencyKey: "pay-other-channel",
				successUrl: "https://shop.example/orders/x",
				cancelUrl: "https://shop.example/orders/x",
				payerIp: "203.0.113.9",
			}),
		).rejects.toMatchObject({ code: "payment_channel_mismatch" });
	});

	it.each([
		"supplier",
		"local-first",
		"local-only",
		"local-shortfall",
		"no-balance",
		"unfunded-opt-in",
		"stale",
	])("checks supplier eligibility without purchasing before payment: %s", async (mode) => {
		const now = Date.now();
		await database.batch([
			database
				.prepare(
					`UPDATE product_sellable_items
					 SET fulfillment_source = 'supplier', supplier_status = 'available'
					 WHERE id = ?`,
				)
				.bind(sellableItemId),
			database
				.prepare("DELETE FROM stock_entries WHERE sellable_item_id = ?")
				.bind(sellableItemId),
			database
				.prepare(
					`INSERT INTO supplier_accounts
					 (id, provider, base_url, normalized_api_origin, protocol_version,
					  currency, currency_decimals, name, credentials_encrypted,
					  credentials_revision, credential_fingerprint, balance_minor,
					  balance_synced_at, reserve_balance_minor, low_balance_minor,
					  health_status, enabled, created_at, updated_at)
					 VALUES ('supplier-account-storefront', 'acg', 'https://supplier.example',
					  'https://supplier.example', '3.5.5', 'CNY', 2, 'Storefront account',
					  'encrypted', 1, 'fingerprint-storefront', '100000', ?, '1000', '0',
					  'healthy', 1, ?, ?)`,
				)
				.bind(now, now, now),
			database
				.prepare(
					`INSERT INTO supplier_bindings
					 (id, sellable_item_id, provider, normalized_api_origin, protocol_version,
					  upstream_product_id, upstream_sku_id, upstream_product_name,
					  upstream_sku_name, reference_cost_minor, max_cost_minor,
					  stock_quantity, remote_status, last_synced_at, enabled,
					  created_at, updated_at)
					 VALUES ('supplier-binding-storefront', ?, 'acg',
					  'https://supplier.example', '3.5.5', 'remote-product', 'remote-sku',
					  'Remote product', 'Remote SKU', '400', '500', 8, 'active', ?, 1, ?, ?)`,
				)
				.bind(sellableItemId, now, now, now),
		]);

		if (
			!["supplier", "no-balance", "unfunded-opt-in", "stale"].includes(mode)
		) {
			await database
				.prepare(
					"UPDATE product_sellable_items SET fulfillment_source='local',supplier_status=NULL WHERE id=?",
				)
				.bind(sellableItemId)
				.run();
			if (mode !== "local-only")
				await database
					.prepare("INSERT INTO system_settings(key,value) VALUES (?, 'true')")
					.bind(`fulfillment.supplier_fallback.${sellableItemId}`)
					.run();
		}
		if (mode === "local-shortfall") {
			await database
				.prepare(`INSERT INTO stock_entries(id,sellable_item_id,content_encrypted,key_version,content_fingerprint,content_mask,status,created_at,updated_at)
    VALUES ('partial',?,'ciphertext',1,'partial','masked','available',1,1)`)
				.bind(sellableItemId)
				.run();
			await database
				.prepare("UPDATE supplier_bindings SET stock_quantity=1")
				.run();
		}
		if (mode === "no-balance" || mode === "unfunded-opt-in")
			await database
				.prepare("UPDATE supplier_accounts SET balance_minor='0'")
				.run();
		if (mode === "unfunded-opt-in")
			await database
				.prepare("INSERT INTO system_settings(key,value) VALUES (?, 'true')")
				.bind(`fulfillment.supplier_unfunded_checkout.${sellableItemId}`)
				.run();
		if (mode === "stale")
			await database
				.prepare("UPDATE supplier_bindings SET last_synced_at=1")
				.run();
		if (
			[
				"local-only",
				"local-first",
				"local-shortfall",
				"no-balance",
				"stale",
			].includes(mode)
		) {
			await expect(
				createStoreOrder(database, {
					sellableItemId,
					quantity: 2,
					email: "supplier-buyer@example.com",
					idempotencyKey: "blocked-checkout",
					customerNote: "",
				}),
			).rejects.toMatchObject({
				code: mode.startsWith("local-")
					? "inventory_unavailable"
					: mode === "no-balance"
						? "supplier_account_unavailable"
						: "supplier_inventory_unavailable",
			});
			expect(
				(await database.prepare("SELECT id FROM supplier_orders").all())
					.results,
			).toHaveLength(0);
			return;
		}

		const result = await createStoreOrder(database, {
			sellableItemId,
			quantity: 2,
			email: "supplier-buyer@example.com",
			idempotencyKey: "supplier-checkout-before-payment",
			customerNote: "",
		});

		expect(result).toMatchObject({
			status: "pending_payment",
			totalMinor: "2000",
		});
		const state = await database
			.prepare(
				`SELECT
				 (SELECT COUNT(*) FROM supplier_orders WHERE order_id = ?) AS supplier_orders,
				 (SELECT COUNT(*) FROM stock_entries WHERE sellable_item_id = ?) AS local_stock`,
			)
			.bind(result.id, sellableItemId)
			.first<{ supplier_orders: number; local_stock: number }>();
		expect(state).toEqual({
			supplier_orders: 0,
			local_stock: mode === "local-shortfall" ? 1 : 0,
		});
	});

	it("accepts a manual-procurement item without preloaded stock", async () => {
		await database.batch([
			database
				.prepare(
					"UPDATE product_sellable_items SET fulfillment_source = 'manual', supplier_status = NULL WHERE id = ?",
				)
				.bind(sellableItemId),
			database
				.prepare("DELETE FROM stock_entries WHERE sellable_item_id = ?")
				.bind(sellableItemId),
		]);
		await expect(
			createStoreOrder(database, {
				sellableItemId,
				quantity: 2,
				email: "manual-buyer@example.com",
				idempotencyKey: "manual-procurement-checkout",
				customerNote: "",
			}),
		).resolves.toMatchObject({
			status: "pending_payment",
			totalMinor: "2000",
		});
	});

	it("caps unpaid orders per email and new orders per IP without counting replays", async () => {
		await database
			.prepare(
				"UPDATE product_sellable_items SET fulfillment_source = 'manual', supplier_status = NULL WHERE id = ?",
			)
			.bind(sellableItemId)
			.run();
		const order = (email: string, idempotencyKey: string, clientIp: string) =>
			createStoreOrder(
				database,
				{
					sellableItemId,
					quantity: 1,
					email,
					idempotencyKey,
					customerNote: "",
				},
				{ clientIp },
			);
		for (let index = 0; index < 5; index++)
			await order("busy@example.com", `unpaid-${index}`, "198.51.100.1");
		await expect(
			order("busy@example.com", "unpaid-5", "198.51.100.1"),
		).rejects.toMatchObject({ code: "too_many_unpaid_orders", status: 429 });
		await expect(
			order("busy@example.com", "unpaid-0", "198.51.100.1"),
		).resolves.toMatchObject({ duplicate: true });

		for (let index = 0; index < 20; index++)
			await order(
				`ip-${index}@example.com`,
				`ip-order-${index}`,
				"198.51.100.2",
			);
		await expect(
			order("ip-0@example.com", "ip-order-0", "198.51.100.2"),
		).resolves.toMatchObject({ duplicate: true });
		await expect(
			order("ip-20@example.com", "ip-order-20", "198.51.100.2"),
		).rejects.toMatchObject({ code: "order_rate_limited", status: 429 });
		await expect(
			order("ip-20@example.com", "ip-order-20", "198.51.100.3"),
		).resolves.toMatchObject({ duplicate: false });
	});

	it("snapshots fixed-term policy without a redundant billing enum", async () => {
		await database
			.prepare("UPDATE product_sellable_items SET duration_ms = ? WHERE id = ?")
			.bind(2_592_000_000, cardComponentId)
			.run();
		const result = await createMultiStoreOrder(database, {
			items: [
				{ sellableItemId, quantity: 1, inputValues: {} },
				{ sellableItemId: secondItemId, quantity: 1, inputValues: {} },
			],
			email: "billing@example.com",
			couponCode: "",
			idempotencyKey: "checkout-derived-billing",
			customerNote: "",
		});
		const snapshots = await database
			.prepare(
				`SELECT sellable_item_id, duration_ms, usage_limit FROM shop_order_items
				 WHERE order_id = ? ORDER BY sellable_item_id`,
			)
			.bind(result.id)
			.all<{
				sellable_item_id: string;
				duration_ms: number | null;
				usage_limit: number | null;
			}>();
		expect(snapshots.results).toEqual([
			{
				sellable_item_id: sellableItemId,
				duration_ms: 2_592_000_000,
				usage_limit: null,
			},
			{
				sellable_item_id: secondItemId,
				duration_ms: null,
				usage_limit: null,
			},
		]);
	});

	it("creates one atomic mixed-product order and allocates scoped discounts by eligible subtotal", async () => {
		const result = await createMultiStoreOrder(database, {
			items: [
				{ sellableItemId, quantity: 1, inputValues: {} },
				{ sellableItemId: secondItemId, quantity: 2, inputValues: {} },
			],
			email: "mixed@example.com",
			couponCode: "SAVE25",
			idempotencyKey: "checkout-mixed-order",
			customerNote: "",
			commerceSessionId: "77777777-7777-4777-8777-777777777777",
		});
		expect(result).toMatchObject({ totalMinor: "1750", duplicate: false });
		const state = await database
			.prepare(
				`SELECT o.subtotal_minor, o.discount_minor, o.total_minor,
				 (SELECT COUNT(*) FROM shop_order_items WHERE order_id = o.id) AS item_count,
				 (SELECT discount_minor FROM shop_order_items
				  WHERE order_id = o.id AND sellable_item_id = ?) AS eligible_discount,
				 (SELECT discount_minor FROM shop_order_items
				  WHERE order_id = o.id AND sellable_item_id = ?) AS excluded_discount,
				 (SELECT COUNT(*) FROM commerce_events
				  WHERE order_id = o.id AND event_type = 'order_created') AS events
				 FROM shop_orders o WHERE o.id = ?`,
			)
			.bind(sellableItemId, secondItemId, result.id)
			.first<Record<string, unknown>>();
		expect(state).toEqual({
			subtotal_minor: "2000",
			discount_minor: "250",
			total_minor: "1750",
			item_count: 2,
			eligible_discount: "250",
			excluded_discount: "0",
			events: 1,
		});
	});

	it("requires an account only for automation and atomically rejects mixed guest checkout", async () => {
		await expect(
			createStoreOrder(database, {
				sellableItemId: automationItemId,
				quantity: 1,
				email: "guest@example.com",
				idempotencyKey: "restricted-automation",
				customerNote: "",
			}),
		).rejects.toMatchObject({
			code: "account_required_for_delivery",
			status: 403,
		});
		await expect(
			createMultiStoreOrder(database, {
				items: [
					{ sellableItemId, quantity: 1, inputValues: {} },
					{ sellableItemId: automationItemId, quantity: 1, inputValues: {} },
				],
				email: "mixed-guest@example.com",
				couponCode: "",
				idempotencyKey: "restricted-mixed-order",
				customerNote: "",
			}),
		).rejects.toMatchObject({
			code: "account_required_for_delivery",
			status: 403,
		});
		const rejectedCount = await database
			.prepare("SELECT COUNT(*) AS total FROM shop_orders")
			.first<{ total: number }>();
		expect(rejectedCount?.total).toBe(0);

		await expect(
			createStoreOrder(database, {
				sellableItemId,
				quantity: 1,
				email: "stock-guest@example.com",
				idempotencyKey: "stock-guest-order",
				customerNote: "",
			}),
		).resolves.toMatchObject({ status: "pending_payment" });
		await expect(
			createStoreOrder(database, {
				sellableItemId: downloadItemId,
				quantity: 1,
				email: "download-guest@example.com",
				idempotencyKey: "guest-download-order",
				customerNote: "",
			}),
		).resolves.toMatchObject({ status: "pending_payment" });
	});

	it("snapshots the selected download version when the order is created", async () => {
		await database
			.prepare(
				`INSERT INTO users
				 (id, name, email, email_verified, created_at, updated_at)
				 VALUES ('download-customer', 'Download customer', 'download@example.com',
				  1, 1, 1)`,
			)
			.run();
		const result = await createStoreOrder(
			database,
			{
				sellableItemId: downloadItemId,
				quantity: 1,
				email: "download@example.com",
				idempotencyKey: "checkout-download-snapshot",
				customerNote: "",
			},
			{ userId: "download-customer" },
		);
		await database.batch([
			database.prepare(
				"UPDATE download_assets SET download_enabled = 0 WHERE id = 'download-v1'",
			),
			database.prepare(
				`INSERT INTO download_assets
				 (id, product_id, object_key, file_name, content_type, size_bytes,
				  checksum_sha256, version, created_at, updated_at)
				 VALUES ('download-v2', '${downloadProductId}', 'downloads/v2', 'v2.zip',
				  'application/zip', 20, '${"b".repeat(64)}', 2, 2, 2)`,
			),
			database.prepare(
				`INSERT INTO download_asset_sellable_items
				 (download_asset_id, sellable_item_id, sort_order)
				 VALUES ('download-v2', '${downloadComponentId}', 200)`,
			),
		]);
		const snapshot = await database
			.prepare(
				`SELECT snapshot.file_name, snapshot.asset_version
				 FROM order_item_download_assets snapshot
				 JOIN shop_order_items item ON item.id = snapshot.order_item_id
				 WHERE item.order_id = ?`,
			)
			.bind(result.id)
			.all<{ file_name: string; asset_version: number }>();
		expect(snapshot.results).toEqual([
			{ file_name: "v1.zip", asset_version: 1 },
		]);
	});

	it("rejects a multi-product checkout with mixed currencies before writing an order", async () => {
		await database
			.prepare(
				"UPDATE product_sellable_items SET currency = 'USD' WHERE id = ?",
			)
			.bind(secondItemId)
			.run();
		await expect(
			createMultiStoreOrder(database, {
				items: [
					{ sellableItemId, quantity: 1, inputValues: {} },
					{ sellableItemId: secondItemId, quantity: 1, inputValues: {} },
				],
				email: "currency@example.com",
				couponCode: "",
				idempotencyKey: "checkout-mixed-currency",
				customerNote: "",
			}),
		).rejects.toMatchObject({ code: "cart_currency_conflict" });
		const count = await database
			.prepare("SELECT COUNT(*) AS total FROM shop_orders")
			.first<{ total: number }>();
		expect(count?.total).toBe(0);
	});

	it("returns the existing order for an idempotency replay", async () => {
		const input = {
			sellableItemId,
			quantity: 1,
			email: "buyer@example.com",
			couponCode: "",
			idempotencyKey: "checkout-order-replay",
			customerNote: "",
		};
		const first = await createStoreOrder(database, input);
		const replay = await createStoreOrder(database, input);
		expect(replay).toMatchObject({
			id: first.id,
			duplicate: true,
		});
		const count = await database
			.prepare("SELECT COUNT(*) AS total FROM shop_orders")
			.first<{ total: number }>();
		expect(count?.total).toBe(1);
		await expect(
			createStoreOrder(database, {
				...input,
				email: "another@example.com",
			}),
		).rejects.toMatchObject({
			code: "idempotency_key_conflict",
			status: 409,
		});
	});

	it("allows only one concurrent redemption of the final coupon use", async () => {
		await database
			.prepare("UPDATE coupons SET usage_limit = 1 WHERE id = ?")
			.bind(couponId)
			.run();
		const base = {
			sellableItemId,
			quantity: 1,
			couponCode: "SAVE25",
			customerNote: "",
		};
		const results = await Promise.allSettled([
			createStoreOrder(database, {
				...base,
				email: "first@example.com",
				idempotencyKey: "coupon-race-first",
			}),
			createStoreOrder(database, {
				...base,
				email: "second@example.com",
				idempotencyKey: "coupon-race-second",
			}),
		]);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			results.filter((result) => result.status === "rejected"),
		).toHaveLength(1);
		const state = await database
			.prepare(
				`SELECT used_count,
				 (SELECT COUNT(*) FROM coupon_redemptions WHERE coupon_id = ?) AS redemptions,
				 (SELECT COUNT(*) FROM shop_orders WHERE coupon_id = ?) AS orders
				 FROM coupons WHERE id = ?`,
			)
			.bind(couponId, couponId, couponId)
			.first<Record<string, number>>();
		expect(state).toEqual({ used_count: 1, redemptions: 1, orders: 1 });
	});

	it("fails closed when a coupon scope is malformed", async () => {
		await database
			.prepare("UPDATE coupons SET scope_json = ? WHERE id = ?")
			.bind('{"productIds":[]}', couponId)
			.run();
		await expect(
			createStoreOrder(database, {
				sellableItemId,
				quantity: 1,
				email: "invalid-scope@example.com",
				couponCode: "SAVE25",
				idempotencyKey: "checkout-invalid-coupon-scope",
				customerNote: "",
			}),
		).rejects.toMatchObject({
			code: "coupon_scope_invalid",
			status: 409,
		});
		const counts = await database
			.prepare(
				`SELECT
				 (SELECT COUNT(*) FROM shop_orders) AS orders,
				 (SELECT COUNT(*) FROM coupon_redemptions) AS redemptions,
				 used_count FROM coupons WHERE id = ?`,
			)
			.bind(couponId)
			.first<Record<string, number>>();
		expect(counts).toEqual({ orders: 0, redemptions: 0, used_count: 0 });
	});

	it("enforces guest-checkout and global quantity settings on the server", async () => {
		await database.batch([
			database.prepare(
				`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
				 VALUES ('orders.allow_guest_checkout', 'false', 0, 1, 1)`,
			),
			database.prepare(
				`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
				 VALUES ('orders.max_quantity', '1', 0, 1, 1)`,
			),
		]);
		const input = {
			sellableItemId,
			quantity: 1,
			email: "signed@example.com",
			couponCode: "",
			idempotencyKey: "checkout-policy",
			customerNote: "",
		};
		await expect(createStoreOrder(database, input)).rejects.toMatchObject({
			code: "guest_checkout_disabled",
			status: 403,
		});
		await database
			.prepare(
				`INSERT INTO users
				 (id, name, email, email_verified, created_at, updated_at)
				 VALUES ('signed-customer', 'Signed customer', 'signed@example.com', 1, 1, 1)`,
			)
			.run();
		await expect(
			createStoreOrder(database, input, { userId: "signed-customer" }),
		).resolves.toMatchObject({ status: "pending_payment" });
		await expect(
			createStoreOrder(
				database,
				{ ...input, quantity: 2, idempotencyKey: "checkout-policy-limit" },
				{ userId: "signed-customer" },
			),
		).rejects.toMatchObject({ code: "quantity_invalid", status: 400 });
	});

	it("requires both the order number and checkout email for guest lookup", async () => {
		const created = await createStoreOrder(database, {
			sellableItemId,
			quantity: 1,
			email: "buyer@example.com",
			couponCode: "",
			idempotencyKey: "checkout-secure-lookup",
			customerNote: "",
		});
		await expect(
			getStoreOrder(database, {
				orderNumber: created.orderNumber,
				email: "BUYER@EXAMPLE.COM",
			}),
		).resolves.toMatchObject({
			orderNumber: created.orderNumber,
			contactEmail: "bu***@example.com",
		});
		await expect(
			getStoreOrder(database, {
				orderNumber: created.orderNumber,
				email: "another@example.com",
			}),
		).rejects.toMatchObject({ code: "order_not_found", status: 404 });
		await expect(
			getStoreOrder(database, {
				orderNumber: `GM${"0".repeat(32)}`,
				email: "buyer@example.com",
			}),
		).rejects.toMatchObject({ code: "order_not_found" });
	});

	it("allows an authenticated customer to read only its own order", async () => {
		await database
			.prepare(
				`INSERT INTO users
				 (id, name, email, email_verified, created_at, updated_at)
				 VALUES ('buyer-user', 'Buyer', 'buyer@example.com', 1, 1, 1)`,
			)
			.run();
		const created = await createStoreOrder(
			database,
			{
				sellableItemId,
				quantity: 1,
				email: "buyer@example.com",
				couponCode: "",
				idempotencyKey: "checkout-account-order",
				customerNote: "",
			},
			{ userId: "buyer-user" },
		);
		await expect(
			getStoreOrder(
				database,
				{ orderNumber: created.orderNumber },
				{ userId: "buyer-user" },
			),
		).resolves.toMatchObject({ orderNumber: created.orderNumber });
		await expect(
			getStoreOrder(
				database,
				{ orderNumber: created.orderNumber },
				{ userId: "another-user" },
			),
		).rejects.toMatchObject({ code: "order_not_found" });
	});

	it("validates versioned order inputs and encrypts sensitive values", async () => {
		await seedOrderInputs(database);
		const created = await createStoreOrder(database, {
			sellableItemId,
			quantity: 1,
			email: "buyer@example.com",
			couponCode: "",
			idempotencyKey: "checkout-dynamic-inputs",
			customerNote: "",
			inputValues: { region: "eu", licenseName: "private-name" },
		});
		const values = await database
			.prepare(
				`SELECT input_values_json, sensitive_input_values_json
				 FROM shop_order_items WHERE order_id = ?`,
			)
			.bind(created.id)
			.first<{
				input_values_json: string;
				sensitive_input_values_json: string;
			}>();
		expect(JSON.parse(values?.input_values_json ?? "{}")).toEqual({
			region: "eu",
		});
		expect(
			JSON.parse(values?.sensitive_input_values_json ?? "{}"),
		).toMatchObject({
			licenseName: { envelope: expect.any(String), keyVersion: 1 },
		});
		expect(values?.sensitive_input_values_json).not.toContain("private-name");
		await expect(
			createStoreOrder(database, {
				sellableItemId,
				quantity: 1,
				email: "other@example.com",
				couponCode: "",
				idempotencyKey: "checkout-unknown-input",
				customerNote: "",
				inputValues: { unknown: "value" },
			}),
		).rejects.toMatchObject({ code: "order_input_unknown" });
	});

	it("completes a free order through the authoritative fulfillment path", async () => {
		await database
			.prepare(
				"UPDATE product_sellable_items SET price_minor = '0' WHERE id = ?",
			)
			.bind(sellableItemId)
			.run();
		const created = await createStoreOrder(database, {
			sellableItemId,
			quantity: 1,
			email: "free@example.com",
			couponCode: "",
			idempotencyKey: "checkout-free-order",
			customerNote: "",
		});
		expect(created.totalMinor).toBe("0");
		await expect(completeFreeStoreOrder(database, created.id)).resolves.toEqual(
			{
				duplicate: false,
				status: "paid",
			},
		);
		await expect(completeFreeStoreOrder(database, created.id)).resolves.toEqual(
			{
				duplicate: true,
				status: "paid",
			},
		);
		const state = await database
			.prepare(
				`SELECT o.status, o.paid_minor, dr.status AS delivery_status,
				 (SELECT COUNT(*) FROM stock_entries WHERE order_item_id = oi.id
				  AND status = 'reserved') AS reserved,
				 (SELECT COUNT(*) FROM outbox_events WHERE aggregate_id = dr.id
				  AND event_type = 'delivery.requested') AS delivery_events
				 FROM shop_orders o JOIN shop_order_items oi ON oi.order_id = o.id
				 JOIN delivery_records dr ON dr.order_item_id = oi.id WHERE o.id = ?`,
			)
			.bind(created.id)
			.first<Record<string, unknown>>();
		expect(state).toMatchObject({
			status: "paid",
			paid_minor: "0",
			delivery_status: "pending",
			reserved: 1,
			delivery_events: 1,
		});
	});

	it("rejects card orders above currently available stock", async () => {
		await expect(
			createStoreOrder(database, {
				sellableItemId,
				quantity: 3,
				email: "buyer@example.com",
				couponCode: "",
				idempotencyKey: "checkout-no-stock",
				customerNote: "",
			}),
		).rejects.toMatchObject({ code: "inventory_unavailable" });
	});

	it("expires unpaid orders and releases reserved coupon usage exactly once", async () => {
		const created = await createStoreOrder(database, {
			sellableItemId,
			quantity: 1,
			email: "buyer@example.com",
			couponCode: "SAVE25",
			idempotencyKey: "checkout-expiration",
			customerNote: "",
		});
		const concurrentExpiry = await Promise.all([
			expireStoreOrders(database, created.expiresAt + 1),
			expireStoreOrders(database, created.expiresAt + 1),
		]);
		expect(
			concurrentExpiry.reduce((total, result) => total + result.expired, 0),
		).toBe(1);
		await expect(
			expireStoreOrders(database, created.expiresAt + 1),
		).resolves.toEqual({ scanned: 0, expired: 0 });
		const state = await database
			.prepare(
				`SELECT o.status, o.version, c.used_count, cr.status AS redemption_status,
				 (SELECT COUNT(*) FROM shop_order_events WHERE order_id = o.id AND event_type = 'order_expired') AS events,
				 (SELECT COUNT(*) FROM outbox_events WHERE aggregate_id = o.id
				  AND event_type = 'shop_order.expired') AS orphaned_outbox_events
				 FROM shop_orders o JOIN coupons c ON c.id = o.coupon_id
				 JOIN coupon_redemptions cr ON cr.order_id = o.id WHERE o.id = ?`,
			)
			.bind(created.id)
			.first<Record<string, unknown>>();
		expect(state).toMatchObject({
			status: "expired",
			version: 2,
			used_count: 0,
			redemption_status: "released",
			events: 1,
			orphaned_outbox_events: 0,
		});
	});
});

async function seedStorefront(database: D1Database) {
	await database.batch([
		database.prepare(
			`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
			 VALUES ('runtime.data_encryption_secret', '"commerce-test-secret"', 1, 1, 1)`,
		),
		database.prepare(
			`INSERT INTO products
			 (id, name, product_type, status, sort_order, created_at, updated_at)
			 VALUES ('${productId}', 'Card Product', 'stock', 'active', 100, 1, 1)`,
		),
		database.prepare(
			`INSERT INTO product_sellable_items
			 (id, product_id, name, currency, currency_decimals,
			  price_minor, minimum_quantity, maximum_quantity,
			  sort_order, enabled, created_at, updated_at)
			 VALUES ('${sellableItemId}', '${productId}', 'Card plan',
			  'CNY', 2, '1000', 1, 10, 100, 1, 1, 1)`,
		),
		database.prepare(
			`INSERT INTO products
			 (id, name, product_type, status, sort_order, created_at, updated_at)
			 VALUES ('${downloadProductId}', 'Download Product', 'download', 'active', 300, 1, 1)`,
		),
		database.prepare(
			`INSERT INTO product_sellable_items
			 (id, product_id, name, currency,
			  currency_decimals, price_minor, minimum_quantity, maximum_quantity,
			  sort_order, enabled, created_at, updated_at)
			 VALUES ('${downloadItemId}', '${downloadProductId}', 'Download',
			  'CNY', 2, '800', 1, 1, 100, 1, 1, 1)`,
		),
		database.prepare(
			`INSERT INTO products
			 (id, name, product_type, status, sort_order, created_at, updated_at)
			 VALUES ('${automationProductId}', 'Automation Product',
			  'automation', 'active', 400, 1, 1)`,
		),
		database.prepare(
			`INSERT INTO product_sellable_items
			 (id, product_id, name, currency, currency_decimals, price_minor,
			  minimum_quantity, maximum_quantity, sort_order, enabled,
			  created_at, updated_at)
			 VALUES ('${automationItemId}', '${automationProductId}', 'Automation',
			  'CNY', 2, '1200', 1, 1, 100, 1, 1, 1)`,
		),
		database.prepare(
			`INSERT INTO product_definition_versions
			 (id, product_id, sellable_item_id, version, schema_json,
			  published_at, created_at, updated_at)
			 VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddddd',
			  '${automationProductId}', '${automationItemId}', 1, '[]', 1, 1, 1)`,
		),
		database.prepare(
			`UPDATE product_sellable_items SET
			 automation_provider = 'github_actions',
			 automation_base_url = 'https://api.github.com',
			 automation_repository_owner = 'gmshop',
			 automation_repository_name = 'example',
			 automation_default_branch = 'main',
			 automation_workflow_file = 'automation.yml',
			 active_definition_version_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
			 WHERE id = '${automationItemId}'`,
		),
		database.prepare(
			`INSERT INTO product_automation_methods
			 (id, sellable_item_id, config_version, key, name, runtime,
			  artifact_policy, output_pattern, sort_order, enabled, created_at, updated_at)
			 VALUES ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
			  '${automationItemId}', 1, 'default', 'Default', 'ubuntu-latest',
			  'none', '', 100, 1, 1, 1)`,
		),
		database.prepare(
			`INSERT INTO download_assets
			 (id, product_id, object_key, file_name, content_type, size_bytes,
			  checksum_sha256, version, created_at, updated_at)
			 VALUES ('download-v1', '${downloadProductId}', 'downloads/v1', 'v1.zip',
			  'application/zip', 10, '${"a".repeat(64)}', 1, 1, 1)`,
		),
		database.prepare(
			`INSERT INTO download_asset_sellable_items
			 (download_asset_id, sellable_item_id, sort_order)
			 VALUES ('download-v1', '${downloadComponentId}', 100)`,
		),
		database.prepare(
			`INSERT INTO products
			 (id, name, product_type, status, sort_order, created_at, updated_at)
			 VALUES ('${secondProductId}', 'Stock Product', 'stock', 'active', 200, 1, 1)`,
		),
		database.prepare(
			`INSERT INTO product_sellable_items
			 (id, product_id, name, currency, currency_decimals,
			  price_minor, cost_minor, minimum_quantity, maximum_quantity,
			  sort_order, enabled, created_at, updated_at)
			 VALUES ('${secondItemId}', '${secondProductId}', 'Service',
			  'CNY', 2, '500', '200', 1, 10, 100, 1, 1, 1)`,
		),
		database.prepare(
			`INSERT INTO stock_entries
			 (id, sellable_item_id, content_encrypted, key_version, content_fingerprint,
			  content_mask, status, created_at, updated_at) VALUES
			 ('stock-1', '${cardComponentId}', 'cipher-1', 1, 'fingerprint-1', '••••0001', 'available', 1, 1),
			 ('stock-2', '${cardComponentId}', 'cipher-2', 1, 'fingerprint-2', '••••0002', 'available', 2, 2),
			 ('stock-3', '${secondComponentId}', 'cipher-3', 1, 'fingerprint-3', '••••0003', 'available', 3, 3),
			 ('stock-4', '${secondComponentId}', 'cipher-4', 1, 'fingerprint-4', '••••0004', 'available', 4, 4)`,
		),
		database.prepare(
			`INSERT INTO coupons
			 (id, code, name, type, currency, currency_decimals, value_bps,
			  usage_limit, usage_limit_per_customer, used_count, scope_json,
			  enabled, created_at, updated_at)
			 VALUES ('${couponId}', 'SAVE25', 'Save 25%', 'percentage', 'CNY', 2,
			  2500, 10, 1, 0, '{"productIds":["${productId}"],"tagNames":[]}', 1, 1, 1)`,
		),
	]);
}

async function seedOrderInputs(database: D1Database) {
	await database.batch([
		database.prepare(
			`INSERT INTO product_definition_versions
			 (id, product_id, sellable_item_id, version, schema_json, published_at, created_at, updated_at)
			 VALUES ('definition-version-1', '${productId}', '${sellableItemId}', 1,
			  '${JSON.stringify([
					{
						key: "region",
						name: "Region",
						description: "",
						inputType: "select",
						scope: "order",
						required: true,
						sensitive: false,
						validationPattern: "",
						minimumValue: null,
						maximumValue: null,
						defaultValue: "",
						sortOrder: 10,
						options: [
							{ value: "eu", label: "Europe" },
							{ value: "us", label: "United States" },
						],
					},
					{
						key: "licenseName",
						name: "License name",
						description: "",
						inputType: "text",
						scope: "order",
						required: true,
						sensitive: true,
						validationPattern: "",
						minimumValue: null,
						maximumValue: null,
						defaultValue: "",
						sortOrder: 20,
						options: [],
					},
				]).replaceAll("'", "''")}', 1, 1, 1)`,
		),
		database
			.prepare(
				"UPDATE product_sellable_items SET active_definition_version_id = 'definition-version-1' WHERE id = ?",
			)
			.bind(sellableItemId),
	]);
}
