import { createHash } from "node:crypto";
import { decryptDeliveryContent } from "#/features/fulfillment/secrets";
import {
	RESELLER_REDEEM_URL,
	withRedeemHost,
} from "#/features/redeem-warehouse/redeem-host";
import {
	prepareSale,
	reserveSaleStatements,
} from "#/features/redeem-warehouse/server/sale-capacity";
import { completeWalletStoreOrder } from "#/features/shop-payments/server/service";
import { assertSupplierAvailability } from "#/features/storefront/server/multi-order";
import { storefrontStockExpression } from "#/features/storefront/server/stock-availability";
import { mutateWallet } from "#/features/wallet/server/ledger";
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

export async function createSupplierApiOrder(
	db: D1Database,
	identity: SupplierApiIdentity,
	input: OrderInput,
	display: { siteHost?: string | null } = {},
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
	const existing = await db
		.prepare(
			`SELECT api.id, api.request_digest, shop_order.total_minor, shop_order.currency,
			 shop_order.currency_decimals FROM supplier_api_orders api
			 JOIN shop_orders shop_order ON shop_order.id = api.shop_order_id
			 WHERE api.user_id = ? AND api.downstream_order_no = ? LIMIT 1`,
		)
		.bind(identity.userId, input.downstreamOrderNo)
		.first<{
			id: string;
			request_digest: string;
			total_minor: string;
			currency: string;
			currency_decimals: number;
		}>();
	if (existing) {
		if (existing.request_digest !== digest)
			throw new DomainError(
				"supplier_idempotency_conflict",
				409,
				"Order number was reused",
			);
		return {
			ok: true,
			order_id: existing.id,
			status: "processing",
			amount_minor: existing.total_minor,
			currency: existing.currency,
			currency_decimals: existing.currency_decimals,
		};
	}
	const item = await db
		.prepare(
			`SELECT item.id, item.product_id, item.name, item.version, item.currency,
			 item.currency_decimals, item.cost_minor, product.name AS product_name,
			 COALESCE(listing.price_minor, item.price_minor) AS price_minor,
			 ${storefrontStockExpression("product", "item")} AS stock_quantity,
   CASE WHEN item.fulfillment_source='local' THEN (SELECT COUNT(*) FROM stock_entries stock WHERE stock.sellable_item_id=item.id
    AND stock.status='available') ELSE 0 END AS owned_stock_quantity
			 FROM product_sellable_items item
			 JOIN supplier_export_listings listing ON listing.sellable_item_id = item.id
			 JOIN products product ON product.id = item.product_id
			 WHERE item.id = ? AND listing.enabled = 1 AND item.enabled = 1
			  AND item.sale_disabled = 0 AND product.sale_disabled = 0
			  AND item.fulfillment_source IN ('local','supplier') AND product.status = 'active'
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
			cost_minor: string | null;
			product_name: string;
			price_minor: string;
			stock_quantity: number;
			owned_stock_quantity: number;
		}>();
	if (!item)
		throw new DomainError("supplier_sku_not_found", 404, "SKU not found");
	const centralSale = await prepareSale(db, input.skuId, input.quantity);
	if (!centralSale && Number(item.stock_quantity) < input.quantity)
		throw new DomainError(
			"supplier_stock_unavailable",
			409,
			"Insufficient stock",
		);
	if (!centralSale && item.owned_stock_quantity < input.quantity)
		await assertSupplierAvailability(
			db,
			item.id,
			input.quantity - item.owned_stock_quantity,
		);
	const total = (BigInt(item.price_minor) * BigInt(input.quantity)).toString();
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
					`INSERT INTO shop_order_items (id, order_id, product_id, sellable_item_id, product_name, delivery_component_id, delivery_component_type, delivery_component_version, sellable_item_name, input_values_json, sensitive_input_values_json, quantity, unit_price_minor, unit_cost_minor, discount_minor, subtotal_minor, activation_trigger, exhaustion_rule, renewal_mode, show_on_order_page, account_library_enabled, email_mode, allow_resend, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'stock', ?, ?, '{}', '{}', ?, ?, ?, '0', ?, 'delivery_completed', 'first_limit_reached', 'stack', 1, 1, 'none', 0, ?, ?)`,
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
					item.cost_minor,
					total,
					now,
					now,
				),
			db
				.prepare(
					`INSERT INTO supplier_api_orders (id, shop_order_id, user_id, api_key_id, downstream_order_no, downstream_site_host, request_digest, callback_url, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?, ?)`,
				)
				.bind(
					apiOrderId,
					orderId,
					identity.userId,
					identity.keyRowId,
					input.downstreamOrderNo,
					display.siteHost ?? null,
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
			...(centralSale
				? reserveSaleStatements(db, item.id, orderItemId, input.quantity, now)
				: []),
		]);
		await completeWalletStoreOrder(db, { orderId, userId: identity.userId });
		return {
			ok: true,
			order_id: apiOrderId,
			status: "processing",
			amount_minor: total,
			currency: item.currency,
			currency_decimals: item.currency_decimals,
		};
	} catch (error) {
		if (
			error instanceof Error &&
			/owned_code_stock_unavailable/.test(error.message)
		)
			throw new DomainError(
				"supplier_stock_unavailable",
				409,
				"Insufficient owned codes",
			);
		if (error instanceof DomainError) throw error;
		const replay = await db
			.prepare(
				`SELECT api.id, api.request_digest, shop_order.total_minor, shop_order.currency,
				 shop_order.currency_decimals FROM supplier_api_orders api
				 JOIN shop_orders shop_order ON shop_order.id = api.shop_order_id
				 WHERE api.user_id = ? AND api.downstream_order_no = ? LIMIT 1`,
			)
			.bind(identity.userId, input.downstreamOrderNo)
			.first<{
				id: string;
				request_digest: string;
				total_minor: string;
				currency: string;
				currency_decimals: number;
			}>();
		if (replay?.request_digest === digest)
			return {
				ok: true,
				order_id: replay.id,
				status: "processing",
				amount_minor: replay.total_minor,
				currency: replay.currency,
				currency_decimals: replay.currency_decimals,
			};
		throw error;
	}
}

export async function getSupplierApiOrder(
	db: D1Database,
	userId: string,
	id: string,
) {
	const row = await db
		.prepare(
			`SELECT api.id, api.state, shop_order.status AS order_status, shop_order.total_minor,
			 shop_order.currency, shop_order.currency_decimals, delivery.status AS delivery_status,
			 delivery.content_encrypted FROM supplier_api_orders api
			 JOIN shop_orders shop_order ON shop_order.id = api.shop_order_id
			 LEFT JOIN shop_order_items item ON item.order_id = shop_order.id
			 LEFT JOIN delivery_records delivery ON delivery.order_item_id = item.id
			 WHERE api.id = ? AND api.user_id = ? LIMIT 1`,
		)
		.bind(id, userId)
		.first<{
			id: string;
			state: string;
			order_status: string;
			delivery_status: string | null;
			content_encrypted: string | null;
			total_minor: string;
			currency: string;
			currency_decimals: number;
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
		const content = withRedeemHost(
			await decryptDeliveryContent(
				row.content_encrypted,
				runtime.commerceSecret,
			),
			RESELLER_REDEEM_URL,
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
			amount_minor: row.total_minor,
			currency: row.currency,
			currency_decimals: row.currency_decimals,
			cards: content.split(/\r?\n/).filter(Boolean),
		};
	}
	if (row.delivery_status === "failed" || row.order_status === "failed")
		return {
			order_id: row.id,
			status: "failed",
			amount_minor: row.total_minor,
			currency: row.currency,
			currency_decimals: row.currency_decimals,
		};
	return {
		order_id: row.id,
		status: row.state,
		amount_minor: row.total_minor,
		currency: row.currency,
		currency_decimals: row.currency_decimals,
	};
}

export async function cancelSupplierApiOrder(
	db: D1Database,
	userId: string,
	id: string,
) {
	const row = await db
		.prepare(
			`SELECT api.id, api.state, api.shop_order_id, shop_order.status,
			 shop_order.total_minor, shop_order.currency, item.id AS order_item_id,
			 delivery.id AS delivery_id, delivery.status AS delivery_status
			 FROM supplier_api_orders api
			 JOIN shop_orders shop_order ON shop_order.id = api.shop_order_id
			 JOIN shop_order_items item ON item.order_id = shop_order.id
			 LEFT JOIN delivery_records delivery ON delivery.order_item_id = item.id
			 WHERE api.id = ? AND api.user_id = ? LIMIT 1`,
		)
		.bind(id, userId)
		.first<{
			id: string;
			state: string;
			shop_order_id: string;
			status: string;
			total_minor: string;
			currency: string;
			order_item_id: string;
			delivery_id: string | null;
			delivery_status: string | null;
		}>();
	if (!row)
		throw new DomainError("supplier_order_not_found", 404, "Order not found");
	if (row.state === "cancelled")
		return { ok: true, order_id: id, status: "cancelled" };
	if (
		row.delivery_status !== "pending" ||
		!["paid", "fulfilling"].includes(row.status)
	)
		throw new DomainError(
			"supplier_order_not_cancellable",
			409,
			"Order cannot be cancelled",
		);
	const now = Date.now();
	const results = await db.batch([
		db
			.prepare(
				"UPDATE delivery_records SET status = 'failed', error_code = 'supplier_api_cancelled', next_attempt_at = NULL, updated_at = ? WHERE id = ? AND status = 'pending'",
			)
			.bind(now, row.delivery_id),
		db
			.prepare(
				"UPDATE stock_entries SET status = 'available', order_item_id = NULL, reserved_at = NULL, updated_at = ? WHERE order_item_id = ? AND status = 'reserved'",
			)
			.bind(now, row.order_item_id),
		db
			.prepare(
				"UPDATE shop_orders SET status = 'cancelled', cancelled_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND status IN ('paid', 'fulfilling')",
			)
			.bind(now, now, row.shop_order_id),
		db
			.prepare(
				"UPDATE supplier_api_orders SET state = 'cancelled', updated_at = ? WHERE id = ? AND state = 'processing'",
			)
			.bind(now, id),
	]);
	if (Number(results[0]?.meta.changes ?? 0) !== 1)
		throw new DomainError(
			"supplier_order_not_cancellable",
			409,
			"Order cannot be cancelled",
		);
	await mutateWallet(db, {
		userId,
		direction: "credit",
		amountMinor: row.total_minor,
		currency: row.currency,
		sourceType: "refund",
		sourceId: row.shop_order_id,
		idempotencyKey: `supplier-api-cancel:${id}`,
		reason: "Supplier API order cancelled",
	});
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
