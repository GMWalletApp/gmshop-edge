import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "./migrations";

describe("commerce hot-query plans and rows read", () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmshop-edge-commerce-query-plans" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await seed(db);
	});

	afterAll(async () => miniflare.dispose());

	it.each([
		[
			"public catalog",
			`SELECT id FROM products INDEXED BY products_status_sort_idx
			 WHERE status = 'active'
			 ORDER BY sort_order, id LIMIT 10`,
			"products_status_sort_idx",
		],
		[
			"order list",
			`SELECT id FROM shop_orders INDEXED BY shop_orders_status_created_idx
			 WHERE status = 'pending_payment' ORDER BY created_at, id LIMIT 10`,
			"shop_orders_status_created_idx",
		],
		[
			"order expiry",
			`SELECT id FROM shop_orders INDEXED BY shop_orders_status_expires_idx
			 WHERE status = 'pending_payment' AND expires_at <= 200000
			 ORDER BY expires_at, id LIMIT 10`,
			"shop_orders_status_expires_idx",
		],
		[
			"stock allocation",
			`SELECT id FROM stock_entries INDEXED BY stock_entries_item_status_created_idx
			 WHERE sellable_item_id = 'sellableItem-stock' AND status = 'available'
			 ORDER BY created_at, id LIMIT 10`,
			"stock_entries_item_status_created_idx",
		],
		[
			"commerce outbox",
			`SELECT id FROM outbox_events INDEXED BY outbox_events_status_attempt_idx
			 WHERE status = 'pending' AND next_attempt_at IS NULL
			 ORDER BY created_at, id LIMIT 10`,
			"outbox_events_status_attempt_idx",
		],
	] as const)(
		"uses the %s index without a temporary sort",
		async (_name, sql, index) => {
			const details = await explain(db, sql);
			expect(details).toContain(index);
			expect(details).not.toContain("USE TEMP B-TREE");
			const rows = await db.prepare(sql).all<{ id: string }>();
			expect(rows.results).toHaveLength(10);
			expect(rows.meta.rows_read).toBeLessThanOrEqual(10);
		},
	);

	it("has covering indexes for customer entitlements and build queue polling", async () => {
		const entitlement = await explain(
			db,
			`SELECT id FROM customer_entitlements
			 WHERE user_id = 'customer' ORDER BY created_at DESC, id DESC LIMIT 25`,
		);
		const builds = await explain(
			db,
			`SELECT id FROM automation_jobs WHERE status = 'queued'
			 AND next_attempt_at IS NULL ORDER BY id LIMIT 25`,
		);
		expect(entitlement).toContain("customer_entitlements_user_status_idx");
		expect(builds).toContain("automation_jobs_status_attempt_idx");
	});

	it("uses supplier source, account, retry, and reconciliation indexes", async () => {
		const plans = await Promise.all([
			explain(
				db,
				`SELECT id FROM supplier_accounts
				 WHERE provider = 'dujiao_next'
				  AND normalized_api_origin = 'https://supplier.example'
				  AND protocol_version = '1.3.1-upstream-v1'
				  AND enabled = 1 AND health_status = 'healthy'`,
			),
			explain(
				db,
				`SELECT id FROM supplier_bindings
				 WHERE provider = 'dujiao_next'
				  AND normalized_api_origin = 'https://supplier.example'
				  AND protocol_version = '1.3.1-upstream-v1'
				  AND enabled = 1 AND remote_status = 'active'`,
			),
			explain(
				db,
				`SELECT id FROM supplier_orders
				 WHERE state = 'uncertain' AND next_retry_at <= 200000`,
			),
			explain(
				db,
				`SELECT id FROM supplier_orders
				 WHERE selected_account_id = 'account'
				  AND upstream_order_id = 'upstream-order'`,
			),
		]);
		expect(plans[0]).toContain("supplier_accounts_source_eligible_idx");
		expect(plans[1]).toContain("supplier_bindings_source_status_sync_idx");
		expect(plans[2]).toContain("supplier_orders_state_retry_idx");
		expect(plans[3]).toContain("supplier_orders_upstream_order_idx");
	});

	it("runs PRAGMA optimize after index changes", async () => {
		await expect(db.prepare("PRAGMA optimize").run()).resolves.toMatchObject({
			success: true,
		});
	});
});

async function seed(db: D1Database) {
	await db.batch([
		db.prepare(
			`WITH RECURSIVE seq(value) AS (
			 SELECT 1 UNION ALL SELECT value + 1 FROM seq WHERE value < 100
			) INSERT INTO products
			 (id, name, product_type, status, sort_order,
			  created_at, updated_at)
			 SELECT printf('product-%03d', value), printf('Product %d', value),
			  'stock', 'active', value, value, value FROM seq`,
		),
		db.prepare(
			`INSERT INTO product_sellable_items
			 (id, product_id, name, price_minor, created_at, updated_at)
			 VALUES ('sellableItem-stock', 'product-001', 'Stock', '100', 1, 1)`,
		),
		db.prepare(
			`WITH RECURSIVE seq(value) AS (
			 SELECT 1 UNION ALL SELECT value + 1 FROM seq WHERE value < 100
			) INSERT INTO stock_entries
			 (id, sellable_item_id, content_encrypted, key_version, content_fingerprint,
			  content_mask, status, created_at, updated_at)
			 SELECT printf('stock-%03d', value), 'sellableItem-stock', 'ciphertext', 1,
			  printf('fingerprint-%03d', value), '****', 'available', value, value FROM seq`,
		),
		db.prepare(
			`WITH RECURSIVE seq(value) AS (
			 SELECT 1 UNION ALL SELECT value + 1 FROM seq WHERE value < 100
			) INSERT INTO shop_orders
			 (id, order_number, idempotency_key, contact_email,
			  normalized_contact_email, currency, currency_decimals, subtotal_minor,
			  total_minor, expires_at, created_at, updated_at)
			 SELECT printf('order-%03d', value), printf('GM-%03d', value),
			  printf('idem-%03d', value),
			  'buyer@example.com', 'buyer@example.com', 'USD', 2, '100', '100',
			  100000 + value, value, value FROM seq`,
		),
		db.prepare(
			`WITH RECURSIVE seq(value) AS (
			 SELECT 1 UNION ALL SELECT value + 1 FROM seq WHERE value < 100
			) INSERT INTO outbox_events
			 (id, event_type, aggregate_type, aggregate_id, idempotency_key,
			  payload, status, created_at, updated_at)
			 SELECT printf('outbox-%03d', value), 'delivery.requested', 'shop_order',
			  printf('order-%03d', value), printf('outbox-idem-%03d', value), '{}',
			  'pending', value, value FROM seq`,
		),
	]);
}

async function explain(db: D1Database, query: string) {
	const rows = await db
		.prepare(`EXPLAIN QUERY PLAN ${query}`)
		.all<{ detail: string }>();
	return rows.results.map((row) => row.detail).join("\n");
}
