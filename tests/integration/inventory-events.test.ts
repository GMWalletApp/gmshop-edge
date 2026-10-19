import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	deliverInventoryEvent,
	publishPendingInventoryEvents,
} from "#/features/supplier-api/server/inventory-events";
import { signGmshopEdgeRequest } from "#/features/suppliers/providers/signatures";
import { encryptSecret } from "#/lib/secrets";
import { createInitialRuntimeConfig } from "#/server/runtime-config";
import { applyMigrations } from "./migrations";

describe("realtime inventory events", { timeout: 30_000 }, () => {
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
	});

	afterEach(async () => miniflare.dispose());

	it("coalesces batch inserts and publishes queue references", async () => {
		await db.batch([
			stockInsert(db, "stock-1", 100),
			stockInsert(db, "stock-2", 100),
		]);
		const pending = await inventoryEvents(db);
		expect(pending).toHaveLength(1);
		const sendBatch = vi.fn(async () => undefined);
		await expect(
			publishPendingInventoryEvents(db, { sendBatch } as never),
		).resolves.toEqual({ published: 1 });
		expect(sendBatch).toHaveBeenCalledWith([
			{
				body: {
					kind: "commerce.inventory-event",
					version: 1,
					outboxId: pending[0]?.id,
				},
			},
		]);
	});

	it("emits on availability changes and signs the existing callback seam", async () => {
		await stockInsert(db, "stock-1", 100).run();
		await db
			.prepare(
				"UPDATE stock_entries SET status = 'reserved', updated_at = 200 WHERE id = 'stock-1'",
			)
			.run();
		const events = await inventoryEvents(db);
		expect(events).toHaveLength(2);
		const runtime = createInitialRuntimeConfig("https://shop.example");
		const apiSecret = "a".repeat(64);
		await db.batch([
			db
				.prepare(
					`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
					 VALUES ('runtime.data_encryption_secret', ?, 1, 1, 1)`,
				)
				.bind(JSON.stringify(runtime.dataEncryptionSecret)),
			db.prepare(
				`INSERT INTO users (id, name, email, email_verified, enabled, created_at, updated_at)
				 VALUES ('user-1', 'Agent', 'agent@example.com', 1, 1, 1, 1)`,
			),
			db
				.prepare(
					`INSERT INTO supplier_api_keys
					 (id, user_id, name, key_id, secret_encrypted, secret_revision,
					  allowed_callback_origin, created_at, updated_at)
					 VALUES ('key-1', 'user-1', 'Agent', 'gme_test', ?, 1,
					  'https://lsrai.example', 1, 1)`,
				)
				.bind(
					await encryptSecret(
						apiSecret,
						runtime.commerceSecret,
						"supplier-api-key",
					),
				),
			// Sorted first: a redirecting partner must not block the next one.
			db
				.prepare(
					`INSERT INTO supplier_api_keys
					 (id, user_id, name, key_id, secret_encrypted, secret_revision,
					  allowed_callback_origin, created_at, updated_at)
					 VALUES ('key-0', 'user-1', 'Broken', 'gme_broken', ?, 1,
					  'https://broken.example', 1, 1)`,
				)
				.bind(
					await encryptSecret(
						apiSecret,
						runtime.commerceSecret,
						"supplier-api-key",
					),
				),
		]);
		const fetcher = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				const headers = new Headers(init?.headers);
				const rawBody = String(init?.body ?? "");
				expect(init?.redirect).toBe("manual");
				if (String(input).startsWith("https://broken.example"))
					return new Response(null, {
						status: 302,
						headers: { location: "http://169.254.169.254/" },
					});
				expect(String(input)).toBe(
					"https://lsrai.example/api/v1/upstream/callback",
				);
				expect(headers.get("GMShop-Edge-Signature")).toBe(
					signGmshopEdgeRequest({
						method: "POST",
						pathWithQuery: "/api/v1/upstream/callback",
						timestamp: headers.get("GMShop-Edge-Timestamp") ?? "",
						nonce: headers.get("GMShop-Edge-Nonce") ?? "",
						rawBody,
						apiSecret,
					}),
				);
				return Response.json({ ok: true });
			},
		);
		await expect(
			deliverInventoryEvent(db, events[0]?.id ?? "", {
				fetcher: fetcher as typeof fetch,
				now: () => 300_000,
			}),
		).resolves.toEqual({ delivered: 1, failed: 1 });
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
});

const ITEM_ID = "11111111-1111-4111-8111-111111111111";

async function seedCatalog(db: D1Database) {
	await db.batch([
		db.prepare(
			`INSERT INTO products (id, name, product_type, status, created_at, updated_at)
			 VALUES ('product-1', 'Product', 'stock', 'active', 1, 1)`,
		),
		db
			.prepare(
				`INSERT INTO product_sellable_items
			 (id, product_id, name, fulfillment_source, currency, currency_decimals,
			  price_minor, created_at, updated_at)
			 VALUES (?, 'product-1', 'SKU', 'local', 'CNY', 2, '100', 1, 1)`,
			)
			.bind(ITEM_ID),
		db
			.prepare(
				`INSERT INTO supplier_export_listings
			 (id, sellable_item_id, price_minor, currency, currency_decimals,
			  enabled, created_at, updated_at)
			 VALUES ('listing-1', ?, '100', 'CNY', 2, 1, 1, 1)`,
			)
			.bind(ITEM_ID),
	]);
}

function stockInsert(db: D1Database, id: string, now: number) {
	return db
		.prepare(
			`INSERT INTO stock_entries
			 (id, sellable_item_id, content_encrypted, key_version, content_fingerprint,
			  content_mask, status, created_at, updated_at)
			 VALUES (?, ?, 'encrypted', 1, ?, '••••test', 'available', ?, ?)`,
		)
		.bind(id, ITEM_ID, `fingerprint-${id}`, now, now);
}

async function inventoryEvents(db: D1Database) {
	return (
		await db
			.prepare(
				"SELECT id, status FROM outbox_events WHERE event_type = 'inventory.changed' ORDER BY created_at, id",
			)
			.all<{ id: string; status: string }>()
	).results;
}
