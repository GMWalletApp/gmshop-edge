import { z } from "zod";
import { consumeEntitlementAccess } from "#/features/entitlements/server/ledger";
import { decryptDeliveryContent } from "#/features/fulfillment/secrets";
import {
	redeemUrlForOrder,
	withRedeemHost,
} from "#/features/redeem-warehouse/redeem-host";
import { getStoreOrder } from "#/features/storefront/server/order-query";
import { resolveSupplierUsageUrl } from "#/features/suppliers/customer-usage";
import { DomainError } from "#/lib/domain-error";
import { loadRuntimeConfig } from "#/server/runtime-config";

const revealSchema = z.object({
	action: z.enum(["reveal", "copied"]).default("reveal"),
});

export async function revealStoreDelivery(
	db: D1Database,
	input: {
		orderNumber: string;
		deliveryId: string;
		email?: string;
		action?: "reveal" | "copied";
		request?: Request;
		userId?: string;
		actorUserId?: string;
	},
) {
	const { action } = revealSchema.parse(input);
	const order = await getStoreOrder(
		db,
		{ orderNumber: input.orderNumber, email: input.email },
		{ userId: input.userId },
	);
	const delivery = await db
		.prepare(
			`SELECT dr.content_encrypted, dr.delivery_type, dr.redeem_sku, ce.id AS entitlement_id,
       EXISTS (SELECT 1 FROM stock_entries stock WHERE stock.order_item_id=oi.id AND stock.redeem_sku IN ('GPT_PLUS_PH','GPT_5X_PH','GPT_20X_PH')) AS has_converted_stock,
			 sellable.policy_json, supplier_order.binding_snapshot_json
			 FROM delivery_records dr
			 JOIN shop_order_items oi ON oi.id = dr.order_item_id
			 LEFT JOIN product_sellable_items sellable ON sellable.id = oi.sellable_item_id
			 LEFT JOIN supplier_orders supplier_order ON supplier_order.order_item_id = oi.id
			 JOIN customer_entitlements ce ON ce.id = (
			  SELECT grants.entitlement_id FROM entitlement_grants grants
			 WHERE grants.source_order_item_id = oi.id LIMIT 1)
			 WHERE dr.id = ? AND oi.order_id = ? AND dr.status = 'delivered'
			 AND dr.delivery_type = 'stock'
			 AND ce.status IN ('active', 'exhausted')
			 AND (ce.expires_at IS NULL OR ce.expires_at > ?)
			 AND dr.content_encrypted IS NOT NULL LIMIT 1`,
		)
		.bind(input.deliveryId, order.id, Date.now())
		.first<{
			content_encrypted: string;
			delivery_type: "stock";
			redeem_sku: string | null;
			has_converted_stock: number;
			entitlement_id: string;
			policy_json: string | null;
			binding_snapshot_json: string | null;
		}>();
	if (!delivery)
		throw new DomainError("delivery_not_found", 404, "Delivery not found");
	if (action === "copied") {
		await db
			.prepare(
				`INSERT INTO entitlement_events
				 (id, kind, entitlement_id, asset_type, asset_id, event_type, consumed,
				  actor_type, request_id, ip_address, created_at)
				 VALUES (?, 'access', ?, ?, ?, 'copied', 0, 'customer', ?, ?, ?)`,
			)
			.bind(
				crypto.randomUUID(),
				delivery.entitlement_id,
				"stock_secret",
				input.deliveryId,
				input.request?.headers.get("x-request-id") ?? null,
				input.request?.headers.get("cf-connecting-ip") ?? null,
				Date.now(),
			)
			.run();
		return { recorded: true as const };
	}
	const runtime = await loadRuntimeConfig(db);
	if (!runtime.commerceSecret)
		throw new DomainError(
			"delivery_secret_unavailable",
			503,
			"Delivery configuration unavailable",
		);
	const redeemUrl = await redeemUrlForOrder(db, order.id);
	const content = withRedeemHost(
		await decryptDeliveryContent(
			delivery.content_encrypted,
			runtime.commerceSecret,
		),
		redeemUrl,
	);
	const usageUrl = delivery.redeem_sku
		? redeemUrl
		: delivery.has_converted_stock
			? null
			: resolveSupplierUsageUrl(
					delivery.policy_json,
					delivery.binding_snapshot_json,
				);
	await consumeEntitlementAccess(db, {
		entitlementId: delivery.entitlement_id,
		assetType: "stock_secret",
		assetId: input.deliveryId,
		eventType: "revealed",
		actorType: "customer",
		requestId: input.request?.headers.get("x-request-id") ?? undefined,
		ipAddress: input.request?.headers.get("cf-connecting-ip") ?? undefined,
	});
	await db
		.prepare(
			`INSERT INTO audit_logs
			 (id, actor_user_id, action, target_type, target_id, request_id, ip_address,
			  after, created_at)
			 VALUES (?, ?, 'delivery.content_viewed', 'delivery', ?, ?, ?, ?, ?)`,
		)
		.bind(
			crypto.randomUUID(),
			input.actorUserId ?? null,
			input.deliveryId,
			input.request?.headers.get("x-request-id") ?? null,
			input.request?.headers.get("cf-connecting-ip") ?? null,
			JSON.stringify({ orderId: order.id, ...(usageUrl ? { usageUrl } : {}) }),
			Date.now(),
		)
		.run();
	return usageUrl ? { content, usageUrl } : { content };
}
