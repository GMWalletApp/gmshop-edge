import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processDelivery } from "#/features/fulfillment/server/process";
import { refreshSaleCapacity } from "#/features/redeem-warehouse/server/sale-capacity";
import { expireStoreOrders } from "#/features/shop-orders/server/expiration";
import { transitionShopOrder } from "#/features/shop-orders/server/transition";
import { completeWalletStoreOrder } from "#/features/shop-payments/server/service";
import { createMultiStoreOrder } from "#/features/storefront/server/multi-order";
import { storefrontStockExpression } from "#/features/storefront/server/stock-availability";
import { listSupplierCatalog } from "#/features/supplier-api/server/catalog";
import { createSupplierApiOrder } from "#/features/supplier-api/server/orders";
import { sha256Hex } from "#/lib/crypto";
import { decryptSecret, encryptSecret } from "#/lib/secrets";
import { applyMigrations } from "./migrations";

const item = "33333333-3333-4333-8333-333333333333",
	product = "22222222-2222-4222-8222-222222222222",
	user = "11111111-1111-4111-8111-111111111111";
const secret = "test-commerce-secret";
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
let testSku = "CLAUDE_PRO_IOS";
function code(i: number) {
	return `${testSku.toLowerCase().replaceAll("_", "-")}-AAAA-BBBB-CCCC-AA${alphabet[Math.floor(i / 32)]}${alphabet[i % 32]}`;
}

describe.each([
	"CLAUDE_PRO_IOS",
	"GPT_20X_PH",
	"GPT_20X_IOS",
	"GPT_5X_IOS",
])("%s checkout reserves owned codes independently of upstream capacity", {
	timeout: 30_000,
}, (sku) => {
	let mf: Miniflare, db: D1Database;
	let keys: number;
	let generated: number;
	let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
	beforeEach(async () => {
		testSku = sku;
		keys = 5;
		generated = 100;
		mf = new Miniflare({
			modules: true,
			script: "export default {fetch(){return new Response('ok')}}",
			d1Databases: { DB: crypto.randomUUID() },
		});
		db = await mf.getD1Database("DB");
		await applyMigrations(db);
		const token = await encryptSecret(
			"test-warehouse-token",
			secret,
			"redeem-warehouse-token",
		);
		await db.batch([
			db
				.prepare(
					"INSERT INTO products (id,name,product_type,status,created_at,updated_at) VALUES (?,'Claude','stock','active',1,1)",
				)
				.bind(product),
			db
				.prepare(
					"INSERT INTO product_sellable_items (id,product_id,name,currency,currency_decimals,price_minor,fulfillment_source,maximum_quantity,created_at,updated_at) VALUES (?,?,'Pro','CNY',2,'100','local',100,1,1)",
				)
				.bind(item, product),
			db
				.prepare(
					"INSERT INTO users (id,name,email,balance_minor,created_at,updated_at) VALUES (?,'Buyer','buyer@example.com','10000',1,1)",
				)
				.bind(user),
			db
				.prepare(
					"INSERT INTO supplier_api_keys (id,user_id,name,key_id,secret_encrypted,created_at,updated_at) VALUES ('key-row',?,'Test','test-key','not-used',1,1)",
				)
				.bind(user),
			db
				.prepare(
					"INSERT INTO supplier_export_listings (id,sellable_item_id,enabled,price_minor,currency,currency_decimals,created_at,updated_at) VALUES ('export-test',?,1,'100','CNY',2,1,1)",
				)
				.bind(item),
			...[
				["runtime.data_encryption_secret", secret],
				["integration.redeem_warehouse_token", token],
				["commerce.default_currency", "CNY"],
			].map(([key, value]) =>
				db
					.prepare(
						"INSERT INTO system_settings (key,value,is_secret,created_at,updated_at) VALUES (?,?,1,1,1)",
					)
					.bind(key, JSON.stringify(value)),
			),
			db
				.prepare(
					"INSERT INTO system_settings (key,value,is_secret,created_at,updated_at) VALUES ('integration.supply_console_map',?,0,1,1)",
				)
				.bind(JSON.stringify({ [item]: sku })),
		]);
		const entries = await Promise.all(
			Array.from({ length: 100 }, async (_, i) => ({
				id: `stock-${i}`,
				mask: code(i).slice(-4),
				cipher: await encryptSecret(
					`CDK：${code(i)}\n充值地址：https://redeem.lsrai.shop`,
					secret,
					"stock-entry",
				),
			})),
		);
		await db.batch(
			entries.map((e) =>
				db
					.prepare(
						"INSERT INTO stock_entries (id,sellable_item_id,content_encrypted,key_version,content_fingerprint,content_mask,status,created_at,updated_at,redeem_sku) VALUES (?,?,?,1,?,?,'available',1,1,?)",
					)
					.bind(e.id, item, e.cipher, e.id, e.mask, sku),
			),
		);
		fetcher = vi.fn<typeof fetch>(async (input, init) => {
			const url = String(input);
			const body = JSON.parse(String(init?.body ?? "{}"));
			if (url.endsWith("sale-capacity")) {
				const owed = body.code_hashes.length;
				return Response.json({
					success: true,
					data: {
						available: keys,
						outstanding: owed,
						sellable: Math.max(0, keys - owed),
					},
				});
			}
			if (url.endsWith("codes/batch"))
				return Response.json({
					success: true,
					data: {
						sku,
						count: body.count,
						codes: Array.from({ length: body.count }, () => code(generated++)),
					},
				});
			throw new Error("Unexpected external call");
		});
		vi.stubGlobal("fetch", fetcher);
	});
	afterEach(async () => {
		vi.unstubAllGlobals();
		await mf.dispose();
	});
	function checkout(quantity: number, key: string = crypto.randomUUID()) {
		return createMultiStoreOrder(
			db,
			{
				items: [{ sellableItemId: item, quantity, inputValues: {} }],
				email: "buyer@example.com",
				idempotencyKey: key,
				customerNote: "",
			},
			{ userId: user },
		);
	}
	async function stock() {
		return (
			await db
				.prepare(
					`SELECT ${storefrontStockExpression("p", "i")} AS count FROM product_sellable_items i JOIN products p ON p.id=i.product_id WHERE i.id=?`,
				)
				.bind(item)
				.first<{ count: number }>()
		)?.count;
	}
	it("the worked example leaves one after selling two plus two, independent of 100 preissued codes", async () => {
		await checkout(2);
		await checkout(2);
		expect(await stock()).toBe(96);
		const catalog = await listSupplierCatalog(db, { page: 1, pageSize: 10 });
		expect(catalog.items[0]?.skus[0]?.stock_quantity).toBe(96);
	});
	it("50 owned codes remain sellable with only 2 keys and 27 unpurchased supplier entries", async () => {
		keys = 2;
		await db
			.prepare(
				"DELETE FROM stock_entries WHERE CAST(substr(id,7) AS INTEGER)>=50",
			)
			.run();
		await db
			.prepare(
				"INSERT INTO system_settings(key,value,is_secret,created_at,updated_at) VALUES (?, 'true',0,1,1)",
			)
			.bind(`fulfillment.supplier_fallback.${item}`)
			.run();
		await db
			.prepare(
				`INSERT INTO supplier_bindings(id,sellable_item_id,provider,normalized_api_origin,protocol_version,upstream_product_id,upstream_sku_id,upstream_product_name,upstream_sku_name,reference_cost_minor,max_cost_minor,stock_quantity,remote_status,last_synced_at,enabled) VALUES ('supplier',?,'shared_stock','https://supplier.example','acg-sharedstock-v1','p','s','Product','SKU','100','100',27,'active',?,1)`,
			)
			.bind(item, Date.now())
			.run();
		expect(await stock()).toBe(50);
		const catalogue = await listSupplierCatalog(db, { page: 1, pageSize: 10 });
		expect(catalogue.items[0]?.skus[0]?.stock_quantity).toBe(50);
		await checkout(2);
		await checkout(1);
		expect(await stock()).toBe(47);
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("payment and replay do not reserve a second set of codes or decrement again", async () => {
		const first = await checkout(2, "same-order-key");
		await completeWalletStoreOrder(db, { orderId: first.id, userId: user });
		await completeWalletStoreOrder(db, { orderId: first.id, userId: user });
		expect((await checkout(2, "same-order-key")).duplicate).toBe(true);
		expect(await stock()).toBe(98);
		expect(
			(
				await db
					.prepare(
						"SELECT COUNT(*) AS n FROM stock_entries WHERE status='reserved'",
					)
					.first<{ n: number }>()
			)?.n,
		).toBe(2);
	});
	it("concurrent checkouts cannot oversell a shared pool", async () => {
		keys = 0;
		await db
			.prepare(
				"DELETE FROM stock_entries WHERE CAST(substr(id,7) AS INTEGER)>=3",
			)
			.run();
		const results = await Promise.allSettled([checkout(2), checkout(2)]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(
			(
				await db
					.prepare("SELECT COUNT(*) AS n FROM shop_orders")
					.first<{ n: number }>()
			)?.n,
		).toBe(1);
		expect(
			(
				await db
					.prepare(
						"SELECT COUNT(*) AS n FROM stock_entries WHERE status='reserved'",
					)
					.first<{ n: number }>()
			)?.n,
		).toBe(2);
	});
	it("double-encoded legacy mappings preserve the atomic owned-code guard", async () => {
		await db
			.prepare(
				"UPDATE system_settings SET value=? WHERE key='integration.supply_console_map'",
			)
			.bind(JSON.stringify(JSON.stringify({ [item]: sku })))
			.run();
		await db.prepare("DELETE FROM stock_entries WHERE id!='stock-0'").run();
		const identity = {
			userId: user,
			keyId: "test-key",
			keyRowId: "key-row",
			allowedCallbackOrigin: null,
		};
		const results = await Promise.allSettled([
			createSupplierApiOrder(db, identity, {
				skuId: item,
				quantity: 1,
				downstreamOrderNo: "concurrent-one",
			}),
			createSupplierApiOrder(db, identity, {
				skuId: item,
				quantity: 1,
				downstreamOrderNo: "concurrent-two",
			}),
		]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(
			await db.prepare("SELECT COUNT(*) AS n FROM supplier_api_orders").first(),
		).toMatchObject({ n: 1 });
		expect(
			await db
				.prepare("SELECT balance_minor FROM users WHERE id=?")
				.bind(user)
				.first(),
		).toMatchObject({ balance_minor: "9900" });
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("never creates more codes as a checkout side effect", async () => {
		await db.prepare("DELETE FROM stock_entries WHERE id!='stock-0'").run();
		await expect(checkout(3)).rejects.toMatchObject({
			code: "inventory_unavailable",
		});
		expect(generated).toBe(100);
		expect(await stock()).toBe(1);
	});
	it("expired and cancelled unpaid orders release once, then read capacity afresh", async () => {
		const first = await checkout(2);
		await expireStoreOrders(db, first.expiresAt + 1);
		await expireStoreOrders(db, first.expiresAt + 1);
		await refreshSaleCapacity(db, item);
		expect(await stock()).toBe(100);
		const next = await checkout(2);
		await transitionShopOrder(db, {
			id: next.id,
			version: 1,
			toStatus: "cancelled",
			note: null,
			actorType: "customer",
			actorUserId: null,
		});
		await refreshSaleCapacity(db, item);
		expect(await stock()).toBe(100);
	});
	it("the agent API shares owned codes with the main storefront and fails before charging", async () => {
		keys = 0;
		await db
			.prepare(
				"DELETE FROM stock_entries WHERE CAST(substr(id,7) AS INTEGER)>=5",
			)
			.run();
		await checkout(4);
		const identity = {
			userId: user,
			keyId: "test-key",
			keyRowId: "key-row",
			allowedCallbackOrigin: null,
		};
		await expect(
			createSupplierApiOrder(db, identity, {
				skuId: item,
				quantity: 2,
				downstreamOrderNo: "agent-too-many",
			}),
		).rejects.toMatchObject({ code: "inventory_unavailable" });
		const sold = await createSupplierApiOrder(db, identity, {
			skuId: item,
			quantity: 1,
			downstreamOrderNo: "agent-last-one",
		});
		expect(sold.ok).toBe(true);
		await createSupplierApiOrder(db, identity, {
			skuId: item,
			quantity: 1,
			downstreamOrderNo: "agent-last-one",
		});
		expect(
			(
				await db
					.prepare("SELECT balance_minor FROM users WHERE id=?")
					.bind(user)
					.first<{ balance_minor: string }>()
			)?.balance_minor,
		).toBe("9900");
		expect(await stock()).toBe(0);
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("keeps paid-but-unallocated legacy orders in sale obligations", async () => {
		const first = await checkout(2);
		await db
			.prepare(
				"UPDATE stock_entries SET status='available',order_item_id=NULL,reserved_at=NULL WHERE order_item_id IN (SELECT id FROM shop_order_items WHERE order_id=?)",
			)
			.bind(first.id)
			.run();
		await db
			.prepare(
				"UPDATE shop_orders SET status='paid',paid_minor=total_minor WHERE id=?",
			)
			.bind(first.id)
			.run();
		const capacity = await refreshSaleCapacity(db, item);
		expect(capacity).toMatchObject({
			available: 5,
			outstanding: 2,
			sellable: 3,
		});
		expect(await stock()).toBe(100);
	});

	it("zero cached capacity and an unavailable warehouse do not block checkout or payment", async () => {
		keys = 0;
		await refreshSaleCapacity(db, item);
		fetcher.mockReset().mockRejectedValue(new Error("offline"));
		const first = await checkout(1);
		await completeWalletStoreOrder(db, { orderId: first.id, userId: user });
		expect(await stock()).toBe(99);
		expect(fetcher).not.toHaveBeenCalled();
		const delivery = await db
			.prepare(
				"SELECT d.id,d.status FROM delivery_records d JOIN shop_order_items i ON i.id=d.order_item_id WHERE i.order_id=?",
			)
			.bind(first.id)
			.first();
		expect(delivery).toMatchObject({ status: "pending" });
		await processDelivery(db, String(delivery?.id));
		await processDelivery(db, String(delivery?.id));
		const delivered = await db
			.prepare(
				"SELECT status,content_encrypted FROM delivery_records WHERE id=?",
			)
			.bind(delivery?.id)
			.first<{ status: string; content_encrypted: string }>();
		expect(delivered?.status).toBe("delivered");
		expect(
			await decryptSecret(
				delivered?.content_encrypted ?? "",
				secret,
				"delivery-content",
			),
		).toContain(code(0));
		expect(
			await db
				.prepare(
					"SELECT cost_source FROM stock_entries WHERE order_item_id IN (SELECT id FROM shop_order_items WHERE order_id=?)",
				)
				.bind(first.id)
				.first(),
		).toEqual({ cost_source: "warehouse_unreachable" });
		// The only outbound call is the best-effort sale notice; an offline warehouse never blocks delivery.
		expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
			"https://redeem.laoshirenvip.com/api/internal/faka/sold",
		]);
		expect(
			JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).code_hashes,
		).toEqual([await sha256Hex(code(0).toLowerCase())]);
	});

	it("records the warehouse's real upstream cost on the delivered code", async () => {
		const first = await checkout(1);
		await completeWalletStoreOrder(db, { orderId: first.id, userId: user });
		const delivery = await db
			.prepare(
				"SELECT d.id FROM delivery_records d JOIN shop_order_items i ON i.id=d.order_item_id WHERE i.order_id=?",
			)
			.bind(first.id)
			.first<{ id: string }>();
		const hash = await sha256Hex(code(0).toLowerCase());
		fetcher.mockReset().mockImplementation(async (input) => {
			if (String(input).endsWith("/api/internal/faka/sold"))
				return Response.json({
					success: true,
					data: {
						results: [
							{
								code_hash: hash,
								source: "faka",
								costMinor: "12200",
								tradeNo: "503426098423060557",
							},
						],
					},
				});
			throw new Error("Unexpected external call");
		});
		await processDelivery(db, String(delivery?.id));
		expect(
			await db
				.prepare(
					"SELECT unit_cost_minor, cost_source, cost_note FROM stock_entries WHERE order_item_id IN (SELECT id FROM shop_order_items WHERE order_id=?)",
				)
				.bind(first.id)
				.first(),
		).toEqual({
			unit_cost_minor: "12200",
			cost_source: "warehouse_bought",
			cost_note: "86订单 503426098423060557",
		});
	});

	it("legacy pending orders without a code hold allocate owned stock without upstream access", async () => {
		const first = await checkout(1);
		await db
			.prepare(
				"UPDATE stock_entries SET status='available',order_item_id=NULL,reserved_at=NULL WHERE order_item_id IN (SELECT id FROM shop_order_items WHERE order_id=?)",
			)
			.bind(first.id)
			.run();
		keys = 0;
		await refreshSaleCapacity(db, item);
		fetcher.mockReset().mockRejectedValue(new Error("offline"));
		await completeWalletStoreOrder(db, { orderId: first.id, userId: user });
		expect(await stock()).toBe(99);
		expect(fetcher).not.toHaveBeenCalled();
	});
});
