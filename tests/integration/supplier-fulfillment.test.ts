import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { completeFreeStoreOrder } from "#/features/shop-payments/server/service";
import { signDujiaoNextRequest } from "#/features/suppliers/providers/signatures";
import { createSupplierCredentialVault } from "#/features/suppliers/secrets";
import { handleDujiaoSupplierCallback } from "#/features/suppliers/server/dujiao-callback";
import { processSupplierOrder } from "#/features/suppliers/server/process";
import {
	createInitialRuntimeConfig,
	runtimeConfigEntries,
} from "#/server/runtime-config";
import { applyMigrations } from "./migrations";

describe("supplier fulfillment", { timeout: 30_000 }, () => {
	let miniflare: Miniflare;
	let db: D1Database;
	const runtime = createInitialRuntimeConfig("https://shop.example");

	beforeEach(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: crypto.randomUUID() },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await seed(db, runtime);
	});

	afterEach(async () => miniflare.dispose());

	it("enforces the three-table account grouping and credential revision constraints", async () => {
		const tables = await db
			.prepare(
				`SELECT name FROM sqlite_master
				 WHERE type = 'table' AND name LIKE 'supplier_%' ORDER BY name`,
			)
			.all<{ name: string }>();
		expect(tables.results).toEqual([
			{ name: "supplier_accounts" },
			{ name: "supplier_api_keys" },
			{ name: "supplier_api_orders" },
			{ name: "supplier_bindings" },
			{ name: "supplier_export_listings" },
			{ name: "supplier_orders" },
		]);
		await expect(
			db
				.prepare(
					"UPDATE supplier_accounts SET credentials_revision = 0 WHERE id = 'account'",
				)
				.run(),
		).rejects.toThrow(/supplier_accounts_credentials_revision_check/);
		await expect(
			db
				.prepare(
					`INSERT INTO supplier_accounts
					 (id, provider, base_url, normalized_api_origin, protocol_version,
					  currency, currency_decimals, name, credentials_encrypted,
					  credentials_revision, credential_fingerprint, enabled,
					  health_status, created_at, updated_at)
					 SELECT 'duplicate-name', provider, base_url, normalized_api_origin,
					  protocol_version, currency, currency_decimals, name,
					  credentials_encrypted, 1, 'another-fingerprint', enabled,
					  health_status, created_at, updated_at
					 FROM supplier_accounts WHERE id = 'account'`,
				)
				.run(),
		).rejects.toThrow(/UNIQUE constraint failed/);
	});

	it("atomically creates an awaiting supplier order after payment", async () => {
		await expect(completeFreeStoreOrder(db, "order")).resolves.toMatchObject({
			status: "paid",
		});
		const state = await db
			.prepare(
				`SELECT so.state, so.quantity, so.binding_snapshot_json,
				        dr.status AS delivery_status, oe.event_type, oe.payload
				 FROM supplier_orders so
				 JOIN delivery_records dr ON dr.id = so.delivery_record_id
				 JOIN outbox_events oe ON oe.aggregate_id = so.id
				 WHERE so.order_id = 'order'`,
			)
			.first<Record<string, unknown>>();
		expect(state).toMatchObject({
			state: "pending",
			quantity: 2,
			delivery_status: "awaiting_supply",
			event_type: "supplier.requested",
		});
		expect(JSON.parse(String(state?.payload))).toEqual({
			supplierOrderId: expect.any(String),
		});
	});

	it("locks a processing account, then imports encrypted cards idempotently", async () => {
		await completeFreeStoreOrder(db, "order");
		const supplierOrder = await db
			.prepare("SELECT id FROM supplier_orders WHERE order_id = 'order'")
			.first<{ id: string }>();
		expect(supplierOrder).toBeTruthy();
		const fetcher: typeof fetch = async (input) => {
			const url = new URL(
				typeof input === "string"
					? input
					: input instanceof URL
						? input
						: input.url,
			);
			if (url.pathname === "/api/v1/upstream/ping")
				return Response.json({
					ok: true,
					site_name: "Supplier",
					balance: "100.00",
					currency: "CNY",
				});
			if (url.pathname === "/api/v1/upstream/products/1")
				return Response.json({ ok: true, product: upstreamProduct() });
			if (url.pathname === "/api/v1/upstream/categories")
				return Response.json({ ok: true, categories: [] });
			if (url.pathname === "/api/v1/upstream/orders")
				return Response.json({ ok: true, order_id: 99, status: "pending" });
			if (url.pathname === "/api/v1/upstream/orders/99")
				return Response.json({
					order_id: 99,
					status: "completed",
					fulfillment: {
						status: "delivered",
						payload: "CARD-1\nCARD-2",
					},
				});
			throw new Error(`Unexpected URL ${url}`);
		};
		await expect(
			processSupplierOrder(db, supplierOrder?.id ?? "", { fetcher }),
		).rejects.toMatchObject({ code: "supplier_order_pending" });
		const locked = await db
			.prepare(
				`SELECT state, selected_account_id, selected_credentials_revision,
				        provider_request_no, upstream_order_id, account_locked_at
				 FROM supplier_orders WHERE id = ?`,
			)
			.bind(supplierOrder?.id)
			.first();
		expect(locked).toMatchObject({
			state: "uncertain",
			selected_account_id: "account",
			selected_credentials_revision: 1,
			upstream_order_id: "99",
		});
		expect(locked?.provider_request_no).toMatch(/^gm_[a-f0-9]{40}$/);
		expect(locked?.account_locked_at).toEqual(expect.any(Number));

		await expect(
			processSupplierOrder(db, supplierOrder?.id ?? "", { fetcher }),
		).resolves.toMatchObject({ state: "supplied", duplicate: false });
		const fulfilled = await db
			.prepare(
				`SELECT so.state, dr.status AS delivery_status,
				        (SELECT COUNT(*) FROM stock_entries se
				         WHERE se.supplier_order_id = so.id AND se.status = 'reserved') AS cards,
				        (SELECT COUNT(*) FROM outbox_events oe
				         WHERE oe.idempotency_key = 'supplier-delivery-requested:' || dr.id) AS delivery_events
				 FROM supplier_orders so
				 JOIN delivery_records dr ON dr.id = so.delivery_record_id
				 WHERE so.id = ?`,
			)
			.bind(supplierOrder?.id)
			.first();
		expect(fulfilled).toMatchObject({
			state: "supplied",
			delivery_status: "pending",
			cards: 2,
			delivery_events: 1,
		});
		await expect(
			db.prepare("DELETE FROM supplier_accounts WHERE id = 'account'").run(),
		).rejects.toThrow(/FOREIGN KEY constraint failed/);
	});

	it("switches only after a definitive rejection and keeps the source fixed", async () => {
		const secondVault = await createSupplierCredentialVault(
			"dujiao_next",
			{ apiKey: "api-key-b", apiSecret: "api-secret-b" },
			runtime.commerceSecret,
		);
		await db
			.prepare(
				`INSERT INTO supplier_accounts
				 (id, provider, base_url, normalized_api_origin, protocol_version,
				  currency, currency_decimals, name, credentials_encrypted,
				  credentials_revision, credential_fingerprint, balance_minor,
				  balance_synced_at, enabled, health_status, created_at, updated_at)
				 VALUES ('account-b', 'dujiao_next', 'https://supplier.example',
				  'https://supplier.example', '1.3.1-upstream-v1', 'CNY', 2,
				  'Account B', ?, 1, 'fingerprint-b', '10000', ?, 1, 'healthy', ?, ?)`,
			)
			.bind(secondVault, Date.now(), Date.now(), Date.now())
			.run();
		await completeFreeStoreOrder(db, "order");
		const supplierOrder = await db
			.prepare("SELECT id FROM supplier_orders WHERE order_id = 'order'")
			.first<{ id: string }>();
		const submittedBy: string[] = [];
		const fetcher: typeof fetch = async (input, init) => {
			const request = new Request(input, init);
			const url = new URL(request.url);
			const apiKey = request.headers.get("Dujiao-Next-Api-Key") ?? "";
			if (url.pathname === "/api/v1/upstream/ping")
				return Response.json({
					ok: true,
					site_name: apiKey,
					balance: "100.00",
					currency: "CNY",
				});
			if (url.pathname === "/api/v1/upstream/products/1")
				return Response.json({ ok: true, product: upstreamProduct() });
			if (url.pathname === "/api/v1/upstream/categories")
				return Response.json({ ok: true, categories: [] });
			if (url.pathname === "/api/v1/upstream/orders") {
				submittedBy.push(apiKey);
				return apiKey === "api-key"
					? Response.json({
							ok: false,
							error_code: "insufficient_balance",
						})
					: Response.json({ ok: true, order_id: 199, status: "pending" });
			}
			throw new Error(`Unexpected URL ${url}`);
		};

		await expect(
			processSupplierOrder(db, supplierOrder?.id ?? "", { fetcher }),
		).rejects.toMatchObject({ code: "supplier_order_pending" });
		expect(submittedBy).toEqual(["api-key", "api-key-b"]);
		const state = await db
			.prepare(
				`SELECT selected_account_id, upstream_order_id, selection_count, state,
				 (SELECT normalized_api_origin FROM supplier_accounts
				  WHERE id = selected_account_id) AS selected_origin
				 FROM supplier_orders WHERE id = ?`,
			)
			.bind(supplierOrder?.id)
			.first();
		expect(state).toMatchObject({
			selected_account_id: "account-b",
			upstream_order_id: "199",
			selection_count: 2,
			state: "uncertain",
			selected_origin: "https://supplier.example",
		});
	});

	it("rejects duplicate or wrong-count fulfillment without storing cards", async () => {
		await completeFreeStoreOrder(db, "order");
		const supplierOrder = await db
			.prepare("SELECT id FROM supplier_orders WHERE order_id = 'order'")
			.first<{ id: string }>();
		let reconciliation = false;
		const fetcher: typeof fetch = async (input) => {
			const url = new URL(String(input));
			if (url.pathname === "/api/v1/upstream/ping")
				return Response.json({
					ok: true,
					site_name: "Supplier",
					balance: "100.00",
					currency: "CNY",
				});
			if (url.pathname === "/api/v1/upstream/products/1")
				return Response.json({ ok: true, product: upstreamProduct() });
			if (url.pathname === "/api/v1/upstream/categories")
				return Response.json({ ok: true, categories: [] });
			if (url.pathname === "/api/v1/upstream/orders")
				return Response.json({ ok: true, order_id: 299, status: "pending" });
			if (url.pathname === "/api/v1/upstream/orders/299") {
				reconciliation = true;
				return Response.json({
					order_id: 299,
					status: "completed",
					fulfillment: {
						status: "delivered",
						payload: "DUPLICATE\nDUPLICATE",
					},
				});
			}
			throw new Error(`Unexpected URL ${url}`);
		};
		await expect(
			processSupplierOrder(db, supplierOrder?.id ?? "", { fetcher }),
		).rejects.toMatchObject({ code: "supplier_order_pending" });
		await expect(
			processSupplierOrder(db, supplierOrder?.id ?? "", { fetcher }),
		).rejects.toMatchObject({ code: "supplier_delivery_quantity_mismatch" });
		expect(reconciliation).toBe(true);
		const state = await db
			.prepare(
				`SELECT state,
				 (SELECT COUNT(*) FROM stock_entries WHERE supplier_order_id = ?) AS cards
				 FROM supplier_orders WHERE id = ?`,
			)
			.bind(supplierOrder?.id, supplierOrder?.id)
			.first();
		expect(state).toMatchObject({ state: "uncertain", cards: 0 });
	});

	it("deduplicates concurrent queue consumers before upstream submission", async () => {
		await completeFreeStoreOrder(db, "order");
		const supplierOrder = await db
			.prepare("SELECT id FROM supplier_orders WHERE order_id = 'order'")
			.first<{ id: string }>();
		let submissions = 0;
		const fetcher: typeof fetch = async (input, init) => {
			const request = new Request(input, init);
			if (
				request.method === "POST" &&
				new URL(request.url).pathname === "/api/v1/upstream/orders"
			)
				submissions += 1;
			return pendingSupplierFetcher(input, init);
		};
		await Promise.allSettled([
			processSupplierOrder(db, supplierOrder?.id ?? "", { fetcher }),
			processSupplierOrder(db, supplierOrder?.id ?? "", { fetcher }),
		]);
		expect(submissions).toBe(1);
		const state = await db
			.prepare(
				`SELECT state, attempt_count, selection_count,
				 (SELECT COUNT(*) FROM supplier_orders WHERE order_id = 'order') AS orders
				 FROM supplier_orders WHERE id = ?`,
			)
			.bind(supplierOrder?.id)
			.first();
		expect(state).toMatchObject({
			state: "uncertain",
			attempt_count: 1,
			selection_count: 1,
			orders: 1,
		});
	});

	it("stores one card set under concurrent distinct fulfillment callbacks", async () => {
		await completeFreeStoreOrder(db, "order");
		const supplierOrder = await db
			.prepare("SELECT id FROM supplier_orders WHERE order_id = 'order'")
			.first<{ id: string }>();
		await expect(
			processSupplierOrder(db, supplierOrder?.id ?? "", {
				fetcher: pendingSupplierFetcher,
			}),
		).rejects.toMatchObject({ code: "supplier_order_pending" });
		const locked = await db
			.prepare("SELECT provider_request_no FROM supplier_orders WHERE id = ?")
			.bind(supplierOrder?.id)
			.first<{ provider_request_no: string }>();
		const timestamp = 1_800_000_000;
		const callback = (event: string, cards: string) => {
			const rawBody = JSON.stringify({
				event,
				order_id: 99,
				order_no: "UPSTREAM-99",
				downstream_order_no: locked?.provider_request_no,
				status: "completed",
				fulfillment: {
					type: "auto",
					status: "delivered",
					payload: cards,
				},
				timestamp,
			});
			return new Request(
				"https://shop.example/api/suppliers/dujiao-next/callback/account",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"Dujiao-Next-Api-Key": "api-key",
						"Dujiao-Next-Timestamp": String(timestamp),
						"Dujiao-Next-Signature": signDujiaoNextRequest({
							method: "POST",
							path: "/api/v1/upstream/callback",
							timestamp: String(timestamp),
							rawBody,
							apiSecret: "api-secret",
						}),
					},
					body: rawBody,
				},
			);
		};
		const responses = await Promise.all([
			handleDujiaoSupplierCallback(
				callback("order.fulfilled.primary", "PRIMARY-1\nPRIMARY-2"),
				"account",
				db,
				timestamp * 1000,
			),
			handleDujiaoSupplierCallback(
				callback("order.fulfilled.variant", "VARIANT-1\nVARIANT-2"),
				"account",
				db,
				timestamp * 1000,
			),
		]);
		for (const response of responses)
			await expect(response.json()).resolves.toMatchObject({ ok: true });
		const state = await db
			.prepare(
				`SELECT state,
				 (SELECT COUNT(*) FROM stock_entries WHERE supplier_order_id = ?) AS cards,
				 (SELECT COUNT(*) FROM outbox_events
				  WHERE idempotency_key = 'supplier-delivery-requested:' || delivery_record_id) AS events
				 FROM supplier_orders WHERE id = ?`,
			)
			.bind(supplierOrder?.id, supplierOrder?.id)
			.first<Record<string, unknown>>();
		expect(state).toMatchObject({ state: "supplied", cards: 2, events: 1 });
	});

	it("verifies and deduplicates a signed Dujiao Next fulfillment callback", async () => {
		await completeFreeStoreOrder(db, "order");
		const supplierOrder = await db
			.prepare("SELECT id FROM supplier_orders WHERE order_id = 'order'")
			.first<{ id: string }>();
		await expect(
			processSupplierOrder(db, supplierOrder?.id ?? "", {
				fetcher: pendingSupplierFetcher,
			}),
		).rejects.toMatchObject({ code: "supplier_order_pending" });
		const locked = await db
			.prepare("SELECT provider_request_no FROM supplier_orders WHERE id = ?")
			.bind(supplierOrder?.id)
			.first<{ provider_request_no: string }>();
		const timestamp = 1_800_000_000;
		const payload = {
			event: "order.fulfilled",
			order_id: 99,
			order_no: "UPSTREAM-99",
			downstream_order_no: locked?.provider_request_no,
			status: "completed",
			fulfillment: {
				type: "auto",
				status: "delivered",
				payload: "CALLBACK-1\nCALLBACK-2",
			},
			timestamp,
		};
		const rawBody = JSON.stringify(payload);
		const signature = signDujiaoNextRequest({
			method: "POST",
			path: "/api/v1/upstream/callback",
			timestamp: String(timestamp),
			rawBody,
			apiSecret: "api-secret",
		});
		const request = () =>
			new Request(
				"https://shop.example/api/suppliers/dujiao-next/callback/account",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"Dujiao-Next-Api-Key": "api-key",
						"Dujiao-Next-Timestamp": String(timestamp),
						"Dujiao-Next-Signature": signature,
					},
					body: rawBody,
				},
			);
		const first = await handleDujiaoSupplierCallback(
			request(),
			"account",
			db,
			timestamp * 1000,
		);
		const duplicate = await handleDujiaoSupplierCallback(
			request(),
			"account",
			db,
			timestamp * 1000,
		);
		await expect(first.json()).resolves.toMatchObject({ ok: true });
		await expect(duplicate.json()).resolves.toMatchObject({ ok: true });
		const invalidSignature = await handleDujiaoSupplierCallback(
			new Request(
				"https://shop.example/api/suppliers/dujiao-next/callback/account",
				{
					method: "POST",
					headers: {
						"Dujiao-Next-Api-Key": "api-key",
						"Dujiao-Next-Timestamp": String(timestamp),
						"Dujiao-Next-Signature": "0".repeat(64),
					},
					body: rawBody,
				},
			),
			"account",
			db,
			timestamp * 1000,
		);
		await expect(invalidSignature.json()).resolves.toEqual({
			ok: false,
			message: "authentication_failed",
		});
		// Only the two authenticated callbacks consumed the account budget.
		await expect(
			db
				.prepare(
					"SELECT count FROM rate_limit_counters WHERE bucket_key = 'supplier:callback:account'",
				)
				.first<{ count: number }>(),
		).resolves.toEqual({ count: 2 });
		const latePayload = { ...payload, event: "order.fulfilled.late" };
		const lateRawBody = JSON.stringify(latePayload);
		const lateSignature = signDujiaoNextRequest({
			method: "POST",
			path: "/api/v1/upstream/callback",
			timestamp: String(timestamp),
			rawBody: lateRawBody,
			apiSecret: "api-secret",
		});
		const late = await handleDujiaoSupplierCallback(
			new Request(
				"https://shop.example/api/suppliers/dujiao-next/callback/account",
				{
					method: "POST",
					headers: {
						"Dujiao-Next-Api-Key": "api-key",
						"Dujiao-Next-Timestamp": String(timestamp),
						"Dujiao-Next-Signature": lateSignature,
					},
					body: lateRawBody,
				},
			),
			"account",
			db,
			timestamp * 1000,
		);
		await expect(late.json()).resolves.toMatchObject({ ok: true });
		const state = await db
			.prepare(
				`SELECT so.state,
				        (SELECT COUNT(*) FROM stock_entries se
				         WHERE se.supplier_order_id = so.id) AS cards,
				        (SELECT COUNT(*) FROM replay_receipts rr
				         WHERE rr.namespace = 'supplier_callback') AS callbacks
				 FROM supplier_orders so WHERE so.id = ?`,
			)
			.bind(supplierOrder?.id)
			.first();
		expect(state).toMatchObject({
			state: "supplied",
			cards: 2,
			callbacks: 2,
		});
	});

	it("rejects an oversized chunked supplier callback with 413", async () => {
		const request = new Request(
			"https://shop.example/api/suppliers/dujiao-next/callback/account",
			{
				method: "POST",
				body: new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new Uint8Array(700_000));
						controller.enqueue(new Uint8Array(700_000));
						controller.close();
					},
				}),
				duplex: "half",
			} as RequestInit & { duplex: "half" },
		);
		const response = await handleDujiaoSupplierCallback(
			request,
			"account",
			db,
			1_800_000_000_000,
		);
		expect(response.status).toBe(413);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			message: "body_too_large",
		});
	});
});

async function seed(
	db: D1Database,
	runtime: ReturnType<typeof createInitialRuntimeConfig>,
) {
	const now = 1_800_000_000_000;
	const encrypted = await createSupplierCredentialVault(
		"dujiao_next",
		{ apiKey: "api-key", apiSecret: "api-secret" },
		runtime.commerceSecret,
	);
	const settings = runtimeConfigEntries(runtime).map((entry) =>
		db
			.prepare(
				`INSERT INTO system_settings
				 (key, value, is_secret, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?)`,
			)
			.bind(entry.key, JSON.stringify(entry.value), entry.isSecret, now, now),
	);
	await db.batch([
		...settings,
		db
			.prepare(
				`INSERT INTO products
			 (id, name, product_type, status, created_at, updated_at)
			 VALUES ('product', 'Product', 'stock', 'active', ?, ?)`,
			)
			.bind(now, now),
		db
			.prepare(
				`INSERT INTO product_sellable_items
			 (id, product_id, name, fulfillment_source, supplier_status,
			  currency, currency_decimals, price_minor, created_at, updated_at)
			 VALUES ('item', 'product', 'SKU', 'supplier', 'available',
			  'USD', 2, '0', ?, ?)`,
			)
			.bind(now, now),
		db
			.prepare(
				`INSERT INTO supplier_accounts
			 (id, provider, base_url, normalized_api_origin, protocol_version,
			  currency, currency_decimals, name, credentials_encrypted,
			  credentials_revision, credential_fingerprint, balance_minor,
			  balance_synced_at, enabled, health_status, created_at, updated_at)
			 VALUES ('account', 'dujiao_next', 'https://supplier.example',
			  'https://supplier.example', '1.3.1-upstream-v1', 'CNY', 2,
			  'Account', ?, 1, 'fingerprint', '10000', ?, 1, 'healthy', ?, ?)`,
			)
			.bind(encrypted, now, now, now),
		db
			.prepare(
				`INSERT INTO supplier_bindings
			 (id, sellable_item_id, provider, normalized_api_origin,
			  protocol_version, upstream_product_id, upstream_sku_id,
			  upstream_product_name, upstream_sku_name, reference_cost_minor,
			  max_cost_minor, stock_quantity, remote_status, last_synced_at,
			  enabled, created_at, updated_at)
			 VALUES ('binding', 'item', 'dujiao_next', 'https://supplier.example',
			  '1.3.1-upstream-v1', '1', '2', 'Product', 'SKU', '100', '150',
			  10, 'active', ?, 1, ?, ?)`,
			)
			.bind(now, now, now),
		db
			.prepare(
				`INSERT INTO shop_orders
			 (id, order_number, status, currency, currency_decimals,
			  subtotal_minor, discount_minor, total_minor, paid_minor,
			  expires_at, created_at, updated_at)
			 VALUES ('order', 'ORDER-1', 'pending_payment', 'USD', 2,
			  '0', '0', '0', '0', ?, ?, ?)`,
			)
			.bind(now + 60_000, now, now),
		db
			.prepare(
				`INSERT INTO shop_order_items
			 (id, order_id, product_id, sellable_item_id, product_name,
			  delivery_component_id, delivery_component_type,
			  delivery_component_version, sellable_item_name, quantity,
			  unit_price_minor, discount_minor, subtotal_minor, created_at, updated_at)
			 VALUES ('order-item', 'order', 'product', 'item', 'Product',
			  'item', 'stock', 1, 'SKU', 2, '0', '0', '0', ?, ?)`,
			)
			.bind(now, now),
	]);
}

function upstreamProduct() {
	return {
		id: 1,
		title: { "zh-CN": "商品" },
		description: {},
		images: [],
		tags: [],
		currency: "CNY",
		is_active: true,
		skus: [
			{
				id: 2,
				sku_code: "SKU",
				spec_values: {},
				price_amount: "1.00",
				stock_quantity: 10,
				is_active: true,
			},
		],
	};
}

const pendingSupplierFetcher: typeof fetch = async (input) => {
	const url = new URL(
		typeof input === "string"
			? input
			: input instanceof URL
				? input
				: input.url,
	);
	if (url.pathname === "/api/v1/upstream/ping")
		return Response.json({
			ok: true,
			site_name: "Supplier",
			balance: "100.00",
			currency: "CNY",
		});
	if (url.pathname === "/api/v1/upstream/products/1")
		return Response.json({ ok: true, product: upstreamProduct() });
	if (url.pathname === "/api/v1/upstream/categories")
		return Response.json({ ok: true, categories: [] });
	if (url.pathname === "/api/v1/upstream/orders")
		return Response.json({ ok: true, order_id: 99, status: "pending" });
	throw new Error(`Unexpected URL ${url}`);
};
