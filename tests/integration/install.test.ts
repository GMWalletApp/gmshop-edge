import { readdir, readFile } from "node:fs/promises";
import { verifyPassword } from "better-auth/crypto";
import { drizzle } from "drizzle-orm/d1";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "#/db/schema";
import { defaultFiatExchangeRates } from "#/features/exchange-rates/default-fiat-rates";
import {
	installSystem,
	isInstalled,
} from "#/features/installation/server/install";
import { reconcileCommerceInfrastructure } from "#/features/installation/server/reconcile-commerce-infrastructure";
import { createInitialRuntimeConfig } from "#/server/runtime-config";
import { applyMigrations } from "./migrations";

describe("GMShop installation", { timeout: 30_000 }, () => {
	let miniflare: Miniflare;
	let database: D1Database;

	beforeEach(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: crypto.randomUUID() },
		});
		database = await miniflare.getD1Database("DB");
		await applyMigrations(database);
	});

	afterEach(async () => miniflare.dispose());

	it("keeps the GMShop baseline and applies incremental migrations", async () => {
		const files = (await readdir(new URL("../../drizzle/", import.meta.url)))
			.filter((name) => /^\d+_.+\.sql$/.test(name))
			.sort();
		expect(files).toEqual([
			"0000_gmshop.sql",
			"0001_telegram_bot_support.sql",
			"0002_glamorous_pete_wisdom.sql",
			"0003_product_tag_names.sql",
			"0004_plain_prima.sql",
			"0005_hot_query_indexes.sql",
		]);
		const legacyTables = await database
			.prepare(
				`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN
				 ('orders', 'payment_rails', 'payment_assets', 'payment_ingresses',
				  'receiving_methods', 'blockchain_transactions', 'webhook_deliveries',
				  'merchant_api_keys')`,
			)
			.all<{ name: string }>();
		expect(legacyTables.results).toEqual([]);
		const tables = await database
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%' ORDER BY name",
			)
			.all<{ name: string }>();
		expect(tables.results).toHaveLength(56);
		expect(tables.results.map((table) => table.name)).toEqual(
			expect.arrayContaining([
				"telegram_web_support_conversations",
				"telegram_web_support_replies",
				"telegram_web_support_sends",
				"supplier_api_keys",
				"supplier_api_orders",
				"supplier_export_listings",
				"wallet_entries",
				"wallet_topups",
			]),
		);
		const foreignKeyFailures = await database
			.prepare("PRAGMA foreign_key_check")
			.all();
		expect(foreignKeyFailures.results).toEqual([]);
		const baseline = await readFile(
			new URL("../../drizzle/0000_gmshop.sql", import.meta.url),
			"utf8",
		);
		expect(baseline).not.toMatch(/^(?:ALTER|DROP|INSERT|UPDATE|DELETE)\s+/gim);
	});

	it("atomically installs root, runtime secrets, commerce defaults and credential auth", async () => {
		const db = drizzle(database, { schema });
		expect(await isInstalled(db)).toBe(false);
		const runtime = createInitialRuntimeConfig("https://shop.example:8443");
		await expect(
			installSystem(
				db,
				{
					name: "Root",
					email: "OWNER@example.com",
					password: "a-secure-password",
				},
				runtime,
			),
		).resolves.toEqual({ email: "owner@example.com", installed: true });

		const state = await database
			.prepare(`SELECT
			 (SELECT COUNT(*) FROM users) AS users,
			 (SELECT COUNT(*) FROM roles WHERE name = 'root' AND built_in = 1) AS root_roles,
			 (SELECT COUNT(*) FROM roles
			  WHERE name = 'customer' AND built_in = 1
			  AND enabled = 1 AND permissions_json = '{}') AS storefront_roles,
			 (SELECT COUNT(*) FROM users, json_each(users.role_ids)) AS role_assignments,
			 (SELECT COUNT(*) FROM audit_logs WHERE action = 'system.installed') AS audits,
			 (SELECT COUNT(*) FROM system_settings WHERE key LIKE 'runtime.%') AS runtime_settings,
			 (SELECT COUNT(*) FROM system_settings) AS settings,
			 (SELECT COUNT(*) FROM system_settings
			  WHERE key = 'auth.providers'
			  AND json_extract(value, '$[0].providerId') = 'credential'
			  AND json_extract(value, '$[0].enabled') = 1) AS credential_providers,
			 (SELECT COUNT(*) FROM exchange_rates WHERE base_currency = 'USD') AS exchange_rates,
			 (SELECT COUNT(*) FROM exchange_rates WHERE enabled = 1) AS enabled_exchange_rates,
			 (SELECT COUNT(*) FROM system_settings WHERE key LIKE 'exchange_rates.sync.%') AS exchange_rate_sync_settings,
			 (SELECT COUNT(*) FROM notification_templates) AS notification_templates,
			 (SELECT COUNT(*) FROM products) AS products,
			 (SELECT COUNT(*) FROM payment_channels) AS payment_channels`)
			.first<Record<string, number>>();
		expect(state).toEqual({
			users: 1,
			root_roles: 1,
			storefront_roles: 1,
			role_assignments: 1,
			audits: 1,
			runtime_settings: 4,
			settings: 30,
			credential_providers: 1,
			exchange_rates: Object.keys(defaultFiatExchangeRates).length,
			enabled_exchange_rates: 1,
			exchange_rate_sync_settings: 2,
			notification_templates: 16,
			products: 0,
			payment_channels: 0,
		});
		const credential = await database
			.prepare("SELECT password FROM accounts WHERE provider_id = 'credential'")
			.first<{ password: string }>();
		expect(credential?.password).toBeTruthy();
		await expect(
			verifyPassword({
				hash: credential?.password ?? "",
				password: "a-secure-password",
			}),
		).resolves.toBe(true);
		await expect(
			installSystem(db, {
				name: "Second root",
				email: "second@example.com",
				password: "another-secure-password",
			}),
		).rejects.toMatchObject({ code: "already_installed" });
	});

	it("reconciles missing defaults without overwriting operator configuration", async () => {
		await installSystem(
			drizzle(database, { schema }),
			{
				name: "Root",
				email: "root@example.com",
				password: "a-secure-password",
			},
			createInitialRuntimeConfig("https://shop.example"),
		);
		await database.batch([
			database
				.prepare(
					"UPDATE system_settings SET value = ? WHERE key = 'orders.default_expiry_ms'",
				)
				.bind(JSON.stringify(123_000)),
			database.prepare(
				"DELETE FROM system_settings WHERE key = 'automation.artifact_retention_ms'",
			),
			database.prepare(
				"DELETE FROM system_settings WHERE key = 'auth.providers'",
			),
			database.prepare("DELETE FROM notification_templates"),
		]);

		await expect(
			reconcileCommerceInfrastructure(database, 1_800_000_000_000),
		).resolves.toEqual({
			settings: 1,
			authProviders: 1,
			notificationTemplates: 16,
			roles: 0,
		});
		await expect(
			reconcileCommerceInfrastructure(database, 1_800_000_000_001),
		).resolves.toEqual({
			settings: 0,
			authProviders: 0,
			notificationTemplates: 0,
			roles: 0,
		});
		const orderExpiry = await database
			.prepare(
				"SELECT value FROM system_settings WHERE key = 'orders.default_expiry_ms'",
			)
			.first<{ value: string }>();
		expect(JSON.parse(orderExpiry?.value ?? "null")).toBe(123_000);
	});
});
