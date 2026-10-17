import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	assessSupplier,
	runBalanceGuard,
} from "#/features/ops-automation/server/balance-guard";
import {
	parseCostFactors,
	planPrice,
	realCostMinor,
	roundUpRetailMinor,
	runPricingGuard,
} from "#/features/ops-automation/server/pricing-guard";
import {
	parseProcurementPrices,
	parseProcurementStats,
	yuanToMinor,
} from "#/features/ops-automation/server/shared";
import {
	buildWeeklyReport,
	formatWeeklyReport,
	runWeeklyReport,
} from "#/features/ops-automation/server/weekly-report";
import { applyMigrations } from "./migrations";

// Monday 2026-10-19 09:30 Beijing.
const monday = Date.parse("2026-10-19T01:30:00Z");
const hour = 3_600_000;
const day = 24 * hour;

const stats = parseProcurementStats({
	success: true,
	data: {
		suppliers: [
			{ name: "86", balance: "5000.00", spend_7d: "700.00", purchases_7d: 7 },
			{ name: "xiaojiu", balance: "30.00", spend_7d: "70.00", purchases_7d: 1 },
		],
		skus: [
			{ sku: "GPT_PLUS", available: 3, restock_source: "86" },
			{ sku: "CLAUDE_PRO", available: 0, restock_source: "xiaojiu" },
			{ sku: "GPT_PRO", available: 0, restock_source: null },
		],
	},
});
const prices = parseProcurementPrices({
	success: true,
	data: [
		{ sku: "GPT_PLUS", source: "86", price: "50.00" },
		{ sku: "GPT_PLUS", source: "xiaojiu", price: "10.00" },
		{ sku: "CLAUDE_PRO", source: "xiaojiu", price: "140.00" },
		{ sku: "GPT_PRO", source: "86", price: "900.00" },
	],
});

describe("ops automation pure helpers", () => {
	it("parses money exactly and rounds retail prices up to 9 / 8", () => {
		expect(yuanToMinor("12.3")).toBe(1230);
		expect(yuanToMinor("12.301")).toBe(1231);
		expect(yuanToMinor(null)).toBeNull();
		expect(roundUpRetailMinor(5372)).toBe(5900);
		expect(roundUpRetailMinor(5900)).toBe(5900);
		expect(roundUpRetailMinor(6001)).toBe(6900);
		expect(roundUpRetailMinor(99_850)).toBe(99_900);
		expect(roundUpRetailMinor(99_950)).toBe(100_800);
		expect(roundUpRetailMinor(109_100)).toBe(109_800);
		expect(roundUpRetailMinor(109_800)).toBe(109_800);
	});

	it("computes real cost with factors and never plans a lower price", () => {
		const factors = parseCostFactors(undefined);
		expect(realCostMinor(5000, "86", factors)).toBe(5072);
		expect(realCostMinor(14000, "xiaojiu", factors)).toBe(14166);
		expect(realCostMinor(10000, "aisou", factors)).toBe(10037);
		expect(
			planPrice({
				usdtMinor: 9900,
				alipayMinor: 9900,
				costMinor: 1004,
				floorMinor: 300,
			}),
		).toBeNull();
		// Only 支付宝 is short: USDT stays, 支付宝 rises to ≥ USDT × 1.02.
		expect(
			planPrice({
				usdtMinor: 10400,
				alipayMinor: 10500,
				costMinor: 10037,
				floorMinor: 300,
			}),
		).toEqual({
			usdtOld: 10400,
			usdtNew: 10400,
			alipayOld: 10500,
			alipayNew: 10900,
			auto: true,
		});
	});

	it("flags low runway and a balance below the next purchase", () => {
		expect(
			assessSupplier({
				key: "aisou",
				label: "AISOU",
				balanceMinor: 20000,
				spend7dMinor: 140000,
				purchases7d: 14,
			}),
		).toMatchObject({ daysLeft: 1, suggestedTopUpMinor: 120000 });
		expect(
			assessSupplier({
				key: "xiaojiu",
				label: "小九",
				balanceMinor: 3000,
				spend7dMinor: 7000,
				purchases7d: 1,
			}),
		).toMatchObject({ daysLeft: 3, suggestedTopUpMinor: 10000 });
		expect(
			assessSupplier({
				key: "86",
				label: "86",
				balanceMinor: 500000,
				spend7dMinor: 70000,
				purchases7d: 7,
			}),
		).toBeNull();
	});
});

describe("ops automation jobs", { timeout: 30_000 }, () => {
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
		await seedBase(db);
	});

	afterEach(async () => miniflare.dispose());

	it("balance guard is off by default, alerts once per supplier per Beijing day", async () => {
		await seedAisou(db);
		const messages: string[] = [];
		const run = (now: number) =>
			runBalanceGuard({
				db,
				now,
				readStats: async () => stats,
				deliver: async (text) => {
					messages.push(text);
				},
			});
		await expect(run(monday)).resolves.toEqual({ status: "disabled" });
		await setSetting(db, "ops.balance_guard.enabled", true);

		await expect(run(monday)).resolves.toEqual({
			status: "sent",
			checked: 3,
			alerted: 2,
		});
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("⚠️ 供应商余额不足｜2026-10-19");
		expect(messages[0]).toContain(
			"· AISOU：余额 ¥200.00，近 7 天消耗 ¥1400.00，约剩 1.0 天；建议充值 ¥1200.00",
		);
		expect(messages[0]).toContain("· 小九：余额 ¥30.00");
		expect(messages[0]).toContain("不够下一笔约 ¥70.00 的进货");
		expect(messages[0]).toContain("建议充值 ¥100.00");
		expect(messages[0]).not.toContain("· 86：");

		// Within two hours the job is throttled; after that, today's alerts are deduped.
		await expect(run(monday + hour)).resolves.toEqual({ status: "throttled" });
		await expect(run(monday + 2 * hour)).resolves.toEqual({
			status: "ok",
			checked: 3,
			alerted: 0,
		});
		expect(messages).toHaveLength(1);
		// Next Beijing day alerts again.
		await expect(run(monday + day)).resolves.toMatchObject({
			status: "sent",
			alerted: 2,
		});
		expect(messages).toHaveLength(2);
	});

	it("balance guard retries a failed delivery on the next run", async () => {
		await seedAisou(db);
		await setSetting(db, "ops.balance_guard.enabled", true);
		const failed = await runBalanceGuard({
			db,
			now: monday,
			readStats: async () => null,
			deliver: async () => {
				throw new Error("down");
			},
		});
		expect(failed.status).toBe("failed");
		const messages: string[] = [];
		await runBalanceGuard({
			db,
			now: monday + 2 * hour,
			readStats: async () => null,
			deliver: async (text) => {
				messages.push(text);
			},
		});
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("AISOU");
		expect(messages[0]).not.toContain("小九");
	});

	it("pricing guard auto-raises ≤5%, proposes >5%, never lowers and flags agent prices", async () => {
		await seedPricing(db);
		const messages: string[] = [];
		const run = (now: number) =>
			runPricingGuard({
				db,
				now,
				readStats: async () => stats,
				readPrices: async () => prices,
				deliver: async (text) => {
					messages.push(text);
				},
			});
		await expect(run(monday)).resolves.toEqual({ status: "disabled" });
		await setSetting(db, "ops.pricing_guard.enabled", true);
		// Before 09:00 Beijing nothing happens.
		await expect(run(monday - 2 * hour)).resolves.toMatchObject({
			status: "waiting",
		});

		await expect(run(monday)).resolves.toMatchObject({
			status: "ran",
			delivery: "sent",
			applied: 2,
			proposed: 1,
			agentWarnings: 1,
			skipped: 1,
		});
		expect(messages).toHaveLength(1);
		const text = messages[0] ?? "";
		expect(text).toContain("📈 定价守护｜2026-10-19（净利底线 ¥3.00）");
		expect(text).toContain("自动调价（事后通知）：");
		expect(text).toContain(
			"· Claude · Pro：成本 ¥141.66；USDT ¥142.00→¥149.00，支付宝 ¥152.00（不变）",
		);
		expect(text).toContain(
			"· AISOU · Plus：成本 ¥100.37；USDT ¥104.00（不变），支付宝 ¥105.00→¥109.00",
		);
		expect(text).toContain("需要你确认（未改价）：");
		expect(text).toContain(
			"· ChatGPT · Plus：成本 ¥50.72；建议 USDT ¥53.00→¥59.00（+11.4%），支付宝 ¥55.00→¥69.00（+25.5%）",
		);
		expect(text).toContain("代理价需要调整（仅建议，未改动）：");
		expect(text).toContain(
			"· AISOU · Cheap：代理价 ¥10.50，成本 ¥10.04，净利 ¥0.46；建议至少 ¥12.00",
		);
		expect(text).not.toContain("Pro 500");

		const item = (id: string) =>
			db
				.prepare(
					`SELECT item.price_minor, item.version, product.revision,
					  (SELECT price_minor FROM sellable_item_channel_prices WHERE sellable_item_id = item.id AND channel_id = 'usdt') AS usdt,
					  (SELECT price_minor FROM sellable_item_channel_prices WHERE sellable_item_id = item.id AND channel_id = 'alipay') AS alipay
					 FROM product_sellable_items item JOIN products product ON product.id = item.product_id
					 WHERE item.id = ?`,
				)
				.bind(id)
				.first();
		await expect(item("claude")).resolves.toEqual({
			price_minor: "14900",
			version: 2,
			revision: 2,
			usdt: "14900",
			// ¥152 already ≥ ¥149 × 1.02 and nets ≥ ¥3, so it stays.
			alipay: "15200",
		});
		await expect(item("aisou-plus")).resolves.toEqual({
			price_minor: "10400",
			version: 2,
			revision: 2,
			usdt: "10400",
			alipay: "10900",
		});
		// >5% is only proposed; generous prices are never lowered.
		await expect(item("gpt-plus")).resolves.toEqual({
			price_minor: "5300",
			version: 1,
			revision: 1,
			usdt: "5300",
			alipay: "5500",
		});
		await expect(item("aisou-cheap")).resolves.toEqual({
			price_minor: "9900",
			version: 1,
			// Shares its product with aisou-plus, whose raise bumped the revision.
			revision: 2,
			usdt: "9900",
			alipay: "9900",
		});
		await expect(
			db
				.prepare(
					"SELECT price_minor FROM supplier_export_listings WHERE id = 'listing'",
				)
				.first("price_minor"),
		).resolves.toBe("1050");
		const audits = await db
			.prepare(
				"SELECT target_id, before, after FROM audit_logs WHERE action = 'pricing_guard.auto_raise' ORDER BY target_id",
			)
			.all<{ target_id: string; before: string; after: string }>();
		expect(audits.results.map((row) => row.target_id)).toEqual([
			"aisou-plus",
			"claude",
		]);
		expect(JSON.parse(audits.results[1]?.before ?? "{}")).toMatchObject({
			priceMinor: "14200",
			alipayMinor: "15200",
			version: 1,
		});
		expect(JSON.parse(audits.results[1]?.after ?? "{}")).toMatchObject({
			priceMinor: "14900",
			alipayMinor: "15200",
			version: 2,
			costMinor: "14166",
		});

		// Once per Beijing day.
		await expect(run(monday + hour)).resolves.toMatchObject({ status: "done" });
		expect(messages).toHaveLength(1);
	});

	it("pricing guard parks an unsent report and retries it", async () => {
		await seedPricing(db);
		await setSetting(db, "ops.pricing_guard.enabled", true);
		await expect(
			runPricingGuard({
				db,
				now: monday,
				readStats: async () => stats,
				readPrices: async () => prices,
				deliver: async () => {
					throw new Error("down");
				},
			}),
		).resolves.toMatchObject({ status: "ran", delivery: "parked" });
		const messages: string[] = [];
		await expect(
			runPricingGuard({
				db,
				now: monday + 60_000,
				readStats: async () => stats,
				readPrices: async () => prices,
				deliver: async (text) => {
					messages.push(text);
				},
			}),
		).resolves.toEqual({ status: "done", retried: "sent" });
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("自动调价（事后通知）");
	});

	it("weekly report compares the last 7 days with the 7 before", async () => {
		await seedWeekly(db);
		const report = await buildWeeklyReport({
			db,
			now: monday,
			readStats: async () => stats,
		});
		expect(report.current).toEqual({
			orders: 3,
			directOrders: 2,
			agentOrders: 1,
			revenueMinor: 23000,
			directRevenueMinor: 15000,
			agentRevenueMinor: 8000,
			profitMinor: 6800,
			costMissing: 0,
		});
		expect(report.previous).toMatchObject({
			orders: 1,
			revenueMinor: 4000,
			profitMinor: 2000,
		});
		expect(report.repeat).toEqual({ customers: 2, repeatCustomers: 1 });
		expect(report.topSkus).toEqual([
			{ label: "ChatGPT · Plus", quantity: 2, profitMinor: 6000 },
			{ label: "ChatGPT · Pro", quantity: 1, profitMinor: 1000 },
		]);
		expect(report.promotions).toEqual({
			referralUses: 1,
			referralDiscountMinor: 500,
			recallUses: 0,
			recallDiscountMinor: 0,
			rewardsCreated: 1,
			rewardsCreatedMinor: 800,
			rewardsCredited: 1,
			rewardsCreditedMinor: 800,
		});
		const text = formatWeeklyReport(report);
		expect(text).toContain("📊 经营周报｜2026-10-12 ~ 2026-10-18");
		expect(text).toContain(
			"付款订单：3 单（+200.0%）；主站直销 2 单，代理 API 1 单",
		);
		expect(text).toContain("营业额：¥230.00（+475.0%）");
		expect(text).toContain("预估毛利：¥68.00（+240.0%");
		expect(text).toContain("平均每单毛利：¥22.67（上周 ¥20.00）");
		expect(text).toContain("30 天复购率：50.0%（1/2");
		expect(text).toContain("1. ChatGPT · Plus：2 件，毛利 ¥60.00");
		expect(text).toContain("邀请券用了 1 次（让利 ¥5.00）");
		expect(text).toContain(
			"· 86：余额 ¥5000.00，近 7 天消耗 ¥700.00，约剩 50.0 天",
		);

		const messages: string[] = [];
		const run = (now: number) =>
			runWeeklyReport({
				db,
				now,
				readStats: async () => stats,
				deliver: async (value) => {
					messages.push(value);
				},
			});
		await expect(run(monday)).resolves.toEqual({ status: "disabled" });
		await setSetting(db, "ops.weekly_report.enabled", true);
		await expect(run(monday - day)).resolves.toMatchObject({
			status: "waiting",
		});
		await expect(run(monday)).resolves.toMatchObject({
			status: "ran",
			delivery: "sent",
			orders: 3,
		});
		await expect(run(monday + hour)).resolves.toMatchObject({ status: "done" });
		expect(messages).toEqual([text]);
	});
});

async function setSetting(db: D1Database, key: string, value: unknown) {
	await db
		.prepare(
			`INSERT INTO system_settings (key, value, created_at, updated_at) VALUES (?, ?, 1, 1)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		)
		.bind(key, JSON.stringify(value))
		.run();
}

async function seedBase(db: D1Database) {
	await db.batch([
		db.prepare(
			`INSERT INTO payment_channels (id, provider, name, currency, fee_bps, enabled, created_at, updated_at)
			 VALUES ('usdt', 'epay', 'USDT', 'CNY', 0, 1, 1, 1),
			        ('alipay', 'epay', '支付宝', 'CNY', 200, 1, 1, 1)`,
		),
		db.prepare(
			`INSERT INTO users (id, name, email, email_verified, enabled, created_at, updated_at)
			 VALUES ('ref', 'Referrer', 'ref@example.com', 1, 1, 1, 1),
			        ('agent', 'Agent', 'agent@example.com', 1, 1, 1, 1)`,
		),
	]);
}

function product(db: D1Database, id: string, name: string) {
	return db
		.prepare(
			`INSERT INTO products (id, name, product_type, status, created_at, updated_at)
			 VALUES (?, ?, 'stock', 'active', 1, 1)`,
		)
		.bind(id, name);
}

function sellable(
	db: D1Database,
	id: string,
	productId: string,
	name: string,
	usdt: string,
	alipay: string,
) {
	return [
		db
			.prepare(
				`INSERT INTO product_sellable_items
				 (id, product_id, name, currency, currency_decimals, price_minor, created_at, updated_at)
				 VALUES (?, ?, ?, 'CNY', 2, ?, 1, 1)`,
			)
			.bind(id, productId, name, usdt),
		db
			.prepare(
				`INSERT INTO sellable_item_channel_prices (id, sellable_item_id, channel_id, price_minor, created_at, updated_at)
				 VALUES (?, ?, 'usdt', ?, 1, 1), (?, ?, 'alipay', ?, 1, 1)`,
			)
			.bind(`${id}-usdt`, id, usdt, `${id}-alipay`, id, alipay),
	];
}

function aisouBinding(
	db: D1Database,
	id: string,
	itemId: string,
	cost: string,
) {
	return db
		.prepare(
			`INSERT INTO supplier_bindings
			 (id, sellable_item_id, provider, normalized_api_origin, protocol_version,
			  upstream_product_id, upstream_sku_id, upstream_product_name, upstream_sku_name,
			  reference_cost_minor, max_cost_minor, enabled, created_at, updated_at)
			 VALUES (?, ?, 'shared_stock', 'https://aisou.pro', 'acg-sharedstock-v1',
			  'p', ?, 'P', 'S', ?, ?, 1, 1, 1)`,
		)
		.bind(id, itemId, id, cost, cost);
}

async function seedAisou(db: D1Database) {
	const recent = monday - day;
	const statements = [
		product(db, "aisou-product", "AISOU"),
		...sellable(db, "aisou-plus", "aisou-product", "Plus", "10400", "10500"),
		aisouBinding(db, "binding", "aisou-plus", "10000"),
		db.prepare(
			`INSERT INTO supplier_accounts
			 (id, provider, base_url, normalized_api_origin, protocol_version, currency,
			  currency_decimals, name, credentials_encrypted, credential_fingerprint,
			  balance_minor, enabled, created_at, updated_at)
			 VALUES ('aisou', 'shared_stock', 'https://aisou.pro', 'https://aisou.pro',
			  'acg-sharedstock-v1', 'CNY', 2, 'AISOU', 'encrypted', 'fp', '20000', 1, 1, 1)`,
		),
	];
	// 14 supplied purchases of ¥100 in the last week, plus one older one that must not count.
	for (let index = 0; index < 15; index += 1) {
		const created = index === 14 ? monday - 8 * day : recent;
		statements.push(
			...orderWithItem(db, `aisou-order-${index}`, {
				paidAt: created,
				total: "10400",
				itemId: "aisou-plus",
				productName: "AISOU",
				itemName: "Plus",
				unitCost: "10000",
			}),
			db
				.prepare(
					`INSERT INTO delivery_records (id, order_item_id, delivery_type, request_key, status, created_at, updated_at)
					 VALUES (?, ?, 'stock', ?, 'delivered', ?, ?)`,
				)
				.bind(
					`delivery-${index}`,
					`aisou-order-${index}-item`,
					`initial:${index}`,
					created,
					created,
				),
			db
				.prepare(
					`INSERT INTO supplier_orders
					 (id, order_id, order_item_id, delivery_record_id, supplier_binding_id, quantity,
					  quoted_unit_cost_minor, total_cost_minor, currency, binding_snapshot_json, state,
					  created_at, updated_at)
					 VALUES (?, ?, ?, ?, 'binding', 1, '10000', '10000', 'CNY', '{}', 'supplied', ?, ?)`,
				)
				.bind(
					`supplier-${index}`,
					`aisou-order-${index}`,
					`aisou-order-${index}-item`,
					`delivery-${index}`,
					created,
					created,
				),
		);
	}
	await db.batch(statements);
}

async function seedPricing(db: D1Database) {
	await db.batch([
		product(db, "gpt", "ChatGPT"),
		product(db, "claude-product", "Claude"),
		product(db, "aisou-product", "AISOU"),
		// Redeem-mapped, 86: needs +11% → proposal only.
		...sellable(db, "gpt-plus", "gpt", "Plus", "5300", "5500"),
		// Redeem-mapped, 86 has no restock source → skipped.
		...sellable(db, "gpt-pro", "gpt", "Pro 500", "100", "100"),
		// Redeem-mapped, 小九: USDT +4.9% → automatic.
		...sellable(db, "claude", "claude-product", "Pro", "14200", "15200"),
		// AISOU: only 支付宝 is short.
		...sellable(db, "aisou-plus", "aisou-product", "Plus", "10400", "10500"),
		aisouBinding(db, "binding-plus", "aisou-plus", "10000"),
		// AISOU: generous retail prices stay; the agent price is too thin.
		...sellable(db, "aisou-cheap", "aisou-product", "Cheap", "9900", "9900"),
		aisouBinding(db, "binding-cheap", "aisou-cheap", "1000"),
		db.prepare(
			`INSERT INTO supplier_export_listings (id, sellable_item_id, price_minor, currency, currency_decimals, enabled, created_at, updated_at)
			 VALUES ('listing', 'aisou-cheap', '1050', 'CNY', 2, 1, 1, 1)`,
		),
		db
			.prepare(
				"INSERT INTO system_settings (key, value, created_at, updated_at) VALUES ('integration.supply_console_map', ?, 1, 1)",
			)
			.bind(
				JSON.stringify({
					"gpt-plus": "GPT_PLUS",
					"gpt-pro": "GPT_PRO",
					claude: "CLAUDE_PRO",
				}),
			),
	]);
}

function orderWithItem(
	db: D1Database,
	id: string,
	input: {
		paidAt: number;
		total: string;
		itemId: string;
		productName: string;
		itemName: string;
		unitCost: string;
		email?: string;
	},
) {
	return [
		db
			.prepare(
				`INSERT INTO shop_orders
				 (id, order_number, status, contact_email, normalized_contact_email, currency,
				  currency_decimals, subtotal_minor, total_minor, paid_minor, expires_at, paid_at,
				  created_at, updated_at)
				 VALUES (?, ?, 'completed', ?, ?, 'CNY', 2, ?, ?, ?, 9999999999999, ?, ?, ?)`,
			)
			.bind(
				id,
				`GM-${id}`,
				input.email ?? null,
				input.email ?? null,
				input.total,
				input.total,
				input.total,
				input.paidAt,
				input.paidAt,
				input.paidAt,
			),
		db
			.prepare(
				`INSERT INTO shop_order_items
				 (id, order_id, product_id, sellable_item_id, product_name, delivery_component_id,
				  delivery_component_type, delivery_component_version, sellable_item_name, quantity,
				  unit_price_minor, unit_cost_minor, subtotal_minor, created_at, updated_at)
				 SELECT ?, ?, product_id, id, ?, id, 'stock', 1, ?, 1, ?, ?, ?, 1, 1
				 FROM product_sellable_items WHERE id = ?`,
			)
			.bind(
				`${id}-item`,
				id,
				input.productName,
				input.itemName,
				input.total,
				input.unitCost,
				input.total,
				input.itemId,
			),
	];
}

async function seedWeekly(db: D1Database) {
	const current = monday - 2 * day;
	const previous = monday - 9 * day;
	await db.batch([
		product(db, "gpt", "ChatGPT"),
		...sellable(db, "plus", "gpt", "Plus", "10000", "10000"),
		...sellable(db, "pro", "gpt", "Pro", "8000", "8000"),
		...orderWithItem(db, "o1", {
			paidAt: current,
			total: "10000",
			itemId: "plus",
			productName: "ChatGPT",
			itemName: "Plus",
			unitCost: "6000",
			email: "a@example.com",
		}),
		...orderWithItem(db, "o2", {
			paidAt: current + hour,
			total: "5000",
			itemId: "plus",
			productName: "ChatGPT",
			itemName: "Plus",
			unitCost: "3000",
			email: "a@example.com",
		}),
		...orderWithItem(db, "o3", {
			paidAt: current,
			total: "8000",
			itemId: "pro",
			productName: "ChatGPT",
			itemName: "Pro",
			unitCost: "7000",
			email: "agent@example.com",
		}),
		...orderWithItem(db, "o4", {
			paidAt: previous,
			total: "4000",
			itemId: "plus",
			productName: "ChatGPT",
			itemName: "Plus",
			unitCost: "2000",
			email: "b@example.com",
		}),
		// o1 paid by 支付宝 (2% fee); o2 by wallet (no fee).
		db
			.prepare(
				`INSERT INTO payment_attempts (id, order_id, channel_id, idempotency_key, status, amount_minor, currency, succeeded_at, created_at, updated_at)
				 VALUES ('pay-o1', 'o1', 'alipay', 'pay-o1', 'succeeded', '10000', 'CNY', ?, ?, ?)`,
			)
			.bind(current, current, current),
		db.prepare(
			"INSERT INTO supplier_api_keys (id, user_id, name, key_id, secret_encrypted, created_at, updated_at) VALUES ('key', 'agent', 'Agent', 'gme_agent', 'x', 1, 1)",
		),
		db
			.prepare(
				"INSERT INTO supplier_api_orders (id, shop_order_id, user_id, api_key_id, downstream_order_no, request_digest, created_at, updated_at) VALUES ('api-o3', 'o3', 'agent', 'key', 'DJ-1', 'digest', ?, ?)",
			)
			.bind(current, current),
		db.prepare(
			`INSERT INTO coupons (id, code, name, type, currency, currency_decimals, value_minor, purpose, referrer_user_id, created_at, updated_at)
			 VALUES ('ref-coupon', 'REF', 'Referral', 'fixed', 'CNY', 2, '500', 'referral', 'ref', 1, 1)`,
		),
		db
			.prepare(
				`INSERT INTO coupon_redemptions (id, coupon_id, order_id, normalized_email, discount_minor, status, consumed_at, created_at, updated_at)
				 VALUES ('redemption', 'ref-coupon', 'o1', 'a@example.com', '500', 'consumed', ?, ?, ?)`,
			)
			.bind(current, current, current),
		db
			.prepare(
				`INSERT INTO promotion_rewards (order_id, user_id, amount_minor, remaining_minor, state, available_at, created_at, updated_at)
				 VALUES ('o1', 'ref', '800', '800', 'available', ?, ?, ?)`,
			)
			.bind(current + hour, current, current + hour),
	]);
}
