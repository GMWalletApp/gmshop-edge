import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#/lib/crypto", () => ({
	constantTimeEqual: (left: string, right: string) => left === right,
	sha256Hex: async (value: string) => `digest:${value}`,
}));

vi.mock("#/features/catalog/server/inventory-secrets", async (original) => {
	const actual =
		await original<
			typeof import("#/features/catalog/server/inventory-secrets")
		>();
	return {
		...actual,
		fingerprintInventorySecret: async (value: string) => `fingerprint:${value}`,
	};
});

vi.mock("#/lib/secrets", () => ({
	encryptSecret: async (value: string, _key: string, purpose: string) =>
		JSON.stringify({ purpose, value }),
	decryptSecret: async (value: string) =>
		(JSON.parse(value) as { value: string }).value,
}));

vi.mock("#/features/fulfillment/secrets", () => ({
	encryptDeliveryContent: async (value: string) => JSON.stringify({ value }),
	decryptDeliveryContent: async (value: string) =>
		(JSON.parse(value) as { value: string }).value,
}));

import { fingerprintInventorySecret } from "#/features/catalog/server/inventory-secrets";
import {
	handleDeliveryReconcileRequest,
	handleRestockApiRequest,
} from "#/features/catalog/server/restock-api";
import { decryptDeliveryContent } from "#/features/fulfillment/secrets";
import { decryptSecret } from "#/lib/secrets";
import { applyMigrations } from "./migrations";

const token = "test-restock-token-that-is-long-enough";
const componentId = "00000000-0000-4000-8000-000000000002";
const requestRef = "RESTOCK-TEST-0001";
const keyring = "0123456789abcdef0123456789abcdef";

describe("restock API", () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeEach(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: crypto.randomUUID() },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await seed(db);
	});

	afterEach(async () => miniflare.dispose());

	it("rejects missing credentials without inspecting inventory", async () => {
		const response = await handleRestockApiRequest(
			new Request("https://shop.example/api/ops/restock", {
				method: "POST",
				body: JSON.stringify(payload()),
				headers: { "content-type": "application/json" },
			}),
			{ DB: db, RESTOCK_API_TOKEN: token },
		);
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({
			ok: false,
			error: "restock_unauthorized",
		});
	});

	it("rate limits wrong tokens per IP before any valid request is served", async () => {
		const attempt = (authorization: string) =>
			handleRestockApiRequest(
				new Request(
					`https://shop.example/api/ops/restock?componentId=${componentId}`,
					{
						headers: {
							authorization,
							"cf-connecting-ip": "198.51.100.80",
						},
					},
				),
				{ DB: db, RESTOCK_API_TOKEN: token },
			);
		for (let index = 0; index < 10; index++)
			expect((await attempt(`Bearer wrong-${index}`)).status).toBe(401);
		const limited = await attempt("Bearer wrong-final");
		expect(limited.status).toBe(429);
		expect(await limited.json()).toEqual({
			ok: false,
			error: "restock_rate_limited",
		});
		expect((await attempt(`Bearer ${token}`)).status).toBe(200);
	});

	it("imports one supplier-backed CDK with its recharge URL and is idempotent", async () => {
		const first = await request("POST", payload());
		expect(first.status).toBe(200);
		expect(await first.json()).toMatchObject({
			ok: true,
			idempotent: false,
			imported: 1,
			duplicates: 0,
			counts: { available: 1 },
		});

		const row = await db
			.prepare(
				`SELECT content_encrypted, content_mask, note, procurement_source,
				 procurement_request_ref, unit_cost_minor FROM stock_entries
				 WHERE sellable_item_id = ?`,
			)
			.bind(componentId)
			.first<{
				content_encrypted: string;
				content_mask: string;
				note: string;
				procurement_source: string;
				procurement_request_ref: string;
				unit_cost_minor: string;
			}>();
		expect(row?.content_mask).toBe("••••••••-001");
		expect(row?.note).toContain("source=86");
		expect(row).toMatchObject({
			procurement_source: "86",
			procurement_request_ref: requestRef,
			unit_cost_minor: "12500",
		});
		expect(
			await decryptDeliveryContent(row?.content_encrypted ?? "", keyring),
		).toBe("CDK：TEST-RESTOCK-001\n充值地址：https://redeem.example/");

		const second = await request("POST", payload());
		expect(await second.json()).toMatchObject({
			ok: true,
			idempotent: true,
			imported: 0,
			counts: { available: 1 },
		});
		expect(
			await db
				.prepare("SELECT COUNT(*) AS total FROM stock_entries")
				.first<{ total: number }>(),
		).toEqual({ total: 1 });
	});

	it("uses persisted request rows when D1 batch metadata reports zero changes", async () => {
		const maskedChangesDb = {
			prepare: db.prepare.bind(db),
			batch: async (statements: D1PreparedStatement[]) =>
				(await db.batch(statements)).map((result) => ({
					...result,
					meta: { ...result.meta, changes: 0 },
				})),
			exec: db.exec.bind(db),
			dump: db.dump.bind(db),
		} as D1Database;
		const response = await handleRestockApiRequest(
			new Request("https://shop.example/api/ops/restock", {
				method: "POST",
				body: JSON.stringify(payload()),
				headers: {
					Authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
			}),
			{ DB: maskedChangesDb, RESTOCK_API_TOKEN: token },
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			idempotent: false,
			imported: 1,
			duplicates: 0,
			counts: { available: 1 },
		});
	});

	it("rejects a missing recharge URL and conflicting request reference", async () => {
		const missing = await request("POST", {
			...payload(),
			requestRef: "RESTOCK-TEST-0002",
			usageUrl: "",
		});
		expect(missing.status).toBe(400);
		expect(await missing.json()).toEqual({
			ok: false,
			error: "inventory_usage_url_required",
		});

		await request("POST", payload());
		const duplicate = await request("POST", {
			...payload(),
			requestRef: "RESTOCK-TEST-0003",
		});
		expect(duplicate.status).toBe(409);
		expect(await duplicate.json()).toEqual({
			ok: false,
			error: "restock_duplicate_inventory",
		});

		const conflict = await request("POST", {
			...payload(),
			secrets: ["TEST-RESTOCK-OTHER"],
		});
		expect(conflict.status).toBe(409);
		expect(await conflict.json()).toEqual({
			ok: false,
			error: "restock_request_conflict",
		});
	});

	it("returns only aggregate stock counts", async () => {
		await request("POST", payload());
		const response = await request("GET");
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({
			ok: true,
			component: {
				id: componentId,
				productName: "Product",
				itemName: "Pro 20X iOS",
				supplierBound: true,
			},
			counts: { available: 1, reserved: 0, delivered: 0, disabled: 0 },
		});
		expect(JSON.stringify(body)).not.toContain("TEST-RESTOCK-001");
	});

	it("synchronizes an already delivered order to owned inventory without exposing the CDK", async () => {
		const fingerprint = await fingerprintInventorySecret(
			"OWNED-CARD-001",
			keyring,
		);
		await db.batch([
			db.prepare(
				`INSERT INTO shop_orders
				 (id,order_number,status,currency,currency_decimals,subtotal_minor,
				  discount_minor,total_minor,paid_minor,expires_at,paid_at,completed_at,
				  created_at,updated_at)
				 VALUES ('order','GM11111111111111111111111111111111','completed','CNY',2,
				  '100','0','100','100',999999,2,3,1,3)`,
			),
			db
				.prepare(
					`INSERT INTO shop_order_items
				 (id,order_id,product_id,sellable_item_id,product_name,
				  delivery_component_id,delivery_component_type,
				  delivery_component_version,sellable_item_name,quantity,
				  unit_price_minor,discount_minor,subtotal_minor,created_at,updated_at)
				 VALUES ('order-item','order','00000000-0000-4000-8000-000000000001',?,
				  'Product',?,'stock',1,'Pro 20X iOS',1,'100','0','100',1,1)`,
				)
				.bind(componentId, componentId),
			db.prepare(
				`INSERT INTO delivery_records
				 (id,order_item_id,delivery_type,status,content_encrypted,
				  content_key_version,attempt_count,delivered_at,created_at,updated_at)
				 VALUES ('delivery','order-item','stock','delivered','old-content',1,0,3,1,3)`,
			),
			db
				.prepare(
					`INSERT INTO stock_entries
					 (id,sellable_item_id,content_encrypted,key_version,content_fingerprint,
					  content_mask,status,created_at,updated_at)
					 VALUES ('owned',?,'owned-content',1,?,'••••••••-001','available',1,1)`,
				)
				.bind(componentId, fingerprint),
		]);
		const payload = {
			requestRef: "DELIVERY-SYNC-TEST-0001",
			orderNumber: "GM11111111111111111111111111111111",
			secret: "OWNED-CARD-001",
			usageUrl: "https://redeem.example/",
			source: "manual-owner-delivery",
		};
		const response = await reconcileRequest(payload);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({
			ok: true,
			idempotent: false,
			orderNumber: payload.orderNumber,
			contentMask: "••••••••-001",
		});
		expect(JSON.stringify(body)).not.toContain(payload.secret);
		const row = await db
			.prepare(
				`SELECT stock.status,stock.order_item_id,delivery.content_encrypted
				 FROM stock_entries stock JOIN delivery_records delivery ON delivery.id='delivery'
				 WHERE stock.id='owned'`,
			)
			.first<{
				status: string;
				order_item_id: string;
				content_encrypted: string;
			}>();
		expect(row).toMatchObject({
			status: "delivered",
			order_item_id: "order-item",
		});
		expect(
			await decryptSecret(row?.content_encrypted ?? "", keyring, "stock-entry"),
		).toBe("CDK：OWNED-CARD-001\n充值地址：https://redeem.example/");
		const duplicate = await reconcileRequest(payload);
		expect(await duplicate.json()).toMatchObject({
			ok: true,
			idempotent: true,
		});
	});

	function request(method: "GET" | "POST", body?: unknown) {
		const url = new URL("https://shop.example/api/ops/restock");
		if (method === "GET") url.searchParams.set("componentId", componentId);
		return handleRestockApiRequest(
			new Request(url, {
				method,
				body: body === undefined ? undefined : JSON.stringify(body),
				headers: {
					Authorization: `Bearer ${token}`,
					...(body === undefined ? {} : { "content-type": "application/json" }),
				},
			}),
			{ DB: db, RESTOCK_API_TOKEN: token },
		);
	}

	function reconcileRequest(body: unknown) {
		return handleDeliveryReconcileRequest(
			new Request("https://shop.example/api/ops/restock/reconcile", {
				method: "POST",
				body: JSON.stringify(body),
				headers: {
					Authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
			}),
			{ DB: db, RESTOCK_API_TOKEN: token },
		);
	}
});

function payload() {
	return {
		requestRef,
		componentId,
		secrets: ["TEST-RESTOCK-001"],
		usageUrl: "https://redeem.example/",
		note: "test",
		source: "86",
		unitCostMinor: "12500",
	};
}

async function seed(db: D1Database) {
	await db.batch([
		db
			.prepare(
				`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
				 VALUES ('runtime.data_encryption_secret', ?, 1, 1, 1)`,
			)
			.bind(JSON.stringify(keyring)),
		db.prepare(
			`INSERT INTO products (id, name, product_type, status, created_at, updated_at)
			 VALUES ('00000000-0000-4000-8000-000000000001', 'Product', 'stock', 'active', 1, 1)`,
		),
		db
			.prepare(
				`INSERT INTO product_sellable_items
			 (id, product_id, name, fulfillment_source, supplier_status, currency,
			  currency_decimals, price_minor, enabled, created_at, updated_at)
			 VALUES (?, '00000000-0000-4000-8000-000000000001', 'Pro 20X iOS',
			  'supplier', 'available', 'CNY', 2, '120000', 1, 1, 1)`,
			)
			.bind(componentId),
		db.prepare(
			`INSERT INTO supplier_accounts
			 (id, provider, base_url, normalized_api_origin, protocol_version, currency,
			  currency_decimals, name, credentials_encrypted, credentials_revision,
			  credential_fingerprint, health_status, enabled, created_at, updated_at)
			 VALUES ('account', 'shared_stock', 'https://supplier.example',
			  'https://supplier.example', '1', 'CNY', 2, 'Supplier', 'encrypted', 1,
			  'fingerprint', 'healthy', 1, 1, 1)`,
		),
		db
			.prepare(
				`INSERT INTO supplier_bindings
			 (id, sellable_item_id, provider, normalized_api_origin, protocol_version,
			  upstream_product_id, upstream_sku_id, upstream_product_name,
			  upstream_sku_name, reference_cost_minor, max_cost_minor, stock_quantity,
			  remote_status, enabled, created_at, updated_at)
			 VALUES ('binding', ?, 'shared_stock', 'https://supplier.example', '1',
			  'remote-product', 'remote-sku', 'Remote Product', 'Remote SKU', '100000',
			  '130000', 0, 'active', 1, 1, 1)`,
			)
			.bind(componentId),
	]);
}
