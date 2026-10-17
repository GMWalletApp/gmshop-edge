import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	formatFeishuOwnerSaleAlert,
	formatStockLines,
	publishPendingOwnerSaleAlerts,
} from "#/features/notifications/server/owner-sale-alerts";
import { applyMigrations } from "./migrations";

describe("owner sale alerts", { timeout: 30_000 }, () => {
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
		await seedSale(db);
	});

	afterEach(async () => miniflare.dispose());

	it("sends one idempotent sale message with the current Aisou balance", async () => {
		const messages: string[] = [];
		await expect(
			publishPendingOwnerSaleAlerts({
				db,
				now: Date.parse("2026-09-02T13:00:00Z"),
				readBalance: async () => ({
					amountMinor: "46700",
					currency: "CNY",
					currencyDecimals: 2,
					fresh: true,
				}),
				deliver: async (text) => {
					messages.push(text);
				},
			}),
		).resolves.toEqual({ scanned: 1, sent: 1, deferred: 0, failed: 0 });
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("💰 新订单｜主站");
		expect(messages[0]).toContain("商品：ChatGPT会员 · Plus菲区 × 1");
		expect(messages[0]).toContain("售价：¥119.00");
		expect(messages[0]).toContain("客户邮箱：未填写");
		expect(messages[0]).toContain("货源：人工采购");
		await expect(
			publishPendingOwnerSaleAlerts({
				db,
				readBalance: async () => null,
				deliver: async (text) => {
					messages.push(text);
				},
			}),
		).resolves.toEqual({ scanned: 0, sent: 0, deferred: 0, failed: 0 });
		expect(messages).toHaveLength(1);
	});

	it("sends once when three publishers race for the same event", async () => {
		const messages: string[] = [];
		const results = await Promise.all(
			Array.from({ length: 3 }, () =>
				publishPendingOwnerSaleAlerts({
					db,
					now: 100_000,
					readBalance: async () => null,
					deliver: async (text) => {
						messages.push(text);
					},
				}),
			),
		);
		expect(messages).toHaveLength(1);
		expect(results.reduce((sum, result) => sum + result.sent, 0)).toBe(1);
	});

	it("reclaims an expired lease but not an active lease", async () => {
		await db.prepare("UPDATE outbox_events SET next_attempt_at = 120000").run();
		const messages: string[] = [];
		const publish = (now: number) =>
			publishPendingOwnerSaleAlerts({
				db,
				now,
				readBalance: async () => null,
				deliver: async (text) => {
					messages.push(text);
				},
			});
		expect((await publish(119999)).scanned).toBe(0);
		expect((await publish(120000)).sent).toBe(1);
		expect(messages).toHaveLength(1);
	});

	it("releases a failed send for a bounded retry", async () => {
		const result = await publishPendingOwnerSaleAlerts({
			db,
			now: 100000,
			readBalance: async () => null,
			deliver: async () => {
				throw new Error("transport failed");
			},
		});
		expect(result.failed).toBe(1);
		const publish = (now: number) =>
			publishPendingOwnerSaleAlerts({
				db,
				now,
				readBalance: async () => null,
				deliver: async () => {},
			});
		expect((await publish(114999)).scanned).toBe(0);
		expect((await publish(115000)).sent).toBe(1);
	});

	it("waits for automatic supply before reading the post-purchase balance", async () => {
		await seedPendingSupplierOrder(db);
		const balances: string[] = [];
		const messages: string[] = [];
		const now = Date.parse("2026-09-02T13:00:00Z");
		await expect(
			publishPendingOwnerSaleAlerts({
				db,
				now,
				readBalance: async () => {
					balances.push("read");
					return null;
				},
				deliver: async (text) => {
					messages.push(text);
				},
			}),
		).resolves.toEqual({ scanned: 1, sent: 0, deferred: 1, failed: 0 });
		expect(balances).toHaveLength(0);
		expect(messages).toHaveLength(0);

		await db
			.prepare(
				"UPDATE supplier_orders SET state = 'supplied' WHERE id = 'supplier-order'",
			)
			.run();
		await expect(
			publishPendingOwnerSaleAlerts({
				db,
				now: now + 15_000,
				readBalance: async () => ({
					amountMinor: "38500",
					currency: "CNY",
					currencyDecimals: 2,
					fresh: true,
				}),
				deliver: async (text) => {
					messages.push(text);
				},
			}),
		).resolves.toEqual({ scanned: 1, sent: 1, deferred: 0, failed: 0 });
		expect(messages[0]).toContain("货源：钱包额度下单");
		expect(messages[0]).toContain("采购钱包余额：¥385.00");
	});

	it("uses the order wallet ledger and allocated stock instead of current mutable state", async () => {
		const messages: string[] = [];
		await db.batch([
			db.prepare(
				`INSERT INTO users
				 (id, name, email, email_verified, preferred_locale, enabled,
				  balance_minor, balance_version, role_ids, created_at, updated_at)
				 VALUES ('wallet-user', 'Wallet User', 'wallet@example.com', 1, 'zh-CN', 1,
				  '111', 2, '[]', 1, 2)`,
			),
			db.prepare(
				`UPDATE shop_orders SET user_id='wallet-user', contact_email='wallet@example.com'
				 WHERE id='order'`,
			),
			db.prepare(
				`INSERT INTO wallet_entries
				 (id, user_id, direction, amount_minor, balance_before_minor,
				  balance_after_minor, currency, source_type, source_id,
				  idempotency_key, created_at)
				 VALUES ('wallet-order', 'wallet-user', 'debit', '11900', '12899',
				  '999', 'CNY', 'shop_order', 'order', 'wallet-order:order', 1)`,
			),
			db.prepare(
				`UPDATE product_sellable_items SET fulfillment_source='local',
				 cost_minor='11500' WHERE id='sellable'`,
			),
			db.prepare(
				`UPDATE shop_order_items SET unit_cost_minor='11500' WHERE id='item'`,
			),
			db.prepare(
				`INSERT INTO stock_entries
				 (id, sellable_item_id, content_encrypted, key_version,
				  content_fingerprint, content_mask, status, order_item_id,
				  unit_cost_minor, created_at, updated_at)
				 VALUES ('allocated-stock', 'sellable', 'ciphertext', 1,
				  'fingerprint', '••••1234', 'delivered', 'item', '11500', 1, 1)`,
			),
		]);
		await publishPendingOwnerSaleAlerts({
			db,
			readBalance: async () => null,
			deliver: async (text) => {
				messages.push(text);
			},
		});
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("客户邮箱：wallet@example.com");
		expect(messages[0]).toContain("用户钱包");
		expect(messages[0]).toContain("余额 ¥9.99");
		expect(messages[0]).not.toContain("¥1.11");
		expect(messages[0]).toContain("货源：内置库存");
		expect(messages[0]).toContain("成本：¥115.00");
		expect(messages[0]).toContain("利润：¥4.00");
	});

	it("waits for the warehouse's real cost of an owned code, then reports it", async () => {
		await db.batch([
			db.prepare(
				`INSERT INTO system_settings (key, value, updated_at)
				 VALUES ('integration.supply_console_map', '{"sellable":"GPT_PLUS_IOS"}', 1)`,
			),
			db.prepare(
				`UPDATE product_sellable_items SET fulfillment_source='local' WHERE id='sellable'`,
			),
			db.prepare(
				`INSERT INTO stock_entries
				 (id, sellable_item_id, content_encrypted, key_version,
				  content_fingerprint, content_mask, status, order_item_id,
				  unit_cost_minor, created_at, updated_at)
				 VALUES ('owned-code', 'sellable', 'ciphertext', 1,
				  'fingerprint', '••••1234', 'delivered', 'item', '10000', 1, 1)`,
			),
		]);
		const created = Number(
			(
				await db
					.prepare(
						"SELECT created_at FROM outbox_events WHERE event_type='owner.sale_alert'",
					)
					.first<{ created_at: number }>()
			)?.created_at,
		);
		const messages: string[] = [];
		const publish = (now: number) =>
			publishPendingOwnerSaleAlerts({
				db,
				now,
				readBalance: async () => null,
				readWarehouse: async () => ({
					balance: "1620.5",
					skus: { GPT_PLUS_IOS: { available: 0, autoRestock: true } },
				}),
				deliver: async (text) => {
					messages.push(text);
				},
			});
		expect((await publish(created + 1_000)).deferred).toBe(1);
		expect(messages).toHaveLength(0);
		await db
			.prepare(
				"UPDATE stock_entries SET cost_source='warehouse_bought', unit_cost_minor='12200', cost_note='86订单 503426098423060557' WHERE id='owned-code'",
			)
			.run();
		expect((await publish(created + 60_000)).sent).toBe(1);
		expect(messages[0]).toContain(
			"货源：86 自动采购（86订单 503426098423060557）",
		);
		expect(messages[0]).toContain("成本：¥122.00");
		expect(messages[0]).not.toContain("¥100.00");
		expect(messages[0]).toContain(
			"卖出后库存：\n· ChatGPT会员 · Plus菲区：前台可售 0｜真实凭证 0（用完自动从 86 进货）\n86 余额：¥1620.50",
		);
	});

	it("flags a failed 86 restock and never guesses the cost", async () => {
		await db.batch([
			db.prepare(
				`INSERT INTO stock_entries
				 (id, sellable_item_id, content_encrypted, key_version,
				  content_fingerprint, content_mask, status, order_item_id,
				  unit_cost_minor, cost_source, cost_note, created_at, updated_at)
				 VALUES ('owned-code', 'sellable', 'ciphertext', 1,
				  'fingerprint', '••••1234', 'delivered', 'item', '10000',
				  'warehouse_unavailable', 'trade_refused: 该商品未开放对接', 1, 1)`,
			),
		]);
		const messages: string[] = [];
		await publishPendingOwnerSaleAlerts({
			db,
			readBalance: async () => null,
			deliver: async (text) => {
				messages.push(text);
			},
		});
		expect(messages[0]).toContain(
			"⚠️ 86 补货失败，请手动补卡（trade_refused: 该商品未开放对接）",
		);
		expect(messages[0]).toContain("成本：待确认\n利润：待确认");
	});
});

it("formats cached balances explicitly", () => {
	const text = formatFeishuOwnerSaleAlert(
		{
			order_number: "GMTEST",
			order_status: "paid",
			currency: "CNY",
			currency_decimals: 2,
			total_minor: "4000",
			contact_email: "buyer@example.com",
			items_summary: "Grok会员 · SuperGrok 3个月 × 1",
			cost_total_minor: "3300",
			cost_missing_count: 0,
			local_fulfilled_count: 1,
			supplier_fulfilled_count: 0,
			local_stock_remaining_summary: "SuperGrok 3个月 2",
			supplier_item_count: 0,
			manual_item_count: 1,
			supplier_pending_count: 0,
			supplier_failed_count: 0,
			payment_channel: "支付宝",
			payment_amount_minor: "4167",
			payment_currency: "CNY",
			payment_currency_decimals: 2,
			payment_fee_bps: 400,
			payment_fixed_fee_minor: "0",
			wallet_balance_after_minor: null,
			internal_supply_count: 1,
			downstream_order_no: "DJ-INTERNAL-1",
			owned_cost_pending_count: 0,
			owned_cost_sources: null,
			owned_cost_notes: null,
		},
		{
			amountMinor: "50000",
			currency: "CNY",
			currencyDecimals: 2,
			fresh: false,
		},
	);
	expect(text).toContain("实付 ¥41.67");
	expect(text).toContain("手续费 ¥1.67 用户承担");
	expect(text).toContain("货源：内置库存");
	expect(text).toContain("💰 新订单｜代理站 lsrai.shop");
	expect(text).toContain("代理站订单：DJ-INTERNAL-1");
	expect(text).toContain("卡网订单：GMTEST");
	expect(text).toContain("下单客户：未回传");
	expect(text).not.toContain("buyer@example.com");
	expect(text).not.toContain("子站");
	expect(text).toContain("利润：¥7.00（主站这一层）");
});

it("subtracts a seller-borne channel fee from owner profit", () => {
	const text = formatFeishuOwnerSaleAlert(
		{
			order_number: "GMSELLERFEE",
			order_status: "completed",
			currency: "CNY",
			currency_decimals: 2,
			total_minor: "4500",
			contact_email: "buyer@example.com",
			items_summary: "ChatGPT 会员充值 · ChatGPT Go 1个月 × 1",
			cost_total_minor: "3500",
			cost_missing_count: 0,
			local_fulfilled_count: 0,
			supplier_fulfilled_count: 1,
			local_stock_remaining_summary: "ChatGPT Go 1个月 48",
			supplier_item_count: 1,
			manual_item_count: 0,
			supplier_pending_count: 0,
			supplier_failed_count: 0,
			payment_channel: "支付宝",
			payment_amount_minor: "4500",
			payment_currency: "CNY",
			payment_currency_decimals: 2,
			payment_fee_bps: 160,
			payment_fixed_fee_minor: "0",
			wallet_balance_after_minor: null,
			internal_supply_count: 0,
			downstream_order_no: null,
			owned_cost_pending_count: 0,
			owned_cost_sources: null,
			owned_cost_notes: null,
		},
		null,
	);
	expect(text).toContain("实付 ¥45.00");
	expect(text).toContain("手续费 ¥0.72 我们承担");
	expect(text).toContain("利润：¥9.28");
});

async function seedSale(db: D1Database) {
	await db.batch([
		db.prepare(
			`INSERT INTO products
			 (id, name, product_type, status, created_at, updated_at)
			 VALUES ('product', 'ChatGPT会员', 'stock', 'active', 1, 1)`,
		),
		db.prepare(
			`INSERT INTO product_sellable_items
			 (id, product_id, name, fulfillment_source, supplier_status,
			  currency, currency_decimals, price_minor, created_at, updated_at)
			 VALUES ('sellable', 'product', 'Plus菲区', 'manual', NULL,
			  'CNY', 2, '11900', 1, 1)`,
		),
		db.prepare(
			`INSERT INTO shop_orders
			 (id, order_number, status, currency, currency_decimals, subtotal_minor,
			  total_minor, paid_minor, expires_at, paid_at, created_at, updated_at)
			 VALUES ('order', 'GMTEST', 'paid', 'CNY', 2, '11900', '11900',
			  '11900', 9999999999999, 1, 1, 1)`,
		),
		db.prepare(
			`INSERT INTO shop_order_items
			 (id, order_id, product_id, sellable_item_id, product_name,
			  delivery_component_id, delivery_component_type,
			  delivery_component_version, sellable_item_name, quantity,
			  unit_price_minor, subtotal_minor, created_at, updated_at)
			 VALUES ('item', 'order', 'product', 'sellable', 'ChatGPT会员',
			  'sellable', 'stock', 1, 'Plus菲区', 1, '11900', '11900', 1, 1)`,
		),
		db.prepare(
			`INSERT INTO outbox_events
			 (id, event_type, aggregate_type, aggregate_id, idempotency_key,
			  payload, status, attempt_count, created_at, updated_at)
			 VALUES ('alert', 'owner.sale_alert', 'shop_order', 'order', 'owner-sale-order:order',
			  '{"orderId":"order"}', 'pending', 0, 1, 1)`,
		),
	]);
}

async function seedPendingSupplierOrder(db: D1Database) {
	await db.batch([
		db.prepare(
			`UPDATE product_sellable_items SET fulfillment_source = 'supplier',
			 supplier_status = 'available' WHERE id = 'sellable'`,
		),
		db.prepare(
			`INSERT INTO supplier_bindings
			 (id, sellable_item_id, provider, normalized_api_origin,
			  protocol_version, upstream_product_id, upstream_sku_id,
			  upstream_product_name, upstream_sku_name, reference_cost_minor,
			  max_cost_minor, stock_quantity, remote_status, last_synced_at,
			  enabled, created_at, updated_at)
			 VALUES ('binding', 'sellable', 'shared_stock', 'https://aisou.pro',
			  'acg-sharedstock-v1', 'product', 'sku', 'Product', 'SKU', '11500',
			  '12000', 10, 'active', 1, 1, 1, 1)`,
		),
		db.prepare(
			`INSERT INTO delivery_records
			 (id, order_item_id, delivery_type, request_key, status, created_at, updated_at)
			 VALUES ('delivery', 'item', 'stock', 'initial:item',
			  'awaiting_supply', 1, 1)`,
		),
		db.prepare(
			`INSERT INTO supplier_orders
			 (id, order_id, order_item_id, delivery_record_id, supplier_binding_id,
			  quantity, currency, binding_snapshot_json, state, created_at, updated_at)
			 VALUES ('supplier-order', 'order', 'item', 'delivery', 'binding', 1,
			  'CNY', '{}', 'pending', 1, 1)`,
		),
	]);
}

it("names the sub-site, its parent order and the real customer", () => {
	const base = {
		order_number: "APITEST",
		order_status: "paid",
		currency: "CNY",
		currency_decimals: 2,
		total_minor: "11900",
		contact_email: "api-account@example.com",
		items_summary: "ChatGPT会员 · Plus × 1",
		cost_total_minor: "11500",
		cost_missing_count: 0,
		local_fulfilled_count: 1,
		supplier_fulfilled_count: 0,
		local_stock_remaining_summary: null,
		supplier_item_count: 0,
		manual_item_count: 0,
		supplier_pending_count: 0,
		supplier_failed_count: 0,
		payment_channel: null,
		payment_amount_minor: null,
		payment_currency: null,
		payment_currency_decimals: null,
		payment_fee_bps: null,
		payment_fixed_fee_minor: null,
		wallet_balance_after_minor: "50000",
		internal_supply_count: 1,
		downstream_order_no: "DJ20261016005006527976-01",
		owned_cost_pending_count: 0,
		owned_cost_sources: null,
		owned_cost_notes: null,
	};
	const sub = formatFeishuOwnerSaleAlert(
		{
			...base,
			downstream_site_host: "777.lsrai.shop",
			downstream_parent_order_no: "DJ20261016005006527976",
			downstream_buyer_email: "buyer@example.com",
		},
		null,
	);
	expect(sub).toContain("💰 新订单｜子站 777.lsrai.shop");
	expect(sub).toContain("\n子站订单：DJ20261016005006527976\n");
	expect(sub).toContain("下单客户：buyer@example.com");
	expect(sub).toContain("支付：lsrai.shop 钱包扣款，余额 ¥500.00");
	expect(sub).not.toContain("api-account@example.com");
	expect(sub).not.toContain("代理站订单");

	// Older lsrai.shop builds send only the child order number.
	const main = formatFeishuOwnerSaleAlert(base, null);
	expect(main).toContain("💰 新订单｜代理站 lsrai.shop");
	expect(main).toContain("代理站订单：DJ20261016005006527976\n");
	expect(main).not.toContain("子站");
});

it("shows storefront codes, real 86 credentials and a low-stock warning", () => {
	const item = {
		fulfillment_source: "local",
		low_stock_threshold: 2,
	};
	expect(
		formatStockLines(
			[
				{
					...item,
					name: "Claude · Pro",
					front_available: 92,
					redeem_sku: "CLAUDE_PRO_IOS",
				},
				{
					...item,
					name: "算力卡 · ¥50",
					front_available: 29,
					redeem_sku: null,
				},
				{
					...item,
					name: "Plus · 菲区",
					front_available: 68,
					redeem_sku: "GPT_PLUS_PH",
				},
			],
			{
				balance: "1742",
				skus: { CLAUDE_PRO_IOS: { available: 1, autoRestock: false } },
			},
		),
	).toEqual([
		"· Claude · Pro：前台可售 92｜真实凭证 1 ⚠️",
		"· 算力卡 · ¥50：剩余卡密 29",
		"· Plus · 菲区：前台可售 68｜真实凭证 读取失败 ⚠️",
		"86 余额：¥1742.00",
	]);
});
