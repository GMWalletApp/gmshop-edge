import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertProductHasNoOrderHistory } from "#/features/catalog/server/admin";
import { applyMigrations } from "./migrations";

vi.mock("cloudflare:workers", () => ({ env: {} }));

describe("catalog product recycle bin", { timeout: 30_000 }, () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmshop-edge-product-recycle-bin" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
	});

	afterAll(async () => miniflare.dispose());

	it("refuses to purge a product that appears in order history", async () => {
		await db.batch([
			db.prepare(
				`INSERT INTO products
				 (id, name, product_type, status, trashed_at, created_at, updated_at)
				 VALUES ('sold-product', 'Sold', 'stock', 'trashed', 2, 1, 2),
				        ('unsold-product', 'Unsold', 'stock', 'trashed', 2, 1, 2)`,
			),
			db.prepare(
				`INSERT INTO shop_orders
				 (id, order_number, idempotency_key, contact_email,
				  normalized_contact_email, status, currency, currency_decimals,
				  subtotal_minor, discount_minor, total_minor, paid_minor, expires_at,
				  created_at, updated_at)
				 VALUES ('sold-order', 'ORDER-SOLD', 'sold-key',
				  'customer@example.com', 'customer@example.com', 'completed',
				  'USD', 2, '100', '0', '100', '100', 1000, 1, 1)`,
			),
			db.prepare(
				`INSERT INTO shop_order_items
				 (id, order_id, product_id, sellable_item_id, product_name,
				  delivery_component_id, delivery_component_type,
				  delivery_component_version, sellable_item_name, quantity,
				  unit_price_minor, discount_minor, subtotal_minor, created_at, updated_at)
				 VALUES ('sold-item', 'sold-order', 'sold-product', 'sold-plan', 'Sold',
				  'sold-plan', 'stock', 1, 'Plan', 1, '100', '0', '100', 1, 1)`,
			),
		]);
		await expect(
			assertProductHasNoOrderHistory(db, "sold-product"),
		).rejects.toMatchObject({ code: "product_has_order_history", status: 409 });
		await expect(
			assertProductHasNoOrderHistory(db, "unsold-product"),
		).resolves.toBeUndefined();
	});

	it("retains immutable order snapshots after deleting the live product graph", async () => {
		await db.batch([
			db.prepare(
				`INSERT INTO products
				 (id, name, product_type, status, trashed_at, created_at, updated_at)
				 VALUES ('product', 'Product', 'stock', 'trashed', 2, 1, 2)`,
			),
			db.prepare(
				`INSERT INTO product_sellable_items
				 (id, product_id, name, price_minor,
				  created_at, updated_at)
				 VALUES ('item', 'product', 'Plan', '100', 1, 1)`,
			),
			db.prepare(
				`INSERT INTO shop_orders
				 (id, order_number, idempotency_key, contact_email,
				  normalized_contact_email, status, currency, currency_decimals,
				  subtotal_minor, discount_minor, total_minor, paid_minor, expires_at,
				  created_at, updated_at)
				 VALUES ('order', 'ORDER-RECYCLE', 'recycle-key',
				  'customer@example.com', 'customer@example.com', 'pending_payment',
				  'USD', 2, '100', '0', '100', '0', 1000, 1, 1)`,
			),
			db.prepare(
				`INSERT INTO shop_order_items
				 (id, order_id, product_id, sellable_item_id, product_name,
				  delivery_component_id, delivery_component_type,
				  delivery_component_version, sellable_item_name, quantity,
				  unit_price_minor, discount_minor, subtotal_minor, created_at, updated_at)
				 VALUES ('order-item', 'order', 'product', 'item', 'Product',
				  'item', 'stock', 1, 'Plan', 1, '100', '0', '100', 1, 1)`,
			),
		]);

		await db.batch([
			db.prepare(
				"DELETE FROM product_sellable_items WHERE product_id = 'product'",
			),
			db.prepare("DELETE FROM products WHERE id = 'product'"),
		]);

		expect(
			await db
				.prepare(
					"SELECT product_id, sellable_item_id, delivery_component_id, product_name FROM shop_order_items WHERE id = 'order-item'",
				)
				.first(),
		).toEqual({
			product_id: "product",
			sellable_item_id: "item",
			delivery_component_id: "item",
			product_name: "Product",
		});
	});
});
