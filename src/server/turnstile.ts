import { loadRequestAllowedHosts } from "./middleware/authority";
import { claimFixedWindowRateLimit } from "./rate-limit";

export type TurnstileConfig = {
	TURNSTILE_SITE_KEY?: string;
	TURNSTILE_SECRET_KEY?: string;
};

export function publicTurnstileConfig(config: TurnstileConfig) {
	return {
		enabled: Boolean(config.TURNSTILE_SITE_KEY || config.TURNSTILE_SECRET_KEY),
		siteKey: config.TURNSTILE_SITE_KEY || "",
	};
}

// Every endpoint that makes us send an email to an arbitrary address. Chosen by
// path alone: a client-controlled header must never switch the challenge off.
const emailSendingPaths = new Set([
	"/api/auth/sign-up/email",
	"/api/auth/email-otp/send-verification-otp",
	"/api/auth/email-otp/request-password-reset",
	"/api/auth/forget-password",
	"/api/auth/request-password-reset",
	"/api/auth/send-verification-email",
]);

// Exact interactive entry points only: never challenge payment or OAuth callbacks.
export function turnstileAction(request: Request): string | null {
	if (request.method !== "POST") return null;
	const path = new URL(request.url).pathname.replace(/\/$/, "");
	if (emailSendingPaths.has(path)) return "register";
	if (path === "/api/support/web/conversations") return "support";
	return null;
}

export async function verifyTurnstile(
	request: Request,
	config: TurnstileConfig,
	db?: D1Database,
): Promise<Response | null> {
	const action = turnstileAction(request);
	if (!action || !publicTurnstileConfig(config).enabled) return null;
	const reject = (status = 403) =>
		Response.json(
			{
				code: "HUMAN_VERIFICATION_REQUIRED",
				message: "Human verification required",
			},
			{ status },
		);
	if (!config.TURNSTILE_SITE_KEY || !config.TURNSTILE_SECRET_KEY)
		return reject(503);
	const token = request.headers.get("cf-turnstile-response");
	if (!token || token.length > 2048) return reject();
	try {
		// Budget Siteverify calls before crossing the network. One shared source
		// bucket prevents rotating between register/support to multiply it.
		if (!db) return reject(503);
		const ip =
			request.headers.get("cf-connecting-ip")?.slice(0, 45) || "unknown";
		const budget = await claimFixedWindowRateLimit(db, {
			bucketKey: `turnstile:verify:${ip}`,
			limit: 20,
			windowMs: 60_000,
		});
		if (!budget.allowed)
			return Response.json(
				{
					code: "TOO_MANY_REQUESTS",
					message: "Too many verification attempts",
				},
				{ status: 429, headers: { "retry-after": "60" } },
			);
		const response = await fetch(
			"https://challenges.cloudflare.com/turnstile/v0/siteverify",
			{
				method: "POST",
				body: new URLSearchParams({
					secret: config.TURNSTILE_SECRET_KEY,
					response: token,
				}),
				signal: AbortSignal.timeout(8000),
			},
		);
		if (!response.ok) return reject(503);
		const result = (await response.json()) as {
			success?: boolean;
			hostname?: string;
			action?: string;
		};
		if (result.success !== true || result.action !== action || !result.hostname)
			return reject();
		if (result.hostname === new URL(request.url).hostname) return null;
		// EdgeOne aliases can rewrite the origin Host. Accept only an exact
		// application-owned hostname from the existing validated authority list.
		// Never derive trust from client-supplied forwarding headers.
		const allowedHosts = await loadRequestAllowedHosts(request, db);
		return allowedHosts.some(
			(host) => new URL(`https://${host}`).hostname === result.hostname,
		)
			? null
			: reject();
	} catch {
		return reject(503);
	}
}
