import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#/lib/crypto", () => ({
	constantTimeEqual: (left: string, right: string) => left === right,
	sha256Hex: async (value: string) => `digest:${value}`,
}));

vi.mock("#/features/catalog/server/inventory-secrets", async (original) => ({
	...(await original<
		typeof import("#/features/catalog/server/inventory-secrets")
	>()),
	fingerprintInventorySecret: async (value: string) => `fingerprint:${value}`,
}));

vi.mock("#/lib/secrets", () => ({
	encryptSecret: async (value: string) => JSON.stringify({ value }),
	decryptSecret: async (value: string) =>
		(JSON.parse(value) as { value: string }).value,
}));

vi.mock("#/features/fulfillment/secrets", () => ({
	encryptDeliveryContent: async (value: string) => JSON.stringify({ value }),
	decryptDeliveryContent: async (value: string) =>
		(JSON.parse(value) as { value: string }).value,
}));

import { handleDeliverySwapRequest } from "#/features/catalog/server/delivery-swap";
import { applyMigrations } from "./migrations";

const token = "test-restock-token-that-is-long-enough";
const product = "00000000-0000-4000-8000-000000000001";
const renew = "00000000-0000-4000-8000-0000000000a1";
const fresh = "00000000-0000-4000-8000-0000000000b1";
const orderNumber = "GM22222222222222222222222222222222";
const oldCode = "gpt-20x-renew-ph-AAAA-BBBB-CCCC-DDDD";
const newCode = "gpt-20x-ph-EEEE-FFFF-GGGG-HHHH";
const content = (code: string) =>
	JSON.stringify({
		value: `CDK：${code}\n充值地址：https://redeem.lsrai.shop`,
	});

describe("delivery swap API", () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeEach(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: crypto.randomUUID() },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await seed(db);
	});

	afterEach(async () => miniflare.dispose());

	it("moves the order to the sibling item and delivers its oldest owned CDK", async () => {
		const response = await swap(payload());
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			ok: true,
			idempotent: false,
			orderNumber,
			newCode,
			supplierOrder: null,
		});
		const stock = await db
			.prepare(
				"SELECT id,status,order_item_id,note FROM stock_entries ORDER BY id",
			)
			.all<{
				id: string;
				status: string;
				order_item_id: string | null;
				note: string;
			}>();
		expect(stock.results).toMatchObject([
			{ id: "new-1", status: "delivered", order_item_id: "item" },
			{ id: "new-2", status: "available", order_item_id: null },
			{ id: "old", status: "disabled", order_item_id: null },
		]);
		expect(stock.results[2]?.note).toContain(`swapped_out=${orderNumber}`);
		expect(
			await db
				.prepare(
					`SELECT i.sellable_item_id,i.sellable_item_name,i.delivery_component_id,
					 d.content_encrypted,d.redeem_sku FROM shop_order_items i
					 JOIN delivery_records d ON d.order_item_id=i.id`,
				)
				.first(),
		).toEqual({
			sellable_item_id: fresh,
			sellable_item_name: "Pro 200 新开",
			delivery_component_id: fresh,
			content_encrypted: content(newCode),
			redeem_sku: "GPT_20X_PH",
		});

		const replay = await swap(payload());
		expect(await replay.json()).toMatchObject({
			ok: true,
			idempotent: true,
			newCode,
		});
		expect(
			await db
				.prepare(
					"SELECT COUNT(*) AS n FROM stock_entries WHERE status='delivered'",
				)
				.first(),
		).toEqual({ n: 1 });
	});

	it("refuses when any channel price differs", async () => {
		await db
			.prepare(
				"UPDATE sellable_item_channel_prices SET price_minor='113900' WHERE sellable_item_id=?",
			)
			.bind(fresh)
			.run();
		const response = await swap(payload());
		expect(await response.json()).toEqual({
			ok: false,
			error: "swap_price_mismatch",
		});
		expect(
			await db
				.prepare("SELECT status FROM stock_entries WHERE id='old'")
				.first(),
		).toEqual({ status: "delivered" });
	});

	it("refuses a CDK that is not the one delivered on the order", async () => {
		const response = await swap({
			...payload(),
			oldSecret: "gpt-20x-renew-ph-ZZZZ-ZZZZ-ZZZZ-ZZZZ",
		});
		expect(await response.json()).toEqual({
			ok: false,
			error: "swap_old_secret_mismatch",
		});
	});

	it("never hands out non-owned upstream stock", async () => {
		await db.exec(
			"UPDATE stock_entries SET note='source=aisou' WHERE id IN ('new-1','new-2')",
		);
		const response = await swap(payload());
		expect(await response.json()).toEqual({
			ok: false,
			error: "swap_target_out_of_stock",
		});
	});

	it("rejects missing credentials", async () => {
		const response = await handleDeliverySwapRequest(
			new Request("https://shop.example/api/ops/restock/swap", {
				method: "POST",
				body: JSON.stringify(payload()),
			}),
			{ DB: db, RESTOCK_API_TOKEN: token },
		);
		expect(response.status).toBe(401);
	});

	function swap(body: unknown) {
		return handleDeliverySwapRequest(
			new Request("https://shop.example/api/ops/restock/swap", {
				method: "POST",
				body: JSON.stringify(body),
				headers: {
					Authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
			}),
			{ DB: db, RESTOCK_API_TOKEN: token },
		);
	}
});

function payload() {
	return {
		requestRef: "SWAP-TEST-000000001",
		orderNumber,
		fromComponentId: renew,
		toComponentId: fresh,
		oldSecret: oldCode,
	};
}

async function seed(db: D1Database) {
	const item = (id: string, name: string) =>
		db
			.prepare(
				`INSERT INTO product_sellable_items
				 (id,product_id,name,fulfillment_source,currency,currency_decimals,
				  price_minor,enabled,created_at,updated_at)
				 VALUES (?,?,?,'local','CNY',2,'109800',1,1,1)`,
			)
			.bind(id, product, name);
	const stock = (
		id: string,
		itemId: string,
		code: string,
		status: string,
		created: number,
		redeemSku: string | null,
	) =>
		db
			.prepare(
				`INSERT INTO stock_entries
				 (id,sellable_item_id,content_encrypted,key_version,content_fingerprint,
				  content_mask,status,order_item_id,note,redeem_sku,created_at,updated_at)
				 VALUES (?,?,?,1,?,?,?,?,'source=redeem-warehouse; sku=X',?,?,?)`,
			)
			.bind(
				id,
				itemId,
				JSON.stringify({ value: JSON.parse(content(code)).value }),
				`fingerprint:${code}`,
				`••••${code.slice(-4)}`,
				status,
				status === "delivered" ? "item" : null,
				redeemSku,
				created,
				created,
			);
	await db.batch([
		db
			.prepare(
				`INSERT INTO system_settings (key,value,is_secret,created_at,updated_at)
				 VALUES ('runtime.data_encryption_secret',?,1,1,1)`,
			)
			.bind(JSON.stringify("0123456789abcdef0123456789abcdef")),
		db.prepare(
			`INSERT INTO products (id,name,product_type,status,created_at,updated_at)
			 VALUES ('${product}','ChatGPT','stock','active',1,1)`,
		),
		db.prepare(
			`INSERT INTO payment_channels (id,name,provider,currency,created_at,updated_at)
			 VALUES ('usdt','USDT','manual','CNY',1,1)`,
		),
		item(renew, "Pro 200 续费"),
		item(fresh, "Pro 200 新开"),
		...[renew, fresh].map((id) =>
			db
				.prepare(
					`INSERT INTO sellable_item_channel_prices
					 (id,sellable_item_id,channel_id,price_minor,enabled,created_at,updated_at)
					 VALUES (?,?,'usdt','109800',1,1,1)`,
				)
				.bind(crypto.randomUUID(), id),
		),
		db.prepare(
			`INSERT INTO shop_orders
			 (id,order_number,status,currency,currency_decimals,subtotal_minor,
			  discount_minor,total_minor,paid_minor,expires_at,paid_at,completed_at,
			  created_at,updated_at)
			 VALUES ('order','${orderNumber}','completed','CNY',2,'109800','0',
			  '109800','109800',999999,2,3,1,3)`,
		),
		db
			.prepare(
				`INSERT INTO shop_order_items
				 (id,order_id,product_id,sellable_item_id,product_name,
				  delivery_component_id,delivery_component_type,
				  delivery_component_version,sellable_item_name,quantity,
				  unit_price_minor,discount_minor,subtotal_minor,created_at,updated_at)
				 VALUES ('item','order',?,?,'ChatGPT',?,'stock',1,'Pro 200 续费',1,
				  '109800','0','109800',1,1)`,
			)
			.bind(product, renew, renew),
		db
			.prepare(
				`INSERT INTO delivery_records
				 (id,order_item_id,delivery_type,status,content_encrypted,
				  content_key_version,attempt_count,delivered_at,created_at,updated_at)
				 VALUES ('delivery','item','stock','delivered',?,1,1,3,1,3)`,
			)
			.bind(content(oldCode)),
		stock("old", renew, oldCode, "delivered", 5, null),
		stock("new-1", fresh, newCode, "available", 1, "GPT_20X_PH"),
		stock(
			"new-2",
			fresh,
			"gpt-20x-ph-JJJJ-KKKK-LLLL-MMMM",
			"available",
			2,
			"GPT_20X_PH",
		),
	]);
}
