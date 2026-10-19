import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enforceDurableAuthRateLimit } from "#/features/auth/server/durable-rate-limit";
import { publishAuthSecurityAlert } from "#/features/auth/server/security-alerts";
import { applyMigrations } from "./migrations";

describe("durable authentication abuse protection", () => {
	let runtime: Miniflare;
	let db: D1Database;
	beforeAll(async () => {
		runtime = new Miniflare({
			modules: true,
			script: "export default {fetch(){return new Response('ok')}}",
			d1Databases: { DB: "auth-abuse" },
		});
		db = await runtime.getD1Database("DB");
		await applyMigrations(db);
	});
	afterAll(async () => runtime.dispose());
	const headers = (ip: string) => new Headers({ "cf-connecting-ip": ip });
	it("atomically caps concurrent login attempts across independent callers", async () => {
		const results = await Promise.allSettled(
			Array.from({ length: 12 }, () =>
				enforceDurableAuthRateLimit(
					db,
					"/sign-in/email",
					headers("198.51.100.1"),
					{ email: "test@example.com", password: "DO_NOT_RECORD" },
					1000,
				),
			),
		);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
		const events = await db
			.prepare(
				"SELECT after FROM audit_logs WHERE action='security.auth_rate_limited'",
			)
			.all();
		expect(events.results).toHaveLength(1);
		expect(JSON.stringify(events.results)).not.toContain("DO_NOT_RECORD");
		expect(JSON.stringify(events.results)).not.toContain("test@example.com");
	});
	it("caps verification mail across rotating IPs over ten minutes", async () => {
		for (let i = 0; i < 3; i++)
			await enforceDurableAuthRateLimit(
				db,
				"/send-verification-email",
				headers(`198.51.110.${i}`),
				{ email: "Victim@customer.com" },
				i * 60000,
			);
		await expect(
			enforceDurableAuthRateLimit(
				db,
				"/send-verification-email",
				headers("198.51.110.9"),
				{ email: " victim@customer.com " },
				180000,
			),
		).rejects.toMatchObject({ status: "TOO_MANY_REQUESTS" });
		await expect(
			enforceDurableAuthRateLimit(
				db,
				"/send-verification-email",
				headers("198.51.110.9"),
				{ email: "victim@customer.com" },
				600000,
			),
		).resolves.toBeUndefined();
	});
	it("caps outbound mail to one recipient at ten per day", async () => {
		const day = 86_400_000 * 100;
		for (let i = 0; i < 10; i++)
			await enforceDurableAuthRateLimit(
				db,
				"/email-otp/request-password-reset",
				headers(`198.51.120.${i}`),
				{ email: "daily@customer.com" },
				day + i * 600_000,
			);
		await expect(
			enforceDurableAuthRateLimit(
				db,
				"/email-otp/request-password-reset",
				headers("198.51.120.99"),
				{ email: "daily@customer.com" },
				day + 10 * 600_000,
			),
		).rejects.toMatchObject({ status: "TOO_MANY_REQUESTS" });
		await expect(
			enforceDurableAuthRateLimit(
				db,
				"/email-otp/request-password-reset",
				headers("198.51.120.99"),
				{ email: "daily@customer.com" },
				day + 86_400_000,
			),
		).resolves.toBeUndefined();
	});
	it("does not charge code consumption against the outbound mail budget", async () => {
		for (let i = 0; i < 3; i++)
			await enforceDurableAuthRateLimit(
				db,
				"/email-otp/send-verification-otp",
				headers(`198.51.111.${i}`),
				{ email: "reader@customer.com" },
				i * 60000,
			);
		await expect(
			enforceDurableAuthRateLimit(
				db,
				"/sign-in/email-otp",
				headers("198.51.111.9"),
				{ email: "reader@customer.com", otp: "123456" },
				180000,
			),
		).resolves.toBeUndefined();
	});
	it("caps one identity across rotating IPs and normalizes email", async () => {
		for (let i = 0; i < 10; i++)
			await enforceDurableAuthRateLimit(
				db,
				"/sign-in/email",
				headers(`198.51.101.${i}`),
				{ email: " Victim@Example.com " },
				1000,
			);
		await expect(
			enforceDurableAuthRateLimit(
				db,
				"/sign-in/email",
				headers("198.51.102.1"),
				{ email: "victim@example.com" },
				1000,
			),
		).rejects.toMatchObject({ status: "TOO_MANY_REQUESTS" });
		await expect(
			enforceDurableAuthRateLimit(
				db,
				"/sign-in/email",
				headers("198.51.102.1"),
				{ email: "victim@example.com" },
				61000,
			),
		).resolves.toBeUndefined();
	});
	it("caps registrations over an hour, not just one minute", async () => {
		for (let i = 0; i < 5; i++)
			await enforceDurableAuthRateLimit(
				db,
				"/sign-up/email",
				headers("198.51.103.1"),
				{ email: `signup${i}@example.com` },
				i * 60000,
			);
		await expect(
			enforceDurableAuthRateLimit(
				db,
				"/sign-up/email",
				headers("198.51.103.1"),
				{ email: "six@example.com" },
				301000,
			),
		).rejects.toMatchObject({ status: "TOO_MANY_REQUESTS" });
	});
	it("does not touch payment callbacks, supplier APIs or session reads", async () => {
		for (const path of [
			"/payments/webhook",
			"/supplier/orders",
			"/get-session",
			"/callback/google",
		])
			await expect(
				enforceDurableAuthRateLimit(
					db,
					path,
					headers("198.51.100.1"),
					{},
					1000,
				),
			).resolves.toBeUndefined();
	});
	it("does not trust spoofable forwarding headers", async () => {
		for (let i = 0; i < 5; i++)
			await enforceDurableAuthRateLimit(
				db,
				"/sign-in/email",
				new Headers({
					"cf-connecting-ip": "198.51.104.1",
					"x-forwarded-for": `192.0.2.${i}`,
				}),
				{},
				1000,
			);
		await expect(
			enforceDurableAuthRateLimit(
				db,
				"/sign-in/email",
				new Headers({
					"cf-connecting-ip": "198.51.104.1",
					"x-forwarded-for": "192.0.2.100",
				}),
				{},
				1000,
			),
		).rejects.toMatchObject({ status: "TOO_MANY_REQUESTS" });
	});
	it("alerts only on meaningful completed windows and deduplicates delivery", async () => {
		await db
			.prepare(
				"INSERT INTO system_settings (key,value,is_secret,created_at,updated_at) VALUES ('security.feishu_alerts_enabled','true',0,0,0)",
			)
			.run();
		expect(
			await publishAuthSecurityAlert(db, 900000, async () => {}),
		).toMatchObject({ status: "sent" });
		expect(
			await publishAuthSecurityAlert(db, 900001, async () => {
				throw new Error("duplicate");
			}),
		).toMatchObject({ status: "deduplicated" });
		expect(
			await publishAuthSecurityAlert(db, 1800000, async () => {
				throw new Error("quiet window");
			}),
		).toMatchObject({ status: "quiet" });
	});
	it("records alert transport failure without throwing into commerce scheduling", async () => {
		await db
			.prepare(
				"INSERT INTO audit_logs (id,action,target_type,created_at) VALUES ('limit-test','security.auth_rate_limited','auth',2000000)",
			)
			.run();
		expect(
			await publishAuthSecurityAlert(db, 2700000, async () => {
				throw new Error("private transport details");
			}),
		).toMatchObject({ status: "failed" });
		expect(
			await db
				.prepare(
					"SELECT count(*) n FROM audit_logs WHERE action='security.alert_failed'",
				)
				.first("n"),
		).toBe(1);
	});
});
