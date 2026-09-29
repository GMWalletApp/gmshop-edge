import { z } from "zod";
import { consumeEntitlementAccess } from "#/features/entitlements/server/ledger";
import { decryptDeliveryContent } from "#/features/fulfillment/secrets";
import { getStoreOrder } from "#/features/storefront/server/order-query";
import { DomainError } from "#/lib/domain-error";
import { clientIp } from "#/server/client-ip";
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
		{ userId: input.userId, request: input.request },
	);
	const delivery = await db
		.prepare(
			`SELECT dr.content_encrypted, dr.delivery_type, ce.id AS entitlement_id
			 FROM delivery_records dr
			 JOIN shop_order_items oi ON oi.id = dr.order_item_id
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
			entitlement_id: string;
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
				clientIp(input.request),
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
	const content = await decryptDeliveryContent(
		delivery.content_encrypted,
		runtime.commerceSecret,
	);
	await consumeEntitlementAccess(db, {
		entitlementId: delivery.entitlement_id,
		assetType: "stock_secret",
		assetId: input.deliveryId,
		eventType: "revealed",
		actorType: "customer",
		requestId: input.request?.headers.get("x-request-id") ?? undefined,
		ipAddress: clientIp(input.request) ?? undefined,
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
			clientIp(input.request),
			JSON.stringify({ orderId: order.id }),
			Date.now(),
		)
		.run();
	return { content };
}
