import { createWalletTopupPayment } from "#/features/shop-payments/server/service";
import { walletTopupSchema } from "#/features/wallet/schema";
import {
	BodyLimitExceededError,
	readBoundedRequestText,
} from "#/lib/bounded-stream";
import { DomainError } from "#/lib/domain-error";
import { authenticateSupplierApi } from "./auth";
import { getSupplierProduct, listSupplierCatalog } from "./catalog";
import {
	cancelSupplierApiOrder,
	createSupplierApiOrder,
	getSupplierApiOrder,
} from "./orders";

export async function handleSupplierApiRequest(
	request: Request,
	db: D1Database | undefined,
) {
	try {
		if (!db)
			throw new DomainError("service_unavailable", 503, "Database unavailable");
		const rawBody = request.method === "POST" ? await readBody(request) : "";
		const identity = await authenticateSupplierApi(request, db, rawBody);
		const url = new URL(request.url);
		const path = url.pathname.replace(/^\/api\/v1\/supplier\/?/, "");

		if (request.method === "POST" && path === "ping")
			return supplierPing(db, identity.userId);
		if (request.method === "GET" && path === "products") {
			const page = positiveInt(url.searchParams.get("page"), 1);
			const pageSize = Math.min(
				100,
				positiveInt(url.searchParams.get("page_size"), 50),
			);
			return Response.json(
				await listSupplierCatalog(db, {
					page,
					pageSize,
					updatedAfter: url.searchParams.get("updated_after") ?? undefined,
				}),
			);
		}
		if (request.method === "GET" && path === "categories")
			return supplierCategories(db);
		if (request.method === "GET" && path === "payment-channels")
			return supplierPaymentChannels(db);
		if (request.method === "POST" && path === "topups")
			return createSupplierTopup(db, identity.userId, rawBody, url.origin);

		const topupMatch = /^topups\/([^/]+)$/.exec(path);
		if (request.method === "GET" && topupMatch?.[1])
			return getSupplierTopup(db, identity.userId, topupMatch[1]);
		const productMatch = /^products\/([^/]+)$/.exec(path);
		if (request.method === "GET" && productMatch?.[1])
			return Response.json(
				await getSupplierProduct(db, decodeURIComponent(productMatch[1])),
			);
		if (request.method === "POST" && path === "orders")
			return createSupplierOrder(db, identity, rawBody);
		const orderMatch = /^orders\/([^/]+)$/.exec(path);
		if (request.method === "GET" && orderMatch?.[1])
			return Response.json(
				await getSupplierApiOrder(
					db,
					identity.userId,
					decodeURIComponent(orderMatch[1]),
				),
			);
		const cancelMatch = /^orders\/([^/]+)\/cancel$/.exec(path);
		if (request.method === "POST" && cancelMatch?.[1])
			return Response.json(
				await cancelSupplierApiOrder(
					db,
					identity.userId,
					decodeURIComponent(cancelMatch[1]),
				),
			);
		throw new DomainError(
			"supplier_endpoint_not_found",
			404,
			"Endpoint not found",
		);
	} catch (error) {
		if (error instanceof DomainError)
			return Response.json(
				{ ok: false, error_code: error.code },
				{ status: error.status },
			);
		return Response.json(
			{ ok: false, error_code: "invalid_request" },
			{ status: 400 },
		);
	}
}

async function supplierPing(db: D1Database, userId: string) {
	const [user, settings] = await Promise.all([
		db
			.prepare("SELECT balance_minor FROM users WHERE id = ?")
			.bind(userId)
			.first<{ balance_minor: string }>(),
		db
			.prepare(
				"SELECT key, value FROM system_settings WHERE key IN ('site.name', 'commerce.default_currency')",
			)
			.all<{ key: string; value: string }>(),
	]);
	const values = new Map(
		settings.results.map((row) => [row.key, JSON.parse(row.value)]),
	);
	return Response.json({
		ok: true,
		site_name: String(values.get("site.name") ?? "GMShop Edge"),
		balance_minor: user?.balance_minor ?? "0",
		currency: String(values.get("commerce.default_currency") ?? "USD"),
	});
}

async function supplierCategories(db: D1Database) {
	const rows = await db
		.prepare(
			`SELECT DISTINCT value AS name
			 FROM product_sellable_items item
			 JOIN products product ON product.id = item.product_id,
			 supplier_export_listings listing,
			 json_each(product.tag_names)
			 WHERE product.status = 'active' AND product.product_type = 'stock'
			  AND item.enabled = 1 AND item.fulfillment_source = 'local'
			  AND listing.sellable_item_id = item.id AND listing.enabled = 1
			 ORDER BY name`,
		)
		.all<{ name: string }>();
	return Response.json({
		items: rows.results.map((row, index) => ({
			id: String(index + 1),
			name: row.name,
		})),
	});
}

async function supplierPaymentChannels(db: D1Database) {
	const channels = await db
		.prepare(
			"SELECT id, name, provider, currency FROM payment_channels WHERE enabled = 1 ORDER BY sort_order, name, id",
		)
		.all();
	return Response.json({ items: channels.results });
}

async function createSupplierTopup(
	db: D1Database,
	userId: string,
	rawBody: string,
	origin: string,
) {
	const body = JSON.parse(rawBody) as Record<string, unknown>;
	const topup = walletTopupSchema.parse({
		amountMinor: body.amount_minor,
		channelId: body.channel_id,
		idempotencyKey: body.request_no,
		paymentCurrency: body.payment_currency,
	});
	return Response.json(
		await createWalletTopupPayment(db, {
			userId,
			amountMinor: topup.amountMinor,
			channelId: topup.channelId,
			idempotencyKey: `supplier-topup:${userId}:${topup.idempotencyKey}`,
			paymentCurrency: topup.paymentCurrency,
			successUrl: new URL("/account", origin).toString(),
			cancelUrl: new URL("/account", origin).toString(),
		}),
	);
}

async function getSupplierTopup(
	db: D1Database,
	userId: string,
	encodedId: string,
) {
	const topup = await db
		.prepare(
			"SELECT id, amount_minor, currency, status, paid_at, refunded_at, created_at FROM wallet_topups WHERE id = ? AND user_id = ? LIMIT 1",
		)
		.bind(decodeURIComponent(encodedId), userId)
		.first();
	if (!topup) throw new DomainError("topup_not_found", 404, "Top-up not found");
	return Response.json(topup);
}

async function createSupplierOrder(
	db: D1Database,
	identity: Awaited<ReturnType<typeof authenticateSupplierApi>>,
	rawBody: string,
) {
	const body = JSON.parse(rawBody) as Record<string, unknown>;
	return Response.json(
		await createSupplierApiOrder(
			db,
			identity,
			{
				skuId: String(body.sku_id ?? ""),
				quantity: Number(body.quantity),
				downstreamOrderNo: String(body.downstream_order_no ?? ""),
				callbackUrl: body.callback_url ? String(body.callback_url) : null,
				traceId: body.trace_id ? String(body.trace_id) : undefined,
			},
			{
				// Display only and outside the request digest, so retries stay idempotent.
				siteHost:
					typeof body.downstream_site_host === "string" &&
					/^[a-z0-9.-]{1,253}$/i.test(body.downstream_site_host)
						? body.downstream_site_host.toLowerCase()
						: null,
			},
		),
	);
}

async function readBody(request: Request) {
	try {
		return await readBoundedRequestText(request, 64_000);
	} catch (error) {
		if (!(error instanceof BodyLimitExceededError)) throw error;
		throw new DomainError("body_too_large", 413, "Body too large");
	}
}

function positiveInt(value: string | null, fallback: number) {
	const parsed = Number(value ?? fallback);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
