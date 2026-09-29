import { getAuth } from "#/features/auth/server/auth";
import { DomainError } from "#/lib/domain-error";
import { getCloudflareEnv } from "#/server/db.server";
import {
	claimFixedWindowRateLimit,
	peekFixedWindowRateLimit,
} from "#/server/rate-limit";

export const reauthenticationAttemptLimit = 5;
export const reauthenticationWindowMs = 15 * 60_000;

/**
 * Confirms the acting user's current password before a sensitive action.
 * `auth.api.verifyPassword` runs in server scope and bypasses Better Auth's
 * HTTP rate limiter, so failed confirmations are throttled per user in D1;
 * correct confirmations never consume the budget, so routine operator work is
 * not locked out.
 */
export async function verifySensitiveAdminAction(
	request: Request,
	userId: string,
	proof: { password: string },
	options: { db?: D1Database; now?: number } = {},
) {
	const db = options.db ?? getCloudflareEnv(request).DB;
	if (!db) throw new Error("D1 binding DB is unavailable");
	const bucket = {
		bucketKey: `reauth:${userId}`,
		limit: reauthenticationAttemptLimit,
		windowMs: reauthenticationWindowMs,
		now: options.now,
	};
	if ((await peekFixedWindowRateLimit(db, bucket)).exhausted)
		throw rateLimited();
	const auth = await getAuth(request);
	let verified = false;
	try {
		const response = await auth.api.verifyPassword({
			headers: request.headers,
			body: { password: proof.password },
			asResponse: true,
		});
		verified = response.ok;
	} catch {
		verified = false;
	}
	if (verified) return;
	const budget = await claimFixedWindowRateLimit(db, bucket);
	if (!budget.allowed) throw rateLimited();
	throw new DomainError(
		"reauthentication_failed",
		401,
		"Enter your current password. Accounts without a local password must set one first.",
	);
}

function rateLimited() {
	return new DomainError(
		"reauthentication_rate_limited",
		429,
		"Too many password confirmations. Wait before trying again.",
	);
}
