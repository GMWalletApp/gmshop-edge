import type { ShopOrderStatus } from "#/features/shop-orders/schema";
import { orderStateGuard } from "#/features/shop-orders/server/order-guard";
import { releaseOrderReservationStatements } from "#/features/shop-orders/server/reservation-release";
import { assertShopOrderTransition } from "#/features/shop-orders/status";
import { completeManualStoreOrder } from "#/features/shop-payments/server/service";
import { DomainError } from "#/lib/domain-error";
import { clientIp } from "#/server/client-ip";

const paymentReleasingStatuses = new Set<ShopOrderStatus>([
	"cancelled",
	"expired",
	"failed",
]);

export async function transitionShopOrder(
	db: D1Database,
	input: {
		id: string;
		version: number;
		toStatus: ShopOrderStatus;
		note: string | null;
		actorType: "system" | "customer" | "admin" | "provider";
		actorUserId: string | null;
		request?: Request;
	},
) {
	const order = await db
		.prepare("SELECT status, version FROM shop_orders WHERE id = ? LIMIT 1")
		.bind(input.id)
		.first<{ status: ShopOrderStatus; version: number }>();
	if (!order) throw new DomainError("order_not_found", 404, "Order not found");
	if (order.version !== input.version)
		throw new DomainError(
			"order_version_conflict",
			409,
			"Order changed; refresh and retry",
		);
	assertShopOrderTransition(order.status, input.toStatus);
	// Marking an order paid must produce the same stock reservation, delivery,
	// entitlement and outbox rows as a provider payment.
	if (input.toStatus === "paid")
		return completeManualStoreOrder(db, {
			orderId: input.id,
			version: input.version,
			actorUserId: input.actorUserId,
			note: input.note,
			ipAddress: clientIp(input.request),
			requestId: input.request?.headers.get("x-request-id") ?? null,
		});
	const now = Date.now();
	const nextVersion = input.version + 1;
	const releasesPayment =
		order.status === "pending_payment" &&
		paymentReleasingStatuses.has(input.toStatus);
	const results = await db.batch([
		db
			.prepare(
				`UPDATE shop_orders SET status = ?, version = ?,
				 paid_minor = CASE WHEN ? = 'paid' THEN total_minor ELSE paid_minor END,
				 paid_at = CASE WHEN ? = 'paid' THEN ? ELSE paid_at END,
				 completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END,
				 cancelled_at = CASE WHEN ? IN ('cancelled', 'expired') THEN ? ELSE cancelled_at END,
				 refunded_at = CASE WHEN ? = 'refunded' THEN ? ELSE refunded_at END,
				 updated_at = ? WHERE id = ? AND status = ? AND version = ?`,
			)
			.bind(
				input.toStatus,
				nextVersion,
				input.toStatus,
				input.toStatus,
				now,
				input.toStatus,
				now,
				input.toStatus,
				now,
				input.toStatus,
				now,
				now,
				input.id,
				order.status,
				input.version,
			),
		db
			.prepare(
				`INSERT INTO shop_order_events
				 (id, order_id, event_type, visibility, from_status, to_status,
				  order_version, note, actor_type, actor_user_id, created_at)
				 SELECT ?, id, 'status_changed', 'customer', ?, ?, ?, ?, ?, ?, ?
				 FROM shop_orders WHERE id = ? AND status = ? AND version = ?`,
			)
			.bind(
				crypto.randomUUID(),
				order.status,
				input.toStatus,
				nextVersion,
				input.note,
				input.actorType,
				input.actorUserId,
				now,
				input.id,
				input.toStatus,
				nextVersion,
			),
		db
			.prepare(
				`INSERT INTO outbox_events
				 (id, event_type, aggregate_type, aggregate_id, idempotency_key, payload,
				  status, attempt_count, created_at, updated_at)
				 SELECT ?, 'shop_order.status_changed', 'shop_order', id, ?, ?, 'pending', 0, ?, ?
				 FROM shop_orders WHERE id = ? AND status = ? AND version = ?`,
			)
			.bind(
				crypto.randomUUID(),
				`shop-order-status:${input.id}:${nextVersion}`,
				JSON.stringify({
					orderId: input.id,
					status: input.toStatus,
					version: nextVersion,
				}),
				now,
				now,
				input.id,
				input.toStatus,
				nextVersion,
			),
		transitionAuditStatement(db, input.request, input.actorUserId, {
			id: input.id,
			fromStatus: order.status,
			toStatus: input.toStatus,
			fromVersion: input.version,
			toVersion: nextVersion,
			now,
		}),
		// Leaving pending_payment through cancel/expire/fail releases the same
		// reservations as automatic expiry.
		...(releasesPayment
			? releaseOrderReservationStatements(
					db,
					input.id,
					now,
					orderStateGuard(input.id, input.toStatus, nextVersion),
					"order_closed",
				)
			: []),
	]);
	if (Number(results[0]?.meta.changes ?? 0) !== 1)
		throw new DomainError(
			"order_version_conflict",
			409,
			"Order changed; refresh and retry",
		);
	return {
		id: input.id,
		fromStatus: order.status,
		toStatus: input.toStatus,
		version: nextVersion,
	};
}

function transitionAuditStatement(
	db: D1Database,
	request: Request | undefined,
	actorUserId: string | null,
	transition: {
		id: string;
		fromStatus: ShopOrderStatus;
		toStatus: ShopOrderStatus;
		fromVersion: number;
		toVersion: number;
		now: number;
	},
) {
	return db
		.prepare(
			`INSERT INTO audit_logs
			 (id, actor_user_id, action, target_type, target_id, request_id,
			  ip_address, before, after, created_at)
			 SELECT ?, ?, 'shop_order.status_changed', 'shop_order', id, ?, ?, ?, ?, ?
			 FROM shop_orders WHERE id = ? AND status = ? AND version = ?`,
		)
		.bind(
			crypto.randomUUID(),
			actorUserId,
			request?.headers.get("x-request-id") ?? null,
			clientIp(request),
			JSON.stringify({
				status: transition.fromStatus,
				version: transition.fromVersion,
			}),
			JSON.stringify({
				status: transition.toStatus,
				version: transition.toVersion,
			}),
			transition.now,
			transition.id,
			transition.toStatus,
			transition.toVersion,
		);
}
