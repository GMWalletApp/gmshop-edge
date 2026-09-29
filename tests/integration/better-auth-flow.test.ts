import { drizzle } from "drizzle-orm/d1";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "#/db/schema";
import { createAuth } from "#/features/auth/server/auth-factory";
import { installSystem } from "#/features/installation/server/install";
import { createInitialRuntimeConfig } from "#/server/runtime-config";
import {
	createDatastoreCounters,
	instrumentD1,
} from "../helpers/datastore-counters";
import { applyMigrations } from "./migrations";

describe("Better Auth account security flow", () => {
	let miniflare: Miniflare;
	let database: D1Database;
	let auth: ReturnType<typeof createAuth>;
	let runtime: ReturnType<typeof createInitialRuntimeConfig>;
	const email = "root@example.com";
	const password = "exact-root-password";

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmshop-edge-better-auth-flow" },
		});
		database = await miniflare.getD1Database("DB");
		await applyMigrations(database);
		const db = drizzle(database, { schema });
		runtime = createInitialRuntimeConfig("https://pay.example");
		await installSystem(
			db,
			{
				name: "Root",
				email,
				password,
			},
			runtime,
		);
		auth = createAuth(db, {
			BETTER_AUTH_SECRET: runtime.betterAuthSecret,
			BETTER_AUTH_URL: runtime.betterAuthUrl,
		});
	});

	afterAll(async () => miniflare.dispose());

	it("keeps an authenticated Better Auth session read within an explicit D1 budget", async () => {
		const signedIn = await auth.api.signInEmail({
			body: { email, password },
			asResponse: true,
		});
		const counters = createDatastoreCounters();
		const countedAuth = createAuth(
			drizzle(instrumentD1(database, counters), { schema }),
			{
				BETTER_AUTH_SECRET: runtime.betterAuthSecret,
				BETTER_AUTH_URL: runtime.betterAuthUrl,
			},
		);
		await expect(
			countedAuth.api.getSession({
				headers: { cookie: responseCookie(signedIn) },
			}),
		).resolves.toMatchObject({ user: { email } });
		expect(counters).toMatchObject({
			d1Prepare: 2,
			d1StatementBind: 2,
			d1StatementRaw: 2,
			d1StatementFirst: 0,
			d1StatementAll: 0,
			d1StatementRun: 0,
			d1Batch: 0,
		});
	});

	it("shares D1-backed authentication rate limits across isolates, keyed by the trusted client address", async () => {
		// Two auth instances stand in for two Workers isolates (or Bun restarts)
		// that only share the database.
		const isolates = [0, 1].map(() =>
			createAuth(drizzle(database, { schema }), {
				BETTER_AUTH_SECRET: runtime.betterAuthSecret,
				BETTER_AUTH_URL: runtime.betterAuthUrl,
			}),
		);
		const attempt = (
			isolate: number,
			headers: Record<string, string>,
			path = "/api/auth/sign-in/email",
		) =>
			(isolates[isolate] ?? isolates[0])?.handler(
				new Request(`${runtime.betterAuthUrl}${path}`, {
					method: "POST",
					headers: {
						...headers,
						"content-type": "application/json",
						origin: runtime.betterAuthUrl,
					},
					body: JSON.stringify({ email, password: "incorrect-password" }),
				}),
			) as Promise<Response>;
		await awaitFreshRateLimitWindow();
		for (let attemptIndex = 0; attemptIndex < 5; attemptIndex += 1) {
			expect(
				(
					await attempt(attemptIndex % 2, {
						"x-gmshop-client-ip": "192.0.2.10",
					})
				).status,
			).toBe(401);
		}
		const limited = await attempt(1, { "x-gmshop-client-ip": "192.0.2.10" });
		expect(limited.status).toBe(429);
		expect(Number(limited.headers.get("X-Retry-After"))).toBeGreaterThan(0);
		expect(
			(await attempt(0, { "x-gmshop-client-ip": "192.0.2.10" })).status,
		).toBe(429);
		expect(
			(await attempt(0, { "x-gmshop-client-ip": "198.51.100.10" })).status,
		).toBe(401);
		// Client-supplied proxy headers are not trusted for keying.
		expect(
			(
				await attempt(1, {
					"cf-connecting-ip": "192.0.2.77",
					"x-forwarded-for": "192.0.2.78",
					"x-gmshop-client-ip": "192.0.2.10",
				})
			).status,
		).toBe(429);
		const buckets = await database
			.prepare(
				"SELECT bucket_key, count FROM rate_limit_counters WHERE bucket_key LIKE 'better-auth:%' ORDER BY bucket_key",
			)
			.all<{ bucket_key: string; count: number }>();
		expect(buckets.results).toEqual([
			{ bucket_key: "better-auth:192.0.2.10|/sign-in/email", count: 5 },
			{ bucket_key: "better-auth:198.51.100.10|/sign-in/email", count: 1 },
		]);
		const failures = await database
			.prepare(
				`SELECT COUNT(*) AS count, group_concat(after) AS payloads
				 FROM audit_logs WHERE action = 'auth.sign_in_failed'`,
			)
			.first<{ count: number; payloads: string }>();
		expect(failures?.count).toBeGreaterThanOrEqual(5);
		expect(failures?.payloads).not.toContain(email);
		expect(failures?.payloads).not.toContain("incorrect-password");
	});

	it("audits self-service password changes without storing either password", async () => {
		const signedIn = await auth.api.signInEmail({
			body: { email, password },
			asResponse: true,
		});
		const cookie = responseCookie(signedIn);
		const root = await database
			.prepare("SELECT id FROM users WHERE email = ?")
			.bind(email)
			.first<{ id: string }>();
		await database
			.prepare(
				`INSERT INTO supplier_api_keys
				 (id, user_id, name, key_id, secret_encrypted, secret_revision,
				  created_at, updated_at)
				 VALUES ('password-change-key', ?, 'Password change key',
				  'gme_password_change', 'encrypted-fixture', 1, ?, ?)`,
			)
			.bind(root?.id, Date.now(), Date.now())
			.run();
		const replacement = "replacement-root-password";
		const changed = await auth.api.changePassword({
			headers: {
				cookie,
				"x-request-id": "self-password-request",
				"x-gmshop-client-ip": "203.0.113.80",
			},
			body: {
				currentPassword: password,
				newPassword: replacement,
				revokeOtherSessions: true,
			},
			asResponse: true,
		});
		expect(changed.status, await changed.clone().text()).toBe(200);
		const audit = await database
			.prepare(
				"SELECT request_id, ip_address, after FROM audit_logs WHERE action = 'auth.password_changed' ORDER BY created_at DESC LIMIT 1",
			)
			.first<{ request_id: string; ip_address: string; after: string }>();
		expect(audit).toMatchObject({
			request_id: "self-password-request",
			ip_address: "203.0.113.80",
		});
		expect(JSON.parse(audit?.after ?? "null")).toEqual({
			revokeOtherSessions: true,
		});
		expect(audit?.after).not.toContain(password);
		expect(audit?.after).not.toContain(replacement);
		const key = await database
			.prepare(
				"SELECT revoked_at FROM supplier_api_keys WHERE id = 'password-change-key'",
			)
			.first<{ revoked_at: number | null }>();
		expect(key?.revoked_at).toEqual(expect.any(Number));

		const currentCookie = mergeResponseCookie(cookie, changed);
		const restored = await auth.api.changePassword({
			headers: { cookie: currentCookie },
			body: {
				currentPassword: replacement,
				newPassword: password,
				revokeOtherSessions: false,
			},
			asResponse: true,
		});
		expect(restored.status, await restored.clone().text()).toBe(200);
	});

	it("does not audit a rejected password change as successful", async () => {
		const signedIn = await auth.api.signInEmail({
			body: { email, password },
			asResponse: true,
		});
		const before = await database
			.prepare(
				"SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'auth.password_changed'",
			)
			.first<{ count: number }>();
		const rejected = await auth.api.changePassword({
			headers: { cookie: responseCookie(signedIn) },
			body: {
				currentPassword: "incorrect-current-password",
				newPassword: "unused-replacement-password",
				revokeOtherSessions: true,
			},
			asResponse: true,
		});
		expect(rejected.status).toBeGreaterThanOrEqual(400);
		const after = await database
			.prepare(
				"SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'auth.password_changed'",
			)
			.first<{ count: number }>();
		expect(after?.count).toBe(before?.count);
	});

	it("rejects public email registration and leaves user creation to administrators", async () => {
		const before = await database
			.prepare("SELECT COUNT(*) AS count FROM users")
			.first<{ count: number }>();
		const response = await auth.api.signUpEmail({
			body: {
				name: "Uninvited user",
				email: "uninvited@example.com",
				password: "uninvited-password-123",
			},
			asResponse: true,
		});
		expect(response.status).toBeGreaterThanOrEqual(400);
		const after = await database
			.prepare("SELECT COUNT(*) AS count FROM users")
			.first<{ count: number }>();
		expect(after?.count).toBe(before?.count);
		const uninvited = await database
			.prepare("SELECT id FROM users WHERE email = 'uninvited@example.com'")
			.first();
		expect(uninvited).toBeNull();
	});

	it("does not create a session for a disabled user", async () => {
		const before = await database
			.prepare("SELECT COUNT(*) AS count FROM sessions")
			.first<{ count: number }>();
		await database
			.prepare(
				`INSERT INTO users
				 (id, name, email, email_verified, enabled, role_ids, created_at, updated_at)
				 SELECT '11111111-1111-4111-8111-111111111111', 'Backup root',
				  'backup-root@example.com', 1, 1, role_ids, ?, ?
				 FROM users WHERE email = ?`,
			)
			.bind(Date.now(), Date.now(), email)
			.run();
		await database
			.prepare(
				"UPDATE users SET enabled = 0, disabled_at = ?, updated_at = ? WHERE email = ?",
			)
			.bind(Date.now(), Date.now(), email)
			.run();
		const response = await auth.api.signInEmail({
			body: { email, password },
			asResponse: true,
		});
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ code: "USER_DISABLED" });
		const after = await database
			.prepare("SELECT COUNT(*) AS count FROM sessions")
			.first<{ count: number }>();
		expect(after?.count).toBe(before?.count);
		await database.batch([
			database
				.prepare(
					"UPDATE users SET enabled = 1, disabled_at = NULL, updated_at = ? WHERE email = ?",
				)
				.bind(Date.now(), email),
			database.prepare(
				"DELETE FROM users WHERE email = 'backup-root@example.com'",
			),
		]);
	});

	it("rate-limits repeated failed sign-in requests from one client", async () => {
		await awaitFreshRateLimitWindow();
		const responses: Response[] = [];
		for (let attempt = 0; attempt < 6; attempt++) {
			responses.push(
				await auth.handler(
					new Request("https://pay.example/api/auth/sign-in/email", {
						method: "POST",
						headers: {
							"content-type": "application/json",
							"x-forwarded-for": "198.51.100.45",
						},
						body: JSON.stringify({ email, password: "wrong-password-value" }),
					}),
				),
			);
		}
		expect(
			responses.slice(0, 5).every((response) => response.status === 401),
		).toBe(true);
		expect(responses[5]?.status).toBe(429);
	});
});

/**
 * D1 rate limits use aligned 60-second windows; a window boundary in the
 * middle of a burst would split it, so wait it out when it is imminent.
 */
async function awaitFreshRateLimitWindow(windowMs = 60_000, marginMs = 3_000) {
	const remaining = windowMs - (Date.now() % windowMs);
	if (remaining < marginMs)
		await new Promise((resolve) => setTimeout(resolve, remaining + 50));
}

function responseCookie(response: Response) {
	const values = response.headers.getSetCookie();
	if (!values.length)
		throw new Error("Authentication response did not set a cookie");
	return values.map((value) => value.split(";", 1)[0]).join("; ");
}

function mergeResponseCookie(current: string, response: Response) {
	const updates = response.headers.getSetCookie();
	if (!updates.length) return current;
	const cookies = new Map(
		current.split("; ").map((value) => {
			const index = value.indexOf("=");
			return [value.slice(0, index), value.slice(index + 1)];
		}),
	);
	for (const update of updates) {
		const pair = update.split(";", 1)[0] ?? "";
		const index = pair.indexOf("=");
		cookies.set(pair.slice(0, index), pair.slice(index + 1));
	}
	return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}
