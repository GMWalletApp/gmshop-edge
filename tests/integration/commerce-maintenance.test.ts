import { drizzle } from "drizzle-orm/d1";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "#/db/schema";
import {
	authProviderSecretKey,
	authProviderSecretPurpose,
} from "#/features/auth/provider-settings";
import { installSystem } from "#/features/installation/server/install";
import {
	decryptSecret,
	encryptSecret,
	rotateSecretKeyring,
} from "#/lib/secrets";
import {
	createInitialRuntimeConfig,
	type RuntimeConfig,
} from "#/server/runtime-config";
import { runMaintenance } from "#/server/scheduled/maintenance";
import { applyMigrations } from "./migrations";

describe("bounded commerce maintenance", () => {
	let miniflare: Miniflare;
	let database: D1Database;
	let bucket: R2Bucket;
	let runtime: RuntimeConfig;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmshop-edge-commerce-maintenance" },
			r2Buckets: { FILES: "gmshop-edge-commerce-maintenance-files" },
		});
		database = await miniflare.getD1Database("DB");
		bucket = (await miniflare.getR2Bucket("FILES")) as unknown as R2Bucket;
		await applyMigrations(database);
		runtime = createInitialRuntimeConfig("https://shop.example");
		await installSystem(
			drizzle(database, { schema }),
			{
				name: "Root",
				email: "root@example.com",
				password: "root-secure-password",
			},
			runtime,
		);
	});

	afterAll(async () => miniflare.dispose());

	it("re-requests deliveries that lost their queue message and leaves live ones alone", async () => {
		const now = Date.now();
		const stale = now - 11 * 60_000;
		await database.batch([
			database.prepare(
				`INSERT INTO products (id, name, product_type, status, sort_order, created_at, updated_at)
				 VALUES ('maint-product', 'Card', 'stock', 'active', 100, 1, 1)`,
			),
			database.prepare(
				`INSERT INTO product_sellable_items
				 (id, product_id, name, currency, currency_decimals, price_minor, minimum_quantity,
				  maximum_quantity, sort_order, enabled, created_at, updated_at)
				 VALUES ('maint-item', 'maint-product', 'Default', 'USD', 2, '100', 1, 1, 100, 1, 1, 1)`,
			),
			database.prepare(
				`INSERT INTO shop_orders
				 (id, order_number, idempotency_key, contact_email, normalized_contact_email, status,
				  currency, currency_decimals, subtotal_minor, discount_minor, total_minor, paid_minor,
				  version, expires_at, created_at, updated_at)
				 VALUES ('maint-order', 'ORDER-MAINT', 'maint-key', 'c@example.com', 'c@example.com',
				  'paid', 'USD', 2, '200', '0', '200', '200', 2, 9999999999999, 1, 1)`,
			),
			database.prepare(
				`INSERT INTO shop_order_items
				 (id, order_id, product_id, sellable_item_id, product_name, delivery_component_id,
				  delivery_component_type, delivery_component_version, sellable_item_name, quantity,
				  unit_price_minor, discount_minor, subtotal_minor, created_at, updated_at)
				 VALUES ('maint-item-stale', 'maint-order', 'maint-product', 'maint-item', 'Card', 'maint-item',
				  'stock', 1, 'Default', 1, '100', '0', '100', 1, 1),
				        ('maint-item-fresh', 'maint-order', 'maint-product', 'maint-item', 'Card', 'maint-item',
				  'stock', 1, 'Default', 1, '100', '0', '100', 1, 1)`,
			),
			database
				.prepare(
					`INSERT INTO delivery_records
					 (id, order_item_id, delivery_type, request_key, status, attempt_count, created_at, updated_at)
					 VALUES ('maint-delivery-stale', 'maint-item-stale', 'stock', 'initial:maint-item-stale',
					  'pending', 0, ?, ?),
					        ('maint-delivery-fresh', 'maint-item-fresh', 'stock', 'initial:maint-item-fresh',
					  'pending', 0, ?, ?)`,
				)
				.bind(stale, stale, now, now),
			database
				.prepare(
					`INSERT INTO outbox_events
					 (id, event_type, aggregate_type, aggregate_id, idempotency_key, payload, status,
					  attempt_count, published_at, created_at, updated_at)
					 VALUES ('maint-outbox-stale', 'delivery.requested', 'delivery', 'maint-delivery-stale',
					  'delivery-requested:maint-delivery-stale', '{}', 'published', 0, ?, ?, ?)`,
				)
				.bind(stale, stale, stale),
		]);
		const first = await runMaintenance(
			{ DB: database, FILES: bucket } as unknown as Env,
			"* * * * *",
			undefined,
			now,
		);
		expect(first.deliveriesReconciled).toBe(1);
		// The publisher runs before maintenance on the next tick and flips the
		// reconcile row to published; the delivery is still pending, so the same
		// window must neither re-request it nor collide on the idempotency key.
		await database
			.prepare(
				`UPDATE outbox_events SET status = 'published', published_at = ?
				 WHERE aggregate_id = 'maint-delivery-stale' AND status = 'pending'`,
			)
			.bind(now + 30_000)
			.run();
		const second = await runMaintenance(
			{ DB: database, FILES: bucket } as unknown as Env,
			"* * * * *",
			undefined,
			now + 60_000,
		);
		expect(second.deliveriesReconciled).toBe(0);
		// After a full window without progress the stale delivery is requested
		// again under a new key — and by then the once-fresh one is stale too.
		const third = await runMaintenance(
			{ DB: database, FILES: bucket } as unknown as Env,
			"* * * * *",
			undefined,
			now + 11 * 60_000,
		);
		expect(third.deliveriesReconciled).toBe(2);
		const rows = await database
			.prepare(
				`SELECT aggregate_id, status, payload FROM outbox_events
				 WHERE event_type = 'delivery.requested' AND aggregate_id = 'maint-delivery-stale'
				 ORDER BY created_at, id`,
			)
			.all<{ aggregate_id: string; status: string; payload: string }>();
		expect(rows.results.map((row) => [row.aggregate_id, row.status])).toEqual([
			["maint-delivery-stale", "published"],
			["maint-delivery-stale", "published"],
			["maint-delivery-stale", "pending"],
		]);
		expect(JSON.parse(rows.results[2]?.payload ?? "{}")).toEqual({
			deliveryId: "maint-delivery-stale",
			orderItemId: "maint-item-stale",
		});
	});

	it("removes expired Better Auth verifications without deleting live rows", async () => {
		const now = Date.now();
		await database.batch([
			database
				.prepare(
					`INSERT INTO verifications
					 (id, identifier, value, expires_at, created_at, updated_at)
					 VALUES ('expired-verification', 'telegram-mini-app:expired', 'telegram', ?, ?, ?),
					        ('live-verification', 'telegram-mini-app:live', 'telegram', ?, ?, ?)`,
				)
				.bind(now - 1, now - 10_000, now - 10_000, now + 60_000, now, now),
		]);

		const result = await runMaintenance(
			{ DB: database, FILES: bucket } as Env,
			"manual",
			undefined,
			now,
		);
		expect(result).toMatchObject({
			authVerificationsDeleted: 1,
		});
		const remaining = await database
			.prepare("SELECT group_concat(id) AS ids FROM verifications")
			.first<{ ids: string }>();
		expect(remaining?.ids).toBe("live-verification");
	});

	it("removes expired rate-limit windows without deleting live counters", async () => {
		const now = Date.now();
		await database
			.prepare(
				`INSERT INTO rate_limit_counters
				 (id, bucket_key, window_start, count, expires_at, created_at, updated_at)
				 VALUES ('expired-rate-limit', 'expired', 0, 1, ?, ?, ?),
				        ('live-rate-limit', 'live', ?, 1, ?, ?, ?)`,
			)
			.bind(now - 1, now - 10_000, now - 10_000, now, now + 60_000, now, now)
			.run();

		const result = await runMaintenance(
			{ DB: database, FILES: bucket } as Env,
			"manual",
			undefined,
			now,
		);
		expect(result.rateLimitsDeleted).toBe(1);
		const remaining = await database
			.prepare(
				"SELECT group_concat(id) AS ids FROM rate_limit_counters ORDER BY id",
			)
			.first<{ ids: string }>();
		expect(remaining?.ids).toBe("live-rate-limit");
	});

	it("progressively rewrites old envelopes after a key rotation", async () => {
		const now = Date.now();
		const encrypted = await encryptSecret(
			"provider-client-secret",
			runtime.authProviderSecret,
			authProviderSecretPurpose("github"),
		);
		await database
			.prepare(
				`INSERT INTO system_settings
				 (key, value, is_secret, created_at, updated_at)
				 VALUES (?, ?, 1, ?, ?)`,
			)
			.bind(
				authProviderSecretKey("github"),
				JSON.stringify(encrypted),
				now,
				now,
			)
			.run();
		const rotated = rotateSecretKeyring(runtime.authProviderSecret);
		await database
			.prepare(
				"UPDATE system_settings SET value = ?, updated_at = ? WHERE key = 'runtime.data_encryption_secret'",
			)
			.bind(JSON.stringify(rotated), now)
			.run();

		const result = await runMaintenance(
			{ DB: database, FILES: bucket } as Env,
			"manual",
			undefined,
			now,
		);
		expect(result.secretsReencrypted).toBeGreaterThanOrEqual(1);
		const row = await database
			.prepare("SELECT value FROM system_settings WHERE key = ?")
			.bind(authProviderSecretKey("github"))
			.first<{ value: string }>();
		const envelope = JSON.parse(row?.value ?? '""') as string;
		expect(envelope.startsWith("v1.k2.")).toBe(true);
		await expect(
			decryptSecret(envelope, rotated, authProviderSecretPurpose("github")),
		).resolves.toBe("provider-client-secret");
	});
});
