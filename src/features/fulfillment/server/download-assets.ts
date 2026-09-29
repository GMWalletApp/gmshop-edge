import { z } from "zod";
import { DomainError } from "#/lib/domain-error";
import { clientIp } from "#/server/client-ip";

const assetInputSchema = z.object({
	productId: z.uuid(),
	componentId: z.uuid(),
	fileName: z
		.string()
		.trim()
		.min(1)
		.max(255)
		.refine((value) =>
			[...value].every((character) => {
				const codePoint = character.codePointAt(0) ?? 0;
				return (
					codePoint >= 32 &&
					codePoint !== 127 &&
					character !== "/" &&
					character !== "\\"
				);
			}),
		),
	contentType: z.string().trim().min(1).max(255),
});

export async function createDownloadAsset(
	db: D1Database,
	bucket: {
		put(
			key: string,
			value: Uint8Array<ArrayBuffer>,
			options: { httpMetadata: { contentType: string } },
		): Promise<unknown>;
		delete(key: string): Promise<unknown>;
	},
	input: {
		productId: string;
		componentId: string;
		fileName: string;
		contentType: string;
		body: ArrayBuffer;
		actorUserId: string;
		request?: Request;
	},
) {
	const data = assetInputSchema.parse(input);
	if (input.body.byteLength < 1 || input.body.byteLength > 100 * 1024 * 1024)
		throw new DomainError(
			"download_asset_size_invalid",
			400,
			"File must be between 1 byte and 100 MiB",
		);
	const target = await db
		.prepare(
			`SELECT product.id, item.id AS component_id FROM products product
			 JOIN product_sellable_items item ON item.product_id = product.id
			 WHERE product.id = ? AND item.id = ?
			  AND product.product_type = 'download' LIMIT 1`,
		)
		.bind(data.productId, data.componentId)
		.first<{ id: string; component_id: string }>();
	if (!target)
		throw new DomainError(
			"download_product_not_found",
			404,
			"Download product or sellable item not found",
		);
	const id = crypto.randomUUID();
	const objectKey = `downloads/${data.productId}/${id}`;
	const checksumSha256 = await digestHex(input.body);
	const latest = await db
		.prepare(
			"SELECT COALESCE(MAX(version), 0) AS version FROM download_assets WHERE product_id = ?",
		)
		.bind(data.productId)
		.first<{ version: number }>();
	const version = Number(latest?.version ?? 0) + 1;
	await bucket.put(objectKey, Uint8Array.from(new Uint8Array(input.body)), {
		httpMetadata: { contentType: data.contentType },
	});
	const now = Date.now();
	try {
		await db.batch([
			db
				.prepare(
					`INSERT INTO download_assets
					 (id, product_id, object_key, file_name, content_type, size_bytes,
					  checksum_sha256, version, download_enabled, sort_order, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 100, ?, ?)`,
				)
				.bind(
					id,
					data.productId,
					objectKey,
					data.fileName,
					data.contentType,
					input.body.byteLength,
					checksumSha256,
					version,
					now,
					now,
				),
			db
				.prepare(
					"INSERT INTO download_asset_sellable_items (download_asset_id, sellable_item_id, sort_order) VALUES (?, ?, 100)",
				)
				.bind(id, data.componentId),
			db
				.prepare(
					`INSERT INTO audit_logs
					 (id, actor_user_id, action, target_type, target_id, request_id,
					  ip_address, after, created_at)
					 VALUES (?, ?, 'download_asset.created', 'download_asset', ?, ?, ?, ?, ?)`,
				)
				.bind(
					crypto.randomUUID(),
					input.actorUserId,
					id,
					input.request?.headers.get("x-request-id") ?? null,
					clientIp(input.request),
					JSON.stringify({
						productId: data.productId,
						componentId: data.componentId,
						fileName: data.fileName,
						sizeBytes: input.body.byteLength,
						checksumSha256,
					}),
					now,
				),
		]);
	} catch (error) {
		await bucket.delete(objectKey);
		throw error;
	}
	return { id, objectKey, checksumSha256, version };
}

async function digestHex(body: ArrayBuffer) {
	const digest = await crypto.subtle.digest("SHA-256", body);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}
