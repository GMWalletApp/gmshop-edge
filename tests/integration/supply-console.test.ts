import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { encryptSecret } from "#/lib/secrets";
import { applyMigrations } from "./migrations";

const mocked = vi.hoisted(() => ({ db: undefined as D1Database | undefined }));
vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("#/server/context", () => ({
	getAdminRuntimeServerContext: async () => ({
		db: mocked.db,
		currentUser: { id: ADMIN_ID },
		request: new Request("https://shop.example/admin/supply", {
			headers: { "x-request-id": "request-1", "cf-connecting-ip": "127.0.0.1" },
		}),
		runtime: { commerceSecret: COMMERCE_SECRET },
	}),
}));

import { requestWarehouse } from "#/features/redeem-warehouse/server/admin";
import { restockInBatches } from "#/features/supply-console/restock-batches";
import {
	listSupplyConsole,
	supplyMapKey,
} from "#/features/supply-console/server/query";
import { restockSupply } from "#/features/supply-console/server/restock";

describe("supply console", { timeout: 30_000 }, () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmshop-supply-console" },
		});
		db = await miniflare.getD1Database("DB");
		mocked.db = db;
		await applyMigrations(db);
		await seed(db);
	});

	afterAll(async () => miniflare.dispose());

	function warehouse(available = 1) {
		return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith("/api/internal/inventory/summary"))
				return Response.json({
					success: true,
					data: [
						{
							sku: "GPT_20X_IOS",
							display_name: "ChatGPT 20X iOS",
							family: "gpt",
							input_kind: "gpt_session",
							available,
							leased: 0,
							processing: 0,
							consumed: 0,
							quarantined: 0,
						},
					],
				});
			if (url.endsWith("/api/internal/inventory/import")) {
				const body = JSON.parse(String(init?.body)) as { keys: string[] };
				return Response.json({
					success: true,
					data: {
						imported: body.keys.length,
						total: body.keys.length,
						results: body.keys.map((_, index) => ({
							index,
							status: "available",
						})),
					},
				});
			}
			if (url.endsWith("/api/internal/codes/batch")) {
				const body = JSON.parse(String(init?.body)) as { count: number };
				return Response.json({
					success: true,
					data: {
						sku: "GPT_20X_IOS",
						count: body.count,
						codes: Array.from(
							{ length: body.count },
							(_, index) => `gpt-20x-ios-CONSOLE-${index}-CCCC-DDDD`,
						),
					},
				});
			}
			return Response.json({ success: false }, { status: 404 });
		});
	}

	function requester(fetcher: ReturnType<typeof warehouse>) {
		const call: typeof requestWarehouse = (token, path, init) =>
			requestWarehouse(token, path, init, fetcher as typeof fetch);
		return call;
	}

	it("reads a single-encoded production supply map", async () => {
		await db
			.prepare("UPDATE system_settings SET value = ? WHERE key = ?")
			.bind(JSON.stringify({ [CENTRAL_ITEM]: "GPT_20X_IOS" }), supplyMapKey)
			.run();
		try {
			const rows = await listSupplyConsole(
				db,
				COMMERCE_SECRET,
				requester(warehouse(1)),
			);
			expect(
				rows.find((row) => row.componentId === CENTRAL_ITEM),
			).toMatchObject({ centralSku: "GPT_20X_IOS", centralAvailable: 1 });
		} finally {
			await db
				.prepare("UPDATE system_settings SET value = ? WHERE key = ?")
				.bind(
					JSON.stringify(JSON.stringify({ [CENTRAL_ITEM]: "GPT_20X_IOS" })),
					supplyMapKey,
				)
				.run();
		}
	});

	it("counts available raw PH cards only while their owned-delivery route is enabled", async () => {
		const routeKey = `integration.redeem_delivery.${CENTRAL_ITEM}`;
		await db
			.prepare("UPDATE system_settings SET value = ? WHERE key = ?")
			.bind(JSON.stringify({ [CENTRAL_ITEM]: "GPT_20X_PH" }), supplyMapKey)
			.run();
		const offline: typeof requestWarehouse = async () => {
			throw new Error("offline");
		};
		try {
			const before = await listSupplyConsole(db, COMMERCE_SECRET, offline);
			expect(
				before.find((row) => row.componentId === CENTRAL_ITEM)
					?.upstreamAvailable,
			).toBe(null);
			await db
				.prepare(
					"INSERT INTO system_settings (key,value,is_secret,created_at,updated_at) VALUES (?,?,0,1,1)",
				)
				.bind(routeKey, JSON.stringify("GPT_20X_PH"))
				.run();
			const rows = await listSupplyConsole(db, COMMERCE_SECRET, offline);
			expect(
				rows.find((row) => row.componentId === CENTRAL_ITEM),
			).toMatchObject({ available: 3, upstreamAvailable: null, gap: null });
			const stocked: typeof requestWarehouse = async () => ({
				success: true,
				data: [
					{
						sku: "GPT_20X_PH",
						display_name: "PH 20X",
						available: 10,
						consumed: 0,
						quarantined: 0,
					},
				],
			});
			const noDoubleCount = await listSupplyConsole(
				db,
				COMMERCE_SECRET,
				stocked,
			);
			expect(
				noDoubleCount.find((row) => row.componentId === CENTRAL_ITEM)
					?.upstreamAvailable,
			).toBe(13);
			await db
				.prepare("UPDATE stock_entries SET status='reserved' WHERE id='s3'")
				.run();
			const reserved = await listSupplyConsole(db, COMMERCE_SECRET, offline);
			expect(
				reserved.find((row) => row.componentId === CENTRAL_ITEM),
			).toMatchObject({ available: 2, upstreamAvailable: null, reserved: 1 });
			await db
				.prepare("UPDATE system_settings SET value=? WHERE key=?")
				.bind(JSON.stringify("GPT_5X_PH"), routeKey)
				.run();
			const mismatch = await listSupplyConsole(db, COMMERCE_SECRET, offline);
			expect(
				mismatch.find((row) => row.componentId === CENTRAL_ITEM)
					?.upstreamAvailable,
			).toBe(null);
		} finally {
			await db
				.prepare("DELETE FROM system_settings WHERE key=?")
				.bind(routeKey)
				.run();
			await db
				.prepare("UPDATE stock_entries SET status='available' WHERE id='s3'")
				.run();
			await db
				.prepare("UPDATE system_settings SET value=? WHERE key=?")
				.bind(
					JSON.stringify(JSON.stringify({ [CENTRAL_ITEM]: "GPT_20X_IOS" })),
					supplyMapKey,
				)
				.run();
		}
	});

	it("reports what each SKU can actually deliver", async () => {
		const rows = await listSupplyConsole(
			db,
			COMMERCE_SECRET,
			requester(warehouse(1)),
		);
		const central = rows.find((row) => row.componentId === CENTRAL_ITEM);
		const direct = rows.find((row) => row.componentId === DIRECT_ITEM);
		expect(rows.map((row) => row.componentId)).not.toContain(PAUSED_ITEM);
		// Three storefront codes but a single key in the vault.
		expect(central).toMatchObject({
			centralSku: "GPT_20X_IOS",
			available: 3,
			centralAvailable: 1,
			upstreamAvailable: 1,
			gap: 2,
			usdtMinor: "175000",
			alipayMinor: "185000",
			supplyMinor: "165000",
		});
		expect(direct).toMatchObject({
			centralSku: null,
			available: 2,
			upstreamAvailable: 2,
			gap: 0,
		});
	});

	it("displays owned codes and upstream keys independently for Claude too", async () => {
		await db
			.prepare("UPDATE system_settings SET value=? WHERE key=?")
			.bind(JSON.stringify({ [CENTRAL_ITEM]: "CLAUDE_PRO_IOS" }), supplyMapKey)
			.run();
		try {
			const warehouse: typeof requestWarehouse = async (_token, path) =>
				path.endsWith("sale-capacity")
					? {
							success: true,
							data: { available: 3, outstanding: 2, sellable: 1 },
						}
					: {
							success: true,
							data: [
								{
									sku: "CLAUDE_PRO_IOS",
									display_name: "Claude Pro",
									available: 3,
									consumed: 22,
									quarantined: 0,
								},
							],
						};
			const rows = await listSupplyConsole(db, COMMERCE_SECRET, warehouse);
			expect(rows.find((r) => r.componentId === CENTRAL_ITEM)).toMatchObject({
				available: 3,
				upstreamAvailable: 3,
			});
		} finally {
			await db
				.prepare("UPDATE system_settings SET value=? WHERE key=?")
				.bind(JSON.stringify({ [CENTRAL_ITEM]: "GPT_20X_IOS" }), supplyMapKey)
				.run();
		}
	});

	it("keeps the console readable when the warehouse is unreachable", async () => {
		const failing: typeof requestWarehouse = async () => {
			throw new Error("warehouse down");
		};
		const rows = await listSupplyConsole(db, COMMERCE_SECRET, failing);
		expect(rows.find((row) => row.componentId === CENTRAL_ITEM)).toMatchObject({
			centralAvailable: null,
			upstreamAvailable: null,
		});
	});

	it("routes a mapped SKU to the central vault and issues storefront codes", async () => {
		const fetcher = warehouse(1);
		const result = await restockSupply(
			{
				requestRef: "supply_console_central_1",
				componentId: CENTRAL_ITEM,
				unitCostYuan: "1600",
				content: "KEY-A\nKEY-B",
			},
			testContext(db),
			requester(fetcher),
		);
		expect(result).toMatchObject({
			route: "central",
			total: 2,
			imported: 2,
			generationFailed: false,
		});
		const stock = await db
			.prepare(
				"SELECT COUNT(*) AS count FROM stock_entries WHERE sellable_item_id = ? AND status = 'available'",
			)
			.bind(CENTRAL_ITEM)
			.first<{ count: number }>();
		expect(stock?.count).toBe(5);
	});

	it("imports 30 PH keys through the real restock path once and adds exactly 30 storefront codes", async () => {
		await db
			.prepare("UPDATE system_settings SET value=? WHERE key=?")
			.bind(JSON.stringify({ [CENTRAL_ITEM]: "GPT_PLUS_PH" }), supplyMapKey)
			.run();
		const imported = new Set<string>();
		let batches = 0;
		const request: typeof requestWarehouse = async (_token, path, init) => {
			const body = JSON.parse(String(init?.body));
			if (path.endsWith("/inventory/import")) {
				if (body.keys.length > 5) throw new Error("input.batch_too_large");
				batches++;
				const results = body.keys.map((key: string, index: number) => {
					const status = imported.has(key) ? "duplicate" : "available";
					imported.add(key);
					return { index, status };
				});
				return {
					success: true,
					data: {
						total: body.keys.length,
						imported: results.filter(
							(item: { status: string }) => item.status === "available",
						).length,
						results,
					},
				};
			}
			if (path.endsWith("/codes/batch"))
				return {
					success: true,
					data: {
						sku: "GPT_PLUS_PH",
						count: body.count,
						codes: Array.from(
							{ length: body.count },
							(_, i) => `gpt-plus-ph-${body.request_ref}-${i}-synthetic`,
						),
					},
				};
			throw new Error("Unexpected path");
		};
		const count = async () =>
			(
				await db
					.prepare(
						"SELECT count(*) n FROM stock_entries WHERE sellable_item_id=?",
					)
					.bind(CENTRAL_ITEM)
					.first<{ n: number }>()
			)?.n ?? 0;
		const before = await count();
		const data = {
			requestRef: "supply_ph_thirty_test",
			componentId: CENTRAL_ITEM,
			unitCostYuan: "113",
			content: Array.from({ length: 30 }, (_, i) => `synthetic-ph-${i}`).join(
				"\n",
			),
		};
		const send = async ({
			data: payload,
		}: {
			data: Parameters<typeof restockSupply>[0];
		}) => restockSupply(payload, testContext(db), request);
		try {
			const result = await restockInBatches(
				data,
				"GPT_PLUS_PH",
				send,
				undefined,
				async () => {},
			);
			expect(result).toMatchObject({
				total: 30,
				imported: 30,
				generated: 30,
				generationFailed: false,
			});
			expect(batches).toBe(6);
			expect(await count()).toBe(before + 30);
			const retry = await restockInBatches(
				{ ...data, requestRef: "supply_ph_thirty_retry" },
				"GPT_PLUS_PH",
				send,
				undefined,
				async () => {},
			);
			expect(retry).toMatchObject({
				total: 30,
				imported: 0,
				generated: 0,
				counts: { duplicate: 30 },
			});
			expect(await count()).toBe(before + 30);
		} finally {
			await db
				.prepare("UPDATE system_settings SET value=? WHERE key=?")
				.bind(JSON.stringify({ [CENTRAL_ITEM]: "GPT_20X_IOS" }), supplyMapKey)
				.run();
		}
	});

	it("stores unmapped SKU keys as storefront stock with their recharge URL", async () => {
		const result = await restockSupply(
			{
				requestRef: "supply_console_direct_1",
				componentId: DIRECT_ITEM,
				unitCostYuan: "125",
				content: "RAW-1\nRAW-2",
				usageUrl: "https://redeemgpt.com/",
			},
			testContext(db),
			requester(warehouse(1)),
		);
		expect(result).toMatchObject({ route: "direct", imported: 2 });
		const rows = await listSupplyConsole(
			db,
			COMMERCE_SECRET,
			requester(warehouse(1)),
		);
		expect(rows.find((row) => row.componentId === DIRECT_ITEM)).toMatchObject({
			available: 4,
			upstreamAvailable: 4,
		});
	});

	it("refuses unmapped restocks without a recharge URL", async () => {
		await expect(
			restockSupply(
				{
					requestRef: "supply_console_direct_2",
					componentId: DIRECT_ITEM,
					unitCostYuan: "125",
					content: "RAW-3",
				},
				testContext(db),
				requester(warehouse(1)),
			),
		).rejects.toMatchObject({ code: "supply_usage_url_required" });
	});
});

const ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRODUCT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CENTRAL_ITEM = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DIRECT_ITEM = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PAUSED_ITEM = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const USDT_CHANNEL = "11111111-1111-4111-8111-111111111111";
const ALIPAY_CHANNEL = "22222222-2222-4222-8222-222222222222";
const COMMERCE_SECRET = "supply-console-integration-commerce-secret";

async function seed(db: D1Database) {
	const token = await encryptSecret(
		"test-internal-token-value-1234567890",
		COMMERCE_SECRET,
		"redeem-warehouse-token",
	);
	const item = (id: string, name: string, saleDisabled: number) =>
		db
			.prepare(
				`INSERT INTO product_sellable_items
				 (id, product_id, name, fulfillment_source, currency, currency_decimals,
				  price_minor, cost_minor, sale_disabled, created_at, updated_at)
				 VALUES (?, ?, ?, 'local', 'CNY', 2, '175000', '160000', ?, 1, 1)`,
			)
			.bind(id, PRODUCT_ID, name, saleDisabled);
	const stock = (id: string, itemId: string) =>
		db
			.prepare(
				`INSERT INTO stock_entries
				 (id, sellable_item_id, content_encrypted, key_version, content_fingerprint,
				  content_mask, status, created_at, updated_at)
				 VALUES (?, ?, 'x', 1, ?, '••••1234', 'available', 1, 1)`,
			)
			.bind(id, itemId, id);
	await db.batch([
		db
			.prepare(
				`INSERT INTO users (id, name, email, email_verified, enabled, created_at, updated_at)
				 VALUES (?, 'Admin', 'admin@example.com', 1, 1, 1, 1)`,
			)
			.bind(ADMIN_ID),
		db
			.prepare(
				`INSERT INTO products (id, name, product_type, status, created_at, updated_at)
				 VALUES (?, 'ChatGPT', 'stock', 'active', 1, 1)`,
			)
			.bind(PRODUCT_ID),
		item(CENTRAL_ITEM, "ChatGPT Pro 20X iOS 1个月", 0),
		item(DIRECT_ITEM, "ChatGPT Plus iOS 1个月", 0),
		item(PAUSED_ITEM, "已停售规格", 1),
		...["s1", "s2", "s3"].map((id) => stock(id, CENTRAL_ITEM)),
		...["d1", "d2"].map((id) => stock(id, DIRECT_ITEM)),
		db
			.prepare(
				`INSERT INTO payment_channels
				 (id, name, provider, currency, default_token, default_network, fee_bps,
				  fixed_fee_minor, sort_order, enabled, created_at, updated_at)
				 VALUES (?, 'USDT', 'gmpay', 'CNY', 'USDT', 'polygon', 0, '0', 1, 1, 1, 1),
				  (?, '支付宝', 'epay', 'CNY', '', '', 0, '0', 2, 1, 1, 1)`,
			)
			.bind(USDT_CHANNEL, ALIPAY_CHANNEL),
		db
			.prepare(
				`INSERT INTO sellable_item_channel_prices
				 (id, sellable_item_id, channel_id, price_minor, enabled, created_at, updated_at)
				 VALUES ('p1', ?, ?, '175000', 1, 1, 1), ('p2', ?, ?, '185000', 1, 1, 1)`,
			)
			.bind(CENTRAL_ITEM, USDT_CHANNEL, CENTRAL_ITEM, ALIPAY_CHANNEL),
		db
			.prepare(
				`INSERT INTO supplier_export_listings
				 (id, sellable_item_id, price_minor, currency, currency_decimals, enabled, created_at, updated_at)
				 VALUES ('l1', ?, '165000', 'CNY', 2, 1, 1, 1)`,
			)
			.bind(CENTRAL_ITEM),
		db
			.prepare(
				`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
				 VALUES ('integration.redeem_warehouse_token', ?, 1, 1, 1)`,
			)
			.bind(JSON.stringify(token)),
		db
			.prepare(
				`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
				 VALUES (?, ?, 0, 1, 1)`,
			)
			.bind(
				supplyMapKey,
				JSON.stringify(JSON.stringify({ [CENTRAL_ITEM]: "GPT_20X_IOS" })),
			),
		db
			.prepare(
				`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
				 VALUES ('runtime.data_encryption_secret', ?, 1, 1, 1)`,
			)
			.bind(JSON.stringify(COMMERCE_SECRET)),
	]);
}

function testContext(db: D1Database) {
	return {
		db,
		currentUser: { id: ADMIN_ID },
		request: new Request("https://shop.example/admin/supply", {
			headers: { "x-request-id": "request-1", "cf-connecting-ip": "127.0.0.1" },
		}),
		runtime: { commerceSecret: COMMERCE_SECRET },
	} as never;
}
