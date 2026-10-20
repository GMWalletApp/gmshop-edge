import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSupplierCredentialVault } from "#/features/suppliers/secrets";
import { runSupplierMaintenance } from "#/features/suppliers/server/maintenance";
import { syncSupplierSource } from "#/features/suppliers/server/source-sync";
import {
	loadSupplierSyncSettings,
	syncAllSupplierCatalogs,
	syncSupplierCatalogsIfDue,
} from "#/features/suppliers/server/sync-settings";
import { upsertFeishuAlertSetting } from "#/features/telegram/server/feishu-alerts";
import {
	encryptTelegramOwnerAlertBotToken,
	telegramOwnerAlertSettingKeys,
} from "#/features/telegram/server/owner-alerts";
import { createInitialRuntimeConfig } from "#/server/runtime-config";
import { applyMigrations } from "./migrations";

describe("supplier source synchronization", { timeout: 30_000 }, () => {
	let miniflare: Miniflare;
	let db: D1Database;
	let cache: KVNamespace;
	const source = {
		provider: "dujiao_next" as const,
		normalizedApiOrigin: "https://supplier.example",
		protocolVersion: "1.3.1-upstream-v1",
	};
	const runtime = createInitialRuntimeConfig("https://shop.example");

	beforeEach(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: crypto.randomUUID() },
			kvNamespaces: { CACHE: crypto.randomUUID() },
		});
		db = await miniflare.getD1Database("DB");
		cache = (await miniflare.getKVNamespace("CACHE")) as unknown as KVNamespace;
		await applyMigrations(db);
		await seedAccount(db, "account-a", "api-a", runtime.commerceSecret);
		await seedAccount(db, "account-b", "api-b", runtime.commerceSecret);
	});

	afterEach(async () => miniflare.dispose());

	it("downloads a catalog once per source window, not once per account", async () => {
		let requests = 0;
		const fetcher: typeof fetch = async (input) => {
			requests += 1;
			if (new URL(String(input)).pathname.endsWith("/categories"))
				return categoriesResponse();
			return catalogResponse();
		};
		const first = await syncSupplierSource({
			db,
			runtime,
			source,
			trigger: "scheduled",
			now: 1_800_000_000_000,
			fetcher,
		});
		const second = await syncSupplierSource({
			db,
			runtime,
			source,
			trigger: "scheduled",
			now: 1_800_000_000_001,
			fetcher,
		});
		expect(first).toMatchObject({
			skipped: false,
			accountId: "account-a",
			productCount: 1,
			skuCount: 1,
		});
		expect(second).toEqual({ skipped: true, reason: "already_synced" });
		expect(requests).toBe(2);
	});

	it("synchronizes every enabled source while sharing one request per source", async () => {
		await seedAccount(
			db,
			"account-c",
			"api-c",
			runtime.commerceSecret,
			"https://second.example",
		);
		const requests = new Map<string, number>();
		const fetcher: typeof fetch = async (input) => {
			const url = new URL(String(input));
			requests.set(url.host, (requests.get(url.host) ?? 0) + 1);
			return url.pathname.endsWith("/categories")
				? categoriesResponse()
				: catalogResponse();
		};
		await expect(
			syncAllSupplierCatalogs({
				db,
				cache,
				runtime,
				trigger: "manual",
				now: 1_800_000_300_000,
				fetcher,
			}),
		).resolves.toEqual({
			updated: 2,
			skipped: 0,
			failed: 0,
			sourceCount: 2,
		});
		expect(requests).toEqual(
			new Map([
				["supplier.example", 2],
				["second.example", 2],
			]),
		);
	});

	it("loads sync settings and skips automatic catalogs until the interval is due", async () => {
		const now = 1_800_000_400_000;
		await db.batch([
			db
				.prepare(
					`INSERT INTO system_settings
					 (key, value, is_secret, created_at, updated_at)
					 VALUES ('suppliers.sync.config', ?, 0, ?, ?)`,
				)
				.bind(
					JSON.stringify({ enabled: true, intervalMs: 3_600_000 }),
					now,
					now,
				),
			db
				.prepare(
					`INSERT INTO system_settings
					 (key, value, is_secret, created_at, updated_at)
					 VALUES ('suppliers.sync.status', ?, 0, ?, ?)`,
				)
				.bind(
					JSON.stringify({
						lastSyncedAt: now - 60_000,
						lastStatus: "succeeded",
						lastErrorCode: null,
					}),
					now,
					now,
				),
		]);
		await expect(loadSupplierSyncSettings(db)).resolves.toMatchObject({
			enabled: true,
			intervalMs: 3_600_000,
			lastSyncedAt: now - 60_000,
		});
		await expect(
			syncSupplierCatalogsIfDue({
				db,
				cache,
				runtime,
				now,
				fetcher: async () => {
					throw new Error("not due");
				},
			}),
		).resolves.toEqual({
			updated: 0,
			skipped: 0,
			failed: 0,
			sourceCount: 0,
		});
	});

	it("cools a failed account and continues with another account in the source", async () => {
		const apiKeys: string[] = [];
		const fetcher: typeof fetch = async (input, init) => {
			const request = new Request(input, init);
			const apiKey = request.headers.get("Dujiao-Next-Api-Key") ?? "";
			apiKeys.push(apiKey);
			if (apiKey === "api-a") throw new Error("connection failed");
			if (new URL(request.url).pathname.endsWith("/categories"))
				return categoriesResponse();
			return catalogResponse();
		};
		await expect(
			syncSupplierSource({
				db,
				runtime,
				source,
				trigger: "manual",
				now: 1_800_000_600_000,
				fetcher,
			}),
		).resolves.toMatchObject({ accountId: "account-b" });
		expect(apiKeys.filter((value) => value === "api-a")).toHaveLength(2);
		expect(apiKeys.filter((value) => value === "api-b")).toHaveLength(2);
		const failed = await db
			.prepare(
				`SELECT health_status, consecutive_failures, cooldown_until,
				        last_error_code FROM supplier_accounts WHERE id = 'account-a'`,
			)
			.first();
		expect(failed).toMatchObject({
			health_status: "degraded",
			consecutive_failures: 1,
			cooldown_until: 1_800_000_660_000,
			last_error_code: "catalog_sync_failed",
		});
	});

	it("refreshes each account balance independently while sharing one catalog sync", async () => {
		let catalogRequests = 0;
		const fetcher: typeof fetch = async (input, init) => {
			const request = new Request(input, init);
			const apiKey = request.headers.get("Dujiao-Next-Api-Key");
			if (new URL(request.url).pathname === "/api/v1/upstream/ping")
				return Response.json({
					ok: true,
					site_name: apiKey,
					balance: apiKey === "api-a" ? "10.00" : "20.00",
					currency: "CNY",
				});
			if (new URL(request.url).pathname.endsWith("/categories"))
				return categoriesResponse();
			catalogRequests += 1;
			return catalogResponse();
		};
		await expect(
			runSupplierMaintenance({
				db,
				runtime,
				now: 1_800_001_200_000,
				fetcher,
			}),
		).resolves.toMatchObject({
			balancesUpdated: 2,
			balancesFailed: 0,
			catalogsUpdated: 1,
		});
		const balances = await db
			.prepare("SELECT id, balance_minor FROM supplier_accounts ORDER BY id")
			.all();
		expect(balances.results).toEqual([
			{ id: "account-a", balance_minor: "1000" },
			{ id: "account-b", balance_minor: "2000" },
		]);
		expect(catalogRequests).toBe(1);
	});

	it("uses an incremental cursor during the day and performs a full daily check", async () => {
		const productQueries: URL[] = [];
		const fetcher: typeof fetch = async (input) => {
			const url = new URL(String(input));
			if (url.pathname.endsWith("/categories")) return categoriesResponse();
			productQueries.push(url);
			return catalogResponse(
				productQueries.length === 1
					? "2027-01-15T10:00:00Z"
					: "2027-01-15T10:10:00Z",
			);
		};
		const firstAt = Date.parse("2027-01-15T10:01:00Z");
		await syncSupplierSource({
			db,
			cache,
			runtime,
			source,
			trigger: "scheduled",
			now: firstAt,
			fetcher,
		});
		await syncSupplierSource({
			db,
			cache,
			runtime,
			source,
			trigger: "scheduled",
			now: firstAt + 10 * 60_000,
			fetcher,
		});
		await syncSupplierSource({
			db,
			cache,
			runtime,
			source,
			trigger: "scheduled",
			now: Date.parse("2027-01-16T00:01:00Z"),
			fetcher,
		});

		expect(productQueries[0]?.searchParams.has("updated_after")).toBe(false);
		expect(productQueries[1]?.searchParams.get("updated_after")).toBe(
			"2027-01-15T10:00:00Z",
		);
		expect(productQueries[2]?.searchParams.has("updated_after")).toBe(false);
		expect(
			productQueries.every((url) => url.searchParams.get("page_size") === "50"),
		).toBe(true);
	});

	it("stops a binding when cost rises while preserving local content and price", async () => {
		await db.batch([
			db.prepare(
				`INSERT INTO products
				 (id, name, description, product_type, status, created_at, updated_at)
				 VALUES ('local-product', 'Local title', 'Local description',
				  'stock', 'active', 1, 1)`,
			),
			db.prepare(
				`INSERT INTO product_sellable_items
				 (id, product_id, name, fulfillment_source, supplier_status,
				  currency, currency_decimals, price_minor, cost_minor,
				  created_at, updated_at)
				 VALUES ('local-item', 'local-product', 'Local SKU', 'supplier',
				  'available', 'CNY', 2, '250', '100', 1, 1)`,
			),
			db.prepare(
				`INSERT INTO supplier_bindings
				 (id, sellable_item_id, provider, normalized_api_origin,
				  protocol_version, upstream_product_id, upstream_sku_id,
				  upstream_product_name, upstream_sku_name, reference_cost_minor,
				  max_cost_minor, stock_quantity, remote_status, last_synced_at,
				  enabled, created_at, updated_at)
				 VALUES ('cost-binding', 'local-item', 'dujiao_next',
				  'https://supplier.example', '1.3.1-upstream-v1', '1', '2',
				  'Old remote title', 'Old remote SKU', '100', '100', 10,
				  'active', 1, 1, 1, 1)`,
			),
		]);
		const fetcher: typeof fetch = async (input) =>
			new URL(String(input)).pathname.endsWith("/categories")
				? categoriesResponse()
				: catalogResponse(undefined, "1.01", "New remote title");
		await syncSupplierSource({
			db,
			runtime,
			source,
			trigger: "manual",
			now: 1_800_002_400_000,
			fetcher,
		});
		const state = await db
			.prepare(
				`SELECT p.name, p.description, psi.name AS item_name,
				        psi.price_minor, psi.cost_minor, psi.supplier_status,
				        sb.upstream_product_name, sb.reference_cost_minor
				 FROM products p
				 JOIN product_sellable_items psi ON psi.product_id = p.id
				 JOIN supplier_bindings sb ON sb.sellable_item_id = psi.id
				 WHERE p.id = 'local-product'`,
			)
			.first();
		expect(state).toMatchObject({
			name: "Local title",
			description: "Local description",
			item_name: "Local SKU",
			price_minor: "250",
			cost_minor: "100",
			supplier_status: "unavailable",
			upstream_product_name: "New remote title",
			reference_cost_minor: "101",
		});
	});

	it("alerts the owner once when an upstream SKU is confirmed deleted", async () => {
		await db
			.prepare(
				`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
				 VALUES ('runtime.data_encryption_secret', ?, 1, 1, 1)`,
			)
			.bind(JSON.stringify(createInitialRuntimeConfig().dataEncryptionSecret))
			.run();
		await db.batch([
			upsertFeishuAlertSetting(
				db,
				telegramOwnerAlertSettingKeys.enabled,
				true,
				1,
			),
			upsertFeishuAlertSetting(
				db,
				telegramOwnerAlertSettingKeys.chatId,
				"-5101401750",
				1,
			),
			upsertFeishuAlertSetting(
				db,
				telegramOwnerAlertSettingKeys.botToken,
				await encryptTelegramOwnerAlertBotToken(
					db,
					"1234567890:AAtest-only-owner-alert-token_abcdefgh",
				),
				1,
				true,
			),
			db.prepare(
				`INSERT INTO products
				 (id, name, description, product_type, status, created_at, updated_at)
				 VALUES ('gone-product', 'Gemini Pro', '', 'stock', 'active', 1, 1)`,
			),
			db.prepare(
				`INSERT INTO product_sellable_items
				 (id, product_id, name, fulfillment_source, supplier_status,
				  currency, currency_decimals, price_minor, cost_minor,
				  created_at, updated_at)
				 VALUES ('gone-item', 'gone-product', '18个月', 'supplier',
				  'available', 'CNY', 2, '1000', '500', 1, 1)`,
			),
			db.prepare(
				`INSERT INTO supplier_bindings
				 (id, sellable_item_id, provider, normalized_api_origin,
				  protocol_version, upstream_product_id, upstream_sku_id,
				  upstream_product_name, upstream_sku_name, reference_cost_minor,
				  max_cost_minor, stock_quantity, remote_status, last_synced_at,
				  enabled, created_at, updated_at)
				 VALUES ('gone-binding', 'gone-item', 'dujiao_next',
				  'https://supplier.example', '1.3.1-upstream-v1', '9', '9',
				  'Old upstream item', 'Old upstream item', '500', '680', 5,
				  'active', 1, 1, 1, 1)`,
			),
		]);
		const alerts: string[] = [];
		const fetcher: typeof fetch = async (input, init) => {
			const url = new URL(String(input));
			if (url.host === "api.telegram.org") {
				alerts.push(JSON.parse(String(init?.body)).text);
				return Response.json({ ok: true, result: { message_id: 1 } });
			}
			return url.pathname.endsWith("/categories")
				? categoriesResponse()
				: catalogResponse();
		};
		const states: unknown[] = [];
		for (const now of [
			1_800_003_000_000, 1_800_003_600_000, 1_800_004_200_000,
			1_800_004_800_000,
		]) {
			await syncSupplierSource({
				db,
				runtime,
				source,
				trigger: "scheduled",
				now,
				fetcher,
			});
			states.push(
				await db
					.prepare(
						`SELECT sb.remote_status, psi.supplier_status
						 FROM supplier_bindings sb
						 JOIN product_sellable_items psi ON psi.id = sb.sellable_item_id
						 WHERE sb.id = 'gone-binding'`,
					)
					.first(),
			);
		}
		expect(states).toEqual([
			{ remote_status: "unknown", supplier_status: "available" },
			{ remote_status: "deleted", supplier_status: "unavailable" },
			{ remote_status: "deleted", supplier_status: "unavailable" },
			{ remote_status: "deleted", supplier_status: "unavailable" },
		]);
		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toContain("Gemini Pro｜18个月");
		expect(alerts[0]).toContain("Old upstream item");
	});

	it("refreshes a staged manual binding without enabling supplier fulfillment", async () => {
		await db.batch([
			db.prepare(
				`INSERT INTO products
				 (id, name, description, product_type, status, created_at, updated_at)
				 VALUES ('manual-product', 'Manual title', 'Manual description',
				  'stock', 'active', 1, 1)`,
			),
			db.prepare(
				`INSERT INTO product_sellable_items
				 (id, product_id, name, fulfillment_source, supplier_status,
				  currency, currency_decimals, price_minor, cost_minor,
				  created_at, updated_at)
				 VALUES ('manual-item', 'manual-product', 'Manual SKU', 'manual',
				  NULL, 'CNY', 2, '250', '100', 1, 1)`,
			),
			db.prepare(
				`INSERT INTO supplier_bindings
				 (id, sellable_item_id, provider, normalized_api_origin,
				  protocol_version, upstream_product_id, upstream_sku_id,
				  upstream_product_name, upstream_sku_name, reference_cost_minor,
				  max_cost_minor, stock_quantity, remote_status, last_synced_at,
				  enabled, created_at, updated_at)
				 VALUES ('manual-binding', 'manual-item', 'dujiao_next',
				  'https://supplier.example', '1.3.1-upstream-v1', '1', '2',
				  'Old remote title', 'Old remote SKU', '100', '150', 1,
				  'active', 1, 1, 1, 1)`,
			),
		]);
		await syncSupplierSource({
			db,
			runtime,
			source,
			trigger: "manual",
			now: 1_800_002_500_000,
			fetcher: async (input) =>
				new URL(String(input)).pathname.endsWith("/categories")
					? categoriesResponse()
					: catalogResponse(undefined, "1.20", "New remote title"),
		});
		const state = await db
			.prepare(
				`SELECT psi.fulfillment_source, psi.supplier_status,
				        psi.cost_minor, sb.reference_cost_minor, sb.stock_quantity,
				        sb.upstream_product_name
				 FROM product_sellable_items psi
				 JOIN supplier_bindings sb ON sb.sellable_item_id = psi.id
				 WHERE psi.id = 'manual-item'`,
			)
			.first();
		expect(state).toMatchObject({
			fulfillment_source: "manual",
			supplier_status: null,
			cost_minor: "100",
			reference_cost_minor: "120",
			stock_quantity: 10,
			upstream_product_name: "New remote title",
		});
	});
});

async function seedAccount(
	db: D1Database,
	id: string,
	apiKey: string,
	commerceSecret: string,
	origin = "https://supplier.example",
) {
	const encrypted = await createSupplierCredentialVault(
		"dujiao_next",
		{ apiKey, apiSecret: "secret" },
		commerceSecret,
	);
	await db
		.prepare(
			`INSERT INTO supplier_accounts
			 (id, provider, base_url, normalized_api_origin, protocol_version,
			  currency, currency_decimals, name, credentials_encrypted,
			  credentials_revision, credential_fingerprint, enabled,
			  health_status, created_at, updated_at)
			 VALUES (?, 'dujiao_next', ?,
			  ?, '1.3.1-upstream-v1', 'CNY', 2, ?,
			  ?, 1, ?, 1, 'healthy', 1, 1)`,
		)
		.bind(id, origin, origin, id, encrypted, `fingerprint-${id}`)
		.run();
}

function catalogResponse(
	updatedAt?: string,
	priceAmount = "1.00",
	title = "商品",
) {
	return Response.json({
		total: 1,
		items: [
			{
				id: 1,
				title: { "zh-CN": title },
				description: {},
				images: [],
				tags: [],
				currency: "CNY",
				is_active: true,
				...(updatedAt ? { updated_at: updatedAt } : {}),
				skus: [
					{
						id: 2,
						sku_code: "SKU",
						spec_values: {},
						price_amount: priceAmount,
						stock_quantity: 10,
						is_active: true,
					},
				],
			},
		],
	});
}

function categoriesResponse() {
	return Response.json({ ok: true, categories: [] });
}
