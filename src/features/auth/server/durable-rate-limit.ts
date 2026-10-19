import { APIError } from "better-auth";
import { claimFixedWindowRateLimit } from "#/server/rate-limit";

// Shared D1 counters survive Worker restarts and are atomic across isolates.
// Only authentication writes are covered: payment/webhook/API traffic is untouched.
export async function enforceDurableAuthRateLimit(
	db: D1Database,
	path: string,
	headers: Headers | undefined,
	body: unknown,
	now = Date.now(),
) {
	if (
		!/^\/(?:sign-in|sign-up|email-otp|sign-in-telegram)(?:\/|$)/.test(path) &&
		![
			"/telegram/miniapp/signin",
			"/telegram/signin",
			"/forget-password",
			"/request-password-reset",
			"/reset-password",
			"/send-verification-email",
			"/change-email",
		].includes(path)
	)
		return;
	const ip = headers?.get("cf-connecting-ip")?.slice(0, 45) || "unknown";
	const limits = [
		{ bucketKey: `auth:write:ip:${ip}`, limit: 20, windowMs: 60_000 },
	];
	if (path === "/sign-up/email")
		limits.push({
			bucketKey: `auth:signup:ip:${ip}`,
			limit: 5,
			windowMs: 3_600_000,
		});
	if (
		/^\/sign-in(?:\/|$)/.test(path) ||
		path === "/telegram/signin" ||
		path === "/telegram/miniapp/signin"
	)
		limits.push({
			bucketKey: `auth:login:ip:${ip}`,
			limit: 5,
			windowMs: 60_000,
		});
	if (/otp|verification|password-reset|forget-password/.test(path))
		limits.push({
			bucketKey: `auth:verify:ip:${ip}`,
			limit: 3,
			windowMs: 60_000,
		});
	const email =
		body &&
		typeof body === "object" &&
		"email" in body &&
		typeof body.email === "string"
			? body.email.trim().toLowerCase().slice(0, 320)
			: null;
	if (email) {
		const digest = Array.from(
			new Uint8Array(
				await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email)),
			),
			(b) => b.toString(16).padStart(2, "0"),
		).join("");
		if (
			[
				"/sign-up/email",
				"/send-verification-email",
				"/email-otp/send-verification-otp",
				"/email-otp/request-password-reset",
				"/forget-password",
				"/request-password-reset",
			].includes(path)
		)
			limits.push(
				{
					bucketKey: `auth:mail:identity:${digest}`,
					limit: 3,
					windowMs: 600_000,
				},
				// Daily ceiling per recipient so rotating IPs cannot mail-bomb one inbox.
				{
					bucketKey: `auth:mail:daily:${digest}`,
					limit: 10,
					windowMs: 86_400_000,
				},
			);
		limits.push({
			bucketKey: `auth:identity:${digest}`,
			limit: 10,
			windowMs: 60_000,
		});
	}
	for (const limit of limits) {
		const result = await claimFixedWindowRateLimit(db, { ...limit, now });
		if (result.allowed) continue;
		const eventId = `auth-limit:${limit.bucketKey}:${result.windowStart}`;
		// One evidence record per exhausted bucket/window, never passwords or email.
		await db
			.prepare(
				`INSERT OR IGNORE INTO audit_logs (id, action, target_type, ip_address, after, created_at) VALUES (?, 'security.auth_rate_limited', 'auth', ?, ?, ?)`,
			)
			.bind(
				eventId,
				ip,
				JSON.stringify({ path, windowMs: limit.windowMs }),
				now,
			)
			.run();
		throw APIError.from("TOO_MANY_REQUESTS", {
			code: "TOO_MANY_REQUESTS",
			message: "Too many requests. Please try again later.",
		});
	}
}
