import { drizzle } from "drizzle-orm/d1";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "#/db/schema";
import { createAuth } from "#/features/auth/server/auth-factory";
import {
	decryptNotificationMessage,
	encryptNotificationConfig,
} from "#/features/notifications/secrets";
import { applyMigrations } from "./migrations";

let authEmailRequestAddress = 10;

describe("authentication email flow", { timeout: 30_000 }, () => {
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
		await seed(database);
	});

	afterEach(async () => miniflare.dispose());

	it("queues encrypted verification and reset messages without exposing tokens", async () => {
		const auth = createEmailAuth(database);
		const signup = await auth.handler(
			jsonRequest("/api/auth/sign-up/email", {
				name: "Buyer",
				email: "buyer@example.com",
				password: "very-secure-password",
				preferredLocale: "zh-CN",
				callbackURL: "/account",
			}),
		);
		expect(signup.status).toBe(200);
		const registered = await database
			.prepare(
				`SELECT u.role_ids, u.preferred_locale, r.name AS role_name, r.permissions_json
				 FROM users u
				 JOIN json_each(u.role_ids) assigned
				 JOIN roles r ON r.id = assigned.value
				 WHERE u.email = 'buyer@example.com'`,
			)
			.first<{
				role_ids: string;
				role_name: string;
				permissions_json: string;
				preferred_locale: string;
			}>();
		expect(registered).toMatchObject({
			role_name: "customer",
			permissions_json: "{}",
			preferred_locale: "zh-CN",
		});
		expect(JSON.parse(registered?.role_ids ?? "[]")).toHaveLength(1);
		const reset = await auth.handler(
			jsonRequest("/api/auth/email-otp/request-password-reset", {
				email: "buyer@example.com",
			}),
		);
		expect(reset.status).toBe(200);
		const deliveries = await database
			.prepare(
				`SELECT event, locale, idempotency_key, message_encrypted
				 FROM notification_deliveries ORDER BY created_at, id`,
			)
			.all<Record<string, unknown>>();
		expect(deliveries.results.map((row) => row.event).sort()).toEqual([
			"auth.email_verification",
			"auth.password_reset",
		]);
		expect(deliveries.results.every((row) => row.locale === "zh-CN")).toBe(
			true,
		);
		for (const delivery of deliveries.results) {
			expect(String(delivery.message_encrypted)).not.toContain(
				"buyer@example.com",
			);
			expect(String(delivery.idempotency_key)).not.toContain("reset-password");
			expect(String(delivery.idempotency_key)).toMatch(/[a-f0-9]{64}$/);
		}
		const resetDelivery = deliveries.results.find(
			(delivery) => delivery.event === "auth.password_reset",
		);
		const resetMessage = JSON.parse(
			await decryptNotificationMessage(
				String(resetDelivery?.message_encrypted),
				"commerce-test-secret",
			),
		) as { text: string };
		expect(resetMessage.text).toContain("密码重置验证码");
		const otp = resetMessage.text.match(/\b\d{6}\b/)?.[0];
		expect(otp).toMatch(/^\d{6}$/);
		const completed = await auth.handler(
			jsonRequest("/api/auth/email-otp/reset-password", {
				email: "buyer@example.com",
				otp,
				password: "new-very-secure-password",
			}),
		);
		expect(completed.status).toBe(200);
		const signIn = await auth.handler(
			jsonRequest("/api/auth/sign-in/email", {
				email: "buyer@example.com",
				password: "new-very-secure-password",
			}),
		);
		expect(signIn.status).toBe(200);
	});

	it("binds an unverified identity email only after new-email verification", async () => {
		const auth = createEmailAuth(database);
		const signup = await signUp(auth, "temporary@example.com");
		const initialVerification = await latestEmail(database);
		await auth.handler(
			new Request(emailUrl(initialVerification.text), {
				headers: { cookie: responseCookie(signup) },
			}),
		);
		const signedIn = await auth.handler(
			jsonRequest("/api/auth/sign-in/email", {
				email: "temporary@example.com",
				password: "very-secure-password",
			}),
		);
		const cookie = responseCookie(signedIn);
		await database
			.prepare(
				`UPDATE users SET email = '42@telegram.invalid',
				 email_verified = 1 WHERE email = 'temporary@example.com'`,
			)
			.run();
		await clearDeliveries(database);
		const placeholderSignIn = await auth.handler(
			jsonRequest("/api/auth/sign-in/email", {
				email: "42@telegram.invalid",
				password: "very-secure-password",
			}),
		);
		expect(placeholderSignIn.status).toBe(401);
		await database
			.prepare(
				`UPDATE users SET email_verified = 0
				 WHERE email = '42@telegram.invalid'`,
			)
			.run();

		const requested = await auth.handler(
			jsonRequest(
				"/api/auth/change-email",
				{
					newEmail: "bound@example.com",
					callbackURL: "/account/settings",
				},
				cookie,
			),
		);
		expect(requested.status).toBe(200);
		expect(await userEmail(database, "42@telegram.invalid")).toEqual({
			email: "42@telegram.invalid",
			email_verified: 0,
		});

		const verification = await latestEmail(database);
		expect(verification.to).toBe("bound@example.com");
		expect(verification.subject).toContain("Verify your Test Shop email");
		const verified = await auth.handler(
			new Request(emailUrl(verification.text), { headers: { cookie } }),
		);
		expect(verified.status).toBe(302);
		expect(verified.headers.get("location")).toContain("/account/settings");
		expect(await userEmail(database, "bound@example.com")).toEqual({
			email: "bound@example.com",
			email_verified: 1,
		});
	});

	it("signs an existing user in with a code when enabled on Email", async () => {
		const passwordAuth = createEmailAuth(database);
		await verifySignup(
			passwordAuth,
			database,
			await signUp(passwordAuth, "otp@example.com"),
		);
		await clearDeliveries(database);
		const otpAuth = createEmailAuth(database, true, true);
		const sent = await otpAuth.handler(
			jsonRequest("/api/auth/email-otp/send-verification-otp", {
				email: "otp@example.com",
				type: "sign-in",
			}),
		);
		expect(sent.status).toBe(200);
		const delivery = await latestEmail(database);
		expect(delivery.subject).toContain("sign-in code");
		const otp = delivery.text.match(/\b\d{6}\b/)?.[0];
		expect(otp).toMatch(/^\d{6}$/);
		const signedIn = await otpAuth.handler(
			jsonRequest("/api/auth/sign-in/email-otp", {
				email: "otp@example.com",
				otp,
			}),
		);
		expect(signedIn.status).toBe(200);
		expect(responseCookie(signedIn)).toContain("better-auth.session_token");
	});

	it("confirms a verified email change with the old address before the new one", async () => {
		const auth = createEmailAuth(database);
		const signup = await signUp(auth, "current@example.com");
		const initialVerification = await latestEmail(database);
		await auth.handler(
			new Request(emailUrl(initialVerification.text), {
				headers: { cookie: responseCookie(signup) },
			}),
		);
		await clearDeliveries(database);
		const signedIn = await auth.handler(
			jsonRequest("/api/auth/sign-in/email", {
				email: "current@example.com",
				password: "very-secure-password",
			}),
		);
		const cookie = responseCookie(signedIn);

		const requested = await auth.handler(
			jsonRequest(
				"/api/auth/change-email",
				{
					newEmail: "changed@example.com",
					callbackURL: "/account/settings",
				},
				cookie,
			),
		);
		expect(requested.status).toBe(200);
		const confirmation = await latestEmail(database);
		expect(confirmation.to).toBe("current@example.com");
		expect(confirmation.subject).toContain(
			"Confirm your Test Shop email change",
		);
		expect(await userEmail(database, "current@example.com")).toMatchObject({
			email: "current@example.com",
			email_verified: 1,
		});

		const confirmed = await auth.handler(
			new Request(emailUrl(confirmation.text), { headers: { cookie } }),
		);
		expect(confirmed.status).toBe(302);
		expect(await userEmail(database, "current@example.com")).toMatchObject({
			email: "current@example.com",
			email_verified: 1,
		});
		const verification = await latestEmail(database);
		expect(verification.to).toBe("changed@example.com");
		expect(verification.subject).toContain("Verify your Test Shop email");

		const verified = await auth.handler(
			new Request(emailUrl(verification.text), { headers: { cookie } }),
		);
		expect(verified.status).toBe(302);
		expect(await userEmail(database, "changed@example.com")).toEqual({
			email: "changed@example.com",
			email_verified: 1,
		});
		const audit = await database
			.prepare(
				`SELECT COUNT(*) AS count FROM audit_logs
				 WHERE action = 'auth.email_change_requested'`,
			)
			.first<{ count: number }>();
		expect(audit?.count).toBe(1);
	});

	it("does not reveal duplicate emails and disables changes without delivery", async () => {
		const auth = createEmailAuth(database);
		await verifySignup(
			auth,
			database,
			await signUp(auth, "primary@example.com"),
		);
		await verifySignup(
			auth,
			database,
			await signUp(auth, "occupied@example.com"),
		);
		await clearDeliveries(database);
		const signedIn = await auth.handler(
			jsonRequest("/api/auth/sign-in/email", {
				email: "primary@example.com",
				password: "very-secure-password",
			}),
		);
		const cookie = responseCookie(signedIn);
		const duplicate = await auth.handler(
			jsonRequest(
				"/api/auth/change-email",
				{
					newEmail: "occupied@example.com",
					callbackURL: "/account/settings",
				},
				cookie,
			),
		);
		expect(duplicate.status).toBe(200);
		expect(
			(
				await database
					.prepare("SELECT COUNT(*) AS count FROM notification_deliveries")
					.first<{ count: number }>()
			)?.count,
		).toBe(0);

		const unavailable = await createEmailAuth(database, false).handler(
			jsonRequest(
				"/api/auth/change-email",
				{
					newEmail: "another@example.com",
					callbackURL: "/account/settings",
				},
				cookie,
			),
		);
		expect(unavailable.status).toBe(400);
	});

	it("rate limits repeated email change requests", async () => {
		const auth = createEmailAuth(database);
		await verifySignup(
			auth,
			database,
			await signUp(auth, "limited@example.com"),
		);
		await clearDeliveries(database);
		const signedIn = await auth.handler(
			jsonRequest("/api/auth/sign-in/email", {
				email: "limited@example.com",
				password: "very-secure-password",
			}),
		);
		const cookie = responseCookie(signedIn);
		const statuses: number[] = [];
		for (let index = 0; index < 4; index += 1) {
			const response = await auth.handler(
				jsonRequest(
					"/api/auth/change-email",
					{
						newEmail: `limited-${index}@example.com`,
						callbackURL: "/account/settings",
					},
					cookie,
					"203.0.113.88",
				),
			);
			statuses.push(response.status);
		}
		expect(statuses).toEqual([200, 200, 200, 429]);
	});
});

function createEmailAuth(
	database: D1Database,
	emailDeliveryEnabled = true,
	emailOtpEnabled = false,
) {
	return createAuth(drizzle(database, { schema }), {
		BETTER_AUTH_SECRET: "better-auth-test-secret-at-least-32-characters",
		BETTER_AUTH_URL: "https://shop.example",
		TRUSTED_ORIGINS: ["https://shop.example"],
		EMAIL_DELIVERY_ENABLED: emailDeliveryEnabled,
		REQUIRE_EMAIL_VERIFICATION: true,
		SITE_NAME: "Test Shop",
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
				emailOtpEnabled,
				revision: 1,
				telegramBotUserId: null,
				telegramBotUsername: null,
				telegramBotToken: null,
				telegramMiniAppEnabled: false,
			},
		],
	});
}

function jsonRequest(
	path: string,
	body: unknown,
	cookie?: string,
	clientIp?: string,
) {
	return new Request(`https://shop.example${path}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Origin: "https://shop.example",
			...(cookie ? { Cookie: cookie } : {}),
			"x-gmshop-client-ip":
				clientIp ?? `198.51.100.${authEmailRequestAddress++}`,
		},
		body: JSON.stringify(body),
	});
}

async function verifySignup(
	auth: ReturnType<typeof createAuth>,
	database: D1Database,
	signup: Response,
) {
	const verification = await latestEmail(database);
	const response = await auth.handler(
		new Request(emailUrl(verification.text), {
			headers: { cookie: responseCookie(signup) },
		}),
	);
	expect(response.status).toBe(302);
}

function signUp(auth: ReturnType<typeof createAuth>, email: string) {
	return auth.handler(
		jsonRequest("/api/auth/sign-up/email", {
			name: "Buyer",
			email,
			password: "very-secure-password",
			preferredLocale: "en-US",
			callbackURL: "/account/settings",
		}),
	);
}

function responseCookie(response: Response) {
	return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

async function clearDeliveries(database: D1Database) {
	await database.prepare("DELETE FROM notification_deliveries").run();
}

async function latestEmail(database: D1Database) {
	const delivery = await database
		.prepare(
			`SELECT message_encrypted FROM notification_deliveries
			 ORDER BY created_at DESC, id DESC LIMIT 1`,
		)
		.first<{ message_encrypted: string }>();
	return JSON.parse(
		await decryptNotificationMessage(
			delivery?.message_encrypted ?? "",
			"commerce-test-secret",
		),
	) as { subject: string; text: string; to: string };
}

function emailUrl(text: string) {
	const match = text.match(/https:\/\/\S+/);
	if (!match) throw new Error("Verification email does not contain a URL");
	return match[0];
}

function userEmail(database: D1Database, email: string) {
	return database
		.prepare("SELECT email, email_verified FROM users WHERE email = ?")
		.bind(email)
		.first<{ email: string; email_verified: number }>();
}

async function seed(database: D1Database) {
	const apiKeyEncrypted = await encryptNotificationConfig(
		"re_test_key",
		"commerce-test-secret",
	);
	await database.batch([
		database.prepare(
			`INSERT INTO roles
			 (id, name, description, built_in, enabled, permissions_json, created_at, updated_at)
			 VALUES ('00000000-0000-4000-8000-000000000050', 'customer',
			  'Built-in authenticated storefront customer role', 1, 1, '{}', 1, 1)`,
		),
		database.prepare(
			`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
			 VALUES ('runtime.data_encryption_secret', '"commerce-test-secret"', 1, 1, 1)`,
		),
		database
			.prepare(
				`INSERT INTO notification_channel_configs
				 (id, channel, name, provider, api_key_encrypted, api_key_version,
				  from_address, sort_order, enabled, created_at, updated_at)
				 VALUES ('email-config', 'email', 'Primary', 'resend', ?, 1,
				  'Test Shop <mail@example.com>', 100, 1, 1, 1)`,
			)
			.bind(apiKeyEncrypted),
	]);
}
