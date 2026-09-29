import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	reauthenticationAttemptLimit,
	reauthenticationWindowMs,
	verifySensitiveAdminAction,
} from "#/features/auth/server/reauthenticate";
import { applyMigrations } from "./migrations";

const verifyPassword = vi.fn(
	async ({ body }: { body: { password: string } }) =>
		new Response(null, {
			status: body.password === "correct-password" ? 200 : 401,
		}),
);

vi.mock("#/features/auth/server/auth", () => ({
	getAuth: async () => ({ api: { verifyPassword } }),
}));

describe("sensitive-action password confirmation", () => {
	let miniflare: Miniflare;
	let db: D1Database;
	const request = new Request("https://shop.example/admin/export", {
		headers: { cookie: "better-auth.session_token=fixture" },
	});

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmshop-edge-reauthentication-rate-limit" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
	});

	afterAll(async () => miniflare.dispose());

	it("throttles failed confirmations per user in D1 and never charges correct ones", async () => {
		const now = 1_800_000_000_000;
		// Routine operator work: many correct confirmations, no budget consumed.
		for (let index = 0; index < reauthenticationAttemptLimit + 3; index += 1)
			await expect(
				verifySensitiveAdminAction(
					request,
					"admin-a",
					{ password: "correct-password" },
					{ db, now },
				),
			).resolves.toBeUndefined();
		expect(
			(
				await db
					.prepare(
						"SELECT COUNT(*) AS total FROM rate_limit_counters WHERE bucket_key LIKE 'reauth:%'",
					)
					.first<{ total: number }>()
			)?.total,
		).toBe(0);
		// Guessing: each failure counts, and once exhausted even the correct
		// password is refused before verification runs.
		for (let attempt = 0; attempt < reauthenticationAttemptLimit; attempt += 1)
			await expect(
				verifySensitiveAdminAction(
					request,
					"admin-a",
					{ password: "wrong-password" },
					{ db, now },
				),
			).rejects.toMatchObject({ code: "reauthentication_failed", status: 401 });
		const callsBefore = verifyPassword.mock.calls.length;
		await expect(
			verifySensitiveAdminAction(
				request,
				"admin-a",
				{ password: "correct-password" },
				{ db, now },
			),
		).rejects.toMatchObject({
			code: "reauthentication_rate_limited",
			status: 429,
		});
		expect(verifyPassword).toHaveBeenCalledTimes(callsBefore);
		await expect(
			verifySensitiveAdminAction(
				request,
				"admin-b",
				{ password: "correct-password" },
				{ db, now },
			),
		).resolves.toBeUndefined();
		await expect(
			verifySensitiveAdminAction(
				request,
				"admin-a",
				{ password: "correct-password" },
				{ db, now: now + reauthenticationWindowMs },
			),
		).resolves.toBeUndefined();
		const buckets = await db
			.prepare(
				"SELECT bucket_key, count FROM rate_limit_counters WHERE bucket_key LIKE 'reauth:%' ORDER BY bucket_key, window_start",
			)
			.all<{ bucket_key: string; count: number }>();
		expect(buckets.results).toEqual([
			{ bucket_key: "reauth:admin-a", count: reauthenticationAttemptLimit },
		]);
	});
});
