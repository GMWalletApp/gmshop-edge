import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentAccessProducts } from "#/features/agent-access/products";
import {
	crossSellProductPath,
	crossSellSettingKey,
	loadOrderGrowth,
	parseCrossSellSetting,
	resolveItemLinkPath,
} from "#/features/storefront/server/order-growth";
import { applyMigrations } from "./migrations";

const signedIn = { signedIn: true };

describe("cross-sell setting parsing", () => {
	it("accepts a JSON object or its stored JSON text, de-duplicates and keeps three", () => {
		const mapping = parseCrossSellSetting(
			JSON.stringify({ a: ["b", "c", "b", "d", "e"], x: [] }),
		);
		expect(mapping.get("a")).toEqual(["b", "c", "d"]);
		expect(mapping.get("x")).toEqual([]);
		expect(parseCrossSellSetting({ a: ["b"] }).get("a")).toEqual(["b"]);
	});

	it.each([
		undefined,
		null,
		"",
		"not json",
		"[]",
		'{"a":"b"}',
		'{"a":[1]}',
		42,
	])("treats %j as no recommendations", (value) => {
		expect(parseCrossSellSetting(value).size).toBe(0);
	});

	it("links to the preselected item with xsell attribution that referral capture ignores", () => {
		expect(crossSellProductPath("p 1", "i1")).toBe(
			"/products/p%201?item=i1&ref=xsell#purchase-options",
		);
		expect(/^INV-[A-Z0-9]{20}$/.test("XSELL")).toBe(false);
	});
});

describe("order growth blocks", { timeout: 60_000 }, () => {
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
		await seedCatalog(db);
	}, 60_000);

	afterEach(async () => miniflare.dispose());

	it.each([
		"pending_payment",
		"cancelled",
		"expired",
		"refunded",
	])("shows nothing for %s orders", async (status) => {
		await seedOrder(db, "o1", ["item-bought"], { status });
		await setCrossSell(db, { "item-bought": ["item-a"] });
		expect(await loadOrderGrowth(db, order("o1", status), signedIn)).toBeNull();
	});

	it("shows nothing for refunded paid orders, agent-access and supplier-API orders", async () => {
		await setCrossSell(db, { "item-bought": ["item-a"] });
		await seedOrder(db, "o1", ["item-bought"]);
		expect(
			await loadOrderGrowth(db, { ...order("o1"), refundedAt: 1 }, signedIn),
		).toBeNull();
		await seedOrder(db, "o-agent", [agentAccessProducts.api.itemId], {
			productId: agentAccessProducts.api.productId,
		});
		expect(await loadOrderGrowth(db, order("o-agent"), signedIn)).toBeNull();
		await seedOrder(db, "o-api", ["item-bought"]);
		await db.batch([
			db.prepare(
				"INSERT INTO users (id, name, email, email_verified, enabled) VALUES ('reseller','Reseller','reseller@partner.com',1,1)",
			),
			db.prepare(
				"INSERT INTO supplier_api_keys (id, user_id, name, key_id, secret_encrypted, created_at, updated_at) VALUES ('key-1','reseller','Main','kid','enc',1,1)",
			),
			db.prepare(
				"INSERT INTO supplier_api_orders (id, shop_order_id, user_id, api_key_id, downstream_order_no, request_digest, created_at, updated_at) VALUES ('sa-1','o-api','reseller','key-1','DS-1','digest',1,1)",
			),
		]);
		expect(await loadOrderGrowth(db, order("o-api"), signedIn)).toBeNull();
	});

	it.each([
		"paid",
		"fulfilling",
		"completed",
	])("recommends only sellable items for %s orders, in configured order", async (status) => {
		await seedOrder(db, "o1", ["item-bought"], { status });
		await setCrossSell(db, {
			"item-bought": [
				"item-bought",
				"item-disabled",
				"item-sale-disabled",
				"item-sold-out",
				"item-inactive-product",
				"item-missing",
				"item-b",
				"item-a",
			],
		});
		const growth = await loadOrderGrowth(db, order("o1", status), signedIn);
		// The setting keeps three ids; only the in-stock, enabled ones survive.
		expect(growth?.crossSell).toEqual([]);
		await setCrossSell(db, {
			"item-bought": ["item-sold-out", "item-b", "item-a"],
		});
		const next = await loadOrderGrowth(db, order("o1", status), signedIn);
		expect(next?.crossSell).toEqual([
			{
				sellableItemId: "item-b",
				productId: "product-other",
				productName: "Claude",
				sellableItemName: "Claude Pro 1个月",
				priceMinor: "16800",
				currency: "CNY",
				currencyDecimals: 2,
				coverUrl: null,
				href: "/products/product-other?item=item-b&ref=xsell#purchase-options",
			},
			{
				sellableItemId: "item-a",
				productId: "product-other",
				productName: "Claude",
				sellableItemName: "Codex 250",
				priceMinor: "2500",
				currency: "CNY",
				currencyDecimals: 2,
				coverUrl: null,
				href: "/products/product-other?item=item-a&ref=xsell#purchase-options",
			},
		]);
	});

	it.each([
		["item-disabled"],
		["item-sale-disabled"],
		["item-sold-out"],
		["item-inactive-product"],
		["item-bought"],
	])("skips %s", async (id) => {
		await seedOrder(db, "o1", ["item-bought"]);
		await setCrossSell(db, { "item-bought": [id] });
		expect(
			(await loadOrderGrowth(db, order("o1"), signedIn))?.crossSell,
		).toEqual([]);
	});

	it("keeps the invitation block without a cross-sell setting and reports the referral amount", async () => {
		await seedOrder(db, "o1", ["item-bought"]);
		expect(await loadOrderGrowth(db, order("o1"), { signedIn: false })).toEqual(
			{
				signedIn: false,
				referralRewardMinor: "100",
				crossSell: [],
			},
		);
		// ¥8 budgets only apply from ¥1000; below that the SKU does not take part.
		await seedOrder(db, "o2", ["item-b"]);
		expect(
			(await loadOrderGrowth(db, order("o2"), signedIn))?.referralRewardMinor,
		).toBe("0");
		await seedOrder(db, "o3", ["item-expensive"]);
		expect(
			(await loadOrderGrowth(db, order("o3"), signedIn))?.referralRewardMinor,
		).toBe("400");
	});

	it("resolves /go/item deep links and keeps a safe src", async () => {
		expect(await resolveItemLinkPath(db, "item-a", "redeem")).toBe(
			"/products/product-other?item=item-a&src=redeem#purchase-options",
		);
		expect(await resolveItemLinkPath(db, "item-a", null)).toBe(
			"/products/product-other?item=item-a#purchase-options",
		);
		expect(await resolveItemLinkPath(db, "item-a", "<script>")).toBe(
			"/products/product-other?item=item-a#purchase-options",
		);
		expect(await resolveItemLinkPath(db, "item-disabled", "redeem")).toBe("/");
		expect(
			await resolveItemLinkPath(db, "item-inactive-product", "redeem"),
		).toBe("/");
		expect(await resolveItemLinkPath(db, "item-missing", "redeem")).toBe("/");
		expect(await resolveItemLinkPath(db, "../etc", "redeem")).toBe("/");
	});
});

function order(id: string, status = "completed") {
	return { id, status, refundedAt: null };
}

async function setCrossSell(db: D1Database, value: unknown) {
	await db
		.prepare(
			`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
			 VALUES (?, ?, 0, 1, 1) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		)
		.bind(crossSellSettingKey, JSON.stringify(value))
		.run();
}

async function seedCatalog(db: D1Database) {
	const products = [
		["product-bought", "ChatGPT", "download", "active"],
		["product-other", "Claude", "download", "active"],
		["product-stock", "Stock", "stock", "active"],
		["product-inactive", "Inactive", "download", "draft"],
		[agentAccessProducts.api.productId, "API", "automation", "active"],
	];
	const items: Array<[string, string, string, string, number, number, string]> =
		[
			// id, product, name, price, enabled, sale_disabled, budget
			["item-bought", "product-bought", "Plus 菲区", "2900", 1, 0, "200"],
			["item-a", "product-other", "Codex 250", "2500", 1, 0, "0"],
			["item-b", "product-other", "Claude Pro 1个月", "16800", 1, 0, "800"],
			["item-expensive", "product-other", "Pro 200", "120000", 1, 0, "800"],
			["item-disabled", "product-other", "Disabled", "100", 0, 0, "0"],
			["item-sale-disabled", "product-other", "Paused", "100", 1, 1, "0"],
			["item-sold-out", "product-stock", "Sold out", "100", 1, 0, "0"],
			["item-inactive-product", "product-inactive", "Draft", "100", 1, 0, "0"],
			[
				agentAccessProducts.api.itemId,
				agentAccessProducts.api.productId,
				"API",
				"990",
				1,
				0,
				"0",
			],
		];
	await db.batch([
		...products.map(([id, name, type, status]) =>
			db
				.prepare(
					"INSERT INTO products (id, name, product_type, status, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)",
				)
				.bind(id, name, type, status),
		),
		...items.map(([id, product, name, price, enabled, saleDisabled, budget]) =>
			db
				.prepare(
					`INSERT INTO product_sellable_items
					 (id, product_id, name, price_minor, currency, currency_decimals, enabled,
					  sale_disabled, promotion_budget_minor, sort_order, created_at, updated_at)
					 VALUES (?, ?, ?, ?, 'CNY', 2, ?, ?, ?, 0, 1, 1)`,
				)
				.bind(id, product, name, price, enabled, saleDisabled, budget),
		),
	]);
}

async function seedOrder(
	db: D1Database,
	id: string,
	itemIds: string[],
	options: { status?: string; productId?: string } = {},
) {
	await db.batch([
		db
			.prepare(
				`INSERT INTO shop_orders
				 (id, order_number, contact_email, normalized_contact_email, locale,
				  status, currency, currency_decimals, subtotal_minor, discount_minor,
				  total_minor, paid_minor, version, expires_at, paid_at, created_at, updated_at)
				 VALUES (?, ?, 'buyer@example.com', 'buyer@example.com', 'zh-CN', ?, 'CNY', 2,
				  '100', '0', '100', '100', 2, 1, 1, 1, 1)`,
			)
			.bind(id, `ORDER-${id.toUpperCase()}`, options.status ?? "completed"),
		...itemIds.map((itemId, index) =>
			db
				.prepare(
					`INSERT INTO shop_order_items
					 (id, order_id, product_id, sellable_item_id, delivery_component_id,
					  product_name, delivery_component_type, delivery_component_version,
					  sellable_item_name, quantity, unit_price_minor, discount_minor,
					  subtotal_minor, created_at, updated_at)
					 VALUES (?, ?, (SELECT product_id FROM product_sellable_items WHERE id = ?),
					  ?, ?, 'Product', 'download', 1, 'Item', 1, '100', '0', '100', ?, 1)`,
				)
				.bind(`${id}-item-${index}`, id, itemId, itemId, itemId, index + 1),
		),
	]);
	if (options.productId)
		await db
			.prepare("UPDATE shop_order_items SET product_id = ? WHERE order_id = ?")
			.bind(options.productId, id)
			.run();
}
