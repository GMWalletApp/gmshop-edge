import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDownloadAsset } from "#/features/fulfillment/server/download-assets";
import { storeDownloadResponse } from "#/features/storefront/server/download-response";
import { applyMigrations } from "./migrations";

function isR2Bucket(value: unknown): value is R2Bucket {
	return (
		typeof value === "object" &&
		value !== null &&
		"put" in value &&
		typeof value.put === "function" &&
		"get" in value &&
		typeof value.get === "function" &&
		"delete" in value &&
		typeof value.delete === "function" &&
		"head" in value &&
		typeof value.head === "function" &&
		"list" in value &&
		typeof value.list === "function" &&
		"createMultipartUpload" in value &&
		typeof value.createMultipartUpload === "function" &&
		"resumeMultipartUpload" in value &&
		typeof value.resumeMultipartUpload === "function"
	);
}

describe("private download fulfillment", { timeout: 30_000 }, () => {
	let miniflare: Miniflare;
	let database: D1Database;
	let bucket: R2Bucket;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmshop-edge-download-fulfillment" },
			r2Buckets: ["FILES"],
		});
		database = await miniflare.getD1Database("DB");
		const binding: unknown = await miniflare.getR2Bucket("FILES");
		if (!isR2Bucket(binding)) throw new Error("FILES must be an R2 bucket");
		bucket = binding;
		await applyMigrations(database);
		await seed(database);
	});

	afterAll(async () => miniflare.dispose());

	it("uploads a private asset and enforces the entitlement download limit", async () => {
		const body = new TextEncoder().encode("private-release-content").buffer;
		const asset = await createDownloadAsset(database, bucket, {
			productId: "11111111-1111-4111-8111-111111111111",
			componentId: "22222222-2222-4222-8222-222222222222",
			fileName: "release.zip",
			contentType: "application/zip",
			body,
			actorUserId: "admin-user",
		});
		await database
			.prepare(
				`INSERT INTO order_item_download_assets
				 (id, order_item_id, download_asset_id, object_key, file_name, content_type,
				  size_bytes, checksum_sha256, created_at, updated_at)
				 SELECT 'snapshot-download', 'item-download', id, object_key, file_name,
				  content_type, size_bytes, checksum_sha256, 1, 1
				 FROM download_assets WHERE id = ?`,
			)
			.bind(asset.id)
			.run();
		await expect(
			download(database, bucket, asset.id, "other@example.com"),
		).rejects.toMatchObject({
			code: "order_not_found",
		});
		const response = await download(database, bucket, asset.id);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(response.headers.get("content-disposition")).toContain(
			"release.zip",
		);
		expect(await response.text()).toBe("private-release-content");
		const state = await database
			.prepare(
				`SELECT ce.access_count,
				 (SELECT COUNT(*) FROM audit_logs WHERE action = 'download_asset.created') AS created_audits,
				 (SELECT COUNT(*) FROM audit_logs WHERE action = 'download.accessed') AS access_audits
				 FROM customer_entitlements ce WHERE ce.id = 'entitlement-download'`,
			)
			.first<Record<string, number>>();
		expect(state).toEqual({
			access_count: 1,
			created_audits: 1,
			access_audits: 1,
		});
		const notModified = await storeDownloadResponse(
			new Request("https://shop.example/api/download", {
				method: "POST",
				headers: { "if-none-match": '"download-etag"' },
			}),
			{
				orderNumber: "GM100001",
				assetId: asset.id,
				email: "buyer@example.com",
			},
			database,
			{
				get: async () => ({
					httpEtag: '"download-etag"',
					writeHttpMetadata() {},
				}),
			} as unknown as R2Bucket,
		);
		expect(notModified.status).toBe(304);
		const afterNotModified = await database
			.prepare(
				`SELECT ce.access_count,
				 (SELECT COUNT(*) FROM audit_logs
				  WHERE action = 'download.accessed') AS access_audits
				 FROM customer_entitlements ce WHERE ce.id = 'entitlement-download'`,
			)
			.first<Record<string, number>>();
		expect(afterNotModified).toEqual({ access_count: 1, access_audits: 1 });
		await expect(download(database, bucket, asset.id)).rejects.toMatchObject({
			code: "download_limit_reached",
		});
	});
});

async function download(
	database: D1Database,
	bucket: R2Bucket,
	assetId: string,
	email = "buyer@example.com",
) {
	return storeDownloadResponse(
		new Request("https://shop.example/api/download", { method: "POST" }),
		{
			orderNumber: "GM100001",
			assetId,
			email,
		},
		database,
		await responseBucket(bucket),
	);
}

async function responseBucket(bucket: R2Bucket) {
	return {
		async get(key: string) {
			const object = await bucket.get(key);
			if (!object) return null;
			const bytes = await object.arrayBuffer();
			return {
				body: new Response(bytes).body,
				httpEtag: object.httpEtag,
				writeHttpMetadata() {},
			};
		},
	} as unknown as R2Bucket;
}

async function seed(database: D1Database) {
	await database.batch([
		database.prepare(
			`INSERT INTO users
			 (id, name, email, email_verified, enabled, created_at, updated_at)
			 VALUES ('admin-user', 'Admin', 'admin@example.com', 1, 1, 1, 1)`,
		),
		database.prepare(
			`INSERT INTO products
			 (id, name, product_type, status, sort_order, created_at, updated_at)
			 VALUES ('11111111-1111-4111-8111-111111111111',
			  'Release', 'download', 'active', 100, 1, 1)`,
		),
		database.prepare(
			`INSERT INTO product_sellable_items
			 (id, product_id, name, access_limit, currency, currency_decimals,
			  price_minor, minimum_quantity, maximum_quantity,
			  sort_order, enabled, created_at, updated_at)
			 VALUES ('22222222-2222-4222-8222-222222222222',
			  '11111111-1111-4111-8111-111111111111', 'Standard',
			  1, 'CNY', 2, '1000', 1, 1, 100, 1, 1, 1)`,
		),
		database.prepare(
			`INSERT INTO users
			 (id, name, email, email_verified, created_at, updated_at)
			 VALUES ('customer-download', 'Download customer', 'buyer@example.com', 1, 1, 1)`,
		),
		database.prepare(
			`INSERT INTO shop_orders
			 (id, order_number, user_id, contact_email,
			  normalized_contact_email, status, currency, currency_decimals,
			  subtotal_minor, discount_minor, total_minor, paid_minor, version,
			  expires_at, paid_at, completed_at, created_at, updated_at)
			 VALUES ('order-download', 'GM100001', 'customer-download',
			  'buyer@example.com', 'buyer@example.com', 'completed', 'CNY', 2,
			  '1000', '0', '1000', '1000', 3, 9999999999999, 2, 3, 1, 3)`,
		),
		database.prepare(
			`INSERT INTO shop_order_items
			 (id, order_id, product_id, sellable_item_id, product_name, delivery_component_id,
			  delivery_component_type, delivery_component_version,
			  sellable_item_name, quantity, unit_price_minor,
			  discount_minor, subtotal_minor, created_at, updated_at)
			 VALUES ('item-download', 'order-download', '11111111-1111-4111-8111-111111111111',
			  '22222222-2222-4222-8222-222222222222', 'Release',
			  '22222222-2222-4222-8222-222222222222', 'download', 1,
			  'Standard', 1, '1000', '0', '1000', 1, 1)`,
		),
		database.prepare(
			`INSERT INTO delivery_records
			 (id, order_item_id, delivery_type, status, attempt_count, delivered_at,
			  created_at, updated_at)
			 VALUES ('delivery-download', 'item-download', 'download', 'delivered', 1, 3, 1, 3)`,
		),
		database.prepare(
			`INSERT INTO customer_entitlements
			 (id, user_id, order_item_id, product_id, sellable_item_id, delivery_component_id, entitlement_type,
			  status, usage_count, access_limit, access_count, activated_at, created_at, updated_at)
			 VALUES ('entitlement-download', 'customer-download', 'item-download',
			  '11111111-1111-4111-8111-111111111111',
			  '22222222-2222-4222-8222-222222222222',
			  '22222222-2222-4222-8222-222222222222', 'download', 'active', 0, 1, 0, 1, 1, 1)`,
		),
		database.prepare(
			`INSERT INTO entitlement_grants
			 (id, entitlement_id, source_order_item_id, status, access_granted,
			  activated_at, applied_at, created_at, updated_at)
			 VALUES ('grant-download', 'entitlement-download', 'item-download', 'active',
			  1, 1, 1, 1, 1)`,
		),
	]);
}
