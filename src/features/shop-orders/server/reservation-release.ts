import type { StatementGuard } from "#/features/shop-orders/server/order-guard";

/**
 * Statements that give back everything a `pending_payment` order held: the
 * coupon usage and redemption reservation, and the open payment attempts.
 * Shared by automatic expiry and manual cancel/expire/fail so both paths stay
 * identical; `guard` binds them to the order state the caller just wrote.
 */
export function releaseOrderReservationStatements(
	db: D1Database,
	orderId: string,
	now: number,
	guard: StatementGuard,
	attemptFailureCode: "order_expired" | "order_closed",
) {
	return [
		db
			.prepare(
				`UPDATE coupons SET used_count = MAX(0, used_count - 1), updated_at = ?
				 WHERE id = (SELECT coupon_id FROM coupon_redemptions WHERE order_id = ?
				  AND status = 'reserved' LIMIT 1) AND ${guard.sql}`,
			)
			.bind(now, orderId, ...guard.bindings),
		db
			.prepare(
				`UPDATE coupon_redemptions SET status = 'released', released_at = ?, updated_at = ?
				 WHERE order_id = ? AND status = 'reserved' AND ${guard.sql}`,
			)
			.bind(now, now, orderId, ...guard.bindings),
		db
			.prepare(
				`UPDATE payment_attempts SET status = 'expired', failure_code = ?, updated_at = ?
				 WHERE order_id = ? AND status IN ('created', 'pending') AND ${guard.sql}`,
			)
			.bind(attemptFailureCode, now, orderId, ...guard.bindings),
	];
}
