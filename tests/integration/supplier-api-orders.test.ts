import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SupplierApiIdentity } from "#/features/supplier-api/server/auth";
import {
	cancelSupplierApiOrder,
	createSupplierApiOrder,
	getSupplierApiOrder,
} from "#/features/supplier-api/server/orders";
import { mutateWallet } from "#/features/wallet/server/ledger";
import { applyMigrations } from "./migrations";

const userId = "00000000-0000-4000-8000-000000000001";
const identity: SupplierApiIdentity = {
	userId,
	keyId: "gme_key",
	keyRowId: "api-key-1",
	allowedCallbackOrigin: null,
};

describe("supplier API orders", { timeout: 60_000 }, () => {
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
		await db.batch([
			db.prepare(
				`INSERT INTO users (id, name, email, email_verified, enabled, created_at, updated_at)
				 VALUES ('${userId}', 'Reseller', 'reseller@example.com', 1, 1, 1, 1)`,
			),
			db.prepare(
				`INSERT INTO supplier_api_keys (id, user_id, name, key_id, secret_encrypted, created_at, updated_at)
				 VALUES ('api-key-1', '${userId}', 'Key', 'gme_key', 'ciphertext', 1, 1)`,
			),
			db.prepare(
				`INSERT INTO products (id, name, product_type, status, sort_order, created_at, updated_at)
				 VALUES ('product-card', 'Card', 'stock', 'active', 100, 1, 1)`,
			),
			db.prepare(
				`INSERT INTO product_sellable_items
				 (id, product_id, name, currency, currency_decimals, price_minor, minimum_quantity,
				  maximum_quantity, sort_order, enabled, fulfillment_source, created_at, updated_at)
				 VALUES ('sku-1', 'product-card', 'Default', 'USD', 2, '300', 1, 10, 100, 1, 'local', 1, 1)`,
			),
			db.prepare(
				`INSERT INTO stock_entries
				 (id, sellable_item_id, content_encrypted, key_version, content_fingerprint, content_mask,
				  status, created_at, updated_at)
				 VALUES ('card-1', 'sku-1', 'ciphertext-1', 1, 'fp-1', '••••1', 'available', 1, 1),
				        ('card-2', 'sku-1', 'ciphertext-2', 1, 'fp-2', '••••2', 'available', 1, 1)`,
			),
		]);
	});

	afterEach(async () => miniflare.dispose());

	it("refuses an order the balance cannot cover without leaving any order behind", async () => {
		await expect(
			createSupplierApiOrder(db, identity, {
				skuId: "sku-1",
				quantity: 1,
				downstreamOrderNo: "down-1",
			}),
		).rejects.toMatchObject({ code: "wallet_insufficient_balance" });
		const counts = await db
			.prepare(
				`SELECT (SELECT COUNT(*) FROM shop_orders) AS orders,
				 (SELECT COUNT(*) FROM supplier_api_orders) AS api_orders`,
			)
			.first();
		expect(counts).toEqual({ orders: 0, api_orders: 0 });
	});

	it("debits the wallet, starts fulfillment, and replays idempotently", async () => {
		await mutateWallet(db, credit("1000", "topup-1"));
		const created = await createSupplierApiOrder(db, identity, {
			skuId: "sku-1",
			quantity: 1,
			downstreamOrderNo: "down-2",
		});
		expect(created).toMatchObject({ ok: true, status: "processing" });
		const replay = await createSupplierApiOrder(db, identity, {
			skuId: "sku-1",
			quantity: 1,
			downstreamOrderNo: "down-2",
		});
		expect(replay).toEqual(created);
		const state = await db
			.prepare(
				`SELECT (SELECT balance_minor FROM users WHERE id = ?) AS balance,
				 (SELECT COUNT(*) FROM shop_orders WHERE status = 'paid') AS paid_orders,
				 (SELECT COUNT(*) FROM delivery_records WHERE status = 'pending') AS deliveries,
				 (SELECT COUNT(*) FROM stock_entries WHERE status = 'reserved') AS reserved`,
			)
			.bind(userId)
			.first();
		expect(state).toEqual({
			balance: "700",
			paid_orders: 1,
			deliveries: 1,
			reserved: 1,
		});
		await expect(
			getSupplierApiOrder(db, userId, String(created.order_id)),
		).resolves.toMatchObject({ status: "processing" });
	});

	it("refunds the wallet in the same batch as the cancellation and never twice", async () => {
		await mutateWallet(db, credit("1000", "topup-2"));
		const created = await createSupplierApiOrder(db, identity, {
			skuId: "sku-1",
			quantity: 2,
			downstreamOrderNo: "down-3",
		});
		const apiOrderId = String(created.order_id);
		await expect(
			cancelSupplierApiOrder(db, userId, apiOrderId),
		).resolves.toMatchObject({ status: "cancelled" });
		await expect(
			cancelSupplierApiOrder(db, userId, apiOrderId),
		).resolves.toMatchObject({ status: "cancelled" });
		const state = await db
			.prepare(
				`SELECT (SELECT balance_minor FROM users WHERE id = ?) AS balance,
				 (SELECT COUNT(*) FROM wallet_entries WHERE source_type = 'refund') AS refunds,
				 (SELECT COUNT(*) FROM stock_entries WHERE status = 'available') AS available,
				 (SELECT status FROM shop_orders) AS order_status,
				 (SELECT state FROM supplier_api_orders) AS api_state`,
			)
			.bind(userId)
			.first();
		expect(state).toEqual({
			balance: "1000",
			refunds: 1,
			available: 2,
			order_status: "cancelled",
			api_state: "cancelled",
		});
		await expect(
			getSupplierApiOrder(db, userId, apiOrderId),
		).resolves.toMatchObject({ status: "cancelled" });
	});

	it("keeps cancellation and refund atomic under concurrent wallet activity", async () => {
		await mutateWallet(db, credit("1000", "topup-race"));
		const created = await createSupplierApiOrder(db, identity, {
			skuId: "sku-1",
			quantity: 1,
			downstreamOrderNo: "down-race",
		});
		const apiOrderId = String(created.order_id);
		// A concurrent top-up moves the balance snapshot while the cancel runs.
		const outcomes = await Promise.allSettled([
			cancelSupplierApiOrder(db, userId, apiOrderId),
			mutateWallet(db, credit("5", "topup-race-2")),
		]);
		// A cancel that lost the race must have applied nothing, so a retry
		// completes it; a cancel that won already refunded.
		if (outcomes[0]?.status === "rejected") {
			expect(outcomes[0].reason).toMatchObject({ code: "wallet_conflict" });
			const pending = await db
				.prepare(
					"SELECT status FROM shop_orders WHERE id = (SELECT shop_order_id FROM supplier_api_orders WHERE id = ?)",
				)
				.bind(apiOrderId)
				.first<{ status: string }>();
			expect(pending?.status).toBe("paid");
			await cancelSupplierApiOrder(db, userId, apiOrderId);
		}
		const state = await db
			.prepare(
				`SELECT (SELECT balance_minor FROM users WHERE id = ?) AS balance,
				 (SELECT COUNT(*) FROM wallet_entries WHERE source_type = 'refund') AS refunds,
				 (SELECT status FROM shop_orders WHERE id = (SELECT shop_order_id FROM supplier_api_orders WHERE id = ?)) AS order_status,
				 (SELECT state FROM supplier_api_orders WHERE id = ?) AS api_state`,
			)
			.bind(userId, apiOrderId, apiOrderId)
			.first();
		expect(state).toEqual({
			balance: "1005",
			refunds: 1,
			order_status: "cancelled",
			api_state: "cancelled",
		});
	});

	it("credits a legacy cancellation that never received its refund exactly once", async () => {
		await mutateWallet(db, credit("1000", "topup-3"));
		const created = await createSupplierApiOrder(db, identity, {
			skuId: "sku-1",
			quantity: 1,
			downstreamOrderNo: "down-4",
		});
		const apiOrderId = String(created.order_id);
		// Simulate the old code path: cancelled rows without the wallet credit.
		await db.batch([
			db
				.prepare(
					"UPDATE supplier_api_orders SET state = 'cancelled' WHERE id = ?",
				)
				.bind(apiOrderId),
			db
				.prepare(
					"UPDATE shop_orders SET status = 'cancelled' WHERE id = (SELECT shop_order_id FROM supplier_api_orders WHERE id = ?)",
				)
				.bind(apiOrderId),
		]);
		await cancelSupplierApiOrder(db, userId, apiOrderId);
		await cancelSupplierApiOrder(db, userId, apiOrderId);
		const state = await db
			.prepare(
				`SELECT (SELECT balance_minor FROM users WHERE id = ?) AS balance,
				 (SELECT COUNT(*) FROM wallet_entries WHERE source_type = 'refund') AS refunds`,
			)
			.bind(userId)
			.first();
		expect(state).toEqual({ balance: "1000", refunds: 1 });
	});
});

function credit(amountMinor: string, idempotencyKey: string) {
	return {
		userId,
		direction: "credit" as const,
		amountMinor,
		currency: "USD",
		sourceType: "topup" as const,
		sourceId: "test",
		idempotencyKey,
	};
}
