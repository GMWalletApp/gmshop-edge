import { z } from "zod";
import { consumeEntitlementAccess } from "#/features/entitlements/server/ledger";
import { storeOrderLookupSchema } from "#/features/storefront/schema";
import { getStoreOrder } from "#/features/storefront/server/order-query";
import { DomainError } from "#/lib/domain-error";
import { clientIp } from "#/server/client-ip";

const downloadSchema = z.object({
	orderNumber: z.string().trim().min(8).max(80),
	assetId: z.uuid(),
	email: storeOrderLookupSchema.shape.email.optional(),
});

type DownloadGrant = {
	entitlement_id: string;
	object_key: string;
	file_name: string;
	content_type: string;
	checksum_sha256: string;
};

export async function storeDownloadResponse(
	request: Request,
	rawInput: unknown,
	db: D1Database,
	bucket: R2Bucket | undefined,
	access: { userId?: string } = {},
) {
	const input = downloadSchema.parse(rawInput);
	if (!bucket)
		throw new DomainError(
			"download_storage_unavailable",
			503,
			"Download storage is unavailable",
		);
	const order = await getStoreOrder(db, input, { ...access, request });
	const grant = await db
		.prepare(
			`SELECT ce.id AS entitlement_id,
			 snapshot.object_key, snapshot.file_name, snapshot.content_type,
			 snapshot.checksum_sha256
			 FROM shop_order_items oi
			 JOIN entitlement_grants grant_row ON grant_row.source_order_item_id = oi.id
			 JOIN customer_entitlements ce ON ce.id = grant_row.entitlement_id
			 JOIN delivery_records dr ON dr.order_item_id = oi.id
			 JOIN order_item_download_assets snapshot ON snapshot.order_item_id = oi.id
			 WHERE oi.order_id = ? AND ce.entitlement_type = 'download'
			 AND ce.status IN ('active', 'exhausted')
			 AND (ce.expires_at IS NULL OR ce.expires_at > ?)
			 AND dr.status = 'delivered' AND snapshot.download_asset_id = ?
			 LIMIT 1`,
		)
		.bind(order.id, Date.now(), input.assetId)
		.first<DownloadGrant>();
	if (!grant)
		throw new DomainError("download_not_found", 404, "Download not found");
	const object = await bucket.get(grant.object_key, {
		onlyIf: request.headers,
	});
	if (!object)
		throw new DomainError("download_not_found", 404, "Download not found");
	if (!("body" in object))
		return new Response(null, {
			status: 304,
			headers: downloadHeaders(grant, object),
		});
	await consumeEntitlementAccess(db, {
		entitlementId: grant.entitlement_id,
		assetType: "download_asset",
		assetId: input.assetId,
		eventType: "downloaded",
		actorType: "customer",
		requestId: request.headers.get("x-request-id") ?? undefined,
		ipAddress: clientIp(request) ?? undefined,
		unavailableCode: "download_limit_reached",
		unavailableMessage: "Download limit reached",
	});
	const now = Date.now();
	await db
		.prepare(
			`INSERT INTO audit_logs
				 (id, action, target_type, target_id, request_id, ip_address, after, created_at)
				 VALUES (?, 'download.accessed', 'download_asset', ?, ?, ?, ?, ?)`,
		)
		.bind(
			crypto.randomUUID(),
			input.assetId,
			request.headers.get("x-request-id"),
			clientIp(request),
			JSON.stringify({
				orderId: order.id,
				entitlementId: grant.entitlement_id,
			}),
			now,
		)
		.run();
	return new Response(object.body, { headers: downloadHeaders(grant, object) });
}

function downloadHeaders(grant: DownloadGrant, object: R2Object) {
	const headers = new Headers({
		"Cache-Control": "private, no-store",
		"Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(grant.file_name)}`,
		"Content-Type": grant.content_type,
		ETag: object.httpEtag,
		"X-Checksum-SHA256": grant.checksum_sha256,
		"X-Content-Type-Options": "nosniff",
	});
	object.writeHttpMetadata(headers);
	return headers;
}
