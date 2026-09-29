import { drizzle } from "drizzle-orm/d1";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "#/db/schema";
import {
	authProviderSecretKey,
	authProviderSecretPurpose,
	authProviderSettingKeys,
	initialStoredAuthProviders,
} from "#/features/auth/provider-settings";
import { createAuth } from "#/features/auth/server/auth-factory";
import { loadRuntimeAuthProviders } from "#/features/auth/server/provider-runtime";
import { installSystem } from "#/features/installation/server/install";
import { encryptSecret } from "#/lib/secrets";
import { createInitialRuntimeConfig } from "#/server/runtime-config";
import { signedTelegramInitData } from "../helpers/telegram-init-data";
import { applyMigrations } from "./migrations";

describe("Telegram Mini App Better Auth login", { timeout: 30_000 }, () => {
	let miniflare: Miniflare;
	let database: D1Database;
	let auth: ReturnType<typeof createAuth>;
	const runtime = createInitialRuntimeConfig("https://shop.example");
	const botToken = "123456:telegram-integration-token";

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmshop-edge-telegram-mini-app-auth" },
		});
		database = await miniflare.getD1Database("DB");
		await applyMigrations(database);
		await installSystem(
			drizzle(database, { schema }),
			{
				name: "Root",
				email: "root@example.com",
				password: "root-secure-password",
			},
			runtime,
		);
		const now = Date.now();
		const providers = [
			...initialStoredAuthProviders,
			{
				id: "11111111-1111-4111-8111-111111111111",
				providerId: "telegram",
				providerType: "social",
				displayName: "Telegram",
				icon: null,
				clientId: "123456",
				scopes: ["openid", "profile"],
				allowSignup: true,
				enabled: true,
				sortOrder: 20,
			},
		];
		await database.batch([
			database
				.prepare(
					`INSERT OR REPLACE INTO system_settings
					 (key, value, is_secret, created_at, updated_at)
					 VALUES (?, ?, 0, ?, ?)`,
				)
				.bind(
					authProviderSettingKeys.providers,
					JSON.stringify(providers),
					now,
					now,
				),
			database
				.prepare(
					`INSERT OR REPLACE INTO system_settings
					 (key, value, is_secret, created_at, updated_at)
					 VALUES (?, ?, 1, ?, ?)`,
				)
				.bind(
					authProviderSecretKey("telegram"),
					JSON.stringify(
						await encryptSecret(
							botToken,
							runtime.authProviderSecret,
							authProviderSecretPurpose("telegram"),
						),
					),
					now,
					now,
				),
			...[
				[authProviderSettingKeys.telegramBotUserId, "123456"],
				[authProviderSettingKeys.telegramUsername, "gmshop_test_bot"],
				[authProviderSettingKeys.telegramMiniAppEnabled, true],
			].map(([key, value]) =>
				database
					.prepare(
						`INSERT OR REPLACE INTO system_settings
						 (key, value, is_secret, created_at, updated_at)
						 VALUES (?, ?, 0, ?, ?)`,
					)
					.bind(key, JSON.stringify(value), now, now),
			),
		]);
		auth = createAuth(drizzle(database, { schema }), {
			BETTER_AUTH_SECRET: runtime.betterAuthSecret,
			BETTER_AUTH_URL: runtime.betterAuthUrl,
			AUTH_PROVIDERS: await loadRuntimeAuthProviders(
				database,
				runtime.authProviderSecret,
				runtime.integrationConfigSecret,
			),
		});
	});

	afterAll(async () => miniflare.dispose());

	it("creates one canonical Telegram account/session and rejects replay", async () => {
		const initData = await signedTelegramInitData(
			botToken,
			Math.floor(Date.now() / 1_000),
			{
				user: telegramUser("https://cdn.example/telegram-avatar.jpg"),
			},
		);
		const request = (data = initData) =>
			new Request("https://shop.example/api/auth/telegram/miniapp/signin", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: "https://shop.example",
					"x-gmshop-client-ip": "203.0.113.10",
				},
				body: JSON.stringify({ initData: data }),
			});
		const response = await auth.handler(request());
		expect(response.status).toBe(200);
		expect(response.headers.get("set-cookie")).toContain(
			"better-auth.session_token",
		);
		const state = await database
			.prepare(`SELECT
			 (SELECT COUNT(*) FROM users) AS users,
			 (SELECT COUNT(*) FROM accounts WHERE provider_id = 'telegram') AS accounts,
			 (SELECT preferred_locale FROM users WHERE email LIKE '%@telegram.invalid' LIMIT 1) AS telegram_locale,
			 (SELECT image FROM users WHERE email LIKE '%@telegram.invalid' LIMIT 1) AS telegram_image,
			 (SELECT COUNT(*) FROM verifications WHERE identifier LIKE 'telegram-mini-app:%') AS receipts,
			 (SELECT COUNT(*) FROM audit_logs WHERE action = 'auth.telegram_mini_app_signed_in') AS audits`)
			.first<Record<string, unknown>>();
		expect(state).toEqual({
			users: 2,
			accounts: 1,
			telegram_locale: "zh-CN",
			telegram_image: "https://cdn.example/telegram-avatar.jpg",
			receipts: 1,
			audits: 1,
		});

		const replay = await auth.handler(request());
		expect(replay.status).toBe(401);
		const replayBody = await replay.text();
		expect(replayBody).not.toContain(botToken);
		expect(replayBody).not.toContain(initData);
	});

	it("fills a missing trusted avatar without replacing a custom avatar", async () => {
		await database
			.prepare(
				`UPDATE users SET image = NULL
				 WHERE email = '900719925474000@telegram.invalid'`,
			)
			.run();
		const first = await signedTelegramInitData(
			botToken,
			Math.floor(Date.now() / 1_000),
			{
				query_id: "AAEAA-avatar-backfill",
				user: telegramUser("https://cdn.example/avatar-backfill.jpg"),
			},
		);
		expect(await signInMiniApp(auth, first)).toBe(200);
		expect(await telegramImage(database)).toBe(
			"https://cdn.example/avatar-backfill.jpg",
		);

		await database
			.prepare(
				`UPDATE users SET image = 'https://shop.example/custom-avatar.jpg'
				 WHERE email = '900719925474000@telegram.invalid'`,
			)
			.run();
		const second = await signedTelegramInitData(
			botToken,
			Math.floor(Date.now() / 1_000),
			{
				query_id: "AAEAA-avatar-preserve",
				user: telegramUser("https://cdn.example/avatar-replacement.jpg"),
			},
		);
		expect(await signInMiniApp(auth, second)).toBe(200);
		expect(await telegramImage(database)).toBe(
			"https://shop.example/custom-avatar.jpg",
		);

		await database
			.prepare(
				`UPDATE users SET image = NULL
				 WHERE email = '900719925474000@telegram.invalid'`,
			)
			.run();
		const invalid = await signedTelegramInitData(
			botToken,
			Math.floor(Date.now() / 1_000),
			{
				query_id: "AAEAA-avatar-invalid",
				user: telegramUser("http://cdn.example/insecure-avatar.jpg"),
			},
		);
		expect(await signInMiniApp(auth, invalid)).toBe(200);
		expect(await telegramImage(database)).toBeNull();
	});

	it("rejects untrusted origins, disabled users and disabled providers", async () => {
		const authDate = Math.floor(Date.now() / 1_000);
		const untrustedData = await signedTelegramInitData(botToken, authDate, {
			query_id: "AAEAA-untrusted-origin",
		});
		const untrusted = await auth.handler(
			new Request("https://shop.example/api/auth/telegram/miniapp/signin", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: "https://evil.example",
				},
				body: JSON.stringify({
					initData: untrustedData,
				}),
			}),
		);
		expect(untrusted.status).toBeGreaterThanOrEqual(400);

		await database
			.prepare(
				`UPDATE users SET enabled = 0 WHERE email =
				 '900719925474000@telegram.invalid'`,
			)
			.run();
		const disabledData = await signedTelegramInitData(botToken, authDate, {
			query_id: "AAEAA-disabled-user",
		});
		const disabled = await auth.handler(
			new Request("https://shop.example/api/auth/telegram/miniapp/signin", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: "https://shop.example",
				},
				body: JSON.stringify({
					initData: disabledData,
				}),
			}),
		);
		expect(disabled.status).toBe(403);

		const withoutProvider = createAuth(drizzle(database, { schema }), {
			BETTER_AUTH_SECRET: runtime.betterAuthSecret,
			BETTER_AUTH_URL: runtime.betterAuthUrl,
			AUTH_PROVIDERS: [],
		});
		const unavailable = await withoutProvider.handler(
			new Request("https://shop.example/api/auth/telegram/miniapp/signin", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: "https://shop.example",
				},
				body: JSON.stringify({
					initData: disabledData,
				}),
			}),
		);
		expect(unavailable.status).toBe(404);
	});
});

function telegramUser(photoUrl: string) {
	return JSON.stringify({
		id: 900_719_925_474_000,
		first_name: "Mini",
		last_name: "User",
		username: "mini_user",
		language_code: "zh-CN",
		photo_url: photoUrl,
	});
}

async function signInMiniApp(
	auth: ReturnType<typeof createAuth>,
	initData: string,
) {
	const response = await auth.handler(
		new Request("https://shop.example/api/auth/telegram/miniapp/signin", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "https://shop.example",
				"x-gmshop-client-ip": "203.0.113.11",
			},
			body: JSON.stringify({ initData }),
		}),
	);
	return response.status;
}

async function telegramImage(database: D1Database) {
	return (
		await database
			.prepare(
				`SELECT image FROM users
				 WHERE email = '900719925474000@telegram.invalid'`,
			)
			.first<{ image: string | null }>()
	)?.image;
}
