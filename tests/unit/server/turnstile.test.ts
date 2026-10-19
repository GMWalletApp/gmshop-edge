import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRequestAllowedHosts } from "../../../src/server/middleware/authority";
import {
	publicTurnstileConfig,
	turnstileAction,
	verifyTurnstile,
} from "../../../src/server/turnstile";

const limiter = vi.hoisted(() => vi.fn());
vi.mock("../../../src/server/rate-limit", () => ({
	claimFixedWindowRateLimit: limiter,
}));
vi.mock("../../../src/server/middleware/authority", () => ({
	loadRequestAllowedHosts: vi.fn(async () => [] as string[]),
}));
const db = {} as D1Database;
beforeEach(() => {
	limiter.mockReset().mockResolvedValue({ allowed: true });
	vi.mocked(loadRequestAllowedHosts).mockReset().mockResolvedValue([]);
});
const verify = (
	request: Request,
	config: Parameters<typeof verifyTurnstile>[1],
) => verifyTurnstile(request, config, db);
const config = {
	TURNSTILE_SITE_KEY: "public-test",
	TURNSTILE_SECRET_KEY: "private-test",
};
const request = (path = "/api/auth/sign-up/email", token = "test-token") =>
	new Request(`https://shop.example.com${path}`, {
		method: "POST",
		headers: { "cf-turnstile-response": token },
	});
afterEach(() => vi.unstubAllGlobals());
describe("Turnstile exact entry point enforcement", () => {
	it("only guards email-sending entry points and new support conversations", () => {
		expect(turnstileAction(request())).toBe("register");
		expect(turnstileAction(request("/api/auth/sign-in/email/"))).toBeNull();
		expect(turnstileAction(request("/api/support/web/conversations"))).toBe(
			"support",
		);
		for (const path of [
			"/api/auth/sign-in/email",
			"/api/auth/callback/google",
			"/api/auth/telegram/callback",
			"/api/payments/callback",
			"/api/supply/orders",
			"/api/auth/sign-in/email-otp",
		])
			expect(turnstileAction(request(path))).toBeNull();
		expect(
			turnstileAction(
				new Request("https://shop.example.com/api/auth/sign-in/email"),
			),
		).toBeNull();
	});
	it("guards every email-sending path by path alone, not by a client header", async () => {
		for (const path of [
			"/api/auth/email-otp/send-verification-otp",
			"/api/auth/email-otp/request-password-reset",
			"/api/auth/forget-password",
			"/api/auth/request-password-reset",
			"/api/auth/send-verification-email/",
		]) {
			const r = request(path, "");
			expect(turnstileAction(r)).toBe("register");
			expect((await verify(r, config))?.status).toBe(403);
			// Without configuration the site keeps working unchallenged.
			expect(await verify(r, {})).toBeNull();
		}
	});
	it("is explicitly optional with no configuration and never exposes the secret", async () => {
		expect(await verify(request(), {})).toBeNull();
		expect(publicTurnstileConfig(config)).toEqual({
			enabled: true,
			siteKey: "public-test",
		});
	});
	it("fails closed for incomplete configuration and missing/oversized tokens", async () => {
		for (const partial of [
			{ TURNSTILE_SITE_KEY: "public-test" },
			{ TURNSTILE_SECRET_KEY: "private-test" },
		])
			expect((await verify(request(), partial))?.status).toBe(503);
		for (const token of ["", "x".repeat(2049)])
			expect((await verify(request(undefined, token), config))?.status).toBe(
				403,
			);
	});
	it("requires success, exact hostname and action, including rejection of replayed tokens", async () => {
		for (const result of [
			{ success: false, "error-codes": ["timeout-or-duplicate"] },
			{ success: true },
			{ success: true, hostname: "attacker.example.com", action: "register" },
			{ success: true, hostname: "shop.example.com", action: "login" },
		]) {
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(result)));
			expect((await verify(request(), config))?.status).toBe(403);
		}
		const fetcher = vi.fn().mockResolvedValue(
			Response.json({
				success: true,
				hostname: "shop.example.com",
				action: "register",
			}),
		);
		vi.stubGlobal("fetch", fetcher);
		expect(await verify(request(), config)).toBeNull();
		expect(fetcher.mock.calls[0]?.[0]).toBe(
			"https://challenges.cloudflare.com/turnstile/v0/siteverify",
		);
		expect(fetcher.mock.calls[0]?.[1].body.get("secret")).toBe("private-test");
	});
	it("fails closed on upstream outage and network timeout", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response("error", { status: 500 })),
		);
		expect((await verify(request(), config))?.status).toBe(503);
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
		expect((await verify(request(), config))?.status).toBe(503);
	});
});

it("budgets remote verification across entry points before calling Siteverify", async () => {
	const remote = vi.fn().mockResolvedValue(Response.json({ success: false }));
	vi.stubGlobal("fetch", remote);
	limiter.mockResolvedValue({ allowed: false });
	for (const path of [
		"/api/auth/sign-up/email",
		"/api/support/web/conversations",
	]) {
		const req = request(path);
		req.headers.set("cf-connecting-ip", "192.0.2.10");
		req.headers.set("x-forwarded-for", "untrusted-changing-input");
		const response = await verifyTurnstile(req, config, db);
		expect(response?.status).toBe(429);
		expect(response?.headers.get("retry-after")).toBe("60");
		expect(limiter).toHaveBeenLastCalledWith(db, {
			bucketKey: "turnstile:verify:192.0.2.10",
			limit: 20,
			windowMs: 60_000,
		});
	}
	expect(remote).not.toHaveBeenCalled();
});
it("fails closed without D1 or if the durable budget fails", async () => {
	const remote = vi.fn();
	vi.stubGlobal("fetch", remote);
	expect((await verifyTurnstile(request(), config))?.status).toBe(503);
	limiter.mockRejectedValue(new Error("database unavailable"));
	expect((await verifyTurnstile(request(), config, db))?.status).toBe(503);
	expect(remote).not.toHaveBeenCalled();
});
it("does not spend D1/network budget for missing tokens, disabled protection or callback/API traffic", async () => {
	const remote = vi.fn();
	vi.stubGlobal("fetch", remote);
	expect(
		(await verifyTurnstile(request(undefined, ""), config, db))?.status,
	).toBe(403);
	expect(await verifyTurnstile(request(), {}, db)).toBeNull();
	for (const path of [
		"/api/auth/sign-in/email",
		"/api/auth/callback/google",
		"/api/auth/telegram/callback",
		"/api/payments/callback",
		"/api/supply/orders",
	])
		expect(await verifyTurnstile(request(path), config, db)).toBeNull();
	expect(limiter).not.toHaveBeenCalled();
	expect(remote).not.toHaveBeenCalled();
});
it("uses a single unknown-source bucket rather than trusting forwarded headers", async () => {
	limiter.mockResolvedValue({ allowed: false });
	const req = request();
	req.headers.set("x-forwarded-for", "192.0.2.44");
	await verifyTurnstile(req, config, db);
	expect(limiter).toHaveBeenCalledWith(db, {
		bucketKey: "turnstile:verify:unknown",
		limit: 20,
		windowMs: 60_000,
	});
});
it("accepts configured storefront aliases behind a rewritten origin Host", async () => {
	vi.mocked(loadRequestAllowedHosts).mockResolvedValue(["cn.shop.example.com"]);
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue(
			Response.json({
				success: true,
				hostname: "cn.shop.example.com",
				action: "register",
			}),
		),
	);
	expect(await verify(request(), config)).toBeNull();
});
it("does not treat a spoofed forwarding header as a trusted widget hostname", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue(
			Response.json({
				success: true,
				hostname: "attacker.example.com",
				action: "register",
			}),
		),
	);
	const req = request();
	req.headers.set("x-forwarded-host", "attacker.example.com");
	expect((await verify(req, config))?.status).toBe(403);
});
