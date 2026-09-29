/**
 * Fixed-window rate limits are keyed by wall-clock minute. A test that counts
 * claims across a loop must not straddle a window boundary, so it waits for a
 * fresh window when the current one is about to roll over.
 */
export async function awaitFreshRateLimitWindow(
	windowMs = 60_000,
	marginMs = 10_000,
) {
	const remaining = windowMs - (Date.now() % windowMs);
	if (remaining > marginMs) return;
	await new Promise((resolve) => setTimeout(resolve, remaining + 50));
}
