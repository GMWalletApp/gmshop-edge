import { z } from "zod";
import { consumeEntitlementAccess } from "#/features/entitlements/server/ledger";
import { getStoreOrder } from "#/features/storefront/server/order-query";
import { DomainError } from "#/lib/domain-error";
import { clientIp } from "#/server/client-ip";

const schema = z.object({
	orderNumber: z.string().trim().min(8).max(80),
	automationJobId: z.uuid(),
	artifactId: z.uuid(),
});

export async function storeAutomationArtifactResponse(
	request: Request,
	rawInput: unknown,
	db: D1Database,
	bucket: R2Bucket | undefined,
	access: { userId?: string } = {},
) {
	const input = schema.parse(rawInput);
	if (!bucket)
		throw new DomainError(
			"download_storage_unavailable",
			503,
			"Download storage is unavailable",
		);
	const order = await getStoreOrder(db, input, { ...access, request });
	const artifact = await db
		.prepare(
			`SELECT ba.id, ba.object_key, ba.file_name, ba.content_type, ba.checksum_sha256,
			 ce.id AS entitlement_id
			 FROM automation_artifacts ba JOIN automation_jobs bj ON bj.id = ba.automation_job_id
			 JOIN shop_order_items oi ON oi.id = bj.order_item_id
			 JOIN customer_entitlements ce ON ce.id = bj.entitlement_id
			 WHERE ba.id = ? AND bj.id = ? AND oi.order_id = ? AND bj.status = 'succeeded'
			 AND ce.status IN ('active', 'exhausted')
			 AND (ce.expires_at IS NULL OR ce.expires_at > ?)
			 AND ba.upload_status = 'ready' AND ba.download_enabled = 1 AND ba.deleted_at IS NULL
			 AND ba.delete_after > ? LIMIT 1`,
		)
		.bind(
			input.artifactId,
			input.automationJobId,
			order.id,
			Date.now(),
			Date.now(),
		)
		.first<{
			id: string;
			object_key: string;
			file_name: string;
			content_type: string;
			checksum_sha256: string;
			entitlement_id: string;
		}>();
	if (!artifact)
		throw new DomainError("download_not_found", 404, "Download not found");
	const object = await bucket.get(artifact.object_key, {
		onlyIf: request.headers,
	});
	if (!object)
		throw new DomainError("download_not_found", 404, "Download not found");
	const headers = new Headers({
		"Cache-Control": "private, no-store",
		"Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(artifact.file_name)}`,
		"Content-Type": artifact.content_type,
		ETag: object.httpEtag,
		"X-Checksum-SHA256": artifact.checksum_sha256,
		"X-Content-Type-Options": "nosniff",
	});
	object.writeHttpMetadata(headers);
	if (!("body" in object)) return new Response(null, { status: 304, headers });
	await consumeEntitlementAccess(db, {
		entitlementId: artifact.entitlement_id,
		assetType: "automation_artifact",
		assetId: artifact.id,
		eventType: "downloaded",
		actorType: "customer",
		requestId: request.headers.get("x-request-id") ?? undefined,
		ipAddress: clientIp(request) ?? undefined,
		unavailableCode: "artifact_access_limit_reached",
		unavailableMessage: "Artifact access limit reached",
	});
	const now = Date.now();
	await db.batch([
		db
			.prepare(
				"UPDATE automation_artifacts SET download_count = download_count + 1, updated_at = ? WHERE id = ? AND download_enabled = 1 AND deleted_at IS NULL",
			)
			.bind(now, artifact.id),
		db
			.prepare(
				`INSERT INTO audit_logs
				 (id, action, target_type, target_id, request_id, ip_address, after, created_at)
				 VALUES (?, 'automation_artifact.accessed', 'automation_artifact', ?, ?, ?, ?, ?)`,
			)
			.bind(
				crypto.randomUUID(),
				artifact.id,
				request.headers.get("x-request-id"),
				clientIp(request),
				JSON.stringify({ orderId: order.id }),
				now,
			),
	]);
	return new Response(object.body, { headers });
}
