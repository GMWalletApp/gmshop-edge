import { z } from "zod";
import {
	decryptDeliveryContent,
	encryptDeliveryContent,
} from "#/features/fulfillment/secrets";
import { constantTimeEqual, sha256Hex } from "#/lib/crypto";
import { DomainError } from "#/lib/domain-error";
import { decryptSecret } from "#/lib/secrets";
import { claimFixedWindowRateLimit } from "#/server/rate-limit";
import type { CloudflareBindings } from "#/server/runtime/cloudflare";
import { loadRuntimeConfig } from "#/server/runtime-config";
import { fingerprintInventorySecret } from "./inventory-secrets";

// Swaps a delivered owned redeem CDK for one from a same-priced sibling item,
// e.g. a customer who bought "renew" but needed "new". The caller voids the old
// code in the redeem warehouse; this only moves shop stock and delivery content.
const OWNED_CONTENT =
	/^CDK：([a-z0-9]+(?:-[a-z0-9]+)+-[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3})\n充值地址：https:\/\/redeem\.lsrai\.shop$/;

const swapSchema = z.object({
	requestRef: z
		.string()
		.trim()
		.regex(/^[A-Za-z0-9_-]{16,100}$/),
	orderNumber: z
		.string()
		.trim()
		.regex(/^GM[A-F0-9]{32}$/),
	fromComponentId: z.uuid(),
	toComponentId: z.uuid(),
	oldSecret: z.string().trim().min(1).max(100),
});

type OrderRow = {
	order_id: string;
	order_status: string;
	paid_minor: string;
	total_minor: string;
	order_item_id: string;
	sellable_item_id: string;
	delivery_component_id: string;
	quantity: number;
	delivery_id: string;
	delivery_status: string;
	delivery_content: string | null;
};

type ItemRow = {
	id: string;
	product_id: string;
	name: string;
	currency: string;
	price_minor: string;
	channel_prices: string | null;
};

export async function handleDeliverySwapRequest(
	request: Request,
	env: CloudflareBindings,
): Promise<Response> {
	try {
		const db = env.DB;
		if (!db || !env.RESTOCK_API_TOKEN)
			throw new DomainError(
				"restock_api_unavailable",
				503,
				"Restock API unavailable",
			);
		const header = request.headers.get("authorization") ?? "";
		const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
		if (!supplied || !constantTimeEqual(supplied, env.RESTOCK_API_TOKEN))
			throw new DomainError("restock_unauthorized", 401, "Invalid credentials");
		const budget = await claimFixedWindowRateLimit(db, {
			bucketKey: `restock-swap:${request.headers.get("cf-connecting-ip") ?? "unknown"}`,
			limit: 10,
			windowMs: 60_000,
			now: Date.now(),
		});
		if (!budget.allowed)
			throw new DomainError("restock_rate_limited", 429, "Rate limit exceeded");
		if (request.method !== "POST")
			return new Response(null, { status: 405, headers: { Allow: "POST" } });
		const data = swapSchema.parse(await request.json());
		return json(await swapDeliveredCode(db, request, data), 200);
	} catch (error) {
		if (error instanceof DomainError)
			return json({ ok: false, error: error.code }, error.status);
		if (error instanceof z.ZodError || error instanceof SyntaxError)
			return json({ ok: false, error: "restock_invalid" }, 400);
		return json({ ok: false, error: "restock_swap_failed" }, 500);
	}
}

async function swapDeliveredCode(
	db: D1Database,
	request: Request,
	data: z.infer<typeof swapSchema>,
) {
	if (data.fromComponentId === data.toComponentId)
		throw new DomainError("swap_same_item", 400, "Swap target must differ");
	const runtime = await loadRuntimeConfig(db);
	if (!runtime.commerceSecret)
		throw new DomainError(
			"inventory_secret_unavailable",
			503,
			"Inventory encryption secret is unavailable",
		);
	const order = await loadOrder(db, data.orderNumber);
	const oldFingerprint = await fingerprintInventorySecret(
		data.oldSecret,
		runtime.commerceSecret,
	);
	const payloadDigest = await sha256Hex(
		JSON.stringify({
			orderNumber: data.orderNumber,
			from: data.fromComponentId,
			to: data.toComponentId,
			oldFingerprint,
		}),
	);
	const receipt = await db
		.prepare(
			`SELECT payload_digest FROM replay_receipts
			 WHERE namespace='delivery_swap' AND scope_id=? AND external_id=? LIMIT 1`,
		)
		.bind(order.order_id, data.requestRef)
		.first<{ payload_digest: string }>();
	if (receipt) {
		if (receipt.payload_digest !== payloadDigest)
			throw new DomainError(
				"swap_request_conflict",
				409,
				"Request reference already belongs to another payload",
			);
		return result(db, order, data, runtime.commerceSecret, true);
	}
	if (order.sellable_item_id !== data.fromComponentId)
		throw new DomainError(
			"swap_source_mismatch",
			409,
			"Order is not for the source item",
		);
	const [from, to] = await Promise.all([
		loadItem(db, data.fromComponentId),
		loadItem(db, data.toComponentId),
	]);
	if (
		from.product_id !== to.product_id ||
		from.currency !== to.currency ||
		from.price_minor !== to.price_minor ||
		(from.channel_prices ?? "") !== (to.channel_prices ?? "")
	)
		throw new DomainError(
			"swap_price_mismatch",
			409,
			"Swap items must share product and every price",
		);
	const oldStock = await db
		.prepare(
			`SELECT id, content_mask FROM stock_entries
			 WHERE order_item_id=? AND status='delivered'`,
		)
		.bind(order.order_item_id)
		.all<{ id: string; content_mask: string }>();
	const oldEntry = oldStock.results[0];
	if (oldStock.results.length !== 1 || !oldEntry)
		throw new DomainError(
			"swap_old_stock_invalid",
			409,
			"Order must hold exactly one delivered stock entry",
		);
	const matches = await db
		.prepare(`SELECT 1 FROM stock_entries WHERE id=? AND content_fingerprint=?`)
		.bind(oldEntry.id, oldFingerprint)
		.first();
	if (!matches)
		throw new DomainError(
			"swap_old_secret_mismatch",
			409,
			"Supplied CDK is not the delivered stock",
		);
	const candidate = await db
		.prepare(
			`SELECT id, content_encrypted, content_mask, redeem_sku FROM stock_entries
			 WHERE sellable_item_id=? AND status='available'
			 AND note LIKE 'source=redeem-warehouse;%'
			 ORDER BY created_at, id LIMIT 1`,
		)
		.bind(to.id)
		.first<{
			id: string;
			content_encrypted: string;
			content_mask: string;
			redeem_sku: string | null;
		}>();
	if (!candidate)
		throw new DomainError(
			"swap_target_out_of_stock",
			409,
			"Target item has no owned CDK available",
		);
	const content = await decryptSecret(
		candidate.content_encrypted,
		runtime.commerceSecret,
		"stock-entry",
	);
	if (!OWNED_CONTENT.test(content))
		throw new DomainError(
			"swap_target_content_invalid",
			409,
			"Target stock is not an owned redeem CDK",
		);
	const encrypted = await encryptDeliveryContent(
		content,
		runtime.commerceSecret,
	);
	const now = Date.now();
	const receiptId = crypto.randomUUID();
	// One D1 batch is one transaction. Every write after the receipt is gated on
	// it, and the receipt is gated on every precondition, so a lost race writes
	// nothing.
	const gate = `EXISTS (SELECT 1 FROM replay_receipts WHERE id='${receiptId}')`;
	await db.batch([
		db
			.prepare(
				`INSERT INTO replay_receipts
				 (id,namespace,scope_id,external_id,event_type,payload_digest,status,
				  processed_at,created_at,updated_at)
				 SELECT ?,'delivery_swap',?,?,'delivery_swap',?,'processed',?,?,?
				 WHERE EXISTS (SELECT 1 FROM stock_entries WHERE id=? AND status='available')
				 AND EXISTS (SELECT 1 FROM stock_entries WHERE id=? AND status='delivered' AND order_item_id=?)
				 AND EXISTS (SELECT 1 FROM delivery_records WHERE id=? AND status='delivered')
				 AND EXISTS (SELECT 1 FROM shop_order_items WHERE id=? AND sellable_item_id=?)`,
			)
			.bind(
				receiptId,
				order.order_id,
				data.requestRef,
				payloadDigest,
				now,
				now,
				now,
				candidate.id,
				oldEntry.id,
				order.order_item_id,
				order.delivery_id,
				order.order_item_id,
				from.id,
			),
		db
			.prepare(
				`UPDATE stock_entries SET status='delivered',order_item_id=?,reserved_at=?,
				 delivered_at=?,updated_at=? WHERE id=? AND ${gate}`,
			)
			.bind(order.order_item_id, now, now, now, candidate.id),
		db
			.prepare(
				`UPDATE stock_entries SET status='disabled',order_item_id=NULL,updated_at=?,
				 note=coalesce(note,'')||'; swapped_out='||?||' request_ref='||?
				 WHERE id=? AND ${gate}`,
			)
			.bind(now, data.orderNumber, data.requestRef, oldEntry.id),
		db
			.prepare(
				`UPDATE delivery_records SET content_encrypted=?,content_key_version=1,
				 redeem_sku=?,updated_at=? WHERE id=? AND ${gate}`,
			)
			.bind(encrypted, candidate.redeem_sku, now, order.delivery_id),
		db
			.prepare(
				`UPDATE shop_order_items SET sellable_item_id=?,sellable_item_name=?,
				 delivery_component_id=CASE WHEN delivery_component_id=? THEN ? ELSE delivery_component_id END,
				 updated_at=? WHERE id=? AND ${gate}`,
			)
			.bind(to.id, to.name, from.id, to.id, now, order.order_item_id),
		db
			.prepare(
				`INSERT INTO audit_logs
				 (id,actor_user_id,action,target_type,target_id,request_id,ip_address,
				  before,after,created_at)
				 SELECT ?,NULL,'delivery.cdk_swapped','delivery',?,?,?,?,?,?
				 WHERE ${gate}`,
			)
			.bind(
				crypto.randomUUID(),
				order.delivery_id,
				data.requestRef,
				request.headers.get("cf-connecting-ip"),
				JSON.stringify({
					sellableItemId: from.id,
					stockEntryId: oldEntry.id,
					contentMask: oldEntry.content_mask,
				}),
				JSON.stringify({
					sellableItemId: to.id,
					stockEntryId: candidate.id,
					contentMask: candidate.content_mask,
				}),
				now,
			),
	]);
	const written = await db
		.prepare(`SELECT 1 FROM replay_receipts WHERE id=?`)
		.bind(receiptId)
		.first();
	if (!written)
		throw new DomainError(
			"swap_state_changed",
			409,
			"Order or stock changed during swap",
		);
	return result(
		db,
		await loadOrder(db, data.orderNumber),
		data,
		runtime.commerceSecret,
		false,
	);
}

async function loadOrder(db: D1Database, orderNumber: string) {
	const rows = await db
		.prepare(
			`SELECT o.id AS order_id, o.status AS order_status, o.paid_minor, o.total_minor,
			 i.id AS order_item_id, i.sellable_item_id, i.delivery_component_id, i.quantity,
			 d.id AS delivery_id, d.status AS delivery_status, d.content_encrypted AS delivery_content
			 FROM shop_orders o JOIN shop_order_items i ON i.order_id=o.id
			 JOIN delivery_records d ON d.order_item_id=i.id
			 WHERE o.order_number=?`,
		)
		.bind(orderNumber)
		.all<OrderRow>();
	const order = rows.results[0];
	if (rows.results.length !== 1 || !order)
		throw new DomainError(
			"swap_order_not_unique",
			409,
			"Order must contain exactly one delivery",
		);
	if (
		order.order_status !== "completed" ||
		order.delivery_status !== "delivered" ||
		order.quantity !== 1 ||
		BigInt(order.paid_minor) < BigInt(order.total_minor)
	)
		throw new DomainError(
			"swap_order_not_delivered",
			409,
			"Order is not a completed paid single delivery",
		);
	return order;
}

async function loadItem(db: D1Database, id: string) {
	const item = await db
		.prepare(
			`SELECT s.id, s.product_id, s.name, s.currency, s.price_minor,
			 (SELECT group_concat(channel_id||'='||price_minor, ',') FROM
			  (SELECT channel_id, price_minor FROM sellable_item_channel_prices
			   WHERE sellable_item_id=s.id AND enabled=1 ORDER BY channel_id)) AS channel_prices
			 FROM product_sellable_items s WHERE s.id=?`,
		)
		.bind(id)
		.first<ItemRow>();
	if (!item)
		throw new DomainError("swap_item_not_found", 404, "Item not found");
	return item;
}

async function result(
	db: D1Database,
	order: OrderRow,
	data: z.infer<typeof swapSchema>,
	commerceSecret: string,
	idempotent: boolean,
) {
	if (order.sellable_item_id !== data.toComponentId || !order.delivery_content)
		throw new DomainError(
			"swap_state_changed",
			409,
			"Order no longer matches the recorded swap",
		);
	const content = await decryptDeliveryContent(
		order.delivery_content,
		commerceSecret,
	);
	const code = OWNED_CONTENT.exec(content)?.[1];
	if (!code)
		throw new DomainError(
			"swap_target_content_invalid",
			409,
			"Delivered content is not an owned redeem CDK",
		);
	const supplier = await db
		.prepare(
			`SELECT id, downstream_order_no, downstream_parent_order_no, downstream_site_host
			 FROM supplier_api_orders WHERE shop_order_id=?`,
		)
		.bind(order.order_id)
		.first<{
			id: string;
			downstream_order_no: string;
			downstream_parent_order_no: string | null;
			downstream_site_host: string | null;
		}>();
	return {
		ok: true,
		idempotent,
		orderNumber: data.orderNumber,
		newCode: code,
		supplierOrder: supplier
			? {
					id: supplier.id,
					downstreamOrderNo: supplier.downstream_order_no,
					downstreamParentOrderNo: supplier.downstream_parent_order_no,
					downstreamSiteHost: supplier.downstream_site_host,
				}
			: null,
	};
}

function json(payload: unknown, status: number) {
	return Response.json(payload, {
		status,
		headers: { "Cache-Control": "no-store" },
	});
}
