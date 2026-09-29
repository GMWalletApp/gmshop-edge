import { orderStateGuard } from "#/features/shop-orders/server/order-guard";
import { releaseOrderReservationStatements } from "#/features/shop-orders/server/reservation-release";

export async function expireStoreOrders(
	db: D1Database,
	now = Date.now(),
	limit = 50,
) {
	const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
	const rows = await db
		.prepare(
			`SELECT id, version FROM shop_orders WHERE status = 'pending_payment'
			 AND expires_at <= ? ORDER BY expires_at, id LIMIT ?`,
		)
		.bind(now, boundedLimit)
		.all<{ id: string; version: number }>();
	let expired = 0;
	for (const order of rows.results) {
		const nextVersion = order.version + 1;
		const results = await db.batch([
			db
				.prepare(
					`UPDATE shop_orders SET status = 'expired', cancelled_at = ?, version = ?,
				 updated_at = ? WHERE id = ? AND status = 'pending_payment' AND version = ?
				 AND expires_at <= ?`,
				)
				.bind(now, nextVersion, now, order.id, order.version, now),
			...releaseOrderReservationStatements(
				db,
				order.id,
				now,
				orderStateGuard(order.id, "expired", nextVersion),
				"order_expired",
			),
			db
				.prepare(
					`INSERT INTO shop_order_events
				 (id, order_id, event_type, visibility, from_status, to_status, order_version,
				  actor_type, created_at)
					 SELECT ?, id, 'order_expired', 'customer', 'pending_payment', 'expired', ?,
					  'system', ? FROM shop_orders WHERE id = ? AND status = 'expired' AND version = ?
					 ON CONFLICT(order_id, order_version) DO NOTHING`,
				)
				.bind(crypto.randomUUID(), nextVersion, now, order.id, nextVersion),
			db
				.prepare(
					`INSERT INTO outbox_events
				 (id, event_type, aggregate_type, aggregate_id, idempotency_key, payload,
				  status, attempt_count, created_at, updated_at)
				 SELECT ?, 'shop_order.expired', 'shop_order', id, ?, ?, 'pending', 0, ?, ?
					 FROM shop_orders WHERE id = ? AND status = 'expired' AND version = ?
					 ON CONFLICT(idempotency_key) DO NOTHING`,
				)
				.bind(
					crypto.randomUUID(),
					`shop-order-expired:${order.id}:${nextVersion}`,
					JSON.stringify({ orderId: order.id, version: nextVersion }),
					now,
					now,
					order.id,
					nextVersion,
				),
		]);
		expired += Number(results[0]?.meta.changes ?? 0);
	}
	return { scanned: rows.results.length, expired };
}
