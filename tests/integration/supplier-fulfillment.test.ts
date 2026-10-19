import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { switchStockFulfillmentMode } from "#/features/catalog/server/fulfillment-source";
import { encryptDeliveryContent } from "#/features/fulfillment/secrets";
import { processDelivery } from "#/features/fulfillment/server/process";
import { completeFreeStoreOrder } from "#/features/shop-payments/server/service";
import { revealStoreDelivery } from "#/features/storefront/server/delivery-reveal";
import { getStoreOrder } from "#/features/storefront/server/order-query";
import { getSupplierProduct } from "#/features/supplier-api/server/catalog";
import { createSupplierApiOrder } from "#/features/supplier-api/server/orders";
import { resolveSupplierUsageUrl } from "#/features/suppliers/customer-usage";
import { supplierFetchJson } from "#/features/suppliers/providers/http";
import { signDujiaoNextRequest } from "#/features/suppliers/providers/signatures";
import { createSupplierCredentialVault } from "#/features/suppliers/secrets";
import { createSupplierHttpAudit } from "#/features/suppliers/server/diagnostics";
import { handleDujiaoSupplierCallback } from "#/features/suppliers/server/dujiao-callback";
import { processSupplierOrder } from "#/features/suppliers/server/process";
import { decryptSecret, encryptSecret } from "#/lib/secrets";
import {
	createInitialRuntimeConfig,
	runtimeConfigEntries,
} from "#/server/runtime-config";
import { applyMigrations } from "./migrations";

describe("supplier fulfillment", { timeout: 30_000 }, () => {
	let miniflare: Miniflare;
	let db: D1Database;
	const runtime = createInitialRuntimeConfig("https://shop.example");

	beforeEach(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: crypto.randomUUID() },
			r2Buckets: { FILES: "files" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await seed(db, runtime);
	});

	afterEach(async () => miniflare.dispose());

	it("enforces the three-table account grouping and credential revision constraints", async () => {
		const tables = await db
			.prepare(
				`SELECT name FROM sqlite_master
				 WHERE type = 'table' AND name LIKE 'supplier_%' ORDER BY name`,
			)
			.all<{ name: string }>();
		expect(tables.results).toEqual([
			{ name: "supplier_accounts" },
			{ name: "supplier_api_keys" },
			{ name: "supplier_api_orders" },
			{ name: "supplier_bindings" },
			{ name: "supplier_exchange_records" },
			{ name: "supplier_export_listings" },
			{ name: "supplier_orders" },
		]);
		await expect(
			db
				.prepare(
					"UPDATE supplier_accounts SET credentials_revision = 0 WHERE id = 'account'",
				)
				.run(),
		).rejects.toThrow(/supplier_accounts_credentials_revision_check/);
		await expect(
			db
				.prepare(
					`INSERT INTO supplier_accounts
					 (id, provider, base_url, normalized_api_origin, protocol_version,
					  currency, currency_decimals, name, credentials_encrypted,
					  credentials_revision, credential_fingerprint, enabled,
					  health_status, created_at, updated_at)
					 SELECT 'duplicate-name', provider, base_url, normalized_api_origin,
					  protocol_version, currency, currency_decimals, name,
					  credentials_encrypted, 1, 'another-fingerprint', enabled,
					  health_status, created_at, updated_at
					 FROM supplier_accounts WHERE id = 'account'`,
				)
				.run(),
		).rejects.toThrow(/UNIQUE constraint failed/);
	});

	it("atomically creates an awaiting supplier order after payment", async () => {
		await expect(completeFreeStoreOrder(db, "order")).resolves.toMatchObject({
			status: "paid",
		});
		const state = await db
			.prepare(
				`SELECT so.state, so.quantity, so.binding_snapshot_json,
				        dr.status AS delivery_status, oe.event_type, oe.payload
				 FROM supplier_orders so
				 JOIN delivery_records dr ON dr.id = so.delivery_record_id
				 JOIN outbox_events oe ON oe.aggregate_id = so.id
				 WHERE so.order_id = 'order'`,
			)
			.first<Record<string, unknown>>();
		expect(state).toMatchObject({
			state: "pending",
			quantity: 2,
			delivery_status: "awaiting_supply",
			event_type: "supplier.requested",
		});
		expect(JSON.parse(String(state?.payload))).toEqual({
			supplierOrderId: expect.any(String),
		});
	});

	it("uses staged local CDKs only in local mode", async () => {
		await db.batch([
			db.prepare(
				"UPDATE product_sellable_items SET fulfillment_source = 'local', supplier_status = NULL WHERE id = 'item'",
			),
			db.prepare(
				`INSERT INTO stock_entries
				 (id, sellable_item_id, content_encrypted, key_version,
				  content_fingerprint, content_mask, status, created_at, updated_at)
				 VALUES
				 ('owned-1', 'item', 'ciphertext-1', 1, 'owned-fingerprint-1', '••••0001', 'available', 1, 1),
				 ('owned-2', 'item', 'ciphertext-2', 1, 'owned-fingerprint-2', '••••0002', 'available', 2, 2)`,
			),
		]);
		await completeFreeStoreOrder(db, "order");
		const local = await db
			.prepare(
				`SELECT delivery.status,
				 (SELECT COUNT(*) FROM stock_entries WHERE order_item_id = 'order-item' AND status = 'reserved') AS reserved,
				 (SELECT COUNT(*) FROM supplier_orders WHERE order_id = 'order') AS supplier_orders,
				 (SELECT COUNT(*) FROM outbox_events WHERE event_type = 'delivery.requested') AS delivery_events
				 FROM delivery_records delivery WHERE delivery.order_item_id = 'order-item'`,
			)
			.first<Record<string, unknown>>();
		expect(local).toMatchObject({
			status: "pending",
			reserved: 2,
			supplier_orders: 0,
			delivery_events: 1,
		});
	});

	it("fails closed instead of buying when local mode has no owned CDKs", async () => {
		await db
			.prepare(
				"UPDATE product_sellable_items SET fulfillment_source = 'local', supplier_status = NULL WHERE id = 'item'",
			)
			.run();
		await completeFreeStoreOrder(db, "order");
		const localOnly = await db
			.prepare(
				`SELECT delivery.status,
				 (SELECT COUNT(*) FROM supplier_orders WHERE order_id = 'order') AS supplier_orders,
				 (SELECT COUNT(*) FROM outbox_events WHERE event_type = 'supplier.requested') AS supplier_events,
				 (SELECT COUNT(*) FROM outbox_events WHERE event_type = 'delivery.requested') AS delivery_events
				 FROM delivery_records delivery WHERE delivery.order_item_id = 'order-item'`,
			)
			.first<Record<string, unknown>>();
		expect(localOnly).toMatchObject({
			status: "failed",
			supplier_orders: 0,
			supplier_events: 0,
			delivery_events: 1,
		});
	});

	async function enableFallback() {
		await db.batch([
			db.prepare(
				"UPDATE product_sellable_items SET fulfillment_source='local',supplier_status=NULL WHERE id='item'",
			),
			db.prepare(
				"INSERT INTO system_settings(key,value) VALUES ('fulfillment.supplier_fallback.item','true')",
			),
		]);
	}
	async function addOwned(count: number) {
		for (let i = 0; i < count; i++)
			await db
				.prepare(`INSERT INTO stock_entries
   (id,sellable_item_id,content_encrypted,key_version,content_fingerprint,content_mask,status,created_at,updated_at)
   VALUES (?,'item',?,1,?,?,'available',?,?)`)
				.bind(
					`owned-${i}`,
					await encryptSecret(
						`OWNED-${i}`,
						runtime.commerceSecret,
						"stock-entry",
					),
					`fp-${i}`,
					`masked-${i}`,
					i + 1,
					i + 1,
				)
				.run();
	}
	it.each([
		0, 1, 2, 3,
	])("local-first reserves owned stock before quoting only the deficit (stock=%i)", async (owned) => {
		await enableFallback();
		await addOwned(owned);
		await completeFreeStoreOrder(db, "order");
		await completeFreeStoreOrder(db, "order");
		const reserved = await db
			.prepare(
				"SELECT id FROM stock_entries WHERE status='reserved' ORDER BY created_at,id",
			)
			.all();
		expect(reserved.results).toHaveLength(Math.min(owned, 2));
		const orders = await db
			.prepare("SELECT quantity,total_cost_minor FROM supplier_orders")
			.all();
		expect(orders.results).toEqual(
			owned >= 2
				? []
				: [
						{
							quantity: 2 - owned,
							total_cost_minor: String(100 * (2 - owned)),
						},
					],
		);
		const delivery = await db
			.prepare("SELECT id,status FROM delivery_records")
			.first<{ id: string; status: string }>();
		expect(delivery?.status).toBe(owned >= 2 ? "pending" : "awaiting_supply");
		expect(
			(
				await db
					.prepare(
						"SELECT id FROM outbox_events WHERE event_type='supplier.requested'",
					)
					.all()
			).results,
		).toHaveLength(owned >= 2 ? 0 : 1);
		if (owned >= 2) {
			await processDelivery(db, delivery?.id ?? "");
			const row = await db
				.prepare("SELECT content_encrypted FROM delivery_records")
				.first<{ content_encrypted: string }>();
			expect(
				await decryptSecret(
					row?.content_encrypted ?? "",
					runtime.commerceSecret,
					"delivery-content",
				),
			).toBe("OWNED-0\nOWNED-1");
		}
	});
	it("keeps local stock usable when the fallback binding is disabled", async () => {
		await enableFallback();
		await addOwned(2);
		await db.prepare("UPDATE supplier_bindings SET enabled=0").run();
		await completeFreeStoreOrder(db, "order");
		expect(
			await db.prepare("SELECT status FROM delivery_records").first(),
		).toEqual({ status: "pending" });
		expect(
			(await db.prepare("SELECT id FROM supplier_orders").all()).results,
		).toHaveLength(0);
	});
	it("does not create a purchase when fallback is enabled but the binding is disabled", async () => {
		await enableFallback();
		await db.prepare("UPDATE supplier_bindings SET enabled=0").run();
		await completeFreeStoreOrder(db, "order");
		expect(
			await db.prepare("SELECT status FROM delivery_records").first(),
		).toEqual({ status: "failed" });
		expect(
			(await db.prepare("SELECT id FROM supplier_orders").all()).results,
		).toHaveLength(0);
	});
	it("delivers prepaid AISOU renewal stock plus only the exact deficit without duplicate purchase", async () => {
		const sku = "fixture-renewal";
		await enableFallback();
		await addOwned(1);
		const vault = await createSupplierCredentialVault(
			"shared_stock",
			{ appId: "merchant", appKey: "test-secret" },
			runtime.commerceSecret,
		);
		await db.batch([
			db
				.prepare(
					"UPDATE supplier_accounts SET provider='shared_stock', protocol_version='acg-sharedstock-v1',credentials_encrypted=?",
				)
				.bind(vault),
			db
				.prepare(
					"UPDATE supplier_bindings SET provider='shared_stock',protocol_version='acg-sharedstock-v1',upstream_product_id=?,upstream_sku_id=?",
				)
				.bind(sku, sku),
		]);
		await completeFreeStoreOrder(db, "order");
		const order = await db
			.prepare("SELECT id,delivery_record_id FROM supplier_orders")
			.first<{ id: string; delivery_record_id: string }>();
		const trades: URLSearchParams[] = [];
		const fetcher: typeof fetch = async (input, init) => {
			const request = new Request(input, init),
				path = new URL(request.url).pathname;
			if (path.endsWith("/connect"))
				return Response.json({
					code: 200,
					data: { shopName: "Supplier", balance: "100.00" },
				});
			if (path.endsWith("/inventory"))
				return Response.json({
					code: 200,
					data: { count: 10, delivery_way: 0, price: "1.00" },
				});
			if (path.endsWith("/trade")) {
				trades.push(new URLSearchParams(await request.text()));
				return Response.json({
					code: 200,
					data: { tradeNo: "trade-exact", secret: "AISOU-CARD" },
				});
			}
			throw Error("Unexpected request");
		};
		await processSupplierOrder(db, order?.id ?? "", { fetcher });
		await processSupplierOrder(db, order?.id ?? "", { fetcher });
		expect(trades).toHaveLength(1);
		expect(trades[0]?.get("shared_code")).toBe(sku);
		expect(trades[0]?.get("num")).toBe("1");
		await processDelivery(db, order?.delivery_record_id ?? "");
		await processDelivery(db, order?.delivery_record_id ?? "");
		expect(
			(await db.prepare("SELECT status FROM stock_entries ORDER BY id").all())
				.results,
		).toEqual([{ status: "delivered" }, { status: "delivered" }]);
		expect(
			await db
				.prepare("SELECT status FROM shop_orders WHERE id='order'")
				.first(),
		).toEqual({ status: "completed" });
		const row = await db
			.prepare("SELECT content_encrypted FROM delivery_records")
			.first<{ content_encrypted: string }>();
		expect(
			await decryptSecret(
				row?.content_encrypted ?? "",
				runtime.commerceSecret,
				"delivery-content",
			),
		).toBe("OWNED-0\nAISOU-CARD");
	});
	it.each([
		false,
		true,
	])("does not charge AISOU with insufficient live balance even when checkout opted in: %s", async (unfunded) => {
		if (unfunded)
			await db
				.prepare(
					"INSERT INTO system_settings(key,value) VALUES ('fulfillment.supplier_unfunded_checkout.item','true')",
				)
				.run();
		await enableFallback();
		await addOwned(1);
		await completeFreeStoreOrder(db, "order");
		const order = await db
			.prepare("SELECT id FROM supplier_orders")
			.first<{ id: string }>();
		const requests: string[] = [];
		const fetcher: typeof fetch = async (input, init) => {
			const req = new Request(input, init);
			requests.push(new URL(req.url).pathname);
			if (req.url.endsWith("/ping"))
				return Response.json({
					ok: true,
					site_name: "Supplier",
					balance: "0.00",
					currency: "CNY",
				});
			return pendingSupplierFetcher(input, init);
		};
		await expect(
			processSupplierOrder(db, order?.id ?? "", { fetcher }),
		).rejects.toMatchObject({ code: "supplier_accounts_exhausted" });
		expect(requests).not.toContain("/api/v1/upstream/orders");
		expect(
			await db
				.prepare(
					"SELECT state,last_error_code,selected_account_id FROM supplier_orders",
				)
				.first(),
		).toEqual({
			state: "failed",
			last_error_code: "supplier_accounts_exhausted",
			selected_account_id: null,
		});
		expect(
			await db.prepare("SELECT status FROM stock_entries").first(),
		).toEqual({ status: "reserved" });
	});

	it("exports owned stock only; fallback catalogue cannot expand a new reseller purchase", async () => {
		await db.batch([
			db.prepare(
				"UPDATE product_sellable_items SET fulfillment_source='local',supplier_status=NULL WHERE id='item'",
			),
			db.prepare(
				"INSERT INTO users(id,name,email,email_verified,enabled,balance_minor) VALUES ('buyer','Buyer','buyer@example.com',1,1,'10000')",
			),
			db.prepare(
				"INSERT INTO supplier_api_keys(id,user_id,name,key_id,secret_encrypted) VALUES ('api-key','buyer','Test','key-id','encrypted')",
			),
			db.prepare(
				"INSERT INTO supplier_export_listings(id,sellable_item_id,price_minor,currency,currency_decimals,enabled) VALUES ('export','item','100','USD',2,1)",
			),
		]);
		await addOwned(1);
		const identity = {
			userId: "buyer",
			keyRowId: "api-key",
			keyId: "key-id",
			allowedCallbackOrigin: null,
		};
		const input = {
			skuId: "item",
			quantity: 2,
			downstreamOrderNo: "reseller-test",
		};
		expect(
			(await getSupplierProduct(db, "product")).product?.skus[0]
				?.stock_quantity,
		).toBe(1);
		await expect(
			createSupplierApiOrder(db, identity, input),
		).rejects.toMatchObject({ code: "supplier_stock_unavailable" });
		await enableFallback();
		expect(
			(await getSupplierProduct(db, "product")).product?.skus[0]
				?.stock_quantity,
		).toBe(1);
		await expect(
			createSupplierApiOrder(db, identity, input),
		).rejects.toMatchObject({ code: "supplier_stock_unavailable" });
		expect(
			await db
				.prepare("SELECT balance_minor FROM users WHERE id='buyer'")
				.first(),
		).toEqual({ balance_minor: "10000" });
		const ownInput = { ...input, quantity: 1 };
		const created = await createSupplierApiOrder(db, identity, ownInput);
		expect(
			(await createSupplierApiOrder(db, identity, ownInput)).order_id,
		).toBe(created.order_id);
		expect(
			await db.prepare("SELECT COUNT(*) AS n FROM supplier_orders").first(),
		).toEqual({ n: 0 });
		expect(
			await db
				.prepare("SELECT balance_minor FROM users WHERE id='buyer'")
				.first(),
		).toEqual({ balance_minor: "9900" });
		expect(
			(await getSupplierProduct(db, "product")).product?.skus[0]
				?.stock_quantity,
		).toBe(0);
	});

	it("two concurrent paid orders cannot consume the same last owned card", async () => {
		await enableFallback();
		await addOwned(1);
		const now = Date.now();
		await db.batch([
			db.prepare(
				"UPDATE shop_order_items SET quantity=1 WHERE id='order-item'",
			),
			db
				.prepare(`INSERT INTO shop_orders(id,order_number,status,currency,currency_decimals,subtotal_minor,discount_minor,total_minor,paid_minor,expires_at)
    VALUES ('order-2','ORDER-2','pending_payment','USD',2,'0','0','0','0',?)`)
				.bind(now + 60000),
			db.prepare(`INSERT INTO shop_order_items(id,order_id,product_id,sellable_item_id,product_name,delivery_component_id,delivery_component_type,delivery_component_version,sellable_item_name,quantity,unit_price_minor,discount_minor,subtotal_minor)
    VALUES ('order-item-2','order-2','product','item','Product','item','stock',1,'SKU',1,'0','0','0')`),
		]);
		await Promise.all([
			completeFreeStoreOrder(db, "order"),
			completeFreeStoreOrder(db, "order-2"),
		]);
		expect(
			(await db.prepare("SELECT status FROM stock_entries").all()).results,
		).toEqual([{ status: "reserved" }]);
		expect(
			(await db.prepare("SELECT quantity FROM supplier_orders").all()).results,
		).toEqual([{ quantity: 1 }]);
		expect(
			(
				await db
					.prepare("SELECT status FROM delivery_records ORDER BY status")
					.all()
			).results,
		).toEqual([{ status: "awaiting_supply" }, { status: "pending" }]);
	});
	it("quotes the deficit without floating-point money loss", async () => {
		await enableFallback();
		await addOwned(1);
		await db
			.prepare(
				"UPDATE supplier_bindings SET reference_cost_minor='9007199254740993',max_cost_minor='9007199254740993'",
			)
			.run();
		await completeFreeStoreOrder(db, "order");
		expect(
			await db
				.prepare("SELECT quantity,total_cost_minor FROM supplier_orders")
				.first(),
		).toEqual({ quantity: 1, total_cost_minor: "9007199254740993" });
	});

	it.each([
		"fixture-claude",
		"fixture-go",
	])("manual mode switch preserves owned deliveries and purchases the exact AISOU SKU: %s", async (sku) => {
		await db
			.prepare(
				"UPDATE product_sellable_items SET fulfillment_source='local',supplier_status=NULL",
			)
			.run();
		await addOwned(3);
		const ownedText = "CDK：OWNED-LOCAL\n充值地址：https://redeem.lsrai.shop/";
		await db
			.prepare(
				"UPDATE stock_entries SET content_encrypted=? WHERE id='owned-0'",
			)
			.bind(
				await encryptSecret(ownedText, runtime.commerceSecret, "stock-entry"),
			)
			.run();
		await completeFreeStoreOrder(db, "order");
		const original = await db
			.prepare("SELECT id FROM delivery_records")
			.first<{ id: string }>();
		const vault = await createSupplierCredentialVault(
			"shared_stock",
			{ appId: "merchant", appKey: "test-secret" },
			runtime.commerceSecret,
		);
		const usageUrl =
			sku === "fixture-claude"
				? "https://redeem.example/claude"
				: "https://redeem.example/";
		await db.batch([
			db
				.prepare(
					"UPDATE supplier_accounts SET provider='shared_stock',protocol_version='acg-sharedstock-v1',credentials_encrypted=?",
				)
				.bind(vault),
			db
				.prepare(
					"UPDATE supplier_bindings SET provider='shared_stock',protocol_version='acg-sharedstock-v1',upstream_product_id=?,upstream_sku_id=?",
				)
				.bind(sku, sku),
			db.prepare("UPDATE product_sellable_items SET policy_json=?").bind(
				JSON.stringify({
					supplierUsageGuide: {
						provider: "shared_stock",
						origin: "https://supplier.example",
						skuId: sku,
						url: usageUrl,
					},
				}),
			),
			db.prepare(
				"INSERT INTO users(id,name,email,email_verified,enabled,balance_minor) VALUES ('buyer','Buyer','buyer@example.com',1,1,'10000')",
			),
			db.prepare(
				"INSERT INTO supplier_api_keys(id,user_id,name,key_id,secret_encrypted) VALUES ('api-key','buyer','Test','key-id','encrypted')",
			),
			db.prepare(
				"INSERT INTO supplier_export_listings(id,sellable_item_id,price_minor,currency,currency_decimals,enabled) VALUES ('export','item','100','USD',2,1)",
			),
		]);
		await switchStockFulfillmentMode(db, "item", "supplier");
		expect(
			(await getSupplierProduct(db, "product")).product?.skus[0]
				?.stock_quantity,
		).toBe(10);
		await processDelivery(db, original?.id ?? "");
		const old = await db
			.prepare("SELECT content_encrypted FROM delivery_records WHERE id=?")
			.bind(original?.id)
			.first<{ content_encrypted: string }>();
		expect(
			await decryptSecret(
				old?.content_encrypted ?? "",
				runtime.commerceSecret,
				"delivery-content",
			),
		).toContain("https://redeem.lsrai.shop/");
		const input = {
			skuId: "item",
			quantity: 1,
			downstreamOrderNo: "manual-aisou",
		};
		const identity = {
			userId: "buyer",
			keyRowId: "api-key",
			keyId: "key-id",
			allowedCallbackOrigin: null,
		};
		await createSupplierApiOrder(db, identity, input);
		await createSupplierApiOrder(db, identity, input);
		const purchase = await db
			.prepare("SELECT id,delivery_record_id FROM supplier_orders")
			.first<{ id: string; delivery_record_id: string }>();
		const trades: URLSearchParams[] = [];
		const fetcher: typeof fetch = async (input, init) => {
			const request = new Request(input, init),
				path = new URL(request.url).pathname;
			if (path.endsWith("/connect"))
				return Response.json({
					code: 200,
					data: { shopName: "Supplier", balance: "100.00" },
				});
			if (path.endsWith("/inventory"))
				return Response.json({
					code: 200,
					data: { count: 10, delivery_way: 0, price: "1.00" },
				});
			if (path.endsWith("/trade")) {
				trades.push(new URLSearchParams(await request.text()));
				return Response.json({
					code: 200,
					data: {
						tradeNo: "manual-trade",
						secret: "AISOU-EXACT-CDK",
						url: "https://supplier.example/payment-only",
					},
				});
			}
			throw Error("Unexpected request");
		};
		await processSupplierOrder(db, purchase?.id ?? "", { fetcher });
		await processSupplierOrder(db, purchase?.id ?? "", { fetcher });
		await processDelivery(db, purchase?.delivery_record_id ?? "");
		expect(trades).toHaveLength(1);
		expect(trades[0]?.get("shared_code")).toBe(sku);
		const delivered = await db
			.prepare("SELECT content_encrypted FROM delivery_records WHERE id=?")
			.bind(purchase?.delivery_record_id)
			.first<{ content_encrypted: string }>();
		const text = await decryptSecret(
			delivered?.content_encrypted ?? "",
			runtime.commerceSecret,
			"delivery-content",
		);
		expect(text).toContain("AISOU-EXACT-CDK");
		expect(text).toContain(usageUrl);
		expect(text).not.toContain("payment-only");
		expect(
			await db
				.prepare("SELECT status FROM stock_entries WHERE id='owned-2'")
				.first(),
		).toEqual({ status: "available" });
		await switchStockFulfillmentMode(db, "item", "local");
		expect(
			(await getSupplierProduct(db, "product")).product?.skus[0]
				?.stock_quantity,
		).toBe(1);
	});

	it("buys directly from the supplier without consuming staged local CDKs", async () => {
		await db
			.prepare(
				`INSERT INTO stock_entries
			 (id, sellable_item_id, content_encrypted, key_version,
			  content_fingerprint, content_mask, status, created_at, updated_at)
			 VALUES ('owned-1', 'item', 'ciphertext-1', 1,
			  'owned-fingerprint-1', '•••0001', 'available', 1, 1)`,
			)
			.run();
		await completeFreeStoreOrder(db, "order");
		const supplierOnly = await db
			.prepare(
				`SELECT delivery.status,
				 (SELECT COUNT(*) FROM stock_entries WHERE status = 'available') AS available,
				 (SELECT COUNT(*) FROM stock_entries WHERE order_item_id = 'order-item') AS reserved,
				 (SELECT COUNT(*) FROM supplier_orders WHERE order_id = 'order') AS supplier_orders,
				 (SELECT COUNT(*) FROM outbox_events WHERE event_type = 'supplier.requested') AS supplier_events
				 FROM delivery_records delivery WHERE delivery.order_item_id = 'order-item'`,
			)
			.first<Record<string, unknown>>();
		expect(supplierOnly).toMatchObject({
			status: "awaiting_supply",
			available: 1,
			reserved: 0,
			supplier_orders: 1,
			supplier_events: 1,
		});
	});

	it.each([
		"supplier",
		"manual",
	] as const)("masks the internal %s fulfillment source on the order page", async (source) => {
		await db
			.prepare(
				"UPDATE product_sellable_items SET fulfillment_source = ?, supplier_status = CASE WHEN ? = 'supplier' THEN 'available' ELSE NULL END WHERE id = 'item'",
			)
			.bind(source, source)
			.run();
		await db
			.prepare(
				"UPDATE shop_orders SET order_number = 'ORDER-TEST-1', contact_email = 'buyer@example.com', normalized_contact_email = 'buyer@example.com' WHERE id = 'order'",
			)
			.run();
		await completeFreeStoreOrder(db, "order");
		if (source === "supplier")
			await db
				.prepare(
					"UPDATE product_sellable_items SET fulfillment_source = 'manual', supplier_status = NULL WHERE id = 'item'",
				)
				.run();
		const result = await getStoreOrder(db, {
			orderNumber: "ORDER-TEST-1",
			email: "buyer@example.com",
		});
		expect(result.deliveries).toHaveLength(1);
		expect(result.deliveries[0]).toMatchObject({
			status: "awaiting_supply",
			fulfillmentSource: source === "manual" ? "manual" : "local",
		});
		if (source === "supplier")
			expect(JSON.stringify(result.deliveries[0])).not.toMatch(
				/supplier|upstream|binding|cost/i,
			);
	});

	it("snapshots the matching usage guide at payment and supports identity-bound legacy fallback", async () => {
		const guide = {
			provider: "dujiao_next",
			origin: "https://supplier.example",
			skuId: "2",
			url: "https://original.example/use",
		};
		await db
			.prepare(
				"UPDATE product_sellable_items SET policy_json = ? WHERE id = 'item'",
			)
			.bind(JSON.stringify({ supplierUsageGuide: guide }))
			.run();
		await db
			.prepare(
				"UPDATE shop_orders SET order_number = 'ORDER-TEST-1', contact_email = 'buyer@example.com', normalized_contact_email = 'buyer@example.com' WHERE id = 'order'",
			)
			.run();
		await completeFreeStoreOrder(db, "order");
		await db
			.prepare(
				"UPDATE product_sellable_items SET policy_json = ? WHERE id = 'item'",
			)
			.bind(
				JSON.stringify({
					supplierUsageGuide: { ...guide, url: "https://new.example/use" },
				}),
			)
			.run();
		const lookup = async () => {
			const row = await db
				.prepare(
					"SELECT s.binding_snapshot_json, i.policy_json FROM supplier_orders s JOIN shop_order_items oi ON oi.id=s.order_item_id JOIN product_sellable_items i ON i.id=oi.sellable_item_id WHERE s.order_id='order'",
				)
				.first<{ binding_snapshot_json: string; policy_json: string }>();
			return resolveSupplierUsageUrl(
				row?.policy_json,
				row?.binding_snapshot_json,
			);
		};
		expect(await lookup()).toBe(guide.url);
		await db
			.prepare(
				"UPDATE supplier_orders SET binding_snapshot_json = json_remove(binding_snapshot_json, '$.customerUsageUrl') WHERE order_id = 'order'",
			)
			.run();
		expect(await lookup()).toBe("https://new.example/use");
	});

	it("locks a processing account, then imports encrypted cards idempotently", async () => {
		await db
			.prepare(
				"UPDATE product_sellable_items SET policy_json = ? WHERE id = 'item'",
			)
			.bind(
				JSON.stringify({
					supplierUsageGuide: {
						provider: "dujiao_next",
						origin: "https://supplier.example",
						skuId: "2",
						url: "https://verified.example/redeem",
					},
				}),
			)
			.run();
		await db
			.prepare(
				"UPDATE shop_orders SET order_number = 'ORDER-TEST-1', contact_email = 'buyer@example.com', normalized_contact_email = 'buyer@example.com' WHERE id = 'order'",
			)
			.run();
		await completeFreeStoreOrder(db, "order");
		const supplierOrder = await db
			.prepare("SELECT id FROM supplier_orders WHERE order_id = 'order'")
			.first<{ id: string }>();
		expect(supplierOrder).toBeTruthy();
		const fetcher: typeof fetch = async (input) => {
			const url = new URL(
				typeof input === "string"
					? input
					: input instanceof URL
						? input
						: input.url,
			);
			if (url.pathname === "/api/v1/upstream/ping")
				return Response.json({
					ok: true,
					site_name: "Supplier",
					balance: "100.00",
					currency: "CNY",
				});
			if (url.pathname === "/api/v1/upstream/products/1")
				return Response.json({ ok: true, product: upstreamProduct() });
			if (url.pathname === "/api/v1/upstream/categories")
				return Response.json({ ok: true, categories: [] });
			if (url.pathname === "/api/v1/upstream/orders")
				return Response.json({ ok: true, order_id: 99, status: "pending" });
			if (url.pathname === "/api/v1/upstream/orders/99")
				return Response.json({
					order_id: 99,
					status: "completed",
					fulfillment: {
						status: "delivered",
						payload: "CARD-1\nCARD-2",
					},
				});
			throw new Error(`Unexpected URL ${url}`);
		};
		await expect(
			processSupplierOrder(db, supplierOrder?.id ?? "", { fetcher }),
		).rejects.toMatchObject({ code: "supplier_order_pending" });
		const locked = await db
			.prepare(
				`SELECT state, selected_account_id, selected_credentials_revision,
				        provider_request_no, upstream_order_id, account_locked_at
				 FROM supplier_orders WHERE id = ?`,
			)
			.bind(supplierOrder?.id)
			.first();
		expect(locked).toMatchObject({
			state: "uncertain",
			selected_account_id: "account",
			selected_credentials_revision: 1,
			upstream_order_id: "99",
		});
		expect(locked?.provider_request_no).toMatch(/^gm_[a-f0-9]{40}$/);
		expect(locked?.account_locked_at).toEqual(expect.any(Number));

		await expect(
			processSupplierOrder(db, supplierOrder?.id ?? "", { fetcher }),
		).resolves.toMatchObject({ state: "supplied", duplicate: false });
		const fulfilled = await db
			.prepare(
				`SELECT so.state, dr.status AS delivery_status,
				        (SELECT COUNT(*) FROM stock_entries se
				         WHERE se.supplier_order_id = so.id AND se.status = 'reserved') AS cards,
				        (SELECT COUNT(*) FROM outbox_events oe
				         WHERE oe.idempotency_key = 'supplier-delivery-requested:' || dr.id) AS delivery_events
				 FROM supplier_orders so
				 JOIN delivery_records dr ON dr.id = so.delivery_record_id
				 WHERE so.id = ?`,
			)
			.bind(supplierOrder?.id)
			.first();
		expect(fulfilled).toMatchObject({
			state: "supplied",
			delivery_status: "pending",
			cards: 2,
			delivery_events: 1,
		});
		await expect(
			db.prepare("DELETE FROM supplier_accounts WHERE id = 'account'").run(),
		).rejects.toThrow(/FOREIGN KEY constraint failed/);
		const target = await db
			.prepare("SELECT delivery_record_id FROM supplier_orders WHERE id=?")
			.bind(supplierOrder?.id)
			.first<{ delivery_record_id: string }>();
		await processDelivery(db, target?.delivery_record_id ?? "");
		const revealed = await revealStoreDelivery(db, {
			orderNumber: "ORDER-TEST-1",
			deliveryId: target?.delivery_record_id ?? "",
			email: "buyer@example.com",
		});
		expect(revealed).toMatchObject({
			usageUrl: "https://verified.example/redeem",
		});
		expect(
			revealed.content
				?.split("\nCDK：")
				.map((value, index) => (index === 0 ? value : `CDK：${value}`))
				.sort(),
		).toEqual([
			"CDK：CARD-1\n充值地址：https://verified.example/redeem",
			"CDK：CARD-2\n充值地址：https://verified.example/redeem",
		]);
		const ownedContent = [
			"gpt-plus-ph-AAAA-BBBB-CCCC-DDDD",
			"gpt-plus-ph-EEEE-FFFF-GGGG-HHHH",
		]
			.map((code) => `CDK：${code}\n充值地址：https://redeem.lsrai.shop`)
			.join("\n");
		await db
			.prepare(
				"UPDATE delivery_records SET redeem_sku='GPT_PLUS_PH',content_encrypted=? WHERE id=?",
			)
			.bind(
				await encryptDeliveryContent(ownedContent, runtime.commerceSecret),
				target?.delivery_record_id,
			)
			.run();
		expect(
			await revealStoreDelivery(db, {
				orderNumber: "ORDER-TEST-1",
				deliveryId: target?.delivery_record_id ?? "",
				email: "buyer@example.com",
			}),
		).toEqual({
			// A storefront buyer never sees the reseller host stored in the stock entry.
			content: ownedContent.replaceAll(
				"https://redeem.lsrai.shop",
				"https://redeem.laoshirenvip.com",
			),
			usageUrl: "https://redeem.laoshirenvip.com",
		});
		await db
			.prepare("UPDATE delivery_records SET redeem_sku=NULL WHERE id=?")
			.bind(target?.delivery_record_id)
			.run();
		await db
			.prepare(
				"UPDATE stock_entries SET redeem_sku='GPT_PLUS_PH' WHERE supplier_order_id=?",
			)
			.bind(supplierOrder?.id)
			.run();
		expect(
			await revealStoreDelivery(db, {
				orderNumber: "ORDER-TEST-1",
				deliveryId: target?.delivery_record_id ?? "",
				email: "buyer@example.com",
			}),
		).toEqual({
			content: ownedContent.replaceAll(
				"https://redeem.lsrai.shop",
				"https://redeem.laoshirenvip.com",
			),
		});
	});

	it.each([
		"non-json",
		"invalid-card",
		"quantity-mismatch",
	])("retains a SharedStock submission after %s without buying again", async (failure) => {
		const files = await miniflare.getR2Bucket("FILES");
		const vault = await createSupplierCredentialVault(
			"shared_stock",
			{ appId: "merchant", appKey: "test-secret" },
			runtime.commerceSecret,
		);
		await db.batch([
			db
				.prepare(`UPDATE supplier_accounts SET provider = 'shared_stock',
			 protocol_version = 'acg-sharedstock-v1', credentials_encrypted = ? WHERE id = 'account'`)
				.bind(vault),
			db.prepare(`UPDATE supplier_bindings SET provider = 'shared_stock',
			 protocol_version = 'acg-sharedstock-v1', upstream_product_id = 'PLUS',
			 upstream_sku_id = 'PLUS'`),
		]);
		await completeFreeStoreOrder(db, "order");
		const order = await db
			.prepare("SELECT id FROM supplier_orders WHERE order_id = 'order'")
			.first<{ id: string }>();
		const requests: string[] = [];
		const submittedRequestNumbers: Array<string | null> = [];
		const fetcher: typeof fetch = async (input, init) => {
			const request = new Request(input, init);
			const path = new URL(request.url).pathname;
			requests.push(path);
			if (path.endsWith("/connect"))
				return Response.json({
					code: 200,
					data: { shopName: "Supplier", balance: "100.00" },
				});
			if (path.endsWith("/inventory"))
				return Response.json({
					code: 200,
					data: { count: 10, delivery_way: 0, price: "1.00" },
				});
			if (path.endsWith("/trade")) {
				submittedRequestNumbers.push(
					new URLSearchParams(await request.text()).get("request_no"),
				);
				if (failure === "non-json")
					return new Response("<html>upstream error</html>", { status: 502 });
				return Response.json({
					code: 200,
					data: {
						tradeNo: "trade-123",
						secret:
							failure === "invalid-card" ? "X".repeat(65_000) : "ONE-CARD",
					},
				});
			}
			if (path.endsWith("/query"))
				return Response.json({
					code: 200,
					data: { secret: "CARD-1\nCARD-2", status: 1 },
				});
			throw new Error("Unexpected request");
		};
		await expect(
			processSupplierOrder(db, order?.id ?? "", { fetcher, files }),
		).rejects.toMatchObject({
			code:
				failure === "quantity-mismatch"
					? "supplier_delivery_quantity_mismatch"
					: "supplier_order_pending",
		});
		const first = await db
			.prepare(`SELECT state, selected_account_id, provider_request_no,
		 attempt_count, next_retry_at, account_locked_at, upstream_order_id, last_error_code FROM supplier_orders WHERE id = ?`)
			.bind(order?.id)
			.first();
		expect(first).toMatchObject({
			state: "uncertain",
			selected_account_id: "account",
			attempt_count: 1,
			provider_request_no: expect.stringMatching(/^[a-f0-9]{19}$/),
			account_locked_at: expect.any(Number),
			next_retry_at: expect.any(Number),
			upstream_order_id: failure === "non-json" ? null : "trade-123",
			last_error_code:
				failure === "quantity-mismatch"
					? "supplier_delivery_quantity_mismatch"
					: "invalid_supplier_response",
		});
		if (failure === "non-json") {
			await expect(
				processSupplierOrder(db, order?.id ?? "", { fetcher, files }),
			).rejects.toMatchObject({ code: "supplier_request_uncertain" });
		} else {
			await expect(
				processSupplierOrder(db, order?.id ?? "", { fetcher, files }),
			).resolves.toMatchObject({ state: "supplied" });
			expect(requests.filter((path) => path.endsWith("/query"))).toHaveLength(
				1,
			);
		}
		expect(requests.filter((path) => path.endsWith("/trade"))).toHaveLength(1);
		expect(submittedRequestNumbers).toEqual([first?.provider_request_no]);
		expect(submittedRequestNumbers[0]).toHaveLength(19);
		expect(
			await db
				.prepare(
					"SELECT state, provider_request_no, attempt_count FROM supplier_orders WHERE id = ?",
				)
				.bind(order?.id)
				.first(),
		).toMatchObject({
			state: failure === "non-json" ? "uncertain" : "supplied",
			provider_request_no: first?.provider_request_no,
			attempt_count: 1,
		});
		const exchanges = await db
			.prepare(
				"SELECT * FROM supplier_exchange_records WHERE supplier_order_id = ? ORDER BY started_at, id",
			)
			.bind(order?.id)
			.all<{ object_key: string; status: string; error_code: string | null }>();
		expect(exchanges.results).toHaveLength(failure === "non-json" ? 3 : 4);
		expect(
			JSON.stringify(
				await db
					.prepare(
						"EXPLAIN QUERY PLAN SELECT * FROM supplier_exchange_records WHERE supplier_order_id = ? ORDER BY started_at, id",
					)
					.bind(order?.id)
					.all(),
			),
		).toContain("supplier_exchange_order_idx");
		for (const exchange of exchanges.results) {
			expect(exchange.status).toBe("recorded");
			const encrypted = await (await files.get(exchange.object_key))?.text();
			expect(encrypted).toBeTruthy();
			expect(encrypted).not.toContain("CARD-");
			const evidence = JSON.parse(
				await decryptSecret(
					encrypted ?? "",
					runtime.commerceSecret,
					"supplier-diagnostic",
				),
			);
			expect(JSON.stringify(evidence)).not.toContain("test-secret");
			expect(evidence.request.body).not.toContain('"merchant"');
			if (evidence.request.url.endsWith("/trade")) {
				expect(evidence.response.httpStatus).toBe(
					failure === "non-json" ? 502 : 200,
				);
				expect(evidence.response.truncated).toBe(false);
				expect(evidence.response.body).toContain(
					failure === "non-json" ? "upstream error" : "trade-123",
				);
			}
		}
	});

	it("fails closed before HTTP if durable request logging is unavailable", async () => {
		await completeFreeStoreOrder(db, "order");
		const order = await db
			.prepare("SELECT id FROM supplier_orders WHERE order_id = 'order'")
			.first<{ id: string }>();
		const fetcher = vi.fn<typeof fetch>();
		const audit = createSupplierHttpAudit({
			db,
			files: {
				put: async () => {
					throw new Error("storage unavailable");
				},
			},
			supplierOrderId: order?.id ?? "",
			accountId: "account",
			commerceSecret: runtime.commerceSecret,
			credentialValues: [],
		});
		await expect(
			supplierFetchJson(
				fetcher,
				"https://supplier.example/trade",
				{ method: "POST", body: "{}" },
				{ validateDestination: false, audit },
			),
		).rejects.toMatchObject({ code: "supplier_diagnostics_unavailable" });
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("retains a durable marker and quarantines a post-request recording failure", async () => {
		await completeFreeStoreOrder(db, "order");
		const order = await db
			.prepare("SELECT id FROM supplier_orders WHERE order_id = 'order'")
			.first<{ id: string }>();
		const files = await miniflare.getR2Bucket("FILES");
		const put = vi
			.fn(files.put.bind(files))
			.mockImplementationOnce(files.put.bind(files))
			.mockRejectedValue(new Error("storage unavailable"));
		const fetcher = vi.fn<typeof fetch>(async () =>
			Response.json({ code: 200, data: { secret: "PRIVATE-CDK" } }),
		);
		const audit = createSupplierHttpAudit({
			db,
			files: { put },
			supplierOrderId: order?.id ?? "",
			accountId: "account",
			commerceSecret: runtime.commerceSecret,
			credentialValues: [],
		});
		await expect(
			supplierFetchJson(
				fetcher,
				"https://supplier.example/trade",
				{ method: "POST", body: "{}" },
				{ validateDestination: false, audit },
			),
		).rejects.toMatchObject({ code: "supplier_request_uncertain" });
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(
			await db
				.prepare(
					"SELECT status, error_code FROM supplier_exchange_records WHERE supplier_order_id = ?",
				)
				.bind(order?.id)
				.first(),
		).toEqual({
			status: "recording_failed",
			error_code: "diagnostics_persist_failed",
		});
	});

	it("also retains another provider's account after a malformed purchase response", async () => {
		await completeFreeStoreOrder(db, "order");
		const order = await db
			.prepare("SELECT id FROM supplier_orders WHERE order_id = 'order'")
			.first<{ id: string }>();
		let submitted = 0;
		const fetcher: typeof fetch = async (input, init) => {
			if (
				new URL(new Request(input, init).url).pathname ===
				"/api/v1/upstream/orders"
			) {
				submitted++;
				return new Response("<html>failure</html>");
			}
			return pendingSupplierFetcher(input, init);
		};
		await expect(
			processSupplierOrder(db, order?.id ?? "", { fetcher }),
		).rejects.toMatchObject({ code: "invalid_supplier_response" });
		expect(
			await db
				.prepare(
					"SELECT state, selected_account_id, last_error_code FROM supplier_orders WHERE id = ?",
				)
				.bind(order?.id)
				.first(),
		).toEqual({
			state: "uncertain",
			selected_account_id: "account",
			last_error_code: "invalid_supplier_response",
		});
		await expect(
			processSupplierOrder(db, order?.id ?? "", { fetcher }),
		).rejects.toMatchObject({ code: "supplier_order_pending" });
		expect(submitted).toBe(1);
	});

	it("removes credentials while retaining encrypted fulfillment evidence", async () => {
		await completeFreeStoreOrder(db, "order");
		const order = await db
			.prepare("SELECT id FROM supplier_orders WHERE order_id = 'order'")
			.first<{ id: string }>();
		const files = await miniflare.getR2Bucket("FILES");
		const record = await createSupplierHttpAudit({
			db,
			files,
			supplierOrderId: order?.id ?? "",
			accountId: "account",
			commerceSecret: runtime.commerceSecret,
			credentialValues: ["DO-NOT-LOG-API-KEY", "123456789012"],
		})({
			url: "https://supplier.example/query?token=QUERY-TOKEN",
			init: {
				method: "POST",
				headers: {
					Authorization: "Bearer DO-NOT-LOG-API-KEY",
					Cookie: "COOKIE-VALUE",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					api_key: "DO-NOT-LOG-API-KEY",
					password: "EXAMPLE-PASSWORD",
					quantity: 1,
				}),
			},
		});
		const body = new TextEncoder().encode(
			JSON.stringify({
				secret: "FULFILLMENT-CARD",
				merchant_id: 123456789012,
				"DO-NOT-LOG-API-KEY": "reflected-as-a-key",
				reflected: "DO-NOT-LOG-API-KEY",
				token: "REFLECTED-TOKEN",
			}),
		);
		await record({
			status: 200,
			headers: new Headers({
				"content-type": "application/json",
				"set-cookie": "NEW-COOKIE",
			}),
			body,
			bodyBytes: body.length,
			truncated: false,
			errorCode: null,
		});
		const row = await db
			.prepare(
				"SELECT object_key FROM supplier_exchange_records WHERE supplier_order_id = ?",
			)
			.bind(order?.id)
			.first<{ object_key: string }>();
		const encrypted = await (await files.get(row?.object_key ?? ""))?.text();
		const clear = await decryptSecret(
			encrypted ?? "",
			runtime.commerceSecret,
			"supplier-diagnostic",
		);
		for (const secret of [
			"DO-NOT-LOG-API-KEY",
			"QUERY-TOKEN",
			"COOKIE-VALUE",
			"NEW-COOKIE",
			"EXAMPLE-PASSWORD",
			"REFLECTED-TOKEN",
		])
			expect(clear).not.toContain(secret);
		expect(clear).toContain("FULFILLMENT-CARD");
		expect(JSON.parse(JSON.parse(clear).response.body).merchant_id).toBe(
			"[REDACTED]",
		);
		expect(encrypted).not.toContain("FULFILLMENT-CARD");
	});

	it("switches only after a definitive rejection and keeps the source fixed", async () => {
		const secondVault = await createSupplierCredentialVault(
			"dujiao_next",
			{ apiKey: "api-key-b", apiSecret: "api-secret-b" },
			runtime.commerceSecret,
		);
		await db
			.prepare(
				`INSERT INTO supplier_accounts
				 (id, provider, base_url, normalized_api_origin, protocol_version,
				  currency, currency_decimals, name, credentials_encrypted,
				  credentials_revision, credential_fingerprint, balance_minor,
				  balance_synced_at, enabled, health_status, created_at, updated_at)
				 VALUES ('account-b', 'dujiao_next', 'https://supplier.example',
				  'https://supplier.example', '1.3.1-upstream-v1', 'CNY', 2,
				  'Account B', ?, 1, 'fingerprint-b', '10000', ?, 1, 'healthy', ?, ?)`,
			)
			.bind(secondVault, Date.now(), Date.now(), Date.now())
			.run();
		await completeFreeStoreOrder(db, "order");
		const supplierOrder = await db
			.prepare("SELECT id FROM supplier_orders WHERE order_id = 'order'")
			.first<{ id: string }>();
		const submittedBy: string[] = [];
		const fetcher: typeof fetch = async (input, init) => {
			const request = new Request(input, init);
			const url = new URL(request.url);
			const apiKey = request.headers.get("Dujiao-Next-Api-Key") ?? "";
			if (url.pathname === "/api/v1/upstream/ping")
				return Response.json({
					ok: true,
					site_name: apiKey,
					balance: "100.00",
					currency: "CNY",
				});
			if (url.pathname === "/api/v1/upstream/products/1")
				return Response.json({ ok: true, product: upstreamProduct() });
			if (url.pathname === "/api/v1/upstream/categories")
				return Response.json({ ok: true, categories: [] });
			if (url.pathname === "/api/v1/upstream/orders") {
				submittedBy.push(apiKey);
				return apiKey === "api-key"
					? Response.json({
							ok: false,
							error_code: "insufficient_balance",
						})
					: Response.json({ ok: true, order_id: 199, status: "pending" });
			}
			throw new Error(`Unexpected URL ${url}`);
		};

		await expect(
			processSupplierOrder(db, supplierOrder?.id ?? "", { fetcher }),
		).rejects.toMatchObject({ code: "supplier_order_pending" });
		expect(submittedBy).toEqual(["api-key", "api-key-b"]);
		const state = await db
			.prepare(
				`SELECT selected_account_id, upstream_order_id, selection_count, state,
				 (SELECT normalized_api_origin FROM supplier_accounts
				  WHERE id = selected_account_id) AS selected_origin
				 FROM supplier_orders WHERE id = ?`,
			)
			.bind(supplierOrder?.id)
			.first();
		expect(state).toMatchObject({
			selected_account_id: "account-b",
			upstream_order_id: "199",
			selection_count: 2,
			state: "uncertain",
			selected_origin: "https://supplier.example",
		});
	});

	it("rejects duplicate or wrong-count fulfillment without storing cards", async () => {
		await completeFreeStoreOrder(db, "order");
		const supplierOrder = await db
			.prepare("SELECT id FROM supplier_orders WHERE order_id = 'order'")
			.first<{ id: string }>();
		let reconciliation = false;
		const fetcher: typeof fetch = async (input) => {
			const url = new URL(String(input));
			if (url.pathname === "/api/v1/upstream/ping")
				return Response.json({
					ok: true,
					site_name: "Supplier",
					balance: "100.00",
					currency: "CNY",
				});
			if (url.pathname === "/api/v1/upstream/products/1")
				return Response.json({ ok: true, product: upstreamProduct() });
			if (url.pathname === "/api/v1/upstream/categories")
				return Response.json({ ok: true, categories: [] });
			if (url.pathname === "/api/v1/upstream/orders")
				return Response.json({ ok: true, order_id: 299, status: "pending" });
			if (url.pathname === "/api/v1/upstream/orders/299") {
				reconciliation = true;
				return Response.json({
					order_id: 299,
					status: "completed",
					fulfillment: {
						status: "delivered",
						payload: "DUPLICATE\nDUPLICATE",
					},
				});
			}
			throw new Error(`Unexpected URL ${url}`);
		};
		await expect(
			processSupplierOrder(db, supplierOrder?.id ?? "", { fetcher }),
		).rejects.toMatchObject({ code: "supplier_order_pending" });
		await expect(
			processSupplierOrder(db, supplierOrder?.id ?? "", { fetcher }),
		).rejects.toMatchObject({ code: "supplier_delivery_quantity_mismatch" });
		expect(reconciliation).toBe(true);
		const state = await db
			.prepare(
				`SELECT state,
				 (SELECT COUNT(*) FROM stock_entries WHERE supplier_order_id = ?) AS cards
				 FROM supplier_orders WHERE id = ?`,
			)
			.bind(supplierOrder?.id, supplierOrder?.id)
			.first();
		expect(state).toMatchObject({ state: "uncertain", cards: 0 });
	});

	it("deduplicates concurrent queue consumers before upstream submission", async () => {
		await completeFreeStoreOrder(db, "order");
		const supplierOrder = await db
			.prepare("SELECT id FROM supplier_orders WHERE order_id = 'order'")
			.first<{ id: string }>();
		let submissions = 0;
		const fetcher: typeof fetch = async (input, init) => {
			const request = new Request(input, init);
			if (
				request.method === "POST" &&
				new URL(request.url).pathname === "/api/v1/upstream/orders"
			)
				submissions += 1;
			return pendingSupplierFetcher(input, init);
		};
		await Promise.allSettled([
			processSupplierOrder(db, supplierOrder?.id ?? "", { fetcher }),
			processSupplierOrder(db, supplierOrder?.id ?? "", { fetcher }),
		]);
		expect(submissions).toBe(1);
		const state = await db
			.prepare(
				`SELECT state, attempt_count, selection_count,
				 (SELECT COUNT(*) FROM supplier_orders WHERE order_id = 'order') AS orders
				 FROM supplier_orders WHERE id = ?`,
			)
			.bind(supplierOrder?.id)
			.first();
		expect(state).toMatchObject({
			state: "uncertain",
			attempt_count: 1,
			selection_count: 1,
			orders: 1,
		});
	});

	it("stores one card set under concurrent distinct fulfillment callbacks", async () => {
		await completeFreeStoreOrder(db, "order");
		const supplierOrder = await db
			.prepare("SELECT id FROM supplier_orders WHERE order_id = 'order'")
			.first<{ id: string }>();
		await expect(
			processSupplierOrder(db, supplierOrder?.id ?? "", {
				fetcher: pendingSupplierFetcher,
			}),
		).rejects.toMatchObject({ code: "supplier_order_pending" });
		const locked = await db
			.prepare("SELECT provider_request_no FROM supplier_orders WHERE id = ?")
			.bind(supplierOrder?.id)
			.first<{ provider_request_no: string }>();
		const timestamp = 1_800_000_000;
		const callback = (event: string, cards: string) => {
			const rawBody = JSON.stringify({
				event,
				order_id: 99,
				order_no: "UPSTREAM-99",
				downstream_order_no: locked?.provider_request_no,
				status: "completed",
				fulfillment: {
					type: "auto",
					status: "delivered",
					payload: cards,
				},
				timestamp,
			});
			return new Request(
				"https://shop.example/api/suppliers/dujiao-next/callback/account",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"Dujiao-Next-Api-Key": "api-key",
						"Dujiao-Next-Timestamp": String(timestamp),
						"Dujiao-Next-Signature": signDujiaoNextRequest({
							method: "POST",
							path: "/api/v1/upstream/callback",
							timestamp: String(timestamp),
							rawBody,
							apiSecret: "api-secret",
						}),
					},
					body: rawBody,
				},
			);
		};
		const responses = await Promise.all([
			handleDujiaoSupplierCallback(
				callback("order.fulfilled.primary", "PRIMARY-1\nPRIMARY-2"),
				"account",
				db,
				timestamp * 1000,
			),
			handleDujiaoSupplierCallback(
				callback("order.fulfilled.variant", "VARIANT-1\nVARIANT-2"),
				"account",
				db,
				timestamp * 1000,
			),
		]);
		for (const response of responses)
			await expect(response.json()).resolves.toMatchObject({ ok: true });
		const state = await db
			.prepare(
				`SELECT state,
				 (SELECT COUNT(*) FROM stock_entries WHERE supplier_order_id = ?) AS cards,
				 (SELECT COUNT(*) FROM outbox_events
				  WHERE idempotency_key = 'supplier-delivery-requested:' || delivery_record_id) AS events
				 FROM supplier_orders WHERE id = ?`,
			)
			.bind(supplierOrder?.id, supplierOrder?.id)
			.first<Record<string, unknown>>();
		expect(state).toMatchObject({ state: "supplied", cards: 2, events: 1 });
	});

	it("verifies and deduplicates a signed Dujiao Next fulfillment callback", async () => {
		const files = await miniflare.getR2Bucket("FILES");
		await completeFreeStoreOrder(db, "order");
		const supplierOrder = await db
			.prepare("SELECT id FROM supplier_orders WHERE order_id = 'order'")
			.first<{ id: string }>();
		await expect(
			processSupplierOrder(db, supplierOrder?.id ?? "", {
				fetcher: pendingSupplierFetcher,
			}),
		).rejects.toMatchObject({ code: "supplier_order_pending" });
		const locked = await db
			.prepare("SELECT provider_request_no FROM supplier_orders WHERE id = ?")
			.bind(supplierOrder?.id)
			.first<{ provider_request_no: string }>();
		const timestamp = 1_800_000_000;
		const payload = {
			event: "order.fulfilled",
			order_id: 99,
			order_no: "UPSTREAM-99",
			downstream_order_no: locked?.provider_request_no,
			status: "completed",
			fulfillment: {
				type: "auto",
				status: "delivered",
				payload: "CALLBACK-1\nCALLBACK-2",
			},
			timestamp,
		};
		const rawBody = JSON.stringify(payload);
		const signature = signDujiaoNextRequest({
			method: "POST",
			path: "/api/v1/upstream/callback",
			timestamp: String(timestamp),
			rawBody,
			apiSecret: "api-secret",
		});
		const request = () =>
			new Request(
				"https://shop.example/api/suppliers/dujiao-next/callback/account",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"Dujiao-Next-Api-Key": "api-key",
						"Dujiao-Next-Timestamp": String(timestamp),
						"Dujiao-Next-Signature": signature,
					},
					body: rawBody,
				},
			);
		const first = await handleDujiaoSupplierCallback(
			request(),
			"account",
			db,
			timestamp * 1000,
			files,
		);
		const duplicate = await handleDujiaoSupplierCallback(
			request(),
			"account",
			db,
			timestamp * 1000,
			files,
		);
		await expect(first.json()).resolves.toMatchObject({ ok: true });
		await expect(duplicate.json()).resolves.toMatchObject({ ok: true });
		const invalidSignature = await handleDujiaoSupplierCallback(
			new Request(
				"https://shop.example/api/suppliers/dujiao-next/callback/account",
				{
					method: "POST",
					headers: {
						"Dujiao-Next-Api-Key": "api-key",
						"Dujiao-Next-Timestamp": String(timestamp),
						"Dujiao-Next-Signature": "0".repeat(64),
					},
					body: rawBody,
				},
			),
			"account",
			db,
			timestamp * 1000,
			files,
		);
		await expect(invalidSignature.json()).resolves.toEqual({
			ok: false,
			message: "authentication_failed",
		});
		// The forged callback was budgeted by source, not against the account.
		expect(
			await db
				.prepare(
					"SELECT bucket_key, SUM(count) AS used FROM rate_limit_counters WHERE bucket_key LIKE 'supplier:callback%' GROUP BY bucket_key ORDER BY bucket_key",
				)
				.all(),
		).toMatchObject({
			results: [
				{ bucket_key: "supplier:callback-failure:ip:unknown", used: 1 },
				{ bucket_key: "supplier:callback:account", used: 2 },
			],
		});
		const latePayload = { ...payload, event: "order.fulfilled.late" };
		const lateRawBody = JSON.stringify(latePayload);
		const lateSignature = signDujiaoNextRequest({
			method: "POST",
			path: "/api/v1/upstream/callback",
			timestamp: String(timestamp),
			rawBody: lateRawBody,
			apiSecret: "api-secret",
		});
		const late = await handleDujiaoSupplierCallback(
			new Request(
				"https://shop.example/api/suppliers/dujiao-next/callback/account",
				{
					method: "POST",
					headers: {
						"Dujiao-Next-Api-Key": "api-key",
						"Dujiao-Next-Timestamp": String(timestamp),
						"Dujiao-Next-Signature": lateSignature,
					},
					body: lateRawBody,
				},
			),
			"account",
			db,
			timestamp * 1000,
			files,
		);
		await expect(late.json()).resolves.toMatchObject({ ok: true });
		const state = await db
			.prepare(
				`SELECT so.state,
				        (SELECT COUNT(*) FROM stock_entries se
				         WHERE se.supplier_order_id = so.id) AS cards,
				        (SELECT COUNT(*) FROM replay_receipts rr
				         WHERE rr.namespace = 'supplier_callback') AS callbacks
				 FROM supplier_orders so WHERE so.id = ?`,
			)
			.bind(supplierOrder?.id)
			.first();
		expect(state).toMatchObject({
			state: "supplied",
			cards: 2,
			callbacks: 2,
		});
		const evidenceRows = await db
			.prepare(
				"SELECT object_key FROM supplier_exchange_records WHERE supplier_order_id = ? AND direction = 'callback'",
			)
			.bind(supplierOrder?.id)
			.all<{ object_key: string }>();
		expect(evidenceRows.results).toHaveLength(3);
		const encrypted = await (
			await files.get(evidenceRows.results[0]?.object_key ?? "")
		)?.text();
		const artifact = JSON.parse(
			await decryptSecret(
				encrypted ?? "",
				runtime.commerceSecret,
				"supplier-diagnostic",
			),
		);
		expect(JSON.stringify(artifact)).not.toContain("api-secret");
		expect(JSON.stringify(artifact.request.headers)).not.toContain(
			"Dujiao-Next",
		);
		expect(artifact.request.body).toContain("CALLBACK-1");
		expect(encrypted).not.toContain("CALLBACK-1");
	});

	it("rejects an oversized chunked supplier callback with 413", async () => {
		const request = new Request(
			"https://shop.example/api/suppliers/dujiao-next/callback/account",
			{
				method: "POST",
				body: new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new Uint8Array(700_000));
						controller.enqueue(new Uint8Array(700_000));
						controller.close();
					},
				}),
				duplex: "half",
			} as RequestInit & { duplex: "half" },
		);
		const response = await handleDujiaoSupplierCallback(
			request,
			"account",
			db,
			1_800_000_000_000,
		);
		expect(response.status).toBe(413);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			message: "body_too_large",
		});
	});
});

async function seed(
	db: D1Database,
	runtime: ReturnType<typeof createInitialRuntimeConfig>,
) {
	const now = 1_800_000_000_000;
	const encrypted = await createSupplierCredentialVault(
		"dujiao_next",
		{ apiKey: "api-key", apiSecret: "api-secret" },
		runtime.commerceSecret,
	);
	const settings = runtimeConfigEntries(runtime).map((entry) =>
		db
			.prepare(
				`INSERT INTO system_settings
				 (key, value, is_secret, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?)`,
			)
			.bind(entry.key, JSON.stringify(entry.value), entry.isSecret, now, now),
	);
	await db.batch([
		...settings,
		db
			.prepare(
				`INSERT INTO products
			 (id, name, product_type, status, created_at, updated_at)
			 VALUES ('product', 'Product', 'stock', 'active', ?, ?)`,
			)
			.bind(now, now),
		db
			.prepare(
				`INSERT INTO product_sellable_items
			 (id, product_id, name, fulfillment_source, supplier_status,
			  currency, currency_decimals, price_minor, created_at, updated_at)
			 VALUES ('item', 'product', 'SKU', 'supplier', 'available',
			  'USD', 2, '0', ?, ?)`,
			)
			.bind(now, now),
		db
			.prepare(
				`INSERT INTO supplier_accounts
			 (id, provider, base_url, normalized_api_origin, protocol_version,
			  currency, currency_decimals, name, credentials_encrypted,
			  credentials_revision, credential_fingerprint, balance_minor,
			  balance_synced_at, enabled, health_status, created_at, updated_at)
			 VALUES ('account', 'dujiao_next', 'https://supplier.example',
			  'https://supplier.example', '1.3.1-upstream-v1', 'CNY', 2,
			  'Account', ?, 1, 'fingerprint', '10000', ?, 1, 'healthy', ?, ?)`,
			)
			.bind(encrypted, now, now, now),
		db
			.prepare(
				`INSERT INTO supplier_bindings
			 (id, sellable_item_id, provider, normalized_api_origin,
			  protocol_version, upstream_product_id, upstream_sku_id,
			  upstream_product_name, upstream_sku_name, reference_cost_minor,
			  max_cost_minor, stock_quantity, remote_status, last_synced_at,
			  enabled, created_at, updated_at)
			 VALUES ('binding', 'item', 'dujiao_next', 'https://supplier.example',
			  '1.3.1-upstream-v1', '1', '2', 'Product', 'SKU', '100', '150',
			  10, 'active', ?, 1, ?, ?)`,
			)
			.bind(now, now, now),
		db
			.prepare(
				`INSERT INTO shop_orders
			 (id, order_number, status, currency, currency_decimals,
			  subtotal_minor, discount_minor, total_minor, paid_minor,
			  expires_at, created_at, updated_at)
			 VALUES ('order', 'ORDER-1', 'pending_payment', 'USD', 2,
			  '0', '0', '0', '0', ?, ?, ?)`,
			)
			.bind(now + 60_000, now, now),
		db
			.prepare(
				`INSERT INTO shop_order_items
			 (id, order_id, product_id, sellable_item_id, product_name,
			  delivery_component_id, delivery_component_type,
			  delivery_component_version, sellable_item_name, quantity,
			  unit_price_minor, discount_minor, subtotal_minor, created_at, updated_at)
			 VALUES ('order-item', 'order', 'product', 'item', 'Product',
			  'item', 'stock', 1, 'SKU', 2, '0', '0', '0', ?, ?)`,
			)
			.bind(now, now),
	]);
}

function upstreamProduct() {
	return {
		id: 1,
		title: { "zh-CN": "商品" },
		description: {},
		images: [],
		tags: [],
		currency: "CNY",
		is_active: true,
		skus: [
			{
				id: 2,
				sku_code: "SKU",
				spec_values: {},
				price_amount: "1.00",
				stock_quantity: 10,
				is_active: true,
			},
		],
	};
}

const pendingSupplierFetcher: typeof fetch = async (input) => {
	const url = new URL(
		typeof input === "string"
			? input
			: input instanceof URL
				? input
				: input.url,
	);
	if (url.pathname === "/api/v1/upstream/ping")
		return Response.json({
			ok: true,
			site_name: "Supplier",
			balance: "100.00",
			currency: "CNY",
		});
	if (url.pathname === "/api/v1/upstream/products/1")
		return Response.json({ ok: true, product: upstreamProduct() });
	if (url.pathname === "/api/v1/upstream/categories")
		return Response.json({ ok: true, categories: [] });
	if (url.pathname === "/api/v1/upstream/orders")
		return Response.json({ ok: true, order_id: 99, status: "pending" });
	throw new Error(`Unexpected URL ${url}`);
};
