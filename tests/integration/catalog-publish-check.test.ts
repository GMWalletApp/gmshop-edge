import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { checkProduct } from "#/features/catalog/server/editor";
import { applyMigrations } from "./migrations";

vi.mock("cloudflare:workers", () => ({ env: {} }));

describe("catalog publish checks", { timeout: 30_000 }, () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmshop-edge-publish-check" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
	});

	afterAll(async () => miniflare.dispose());

	it("allows stock products to publish without inventory and reports a visible warning", async () => {
		await db.batch([
			db.prepare(
				`INSERT INTO products
				 (id, name, product_type, status, created_at, updated_at)
				 VALUES ('11111111-1111-4111-8111-111111111114',
				  'Stock product', 'stock', 'draft', 1, 1)`,
			),
			db.prepare(
				`INSERT INTO product_sellable_items
				 (id, product_id, name, price_minor, sort_order, enabled, created_at, updated_at)
				 VALUES ('22222222-2222-4222-8222-222222222234',
				  '11111111-1111-4111-8111-111111111114',
				  'Default', '1000', 100, 1, 1, 1)`,
			),
		]);
		const check = await checkProduct(
			{ db: { $client: db } } as never,
			"11111111-1111-4111-8111-111111111114",
		);
		expect(check.blockers).toEqual([]);
		expect(check.warnings).toContainEqual(
			expect.objectContaining({
				code: "stock_out_of_stock",
				target: "sellableItem:22222222-2222-4222-8222-222222222234",
			}),
		);
	});

	it("requires an enabled binding and purchasing account instead of local inventory for supplier stock", async () => {
		await db.batch([
			db.prepare(
				`INSERT INTO products
				 (id, name, product_type, status, created_at, updated_at)
				 VALUES ('11111111-1111-4111-8111-111111111115',
				  'Supplier stock', 'stock', 'draft', 1, 1)`,
			),
			db.prepare(
				`INSERT INTO product_sellable_items
				 (id, product_id, name, fulfillment_source, supplier_status,
				  price_minor, sort_order, enabled, created_at, updated_at)
				 VALUES ('22222222-2222-4222-8222-222222222235',
				  '11111111-1111-4111-8111-111111111115',
				  'Supplier item', 'supplier', 'available',
				  '1000', 100, 1, 1, 1)`,
			),
		]);
		const unbound = await checkProduct(
			{ db: { $client: db } } as never,
			"11111111-1111-4111-8111-111111111115",
		);
		expect(unbound.blockers.map((issue) => issue.code)).toContain(
			"supplier_binding_missing",
		);
		await db.batch([
			db.prepare(
				`INSERT INTO supplier_accounts
				 (id, provider, base_url, normalized_api_origin, protocol_version,
				  name, credentials_encrypted, credential_fingerprint, enabled,
				  created_at, updated_at)
				 VALUES ('supplier-account', 'acg', 'https://supplier.example',
				  'https://supplier.example', '3.5.5', 'Account', 'encrypted',
				  'fingerprint', 1, 1, 1)`,
			),
			db.prepare(
				`INSERT INTO supplier_bindings
				 (id, sellable_item_id, provider, normalized_api_origin,
				  protocol_version, upstream_product_id, upstream_sku_id,
				  upstream_product_name, upstream_sku_name, reference_cost_minor,
				  max_cost_minor, stock_quantity, remote_status, enabled,
				  created_at, updated_at)
				 VALUES ('supplier-binding',
				  '22222222-2222-4222-8222-222222222235', 'acg',
				  'https://supplier.example', '3.5.5', 'product', 'sku',
				  'Product', 'SKU', '500', '600', 10, 'active', 1, 1, 1)`,
			),
		]);
		const check = await checkProduct(
			{ db: { $client: db } } as never,
			"11111111-1111-4111-8111-111111111115",
		);
		expect(check.blockers).toEqual([]);
		expect(check.warnings).not.toContainEqual(
			expect.objectContaining({ code: "stock_out_of_stock" }),
		);
	});

	it.each([
		[
			"download",
			"download_file_missing",
			DOWNLOAD_PRODUCT_ID,
			DOWNLOAD_COMPONENT_ID,
		],
		[
			"automation",
			"automation_configuration_missing",
			BUILD_PRODUCT_ID,
			BUILD_COMPONENT_ID,
		],
	] as const)(
		"requires operational configuration for %s products",
		async (type, blocker, productId, componentId) => {
			await seedConfiguredDeliveryProduct(db, productId, componentId, type);
			const incomplete = await checkProduct(
				{ db: { $client: db } } as never,
				productId,
			);
			expect(incomplete.blockers.map((issue) => issue.code)).toContain(blocker);

			await completeDeliveryConfiguration(db, productId, componentId, type);
			const ready = await checkProduct(
				{ db: { $client: db } } as never,
				productId,
			);
			expect(ready.blockers).toEqual([]);
			if (type === "automation") {
				await db
					.prepare(
						"DELETE FROM system_settings WHERE key = 'runtime.automation_callback_secret'",
					)
					.run();
				const missingCallback = await checkProduct(
					{ db: { $client: db } } as never,
					productId,
				);
				expect(missingCallback.blockers.map((issue) => issue.code)).toContain(
					"automation_configuration_missing",
				);
			}
		},
	);
});

const DOWNLOAD_PRODUCT_ID = "11111111-1111-4111-8111-111111111110";
const BUILD_PRODUCT_ID = "11111111-1111-4111-8111-111111111112";
const DOWNLOAD_COMPONENT_ID = "22222222-2222-4222-8222-222222222230";
const BUILD_COMPONENT_ID = "22222222-2222-4222-8222-222222222232";

async function seedConfiguredDeliveryProduct(
	db: D1Database,
	productId: string,
	componentId: string,
	type: "download" | "automation",
) {
	const now = Date.now();
	await db.batch([
		db
			.prepare(
				"INSERT INTO products (id, name, product_type, status, created_at, updated_at) VALUES (?, 'Delivery product', ?, 'draft', ?, ?)",
			)
			.bind(productId, type, now, now),
		db
			.prepare(
				`INSERT INTO product_sellable_items
					 (id, product_id, name, price_minor,
					  sort_order, enabled, created_at, updated_at)
					 VALUES (?, ?, ?, '1000', ?, 1, ?, ?)`,
			)
			.bind(componentId, productId, type, 100, now, now),
	]);
}

async function completeDeliveryConfiguration(
	db: D1Database,
	productId: string,
	componentId: string,
	type: "download" | "automation",
) {
	const now = Date.now();
	const assetId = "55555555-5555-4555-8555-555555555550";
	if (type === "download") {
		await db.batch([
			db
				.prepare(
					`INSERT INTO download_assets
					 (id, product_id, object_key, file_name, content_type, size_bytes,
					  checksum_sha256, download_enabled, created_at, updated_at)
					 VALUES (?, ?, 'downloads/file.zip', 'file.zip', 'application/zip', 10,
					  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
					  1, ?, ?)`,
				)
				.bind(assetId, productId, now, now),
			db
				.prepare(
					`INSERT INTO download_asset_sellable_items
					 (download_asset_id, sellable_item_id, sort_order) VALUES (?, ?, 100)`,
				)
				.bind(assetId, componentId),
		]);
		return;
	}
	await db.batch([
		db.prepare(
			`INSERT INTO system_settings
			 (key, value, is_secret, created_at, updated_at)
			 VALUES ('runtime.automation_callback_secret',
			  '"publish-check-build-callback-secret-1234567890"', 1, 1, 1)`,
		),
		db
			.prepare(
				`INSERT INTO product_definition_versions
				 (id, product_id, sellable_item_id, version, schema_json,
				  published_at, created_at, updated_at)
				 VALUES ('77777777-7777-4777-8777-777777777770', ?, ?, 1, '[]', ?, ?, ?)`,
			)
			.bind(productId, componentId, now, now, now),
		db
			.prepare(
				`UPDATE product_sellable_items SET automation_provider = 'github_actions',
				  automation_base_url = 'https://api.github.com',
				  automation_repository_owner = 'owner',
				  automation_repository_name = 'repository',
				  automation_default_branch = 'main',
				  automation_workflow_file = 'build.yml',
				  automation_credential_encrypted = 'encrypted-token',
				  automation_credential_key_version = 1,
				  active_definition_version_id = '77777777-7777-4777-8777-777777777770',
				  version = 1, updated_at = ? WHERE id = ?`,
			)
			.bind(now, componentId),
		db
			.prepare(
				`INSERT INTO product_automation_methods
				 (id, sellable_item_id, config_version, key, name, runtime,
				  output_pattern, enabled, created_at, updated_at)
				 VALUES ('88888888-8888-4888-8888-888888888880', ?, 1,
				  'release', 'Release', 'ubuntu-latest', 'dist/*.zip', 1, ?, ?)`,
			)
			.bind(componentId, now, now),
	]);
}
