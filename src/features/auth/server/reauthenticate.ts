import { getAuth } from "#/features/auth/server/auth";
import { DomainError } from "#/lib/domain-error";
import { getCloudflareEnv } from "#/server/db.server";
import { claimFixedWindowRateLimit } from "#/server/rate-limit";

const FAILURE_LIMIT = 5;
const FAILURE_WINDOW_MS = 900_000;

export async function verifySensitiveAdminAction(
	request: Request,
	userId: string,
	proof: { password: string },
) {
	const db = getCloudflareEnv(request).DB;
	if (!db) throw new Error("D1 binding DB is unavailable");
	await withPasswordFailureBudget(db, request, userId, async () => {
		const auth = await getAuth(request);
		const response = await auth.api.verifyPassword({
			headers: request.headers,
			body: { password: proof.password },
			asResponse: true,
		});
		return response.ok;
	});
}

// Reserve a failure slot before checking the password and hand it back on
// success, so guessing is capped at five per user and IP while legitimate
// repeated reveals/exports are never throttled.
export async function withPasswordFailureBudget(
	db: D1Database,
	request: Request,
	userId: string,
	verify: () => Promise<boolean>,
) {
	const ip = request.headers.get("cf-connecting-ip")?.slice(0, 45) || "unknown";
	const bucketKey = `reauth:failure:${userId}:${ip}`;
	const slot = await claimFixedWindowRateLimit(db, {
		bucketKey,
		limit: FAILURE_LIMIT,
		windowMs: FAILURE_WINDOW_MS,
	});
	if (!slot.allowed)
		throw new DomainError(
			"reauthentication_rate_limited",
			429,
			"Too many password attempts. Please try again later.",
		);
	const verified = await verify().catch(() => false);
	if (verified) {
		// Counters must stay positive, so the last slot is released by deletion.
		await db.batch([
			db
				.prepare(
					"DELETE FROM rate_limit_counters WHERE bucket_key = ? AND window_start = ? AND count = 1",
				)
				.bind(bucketKey, slot.windowStart),
			db
				.prepare(
					"UPDATE rate_limit_counters SET count = count - 1 WHERE bucket_key = ? AND window_start = ? AND count > 1",
				)
				.bind(bucketKey, slot.windowStart),
		]);
		return;
	}
	throw new DomainError(
		"reauthentication_failed",
		401,
		"Enter your current password. Accounts without a local password must set one first.",
	);
}
