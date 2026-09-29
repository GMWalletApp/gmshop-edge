/**
 * Read the current count of a bucket without consuming it. Callers use it to
 * refuse work when a budget is already exhausted and only `claim` on the
 * outcome that should count (for example a failed guess), so legitimate
 * successful requests never write to D1.
 */
export async function peekFixedWindowRateLimit(
	db: D1Database,
	input: { bucketKey: string; limit: number; windowMs: number; now?: number },
) {
	const now = input.now ?? Date.now();
	const windowStart = Math.floor(now / input.windowMs) * input.windowMs;
	const row = await db
		.prepare(
			"SELECT count FROM rate_limit_counters WHERE bucket_key = ? AND window_start = ? LIMIT 1",
		)
		.bind(input.bucketKey, windowStart)
		.first<{ count: number }>();
	const count = Number(row?.count ?? 0);
	return { exhausted: count >= input.limit, count, windowStart };
}

export async function claimFixedWindowRateLimit(
	db: D1Database,
	input: {
		bucketKey: string;
		limit: number;
		windowMs: number;
		now?: number;
	},
) {
	const now = input.now ?? Date.now();
	const windowStart = Math.floor(now / input.windowMs) * input.windowMs;
	const row = await db
		.prepare(
			`INSERT INTO rate_limit_counters
			 (id, bucket_key, window_start, count, expires_at, created_at, updated_at)
			 VALUES (?, ?, ?, 1, ?, ?, ?)
			 ON CONFLICT(bucket_key, window_start) DO UPDATE SET
			 count = rate_limit_counters.count + 1, updated_at = excluded.updated_at
			 WHERE rate_limit_counters.count < ?
			 RETURNING count`,
		)
		.bind(
			crypto.randomUUID(),
			input.bucketKey,
			windowStart,
			windowStart + input.windowMs * 2,
			now,
			now,
			input.limit,
		)
		.first<{ count: number }>();
	return {
		allowed: Boolean(row),
		count: row?.count ?? input.limit,
		windowStart,
	};
}
