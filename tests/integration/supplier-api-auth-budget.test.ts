import { drizzle } from "drizzle-orm/d1";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "#/db/schema";
import { authenticateSupplierApi } from "#/features/supplier-api/server/auth";
import { createSupplierApiKey } from "#/features/supplier-api/server/key-store";
import { signGmshopEdgeRequest } from "#/features/suppliers/providers/signatures";
import { createUser } from "#/features/users/server/users";
import { createInitialRuntimeConfig } from "#/server/runtime-config";
import { applyMigrations } from "./migrations";

describe("supplier API authentication budget", { timeout: 30_000 }, () => {
	let miniflare: Miniflare;
	let db: D1Database;
	let credentials: { apiKey: string; apiSecret: string };
	const secret = createInitialRuntimeConfig(
		"https://shop.example",
	).commerceSecret;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: crypto.randomUUID() },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await db.batch([
			db
				.prepare(
					"INSERT INTO system_settings(key,value,is_secret,created_at,updated_at) VALUES ('runtime.data_encryption_secret',?,1,1,1)",
				)
				.bind(JSON.stringify(secret)),
			db.prepare(
				"INSERT INTO system_settings(key,value,is_secret,created_at,updated_at) VALUES ('commerce.supplier_api_enabled','true',0,1,1)",
			),
		]);
		const user = await createUser(drizzle(db, { schema }), {
			name: "API customer",
			email: "api-customer@example.com",
			enabled: true,
			password: "current-password",
		});
		credentials = await createSupplierApiKey(
			db,
			new Request("https://shop.example/account"),
			user.id,
			secret,
			{ name: "Store", password: "current-password" },
		);
	});
	afterAll(async () => miniflare.dispose());

	const call = (ip: string, sign: boolean) => {
		const timestamp = String(Math.floor(Date.now() / 1000));
		const nonce = crypto.randomUUID();
		const signature = sign
			? signGmshopEdgeRequest({
					method: "GET",
					pathWithQuery: "/api/supply/v1/products",
					timestamp,
					nonce,
					rawBody: "",
					apiSecret: credentials.apiSecret,
				})
			: "0".repeat(64);
		return authenticateSupplierApi(
			new Request("https://shop.example/api/supply/v1/products", {
				headers: {
					"cf-connecting-ip": ip,
					"GMShop-Edge-Api-Key": credentials.apiKey,
					"GMShop-Edge-Timestamp": timestamp,
					"GMShop-Edge-Nonce": nonce,
					"GMShop-Edge-Signature": signature,
				},
			}),
			db,
			"",
		);
	};
	const keyBudgetUsed = async () =>
		(
			await db
				.prepare(
					"SELECT COALESCE(SUM(count),0) AS used FROM rate_limit_counters WHERE bucket_key LIKE 'supplier-api:key:%'",
				)
				.first<{ used: number }>()
		)?.used;

	it("verifies the signature before spending the key budget", async () => {
		await expect(call("198.51.100.60", false)).rejects.toMatchObject({
			code: "supplier_api_unauthorized",
		});
		expect(await keyBudgetUsed()).toBe(0);
		await expect(call("198.51.100.60", true)).resolves.toMatchObject({
			keyId: credentials.apiKey,
		});
		expect(await keyBudgetUsed()).toBe(1);
	});

	it("budgets failed signatures per source IP", async () => {
		for (let index = 0; index < 30; index++)
			await expect(call("198.51.100.61", false)).rejects.toMatchObject({
				code: "supplier_api_unauthorized",
			});
		await expect(call("198.51.100.61", false)).rejects.toMatchObject({
			code: "supplier_rate_limited",
			status: 429,
		});
		await expect(call("198.51.100.62", true)).resolves.toBeDefined();
	});
});
