import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authenticateSupplierApi } from "#/features/supplier-api/server/auth";
import { signGmshopEdgeRequest } from "#/features/suppliers/providers/signatures";
import { encryptSecret } from "#/lib/secrets";
import { CLIENT_IP_HEADER } from "#/server/client-ip";
import {
	createInitialRuntimeConfig,
	runtimeConfigEntries,
} from "#/server/runtime-config";
import { awaitFreshRateLimitWindow } from "../helpers/rate-limit-window";
import { applyMigrations } from "./migrations";

const apiKeyId = "gme_supplier_api_auth_fixture";
const apiSecret = "b".repeat(64);
const keyRowId = "supplier-api-auth-key";
const path = "/api/v1/supplier/ping";

describe("supplier API authentication", () => {
	let miniflare: Miniflare;
	let db: D1Database;
	let nonceSequence = 0;
	const now = 1_800_000_000_000;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmshop-edge-supplier-api-auth" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		const runtime = createInitialRuntimeConfig("https://shop.example");
		const encrypted = await encryptSecret(
			apiSecret,
			runtime.commerceSecret,
			"supplier-api-key",
		);
		await db.batch([
			...runtimeConfigEntries(runtime).map((entry) =>
				db
					.prepare(
						"INSERT INTO system_settings (key, value, is_secret, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
					)
					.bind(
						entry.key,
						JSON.stringify(entry.value),
						entry.isSecret,
						now,
						now,
					),
			),
			db
				.prepare(
					"INSERT INTO system_settings (key, value, is_secret, created_at, updated_at) VALUES ('commerce.supplier_api_enabled', 'true', 0, ?, ?)",
				)
				.bind(now, now),
			db
				.prepare(
					"INSERT INTO users (id, name, email, email_verified, enabled, created_at, updated_at) VALUES ('api-user', 'API user', 'api-user@example.com', 1, 1, ?, ?)",
				)
				.bind(now, now),
			db
				.prepare(
					`INSERT INTO supplier_api_keys
					 (id, user_id, name, key_id, secret_encrypted, secret_revision, created_at, updated_at)
					 VALUES (?, 'api-user', 'Store', ?, ?, 1, ?, ?)`,
				)
				.bind(keyRowId, apiKeyId, encrypted, now, now),
		]);
	});

	afterAll(async () => miniflare.dispose());

	function signedRequest(
		overrides: {
			signature?: string;
			secret?: string;
			nonce?: string;
			ip?: string;
		} = {},
	) {
		const timestamp = String(Math.floor(Date.now() / 1000));
		const nonce =
			overrides.nonce ?? `nonce-${String(++nonceSequence).padStart(16, "0")}`;
		const signature =
			overrides.signature ??
			signGmshopEdgeRequest({
				method: "POST",
				pathWithQuery: path,
				timestamp,
				nonce,
				rawBody: "",
				apiSecret: overrides.secret ?? apiSecret,
			});
		return new Request(`https://shop.example${path}`, {
			method: "POST",
			headers: {
				"GMShop-Edge-Api-Key": apiKeyId,
				"GMShop-Edge-Timestamp": timestamp,
				"GMShop-Edge-Nonce": nonce,
				"GMShop-Edge-Signature": signature,
				...(overrides.ip ? { [CLIENT_IP_HEADER]: overrides.ip } : {}),
			},
		});
	}

	async function budgets() {
		const rows = await db
			.prepare(
				"SELECT bucket_key, count FROM rate_limit_counters WHERE bucket_key LIKE 'supplier-api:%' ORDER BY bucket_key",
			)
			.all<{ bucket_key: string; count: number }>();
		return Object.fromEntries(
			rows.results.map((row) => [row.bucket_key, row.count]),
		);
	}

	it("does not charge the key owner's budget for requests that fail signature verification", async () => {
		await expect(
			authenticateSupplierApi(
				signedRequest({ secret: "c".repeat(64) }),
				db,
				"",
			),
		).rejects.toMatchObject({ code: "supplier_api_unauthorized", status: 401 });
		await expect(
			authenticateSupplierApi(
				signedRequest({ signature: "0".repeat(64) }),
				db,
				"",
			),
		).rejects.toMatchObject({ code: "supplier_api_unauthorized", status: 401 });
		// Forged requests never touch the owner's quota (and without a trusted
		// client address there is nothing to throttle them by).
		expect(await budgets()).toEqual({});
		const replays = await db
			.prepare(
				"SELECT COUNT(*) AS count FROM replay_receipts WHERE namespace = 'supplier_api'",
			)
			.first<{ count: number }>();
		expect(replays?.count).toBe(0);
	});

	it("refuses a flood of forged requests from one client before doing signature work", async () => {
		await awaitFreshRateLimitWindow();
		const forger = "203.0.113.9";
		for (let index = 0; index < 60; index += 1)
			await expect(
				authenticateSupplierApi(
					signedRequest({
						signature: "0".repeat(64),
						nonce: `flood-nonce-${String(index).padStart(6, "0")}`,
						ip: forger,
					}),
					db,
					"",
				),
			).rejects.toMatchObject({ status: 401 });
		await expect(
			authenticateSupplierApi(
				signedRequest({
					signature: "0".repeat(64),
					nonce: "flood-nonce-last-000001",
					ip: forger,
				}),
				db,
				"",
			),
		).rejects.toMatchObject({ code: "supplier_rate_limited", status: 429 });
		// The legitimate reseller on another address is still served and its own
		// budget only reflects its own call.
		await expect(
			authenticateSupplierApi(
				signedRequest({
					nonce: "after-flood-nonce-000001",
					ip: "198.51.100.8",
				}),
				db,
				"",
			),
		).resolves.toMatchObject({ keyRowId });
		expect(await budgets()).toMatchObject({
			[`supplier-api:invalid:${forger}`]: 60,
			[`supplier-api:key:${keyRowId}`]: 1,
		});
	});

	it("charges per-key and per-user budgets only after a valid signature, then records the nonce", async () => {
		const nonce = "nonce-replayed-fixture-0001";
		await expect(
			authenticateSupplierApi(signedRequest({ nonce }), db, ""),
		).resolves.toEqual({
			userId: "api-user",
			keyId: apiKeyId,
			keyRowId,
			allowedCallbackOrigin: null,
		});
		expect(await budgets()).toMatchObject({
			[`supplier-api:key:${keyRowId}`]: 2,
			"supplier-api:user:api-user": 2,
		});
		await expect(
			authenticateSupplierApi(signedRequest({ nonce }), db, ""),
		).rejects.toMatchObject({ code: "supplier_replay", status: 409 });
		expect(await budgets()).toMatchObject({
			[`supplier-api:key:${keyRowId}`]: 3,
			"supplier-api:user:api-user": 3,
		});
	});
});
