import { activateEntitlementGrantStatements } from "#/features/entitlements/server/ledger";
import { encryptDeliveryContent } from "#/features/fulfillment/secrets";
import { DomainError } from "#/lib/domain-error";
import { decryptSecret } from "#/lib/secrets";
import { loadRuntimeConfig } from "#/server/runtime-config";

type DeliveryContext = {
	id: string;
	status: "pending" | "processing" | "awaiting_supply" | "delivered" | "failed";
	delivery_type: "stock" | "download" | "automation";
	content_encrypted: string | null;
	error_code: string | null;
	order_item_id: string;
	delivery_component_id: string;
	order_id: string;
	order_status: string;
	order_version: number;
	quantity: number;
};

export type ProcessDeliveryResult = {
	id: string;
	status: "delivered" | "failed" | "awaiting_supply";
	orderStatus?: string;
	errorCode?: string | null;
	duplicate: boolean;
};

const fulfillableOrderStatuses = new Set(["paid", "fulfilling"]);

/**
 * Deliver one delivery record. Every outcome that needs an operator (order no
 * longer fulfillable, inventory short) is persisted as an explicit `failed`
 * record instead of an exception so the queue does not spin on it; only
 * transient conditions (missing runtime secret, optimistic-lock conflicts)
 * throw and are retried by the queue.
 */
export async function processDelivery(
	db: D1Database,
	deliveryId: string,
): Promise<ProcessDeliveryResult> {
	const delivery = await loadDelivery(db, deliveryId);
	if (!delivery)
		throw new DomainError("delivery_not_found", 404, "Delivery not found");
	if (delivery.status === "delivered")
		return { id: delivery.id, status: "delivered", duplicate: true };
	if (delivery.status === "failed")
		return {
			id: delivery.id,
			status: "failed",
			errorCode: delivery.error_code,
			duplicate: true,
		};
	if (delivery.status === "awaiting_supply")
		return { id: delivery.id, status: "awaiting_supply", duplicate: true };
	const now = Date.now();
	if (!fulfillableOrderStatuses.has(delivery.order_status))
		return failDelivery(db, delivery, "order_not_fulfillable", now);
	let contentEncrypted = delivery.content_encrypted;
	if (delivery.delivery_type === "stock") {
		const runtime = await loadRuntimeConfig(db);
		if (!runtime.commerceSecret)
			throw new DomainError(
				"delivery_secret_unavailable",
				503,
				"Delivery configuration unavailable",
			);
		let entries = await loadReservedEntries(db, delivery.order_item_id);
		if (entries.length < delivery.quantity) {
			// A delivery retried after an inventory shortage has no reserved rows
			// (the payment batch only reserves all-or-nothing). Reserve the missing
			// cards now, still all-or-nothing and still bound to a fulfillable order.
			await reserveMissingStock(
				db,
				delivery,
				delivery.quantity - entries.length,
				now,
			);
			entries = await loadReservedEntries(db, delivery.order_item_id);
		}
		if (entries.length !== delivery.quantity)
			return failDelivery(
				db,
				delivery,
				entries.length < delivery.quantity
					? "inventory_unavailable"
					: "delivery_inventory_invalid",
				now,
			);
		const plaintext = await Promise.all(
			entries.map((entry) =>
				decryptSecret(
					entry.content_encrypted,
					runtime.commerceSecret,
					"stock-entry",
				),
			),
		);
		contentEncrypted = await encryptDeliveryContent(
			plaintext.join("\n"),
			runtime.commerceSecret,
		);
	}

	const nextStatus = await nextOrderStatus(db, delivery.order_id, delivery.id);
	const nextVersion = delivery.order_version + 1;
	const statusChanged = nextStatus !== delivery.order_status;
	const statements: D1PreparedStatement[] = [
		db
			.prepare(
				`UPDATE delivery_records SET status = 'delivered', content_encrypted = ?,
			 content_key_version = CASE WHEN ? IS NULL THEN NULL ELSE 1 END,
			 attempt_count = attempt_count + 1, next_attempt_at = NULL, error_code = NULL,
			 delivered_at = ?, updated_at = ? WHERE id = ? AND status IN ('pending', 'processing')
			 AND EXISTS (SELECT 1 FROM shop_orders WHERE id = ? AND status = ? AND version = ?)`,
			)
			.bind(
				contentEncrypted,
				contentEncrypted,
				now,
				now,
				delivery.id,
				delivery.order_id,
				delivery.order_status,
				delivery.order_version,
			),
	];
	if (delivery.delivery_type === "stock")
		statements.push(
			db
				.prepare(
					`UPDATE stock_entries SET status = 'delivered', delivered_at = ?, updated_at = ?
				 WHERE order_item_id = ? AND status = 'reserved'
				 AND EXISTS (SELECT 1 FROM delivery_records WHERE id = ? AND status = 'delivered' AND delivered_at = ?)`,
				)
				.bind(now, now, delivery.order_item_id, delivery.id, now),
		);
	statements.push(
		db
			.prepare(
				`UPDATE shop_orders SET status = ?, completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END,
			 version = ?, updated_at = ? WHERE id = ? AND status = ? AND version = ?
			 AND EXISTS (SELECT 1 FROM delivery_records WHERE id = ? AND status = 'delivered' AND delivered_at = ?)`,
			)
			.bind(
				nextStatus,
				nextStatus,
				now,
				nextVersion,
				now,
				delivery.order_id,
				delivery.order_status,
				delivery.order_version,
				delivery.id,
				now,
			),
		// The transition CHECK constraint forbids from_status = to_status, so a
		// delivery that leaves the order in `fulfilling` records a progress event
		// without a status pair.
		db
			.prepare(
				`INSERT INTO shop_order_events
			 (id, order_id, event_type, visibility, from_status, to_status, order_version,
			  actor_type, created_at)
			 SELECT ?, id, 'delivery_progressed', 'customer', ?, ?, ?, 'system', ?
			 FROM shop_orders WHERE id = ? AND status = ? AND version = ?`,
			)
			.bind(
				crypto.randomUUID(),
				statusChanged ? delivery.order_status : null,
				statusChanged ? nextStatus : null,
				nextVersion,
				now,
				delivery.order_id,
				nextStatus,
				nextVersion,
			),
		db
			.prepare(
				`INSERT INTO outbox_events
				 (id, event_type, aggregate_type, aggregate_id, idempotency_key, payload,
				  status, attempt_count, created_at, updated_at)
				 SELECT ?, 'delivery.ready', 'delivery', ?, ?, ?, 'pending', 0, ?, ?
				 FROM delivery_records WHERE id = ? AND status = 'delivered'
				 ON CONFLICT(idempotency_key) DO NOTHING`,
			)
			.bind(
				crypto.randomUUID(),
				delivery.id,
				`delivery-ready:${delivery.id}`,
				JSON.stringify({
					deliveryId: delivery.id,
					orderId: delivery.order_id,
				}),
				now,
				now,
				delivery.id,
			),
		db
			.prepare(
				`UPDATE outbox_events SET status = 'published', published_at = ?, updated_at = ?
			 WHERE event_type = 'delivery.requested' AND aggregate_type = 'delivery'
			 AND aggregate_id = ? AND status IN ('pending', 'processing')`,
			)
			.bind(now, now, delivery.id),
	);
	if (delivery.delivery_type === "stock")
		statements.push(
			...activateEntitlementGrantStatements(db, delivery.order_item_id, now),
		);
	const results = await db.batch(statements);
	if (Number(results[0]?.meta.changes ?? 0) !== 1) {
		const current = await loadDelivery(db, deliveryId);
		if (current?.status === "delivered")
			return { id: delivery.id, status: "delivered", duplicate: true };
		throw new DomainError(
			"delivery_order_conflict",
			409,
			"Order changed while delivering; retry",
			{ retryable: true },
		);
	}
	return {
		id: delivery.id,
		status: "delivered",
		orderStatus: nextStatus,
		duplicate: false,
	};
}

async function loadDelivery(db: D1Database, deliveryId: string) {
	return db
		.prepare(
			`SELECT dr.id, dr.status, dr.delivery_type, dr.content_encrypted, dr.error_code,
			 dr.order_item_id, oi.delivery_component_id,
			 oi.order_id, oi.quantity, o.status AS order_status, o.version AS order_version
			 FROM delivery_records dr JOIN shop_order_items oi ON oi.id = dr.order_item_id
			 JOIN shop_orders o ON o.id = oi.order_id WHERE dr.id = ? LIMIT 1`,
		)
		.bind(deliveryId)
		.first<DeliveryContext>();
}

async function loadReservedEntries(db: D1Database, orderItemId: string) {
	const entries = await db
		.prepare(
			`SELECT content_encrypted FROM stock_entries
			 WHERE order_item_id = ? AND status = 'reserved' ORDER BY created_at, id`,
		)
		.bind(orderItemId)
		.all<{ content_encrypted: string }>();
	return entries.results;
}

async function reserveMissingStock(
	db: D1Database,
	delivery: DeliveryContext,
	missing: number,
	now: number,
) {
	await db
		.prepare(
			`UPDATE stock_entries SET status = 'reserved', order_item_id = ?, reserved_at = ?, updated_at = ?
			 WHERE id IN (SELECT id FROM stock_entries WHERE sellable_item_id = ? AND status = 'available'
			  ORDER BY created_at, id LIMIT ?)
			 AND (SELECT COUNT(*) FROM stock_entries WHERE sellable_item_id = ? AND status = 'available') >= ?
			 AND EXISTS (SELECT 1 FROM shop_orders WHERE id = ? AND status IN ('paid', 'fulfilling'))
			 AND EXISTS (SELECT 1 FROM delivery_records WHERE id = ? AND status IN ('pending', 'processing'))`,
		)
		.bind(
			delivery.order_item_id,
			now,
			now,
			delivery.delivery_component_id,
			missing,
			delivery.delivery_component_id,
			missing,
			delivery.order_id,
			delivery.id,
		)
		.run();
}

async function failDelivery(
	db: D1Database,
	delivery: DeliveryContext,
	errorCode: string,
	now: number,
): Promise<ProcessDeliveryResult> {
	const result = await db
		.prepare(
			`UPDATE delivery_records SET status = 'failed', error_code = ?,
			 attempt_count = attempt_count + 1, next_attempt_at = NULL, updated_at = ?
			 WHERE id = ? AND status IN ('pending', 'processing')`,
		)
		.bind(errorCode, now, delivery.id)
		.run();
	return {
		id: delivery.id,
		status: "failed",
		errorCode,
		duplicate: Number(result.meta.changes ?? 0) !== 1,
	};
}

async function nextOrderStatus(
	db: D1Database,
	orderId: string,
	currentDeliveryId: string,
) {
	const remaining = await db
		.prepare(
			`SELECT COUNT(*) AS total FROM delivery_records dr
			 JOIN shop_order_items oi ON oi.id = dr.order_item_id
			 WHERE oi.order_id = ? AND dr.id <> ? AND dr.status <> 'delivered'`,
		)
		.bind(orderId, currentDeliveryId)
		.first<{ total: number }>();
	return Number(remaining?.total ?? 0) === 0 ? "completed" : "fulfilling";
}
