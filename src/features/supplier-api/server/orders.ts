import { createHash } from "node:crypto";
import { decryptDeliveryContent } from "#/features/fulfillment/secrets";
import { orderStateGuard } from "#/features/shop-orders/server/order-guard";
import { completeWalletStoreOrder } from "#/features/shop-payments/server/service";
import {
	findWalletEntry,
	loadWalletSnapshot,
	mutateWallet,
	walletMutationStatements,
} from "#/features/wallet/server/ledger";
import { DomainError } from "#/lib/domain-error";
import { isSafeWebhookUrl } from "#/lib/webhook-url";
import { loadRuntimeConfig } from "#/server/runtime-config";
import type { SupplierApiIdentity } from "./auth";

type OrderInput = {
	skuId: string;
	quantity: number;
	downstreamOrderNo: string;
	callbackUrl?: string | null;
	traceId?: string;
};

type ExistingApiOrder = {
	id: string;
	request_digest: string;
	state: string;
	shop_order_id: string;
	order_status: string;
	delivery_status: string | null;
};

export async function createSupplierApiOrder(
	db: D1Database,
	identity: SupplierApiIdentity,
	input: OrderInput,
) {
	if (
		!Number.isInteger(input.quantity) ||
		input.quantity < 1 ||
		input.quantity > 1_000
	)
		throw new DomainError("supplier_quantity_invalid", 400, "Invalid quantity");
	validateCallback(input.callbackUrl, identity.allowedCallbackOrigin);
	const digest = createHash("sha256")
		.update(JSON.stringify(input))
		.digest("hex");
	const existing = await loadExistingApiOrder(
		db,
		identity.userId,
		input.downstreamOrderNo,
	);
	if (existing) {
		if (existing.request_digest !== digest)
			throw new DomainError(
				"supplier_idempotency_conflict",
				409,
				"Order number was reused",
			);
		return settleReplayedApiOrder(db, identity, existing);
	}
	const item = await db
		.prepare(
			`SELECT item.id, item.product_id, item.name, item.version, item.currency,
			 item.currency_decimals, product.name AS product_name,
			 COALESCE(listing.price_minor, item.price_minor) AS price_minor,
			 (SELECT COUNT(*) FROM stock_entries stock WHERE stock.sellable_item_id = item.id
			  AND stock.status = 'available') AS stock_quantity
			 FROM product_sellable_items item
			 LEFT JOIN supplier_export_listings listing ON listing.sellable_item_id = item.id
			 JOIN products product ON product.id = item.product_id
			 WHERE item.id = ? AND COALESCE(listing.enabled, 1) = 1 AND item.enabled = 1
			  AND item.fulfillment_source = 'local' AND product.status = 'active'
			  AND product.product_type = 'stock'
			  AND item.currency = COALESCE((SELECT json_extract(value, '$') FROM system_settings
			   WHERE key = 'commerce.default_currency'), 'USD')
			  AND item.currency_decimals = COALESCE((SELECT CAST(json_extract(value, '$') AS INTEGER)
			   FROM system_settings WHERE key = 'commerce.currency_decimals'), 2) LIMIT 1`,
		)
		.bind(input.skuId)
		.first<{
			id: string;
			product_id: string;
			name: string;
			version: number;
			currency: string;
			currency_decimals: number;
			product_name: string;
			price_minor: string;
			stock_quantity: number;
		}>();
	if (!item)
		throw new DomainError("supplier_sku_not_found", 404, "SKU not found");
	if (Number(item.stock_quantity) < input.quantity)
		throw new DomainError(
			"supplier_stock_unavailable",
			409,
			"Insufficient stock",
		);
	const total = (BigInt(item.price_minor) * BigInt(input.quantity)).toString();
	// Refuse early when the balance cannot cover the order so no order rows are
	// created for a purchase that can never be paid.
	const balance = await loadWalletSnapshot(db, identity.userId);
	if (BigInt(balance.balanceMinor) < BigInt(total))
		throw new DomainError(
			"wallet_insufficient_balance",
			409,
			"Insufficient balance",
		);
	const orderId = crypto.randomUUID();
	const orderItemId = crypto.randomUUID();
	const apiOrderId = crypto.randomUUID();
	const now = Date.now();
	const orderNumber = `API${crypto.randomUUID().replaceAll("-", "").toUpperCase()}`;
	try {
		await db.batch([
			db
				.prepare(
					`INSERT INTO shop_orders (id, order_number, idempotency_key, user_id, contact_email, normalized_contact_email, locale, status, currency, currency_decimals, subtotal_minor, discount_minor, total_minor, paid_minor, version, expires_at, created_at, updated_at) SELECT ?, ?, ?, user.id, user.email, lower(user.email), user.preferred_locale, 'pending_payment', ?, ?, ?, '0', ?, '0', 1, ?, ?, ? FROM users user WHERE user.id = ? AND user.enabled = 1`,
				)
				.bind(
					orderId,
					orderNumber,
					`supplier-api:${identity.userId}:${input.downstreamOrderNo}`,
					item.currency,
					item.currency_decimals,
					total,
					total,
					now + 900_000,
					now,
					now,
					identity.userId,
				),
			db
				.prepare(
					`INSERT INTO shop_order_items (id, order_id, product_id, sellable_item_id, product_name, delivery_component_id, delivery_component_type, delivery_component_version, sellable_item_name, input_values_json, sensitive_input_values_json, quantity, unit_price_minor, discount_minor, subtotal_minor, activation_trigger, exhaustion_rule, renewal_mode, show_on_order_page, account_library_enabled, email_mode, allow_resend, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'stock', ?, ?, '{}', '{}', ?, ?, '0', ?, 'delivery_completed', 'first_limit_reached', 'stack', 1, 1, 'none', 0, ?, ?)`,
				)
				.bind(
					orderItemId,
					orderId,
					item.product_id,
					item.id,
					item.product_name,
					item.id,
					item.version,
					item.name,
					input.quantity,
					item.price_minor,
					total,
					now,
					now,
				),
			db
				.prepare(
					`INSERT INTO supplier_api_orders (id, shop_order_id, user_id, api_key_id, downstream_order_no, request_digest, callback_url, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'processing', ?, ?)`,
				)
				.bind(
					apiOrderId,
					orderId,
					identity.userId,
					identity.keyRowId,
					input.downstreamOrderNo,
					digest,
					input.callbackUrl ?? null,
					now,
					now,
				),
			db
				.prepare(
					`INSERT INTO shop_order_events (id, order_id, event_type, visibility, actor_type, created_at) VALUES (?, ?, 'supplier_api_order_created', 'internal', 'customer', ?)`,
				)
				.bind(crypto.randomUUID(), orderId, now),
		]);
	} catch (error) {
		if (error instanceof DomainError) throw error;
		const replay = await loadExistingApiOrder(
			db,
			identity.userId,
			input.downstreamOrderNo,
		);
		if (replay?.request_digest === digest)
			return settleReplayedApiOrder(db, identity, replay);
		throw error;
	}
	return payApiOrder(db, identity.userId, apiOrderId, orderId);
}

async function loadExistingApiOrder(
	db: D1Database,
	userId: string,
	downstreamOrderNo: string,
) {
	return db
		.prepare(
			`SELECT api.id, api.request_digest, api.state, api.shop_order_id,
			 shop_order.status AS order_status, delivery.status AS delivery_status
			 FROM supplier_api_orders api
			 JOIN shop_orders shop_order ON shop_order.id = api.shop_order_id
			 LEFT JOIN shop_order_items item ON item.order_id = shop_order.id
			 LEFT JOIN delivery_records delivery ON delivery.order_item_id = item.id
			 WHERE api.user_id = ? AND api.downstream_order_no = ? LIMIT 1`,
		)
		.bind(userId, downstreamOrderNo)
		.first<ExistingApiOrder>();
}

/**
 * A replayed creation is idempotent: an order whose wallet debit never
 * happened (crash or transient failure between the two steps) is paid now,
 * everything else reports its current state.
 */
async function settleReplayedApiOrder(
	db: D1Database,
	identity: SupplierApiIdentity,
	existing: ExistingApiOrder,
) {
	if (
		existing.state === "processing" &&
		existing.order_status === "pending_payment"
	)
		return payApiOrder(
			db,
			identity.userId,
			existing.id,
			existing.shop_order_id,
		);
	return {
		ok: true,
		order_id: existing.id,
		status: presentApiState(
			existing.state,
			existing.order_status,
			existing.delivery_status,
		),
	};
}

/**
 * Debit the wallet and start fulfillment. When the debit is refused the API
 * order and the shop order are closed explicitly so the reseller never sees a
 * "processing" order that will never be supplied.
 */
async function payApiOrder(
	db: D1Database,
	userId: string,
	apiOrderId: string,
	orderId: string,
) {
	try {
		await completeWalletStoreOrder(db, { orderId, userId });
	} catch (error) {
		if (!(error instanceof DomainError)) throw error;
		if (error.code === "order_version_conflict") throw error;
		const now = Date.now();
		await db.batch([
			db
				.prepare(
					`UPDATE shop_orders SET status = 'failed', version = version + 1, updated_at = ?
					 WHERE id = ? AND status = 'pending_payment'`,
				)
				.bind(now, orderId),
			db
				.prepare(
					`INSERT INTO shop_order_events
					 (id, order_id, event_type, visibility, from_status, to_status, order_version, note, actor_type, created_at)
					 SELECT ?, id, 'status_changed', 'internal', 'pending_payment', 'failed', version, ?, 'system', ?
					 FROM shop_orders WHERE id = ? AND status = 'failed'`,
				)
				.bind(crypto.randomUUID(), error.code, now, orderId),
			db
				.prepare(
					`UPDATE supplier_api_orders SET state = 'failed', updated_at = ?
					 WHERE id = ? AND state = 'processing'`,
				)
				.bind(now, apiOrderId),
		]);
		throw error;
	}
	return { ok: true, order_id: apiOrderId, status: "processing" };
}

/**
 * The reseller-visible state, derived once from the API order, the shop order
 * and its delivery so every read path agrees.
 */
function presentApiState(
	state: string,
	orderStatus: string,
	deliveryStatus: string | null,
) {
	if (state === "supplied" || state === "cancelled" || state === "failed")
		return state;
	if (orderStatus === "cancelled" || orderStatus === "refunded")
		return "cancelled";
	if (
		orderStatus === "failed" ||
		orderStatus === "expired" ||
		deliveryStatus === "failed"
	)
		return "failed";
	return "processing";
}

export async function getSupplierApiOrder(
	db: D1Database,
	userId: string,
	id: string,
) {
	const row = await db
		.prepare(
			`SELECT api.id, api.state, shop_order.status AS order_status, delivery.status AS delivery_status, delivery.content_encrypted FROM supplier_api_orders api JOIN shop_orders shop_order ON shop_order.id = api.shop_order_id LEFT JOIN shop_order_items item ON item.order_id = shop_order.id LEFT JOIN delivery_records delivery ON delivery.order_item_id = item.id WHERE api.id = ? AND api.user_id = ? LIMIT 1`,
		)
		.bind(id, userId)
		.first<{
			id: string;
			state: string;
			order_status: string;
			delivery_status: string | null;
			content_encrypted: string | null;
		}>();
	if (!row)
		throw new DomainError("supplier_order_not_found", 404, "Order not found");
	if (row.delivery_status === "delivered" && row.content_encrypted) {
		const runtime = await loadRuntimeConfig(db);
		if (!runtime.commerceSecret)
			throw new DomainError(
				"supplier_api_unavailable",
				503,
				"Supplier API unavailable",
			);
		const content = await decryptDeliveryContent(
			row.content_encrypted,
			runtime.commerceSecret,
		);
		await db
			.prepare(
				"UPDATE supplier_api_orders SET state = 'supplied', updated_at = ? WHERE id = ? AND state = 'processing'",
			)
			.bind(Date.now(), id)
			.run();
		return {
			order_id: row.id,
			status: "supplied",
			cards: content.split(/\r?\n/).filter(Boolean),
		};
	}
	return {
		order_id: row.id,
		status: presentApiState(row.state, row.order_status, row.delivery_status),
	};
}

export async function cancelSupplierApiOrder(
	db: D1Database,
	userId: string,
	id: string,
) {
	const row = await db
		.prepare(
			`SELECT api.id, api.state, api.shop_order_id, shop_order.status, shop_order.version, shop_order.total_minor, shop_order.currency, item.id AS order_item_id, delivery.id AS delivery_id, delivery.status AS delivery_status FROM supplier_api_orders api JOIN shop_orders shop_order ON shop_order.id = api.shop_order_id JOIN shop_order_items item ON item.order_id = shop_order.id LEFT JOIN delivery_records delivery ON delivery.order_item_id = item.id WHERE api.id = ? AND api.user_id = ? LIMIT 1`,
		)
		.bind(id, userId)
		.first<{
			id: string;
			state: string;
			shop_order_id: string;
			status: string;
			version: number;
			total_minor: string;
			currency: string;
			order_item_id: string;
			delivery_id: string | null;
			delivery_status: string | null;
		}>();
	if (!row)
		throw new DomainError("supplier_order_not_found", 404, "Order not found");
	const refund = {
		userId,
		direction: "credit" as const,
		amountMinor: row.total_minor,
		currency: row.currency,
		sourceType: "refund" as const,
		sourceId: row.shop_order_id,
		idempotencyKey: `supplier-api-cancel:${id}`,
		reason: "Supplier API order cancelled",
	};
	if (row.state === "cancelled") {
		// Older cancellations credited the wallet after the cancel batch; make
		// sure a cancelled order is always refunded exactly once.
		if (!(await findWalletEntry(db, refund.idempotencyKey)))
			await mutateWallet(db, refund);
		return { ok: true, order_id: id, status: "cancelled" };
	}
	if (
		!row.delivery_id ||
		row.delivery_status !== "pending" ||
		!["paid", "fulfilling"].includes(row.status)
	)
		throw new DomainError(
			"supplier_order_not_cancellable",
			409,
			"Order cannot be cancelled",
		);
	const now = Date.now();
	const nextVersion = row.version + 1;
	// The refund ledger row is the anchor of the whole cancellation: it is only
	// inserted against the exact pre-cancel state (order, delivery and wallet
	// snapshot), and every other statement requires it. A stale snapshot or a
	// concurrent order change therefore changes nothing, and the caller retries.
	const orderGuard = orderStateGuard(
		row.shop_order_id,
		row.status,
		row.version,
	);
	const wallet = walletMutationStatements(
		db,
		refund,
		await loadWalletSnapshot(db, userId),
		{
			now,
			guardSql: `${orderGuard.sql} AND EXISTS (SELECT 1 FROM delivery_records WHERE id = ? AND status = 'pending')`,
			guardBindings: [...orderGuard.bindings, row.delivery_id],
		},
	);
	const anchorSql =
		"EXISTS (SELECT 1 FROM wallet_entries WHERE idempotency_key = ?)";
	const results = await db.batch([
		wallet.insert,
		wallet.update,
		db
			.prepare(
				`UPDATE delivery_records SET status = 'failed', error_code = 'supplier_api_cancelled',
				 next_attempt_at = NULL, updated_at = ? WHERE id = ? AND status = 'pending' AND ${anchorSql}`,
			)
			.bind(now, row.delivery_id, refund.idempotencyKey),
		db
			.prepare(
				`UPDATE stock_entries SET status = 'available', order_item_id = NULL, reserved_at = NULL, updated_at = ?
				 WHERE order_item_id = ? AND status = 'reserved' AND ${anchorSql}`,
			)
			.bind(now, row.order_item_id, refund.idempotencyKey),
		db
			.prepare(
				`UPDATE shop_orders SET status = 'cancelled', cancelled_at = ?, version = ?, updated_at = ?
				 WHERE id = ? AND status = ? AND version = ? AND ${anchorSql}`,
			)
			.bind(
				now,
				nextVersion,
				now,
				row.shop_order_id,
				row.status,
				row.version,
				refund.idempotencyKey,
			),
		db
			.prepare(
				`UPDATE supplier_api_orders SET state = 'cancelled', updated_at = ?
				 WHERE id = ? AND state = 'processing' AND ${anchorSql}`,
			)
			.bind(now, id, refund.idempotencyKey),
		db
			.prepare(
				`INSERT INTO shop_order_events
				 (id, order_id, event_type, visibility, from_status, to_status, order_version, actor_type, created_at)
				 SELECT ?, id, 'status_changed', 'internal', ?, 'cancelled', ?, 'customer', ?
				 FROM shop_orders WHERE id = ? AND status = 'cancelled' AND version = ?`,
			)
			.bind(
				crypto.randomUUID(),
				row.status,
				nextVersion,
				now,
				row.shop_order_id,
				nextVersion,
			),
	]);
	if (Number(results[1]?.meta.changes ?? 0) !== 1)
		throw new DomainError(
			"wallet_conflict",
			409,
			"Wallet or order changed; retry cancellation",
			{ retryable: true },
		);
	return { ok: true, order_id: id, status: "cancelled" };
}

function validateCallback(
	value: string | null | undefined,
	allowedOrigin: string | null,
) {
	if (!value) return;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new DomainError(
			"supplier_callback_invalid",
			400,
			"Invalid callback URL",
		);
	}
	if (
		!isSafeWebhookUrl(value) ||
		url.port ||
		!allowedOrigin ||
		url.origin !== allowedOrigin
	)
		throw new DomainError(
			"supplier_callback_invalid",
			400,
			"Callback origin is not allowed",
		);
}
