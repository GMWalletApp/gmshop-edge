import { drizzle } from "drizzle-orm/d1";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "#/db/schema";
import { telegramIdentityEmail } from "#/features/auth/identity-email";
import { createAuth } from "#/features/auth/server/auth-factory";
import { installSystem } from "#/features/installation/server/install";
import { createInitialRuntimeConfig } from "#/server/runtime-config";
import { applyMigrations } from "./migrations";

const origin = "https://shop.example";
const rootEmail = "root@example.com";
const rootPassword = "exact-root-password";
let requestAddress = 20;

describe("internal identity e-mail squatting", { timeout: 30_000 }, () => {
	let miniflare: Miniflare;
	let database: D1Database;
	let auth: ReturnType<typeof createAuth>;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmshop-edge-identity-email" },
		});
		database = await miniflare.getD1Database("DB");
		await applyMigrations(database);
		const db = drizzle(database, { schema });
		const runtime = createInitialRuntimeConfig(origin);
		await installSystem(
			db,
			{ name: "Root", email: rootEmail, password: rootPassword },
			runtime,
		);
		// E-mail delivery is what enables Better Auth's change-email route; the
		// reserved-address check fires before any confirmation is queued.
		auth = createAuth(db, {
			BETTER_AUTH_SECRET: runtime.betterAuthSecret,
			BETTER_AUTH_URL: origin,
			TRUSTED_ORIGINS: [origin],
			EMAIL_DELIVERY_ENABLED: true,
			AUTH_PROVIDERS: [
				{
					id: "credential-provider",
					providerId: "credential",
					providerType: "email",
					displayName: "Email",
					clientId: null,
					clientSecret: null,
					scopes: [],
					allowSignup: true,
					passwordLoginEnabled: true,
					emailOtpEnabled: false,
					revision: 1,
					telegramBotUserId: null,
					telegramBotUsername: null,
					telegramBotToken: null,
					telegramMiniAppEnabled: false,
				},
			],
		});
	});

	afterAll(async () => miniflare.dispose());

	it.each([
		telegramIdentityEmail("424242"),
		"424242@identity.gmshop.invalid",
		"424242@TELEGRAM.INVALID",
	])("rejects registration with the reserved address %s", async (email) => {
		const response = await auth.handler(
			jsonRequest("/api/auth/sign-up/email", {
				name: "Squatter",
				email,
				password: "squatter-password-123",
			}),
		);
		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			code: "INVALID_EMAIL",
		});
		const users = await database
			.prepare(
				"SELECT COUNT(*) AS count FROM users WHERE lower(email) = lower(?)",
			)
			.bind(email)
			.first<{ count: number }>();
		expect(users?.count).toBe(0);
	});

	it("rejects moving an existing account onto a reserved address", async () => {
		const signedIn = await auth.handler(
			jsonRequest("/api/auth/sign-in/email", {
				email: rootEmail,
				password: rootPassword,
			}),
		);
		expect(signedIn.status).toBe(200);
		const cookie = signedIn.headers
			.getSetCookie()
			.map((value) => value.split(";", 1)[0])
			.join("; ");
		const response = await auth.handler(
			jsonRequest(
				"/api/auth/change-email",
				{
					newEmail: telegramIdentityEmail("777"),
					callbackURL: "/account/settings",
				},
				cookie,
			),
		);
		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			code: "INVALID_EMAIL",
		});
		const root = await database
			.prepare("SELECT email FROM users WHERE email = ?")
			.bind(rootEmail)
			.first<{ email: string }>();
		expect(root).toEqual({ email: rootEmail });
		const pending = await database
			.prepare(
				"SELECT COUNT(*) AS count FROM verifications WHERE value LIKE '%telegram.invalid%'",
			)
			.first<{ count: number }>();
		expect(pending?.count).toBe(0);
	});

	it("still rejects password sign-in against reserved addresses without revealing existence", async () => {
		const response = await auth.handler(
			jsonRequest("/api/auth/sign-in/email", {
				email: telegramIdentityEmail("424242"),
				password: "squatter-password-123",
			}),
		);
		expect(response.status).toBe(401);
	});
});

function jsonRequest(path: string, body: unknown, cookie?: string) {
	return new Request(`${origin}${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			origin,
			"x-gmshop-client-ip": `198.51.100.${requestAddress++}`,
			...(cookie ? { cookie } : {}),
		},
		body: JSON.stringify(body),
	});
}
