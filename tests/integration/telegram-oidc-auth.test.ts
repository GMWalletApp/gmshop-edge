import { drizzle } from "drizzle-orm/d1";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "#/db/schema";
import {
	authProviderSecretKey,
	authProviderSecretPurpose,
	authProviderSettingKeys,
	initialStoredAuthProviders,
	telegramBotTokenSecretPurpose,
} from "#/features/auth/provider-settings";
import { createAuth } from "#/features/auth/server/auth-factory";
import { loadRuntimeAuthProviders } from "#/features/auth/server/provider-runtime";
import { installSystem } from "#/features/installation/server/install";
import { encryptSecret } from "#/lib/secrets";
import { createInitialRuntimeConfig } from "#/server/runtime-config";
import { applyMigrations } from "./migrations";

let requestAddress = 10;

describe("Telegram OIDC Better Auth login", { timeout: 30_000 }, () => {
	let miniflare: Miniflare;
	let database: D1Database;
	let auth: ReturnType<typeof createAuth>;
	let tokenNonce = "";
	const runtime = createInitialRuntimeConfig("https://shop.example");
	const clientId = "123456789";
	const clientSecret = "telegram-oidc-client-secret";
	const botToken = "123456:telegram-widget-token-value";
	let telegramUserId = "987654321";
	let telegramPicture = "https://cdn.example/telegram-oidc-avatar.jpg";

	beforeAll(async () => {
		const keys = await generateKeyPair("RS256");
		const publicJwk = await exportJWK(keys.publicKey);
		Object.assign(publicJwk, {
			alg: "RS256",
			kid: "telegram-test",
			use: "sig",
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url === "https://oauth.telegram.org/token") {
					const body = new URLSearchParams(String(init?.body));
					expect(body.get("client_id")).toBe(clientId);
					expect(body.get("client_secret")).toBe(clientSecret);
					const now = Math.floor(Date.now() / 1_000);
					const idToken = await new SignJWT({
						nonce: tokenNonce,
						name: "Telegram Shopper",
						picture: telegramPicture,
						preferred_username: "shopper",
					})
						.setProtectedHeader({ alg: "RS256", kid: "telegram-test" })
						.setIssuer("https://oauth.telegram.org")
						.setAudience(clientId)
						.setSubject(telegramUserId)
						.setIssuedAt(now)
						.setExpirationTime(now + 300)
						.sign(keys.privateKey);
					return Response.json({
						access_token: "telegram-access-token",
						token_type: "Bearer",
						expires_in: 3_600,
						id_token: idToken,
					});
				}
				if (url === "https://oauth.telegram.org/.well-known/jwks.json")
					return Response.json({ keys: [publicJwk] });
				throw new Error(`Unexpected Telegram OIDC request: ${url}`);
			}),
		);
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmshop-edge-telegram-oidc-auth" },
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
				id: "22222222-2222-4222-8222-222222222222",
				providerId: "telegram",
				providerType: "social",
				displayName: "Telegram",
				icon: null,
				clientId,
				scopes: ["openid", "profile"],
				allowSignup: true,
				enabled: true,
				sortOrder: 10,
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
							clientSecret,
							runtime.authProviderSecret,
							authProviderSecretPurpose("telegram"),
						),
					),
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
					authProviderSettingKeys.telegramBotToken,
					JSON.stringify(
						await encryptSecret(
							botToken,
							runtime.authProviderSecret,
							telegramBotTokenSecretPurpose(),
						),
					),
					now,
					now,
				),
			database
				.prepare(
					`INSERT OR REPLACE INTO system_settings
				 (key, value, is_secret, created_at, updated_at)
				 VALUES (?, ?, 0, ?, ?)`,
				)
				.bind(
					authProviderSettingKeys.telegramBotUserId,
					JSON.stringify("123456"),
					now,
					now,
				),
			database
				.prepare(
					`INSERT OR REPLACE INTO system_settings
				 (key, value, is_secret, created_at, updated_at)
				 VALUES (?, ?, 0, ?, ?)`,
				)
				.bind(
					authProviderSettingKeys.telegramUsername,
					JSON.stringify("gmshop_test_bot"),
					now,
					now,
				),
		]);
		const runtimeProviders = await loadRuntimeAuthProviders(
			database,
			runtime.authProviderSecret,
			runtime.integrationConfigSecret,
		);
		expect(
			runtimeProviders.find((provider) => provider.providerId === "telegram"),
		).toMatchObject({
			clientSecret,
			telegramBotToken: botToken,
		});
		auth = createAuth(drizzle(database, { schema }), {
			BETTER_AUTH_SECRET: runtime.betterAuthSecret,
			BETTER_AUTH_URL: runtime.betterAuthUrl,
			AUTH_PROVIDER_SECRET: runtime.authProviderSecret,
			AUTH_PROVIDERS: runtimeProviders,
		});
	});

	afterAll(async () => {
		vi.unstubAllGlobals();
		await miniflare.dispose();
	});

	it("verifies state, PKCE, nonce, issuer, audience, signature and time", async () => {
		const started = await startOidc(auth);
		tokenNonce = started.url.searchParams.get("nonce") ?? "";
		expect(tokenNonce).toHaveLength(43);
		expect(started.url.searchParams.get("origin")).toBe("https://shop.example");
		expect(started.url.searchParams.get("redirect_uri")).toBe(
			"https://shop.example/api/auth/callback/telegram",
		);
		expect(started.url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(started.url.searchParams.get("code_challenge")).toHaveLength(43);
		const response = await callbackOidc(auth, started.state, started.cookie);
		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe("/account");
		expect(response.headers.get("set-cookie")).toContain(
			"better-auth.session_token",
		);
		const state = await database
			.prepare(`SELECT
			 (SELECT COUNT(*) FROM users WHERE email = ?) AS users,
			 (SELECT COUNT(*) FROM accounts WHERE provider_id = 'telegram' AND account_id = ?) AS accounts,
			 (SELECT image FROM users WHERE email = ?) AS image,
			 (SELECT COUNT(*) FROM audit_logs WHERE action = 'auth.telegram_oidc_signed_in') AS audits`)
			.bind(
				`${telegramUserId}@telegram.invalid`,
				telegramUserId,
				`${telegramUserId}@telegram.invalid`,
			)
			.first<Record<string, number | string>>();
		expect(state).toEqual({
			users: 1,
			accounts: 1,
			image: telegramPicture,
			audits: 1,
		});
		const replay = await callbackOidc(auth, started.state, started.cookie);
		expect(replay.status).toBe(302);
		expect(replay.headers.get("location")).toContain("error=");
	});

	it("backfills only a missing OIDC avatar and rejects insecure URLs", async () => {
		const telegramEmail = `${telegramUserId}@telegram.invalid`;
		await database
			.prepare("UPDATE users SET image = NULL WHERE email = ?")
			.bind(telegramEmail)
			.run();
		telegramPicture = "https://cdn.example/telegram-oidc-backfill.jpg";
		let started = await startOidc(auth);
		tokenNonce = started.url.searchParams.get("nonce") ?? "";
		expect(
			(await callbackOidc(auth, started.state, started.cookie)).status,
		).toBe(302);
		expect(await oidcUserImage(database, telegramEmail)).toBe(telegramPicture);

		await database
			.prepare("UPDATE users SET image = ? WHERE email = ?")
			.bind("https://shop.example/custom-avatar.jpg", telegramEmail)
			.run();
		telegramPicture = "https://cdn.example/telegram-oidc-replacement.jpg";
		started = await startOidc(auth);
		tokenNonce = started.url.searchParams.get("nonce") ?? "";
		expect(
			(await callbackOidc(auth, started.state, started.cookie)).status,
		).toBe(302);
		expect(await oidcUserImage(database, telegramEmail)).toBe(
			"https://shop.example/custom-avatar.jpg",
		);

		await database
			.prepare("UPDATE users SET image = NULL WHERE email = ?")
			.bind(telegramEmail)
			.run();
		telegramPicture = "http://cdn.example/insecure-avatar.jpg";
		started = await startOidc(auth);
		tokenNonce = started.url.searchParams.get("nonce") ?? "";
		expect(
			(await callbackOidc(auth, started.state, started.cookie)).status,
		).toBe(302);
		expect(await oidcUserImage(database, telegramEmail)).toBeNull();
	});

	it("rejects a correctly signed token carrying the wrong nonce", async () => {
		const started = await startOidc(auth);
		tokenNonce = "wrong-nonce";
		const response = await callbackOidc(auth, started.state, started.cookie);
		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toContain("error=invalid_code");
		expect(response.headers.get("location")).not.toContain(clientSecret);
	});

	it("links a new Telegram identity only from an authenticated session", async () => {
		telegramUserId = "555555555";
		telegramPicture = "https://cdn.example/linked-telegram-avatar.jpg";
		const signedIn = await auth.api.signInEmail({
			body: {
				email: "root@example.com",
				password: "root-secure-password",
			},
			asResponse: true,
		});
		const cookie = responseCookie(signedIn);
		const unauthenticated = await startOidc(auth, { link: true });
		expect(unauthenticated.response.status).toBe(401);

		const started = await startOidc(auth, { cookie, link: true });
		expect(started.response.status).toBe(200);
		tokenNonce = started.url.searchParams.get("nonce") ?? "";
		const response = await callbackOidc(
			auth,
			started.state,
			`${cookie}; ${started.cookie}`,
		);
		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe("/account");

		const state = await database
			.prepare(
				`SELECT
				 (SELECT COUNT(*) FROM users) AS users,
				 (SELECT COUNT(*) FROM accounts account JOIN users user ON user.id = account.user_id
				   WHERE account.provider_id = 'telegram' AND account.account_id = ?
				    AND user.email = 'root@example.com') AS linked,
				 (SELECT COUNT(*) FROM audit_logs
				   WHERE action = 'auth.telegram_oidc_signed_in' AND target_id = ?) AS audits`,
			)
			.bind(telegramUserId, `telegram:${telegramUserId}`)
			.first<Record<string, number>>();
		expect(state).toEqual({ users: 2, linked: 1, audits: 1 });
	});
});

async function startOidc(
	auth: ReturnType<typeof createAuth>,
	options: { cookie?: string; link?: boolean } = {},
) {
	const response = await auth.handler(
		new Request(
			`https://shop.example/api/auth/${options.link ? "link-social" : "sign-in/social"}`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: "https://shop.example",
					"x-gmshop-client-ip": `203.0.113.${requestAddress++}`,
					...(options.cookie ? { cookie: options.cookie } : {}),
				},
				body: JSON.stringify({
					provider: "telegram",
					callbackURL: "/account",
					disableRedirect: true,
				}),
			},
		),
	);
	const redirectLocation = response.headers.get("location");
	if (redirectLocation) {
		const url = new URL(redirectLocation);
		return {
			response,
			url,
			state: url.searchParams.get("state") ?? "",
			cookie: responseCookie(response),
		};
	}
	if (!response.ok) {
		const diagnostic = await response.clone().text();
		return {
			response,
			url: new URL(
				`https://oauth.telegram.org/auth?status=${response.status}&body=${encodeURIComponent(diagnostic)}`,
			),
			state: "",
			cookie: "",
		};
	}
	const body = (await response.clone().json()) as { url: string };
	const url = new URL(body.url);
	return {
		response,
		url,
		state: url.searchParams.get("state") ?? "",
		cookie: responseCookie(response),
	};
}

function callbackOidc(
	auth: ReturnType<typeof createAuth>,
	state: string,
	cookie: string,
) {
	const url = new URL("https://shop.example/api/auth/callback/telegram");
	url.searchParams.set("code", "authorization-code");
	url.searchParams.set("state", state);
	return auth.handler(new Request(url, { headers: { cookie } }));
}

async function oidcUserImage(database: D1Database, email: string) {
	return (
		await database
			.prepare("SELECT image FROM users WHERE email = ?")
			.bind(email)
			.first<{ image: string | null }>()
	)?.image;
}

function responseCookie(response: Response) {
	return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}
