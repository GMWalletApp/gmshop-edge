import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	removeSiteLogo,
	uploadSiteLogo,
} from "#/features/settings/server/site-asset";
import { loadSiteBrand } from "#/features/settings/server/site-brand";
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

describe("site asset storage", () => {
	let miniflare: Miniflare;
	let db: D1Database;
	let bucket: R2Bucket;
	let cache: KVNamespace;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmshop-edge-site-assets" },
			r2Buckets: ["FILES"],
			kvNamespaces: ["CACHE"],
		});
		db = await miniflare.getD1Database("DB");
		const binding: unknown = await miniflare.getR2Bucket("FILES");
		if (!isR2Bucket(binding)) throw new Error("FILES must be an R2 bucket");
		bucket = binding;
		cache = (await miniflare.getKVNamespace("CACHE")) as unknown as KVNamespace;
		await applyMigrations(db);
		await db
			.prepare(
				"INSERT OR IGNORE INTO users (id, name, email, email_verified, enabled) VALUES ('root-user', 'Root', 'brand-root@example.com', 1, 1)",
			)
			.run();
	});

	beforeEach(async () => {
		await db.batch([
			db.prepare("DELETE FROM system_settings WHERE key = 'site.logo_url'"),
			db.prepare(
				"DELETE FROM audit_logs WHERE action IN ('site_asset.uploaded', 'site_asset.removed')",
			),
		]);
		await Promise.all([
			bucket.delete("branding/site-logo"),
			cache.delete("site-brand:v1"),
		]);
	});

	afterAll(async () => miniflare.dispose());

	it("uploads an inspected asset, updates D1, audits it, and invalidates the brand cache", async () => {
		await loadSiteBrand(db, cache);
		const result = await uploadSiteLogo(
			{ contentType: "image/png", base64: toBase64(png(2, 2)) },
			dependencies(),
		);

		expect(result.url).toMatch(/^\/api\/site-logo\?v=\d+$/);
		const object = await bucket.get("branding/site-logo");
		expect(object).not.toBeNull();
		expect(object?.httpMetadata?.contentType).toBe("image/png");
		await expect(object?.arrayBuffer()).resolves.toHaveProperty(
			"byteLength",
			33,
		);
		await expect(setting("site.logo_url")).resolves.toBe(
			JSON.stringify(result.url),
		);
		await expect(
			db
				.prepare(
					"SELECT action, actor_user_id, request_id, ip_address FROM audit_logs WHERE target_id = 'site.logo_url' ORDER BY created_at DESC LIMIT 1",
				)
				.first(),
		).resolves.toMatchObject({
			action: "site_asset.uploaded",
			actor_user_id: "root-user",
			request_id: "request-brand",
			ip_address: "192.0.2.1",
		});
		expect(await cache.get("site-brand:v1")).toBeNull();
		await expect(loadSiteBrand(db, cache)).resolves.toMatchObject({
			logoUrl: result.url,
		});
	});

	it("stores the detected image type when the browser MIME is incorrect", async () => {
		await uploadSiteLogo(
			{ contentType: "image/png", base64: toBase64(jpeg(2, 2)) },
			dependencies(),
		);

		const object = await bucket.get("branding/site-logo");
		expect(object?.httpMetadata?.contentType).toBe("image/jpeg");
	});

	it("removes the R2 object and clears the public setting with an audit record", async () => {
		await uploadSiteLogo(
			{ contentType: "image/png", base64: toBase64(png(2, 2)) },
			dependencies(),
		);
		await expect(removeSiteLogo(dependencies())).resolves.toEqual({
			removed: true,
		});

		expect(await bucket.get("branding/site-logo")).toBeNull();
		await expect(setting("site.logo_url")).resolves.toBe('""');
		await expect(
			db
				.prepare(
					"SELECT action FROM audit_logs WHERE target_id = 'site.logo_url' ORDER BY created_at DESC, rowid DESC LIMIT 1",
				)
				.first(),
		).resolves.toMatchObject({ action: "site_asset.removed" });
	});

	function dependencies() {
		return {
			db,
			bucket,
			cache,
			userId: "root-user",
			requestId: "request-brand",
			ipAddress: "192.0.2.1",
		};
	}

	async function setting(key: string) {
		return (
			await db
				.prepare("SELECT value FROM system_settings WHERE key = ?")
				.bind(key)
				.first<{ value: string }>()
		)?.value;
	}
});

function png(width: number, height: number) {
	const bytes = new Uint8Array(33);
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	bytes.set([0x49, 0x48, 0x44, 0x52], 12);
	new DataView(bytes.buffer).setUint32(16, width);
	new DataView(bytes.buffer).setUint32(20, height);
	return bytes;
}

function jpeg(width: number, height: number) {
	const bytes = new Uint8Array(23);
	bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]);
	new DataView(bytes.buffer).setUint16(7, height);
	new DataView(bytes.buffer).setUint16(9, width);
	bytes.set([0xff, 0xd9], 21);
	return bytes;
}

function toBase64(bytes: Uint8Array) {
	let value = "";
	for (const byte of bytes) value += String.fromCharCode(byte);
	return btoa(value);
}
