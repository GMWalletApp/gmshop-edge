import { DomainError } from "#/lib/domain-error";

export type EntitlementOrderItem = {
	id: string;
	sellable_item_id: string;
	product_id: string;
	delivery_component_id: string;
	delivery_component_type: "stock" | "download" | "automation";
	quantity: number;
	duration_ms: number | null;
	usage_limit: number | null;
	access_limit: number | null;
	renewed_from_entitlement_id: string | null;
	renewal_mode: "stack" | "disabled";
	definition_version_id: string | null;
};

export function createEntitlementGrantStatements(
	db: D1Database,
	orderId: string,
	item: EntitlementOrderItem,
	now: number,
	/** When given, the grant only exists for this exact paid order version. */
	orderVersion?: number,
) {
	const versionSql = orderVersion === undefined ? "" : " AND version = ?";
	const versionBindings = orderVersion === undefined ? [] : [orderVersion];
	const entitlementId = item.renewed_from_entitlement_id ?? crypto.randomUUID();
	const grantId = crypto.randomUUID();
	const usageGranted = multipliedLimit(item.usage_limit, item.quantity);
	const accessGranted = multipliedLimit(item.access_limit, item.quantity);
	const statements: D1PreparedStatement[] = [];

	if (!item.renewed_from_entitlement_id) {
		statements.push(
			db
				.prepare(
					`INSERT INTO customer_entitlements
					 (id, user_id, order_item_id, product_id, sellable_item_id, delivery_component_id, entitlement_type,
					  status, definition_version_id, usage_limit, usage_count, access_limit,
					  access_count, created_at, updated_at)
					 SELECT ?, user_id, ?, ?, ?, ?, ?, 'pending', ?, NULL, 0, NULL, 0, ?, ?
					 FROM shop_orders WHERE id = ? AND status = 'paid'${versionSql}`,
				)
				.bind(
					entitlementId,
					item.id,
					item.product_id,
					item.sellable_item_id,
					item.delivery_component_id,
					item.delivery_component_type,
					item.definition_version_id,
					now,
					now,
					orderId,
					...versionBindings,
				),
		);
	}

	statements.push(
		db
			.prepare(
				`INSERT INTO entitlement_grants
				 (id, entitlement_id, source_order_item_id, renewed_from_entitlement_id,
				  status, duration_ms, usage_granted, access_granted, created_at, updated_at)
				 SELECT ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?
				 FROM shop_orders orders
				 JOIN customer_entitlements entitlement ON entitlement.id = ?
				 WHERE orders.id = ? AND orders.status = 'paid'${orderVersion === undefined ? "" : " AND orders.version = ?"}
				 AND entitlement.user_id IS orders.user_id
				 AND entitlement.sellable_item_id = ?`,
			)
			.bind(
				grantId,
				entitlementId,
				item.id,
				item.renewed_from_entitlement_id,
				item.duration_ms,
				usageGranted,
				accessGranted,
				now,
				now,
				entitlementId,
				orderId,
				...versionBindings,
				item.sellable_item_id,
			),
	);

	return { entitlementId, statements };
}

export function activateEntitlementGrantStatements(
	db: D1Database,
	orderItemId: string,
	now: number,
	options: { requireDownloadAsset?: boolean } = {},
) {
	return [
		db
			.prepare(
				`UPDATE customer_entitlements AS entitlement SET
				 status = 'active',
				 usage_limit = CASE
				  WHEN (SELECT usage_granted FROM entitlement_grants WHERE source_order_item_id = ?) IS NULL THEN NULL
				  WHEN NOT EXISTS (SELECT 1 FROM entitlement_grants prior WHERE prior.entitlement_id = entitlement.id AND prior.status = 'active')
				   THEN (SELECT usage_granted FROM entitlement_grants WHERE source_order_item_id = ?)
				  WHEN usage_limit IS NULL THEN NULL
				  ELSE usage_limit + (SELECT usage_granted FROM entitlement_grants WHERE source_order_item_id = ?)
				 END,
				 access_limit = CASE
				  WHEN (SELECT access_granted FROM entitlement_grants WHERE source_order_item_id = ?) IS NULL THEN NULL
				  WHEN NOT EXISTS (SELECT 1 FROM entitlement_grants prior WHERE prior.entitlement_id = entitlement.id AND prior.status = 'active')
				   THEN (SELECT access_granted FROM entitlement_grants WHERE source_order_item_id = ?)
				  WHEN access_limit IS NULL THEN NULL
				  ELSE access_limit + (SELECT access_granted FROM entitlement_grants WHERE source_order_item_id = ?)
				 END,
				 activated_at = COALESCE(activated_at, ?),
				 expires_at = CASE
				  WHEN (SELECT duration_ms FROM entitlement_grants WHERE source_order_item_id = ?) IS NULL THEN NULL
				  WHEN NOT EXISTS (SELECT 1 FROM entitlement_grants prior WHERE prior.entitlement_id = entitlement.id AND prior.status = 'active')
				   THEN ? + (SELECT duration_ms FROM entitlement_grants WHERE source_order_item_id = ?)
				  WHEN expires_at IS NULL THEN NULL
				  WHEN expires_at > ? THEN expires_at + (SELECT duration_ms FROM entitlement_grants WHERE source_order_item_id = ?)
				  ELSE ? + (SELECT duration_ms FROM entitlement_grants WHERE source_order_item_id = ?)
				 END,
				 revoked_at = NULL, updated_at = ?
				 WHERE id = (SELECT entitlement_id FROM entitlement_grants
				  WHERE source_order_item_id = ? AND status = 'pending' AND applied_at IS NULL
				  AND (? = 0 OR EXISTS (
				   SELECT 1 FROM order_item_download_assets snapshot
				   WHERE snapshot.order_item_id = entitlement_grants.source_order_item_id
				  )))`,
			)
			.bind(
				orderItemId,
				orderItemId,
				orderItemId,
				orderItemId,
				orderItemId,
				orderItemId,
				now,
				orderItemId,
				now,
				orderItemId,
				now,
				orderItemId,
				now,
				orderItemId,
				now,
				orderItemId,
				options.requireDownloadAsset ? 1 : 0,
			),
		db
			.prepare(
				`UPDATE entitlement_grants SET status = 'active', activated_at = ?, applied_at = ?, updated_at = ?
				 WHERE source_order_item_id = ? AND status = 'pending' AND applied_at IS NULL
				 AND EXISTS (SELECT 1 FROM customer_entitlements entitlement
				  WHERE entitlement.id = entitlement_grants.entitlement_id AND entitlement.status = 'active')`,
			)
			.bind(now, now, now, orderItemId),
	];
}

export async function consumeEntitlementAccess(
	db: D1Database,
	input: {
		entitlementId: string;
		assetType: "stock_secret" | "download_asset" | "automation_artifact";
		assetId: string;
		eventType: "revealed" | "downloaded" | "email_content_sent";
		actorType: "customer" | "admin" | "system";
		idempotencyKey?: string;
		requestId?: string;
		ipAddress?: string;
		unavailableCode?: string;
		unavailableMessage?: string;
	},
) {
	if (input.idempotencyKey) {
		const replay = await db
			.prepare(
				"SELECT id FROM entitlement_events WHERE idempotency_key = ? LIMIT 1",
			)
			.bind(input.idempotencyKey)
			.first();
		if (replay) return;
	}
	const now = Date.now();
	let results: D1Result<unknown>[];
	try {
		results = await db.batch([
			db
				.prepare(
					`UPDATE customer_entitlements SET
					 access_count = access_count + 1,
					 status = CASE
					  WHEN access_limit IS NOT NULL AND access_count + 1 >= access_limit
					  THEN 'exhausted'
					  ELSE status
					 END,
					 updated_at = ?
				 WHERE id = ? AND status IN ('active', 'exhausted')
				 AND (expires_at IS NULL OR expires_at > ?)
				 AND (access_limit IS NULL OR access_count < access_limit)`,
				)
				.bind(now, input.entitlementId, now),
			db
				.prepare(
					`INSERT INTO entitlement_events
				 (id, kind, entitlement_id, asset_type, asset_id, event_type, consumed, actor_type,
				  idempotency_key, request_id, ip_address, created_at)
				 SELECT ?, 'access', ?, ?, ?, ?, 1, ?, ?, ?, ?, ? WHERE changes() = 1`,
				)
				.bind(
					crypto.randomUUID(),
					input.entitlementId,
					input.assetType,
					input.assetId,
					input.eventType,
					input.actorType,
					input.idempotencyKey ?? null,
					input.requestId ?? null,
					input.ipAddress ?? null,
					now,
				),
		]);
	} catch (error) {
		if (input.idempotencyKey) {
			const replay = await db
				.prepare(
					"SELECT id FROM entitlement_events WHERE idempotency_key = ? LIMIT 1",
				)
				.bind(input.idempotencyKey)
				.first();
			if (replay) return;
		}
		throw error;
	}
	if (Number(results[0]?.meta.changes ?? 0) !== 1)
		throw new DomainError(
			input.unavailableCode ?? "entitlement_access_unavailable",
			409,
			input.unavailableMessage ?? "The delivery can no longer be accessed",
		);
}

export async function refundEntitlementGrantStatements(
	db: D1Database,
	orderId: string,
	now: number,
	guard?: { refundId: string; attempt: number },
) {
	const guardSql = guard
		? ` AND EXISTS (
			 SELECT 1 FROM refunds completed_refund WHERE completed_refund.id = ?
			  AND completed_refund.attempt_count = ?
			  AND completed_refund.status = 'succeeded'
			  AND completed_refund.completed_at = ?
			)`
		: "";
	const guardBindings = guard ? [guard.refundId, guard.attempt, now] : [];
	const affected = await db
		.prepare(
			`SELECT DISTINCT grants.entitlement_id FROM entitlement_grants grants
			 JOIN shop_order_items item ON item.id = grants.source_order_item_id
			 WHERE item.order_id = ? AND grants.status IN ('pending', 'active')`,
		)
		.bind(orderId)
		.all<{ entitlement_id: string }>();
	const statements: D1PreparedStatement[] = [
		db
			.prepare(
				`UPDATE entitlement_grants SET status = 'refunded', revoked_at = ?,
				 revocation_reason = 'order_refunded', updated_at = ?
				 WHERE source_order_item_id IN (SELECT id FROM shop_order_items WHERE order_id = ?)
				 AND status IN ('pending', 'active')${guardSql}`,
			)
			.bind(now, now, orderId, ...guardBindings),
	];
	for (const row of affected.results) {
		const entitlement = await db
			.prepare(
				"SELECT usage_count, access_count FROM customer_entitlements WHERE id = ? LIMIT 1",
			)
			.bind(row.entitlement_id)
			.first<{ usage_count: number; access_count: number }>();
		const grants = await db
			.prepare(
				`SELECT duration_ms, usage_granted, access_granted, activated_at
				 FROM entitlement_grants WHERE entitlement_id = ? AND status = 'active'
				 AND source_order_item_id NOT IN (
				  SELECT id FROM shop_order_items WHERE order_id = ?)
				 ORDER BY activated_at, created_at, id`,
			)
			.bind(row.entitlement_id, orderId)
			.all<{
				duration_ms: number | null;
				usage_granted: number | null;
				access_granted: number | null;
				activated_at: number | null;
			}>();
		const active = grants.results.filter(
			(grant) => grant.activated_at !== null,
		);
		const expiresAt = rebuildExpiry(active);
		const usageLimit = sumGranted(active, "usage_granted");
		const accessLimit = sumGranted(active, "access_granted");
		const activatedAt = active[0]?.activated_at ?? null;
		const status =
			active.length === 0
				? "revoked"
				: expiresAt !== null && expiresAt <= now
					? "expired"
					: (usageLimit !== null &&
								Number(entitlement?.usage_count ?? 0) >= usageLimit) ||
							(accessLimit !== null &&
								Number(entitlement?.access_count ?? 0) >= accessLimit)
						? "exhausted"
						: "active";
		statements.push(
			db
				.prepare(
					`UPDATE customer_entitlements SET status = ?, usage_limit = ?, access_limit = ?,
					 activated_at = ?, expires_at = ?, revoked_at = ?, updated_at = ?
					 WHERE id = ?${guardSql}`,
				)
				.bind(
					status,
					usageLimit,
					accessLimit,
					activatedAt,
					expiresAt,
					status === "revoked" ? now : null,
					now,
					row.entitlement_id,
					...guardBindings,
				),
		);
	}
	return statements;
}

function multipliedLimit(limit: number | null, quantity: number) {
	if (limit === null) return null;
	const value = limit * quantity;
	if (!Number.isSafeInteger(value))
		throw new DomainError(
			"entitlement_limit_too_large",
			400,
			"Entitlement limit is too large",
		);
	return value;
}

function sumGranted(
	grants: Array<{
		usage_granted: number | null;
		access_granted: number | null;
	}>,
	key: "usage_granted" | "access_granted",
) {
	if (!grants.length || grants.some((grant) => grant[key] === null))
		return null;
	return grants.reduce((total, grant) => total + (grant[key] ?? 0), 0);
}

function rebuildExpiry(
	grants: Array<{ duration_ms: number | null; activated_at: number | null }>,
) {
	if (!grants.length || grants.some((grant) => grant.duration_ms === null))
		return null;
	let expiresAt = 0;
	for (const grant of grants) {
		const activatedAt = grant.activated_at ?? 0;
		expiresAt = Math.max(expiresAt, activatedAt) + (grant.duration_ms ?? 0);
	}
	return expiresAt;
}
