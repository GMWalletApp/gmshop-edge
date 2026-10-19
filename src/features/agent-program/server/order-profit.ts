import { z } from "zod";
import { itemCostSql } from "#/features/ops-automation/server/item-cost";
import {
	parseCostFactors,
	realCostMinor,
} from "#/features/ops-automation/server/pricing-guard";
import { loadSettings } from "#/features/ops-automation/server/shared";
import {
	BodyLimitExceededError,
	readBoundedRequestText,
} from "#/lib/bounded-stream";
import { constantTimeEqual, sha256Hex } from "#/lib/crypto";
import type { RuntimeEnv } from "#/server/runtime/types";

const inputSchema = z.object({
	downstream_order_nos: z
		.array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/))
		.max(500),
});
type Item = {
	downstream_order_no: string;
	supplier_api_order_id: string;
	shop_order_id: string;
	paid_minor: string;
	currency: string;
	currency_decimals: number;
	item_id: string | null;
	cost_minor: number | null;
	quantity: number | null;
	sources: string | null;
	supplier_origin: string | null;
};
function json(value: unknown, status = 200) {
	return Response.json(value, {
		status,
		headers: { "Cache-Control": "no-store" },
	});
}

export async function handleOrderProfitRequest(
	request: Request,
	env: Pick<RuntimeEnv, "DB" | "AGENT_PROGRAM_PROFIT_TOKEN">,
) {
	const started = performance.now();
	try {
		const token = env.AGENT_PROGRAM_PROFIT_TOKEN?.trim();
		const header = request.headers.get("authorization") ?? "";
		const match = /^Bearer (.+)$/i.exec(header);
		if (
			!token ||
			!match ||
			!constantTimeEqual(
				await sha256Hex(match[1] ?? ""),
				await sha256Hex(token),
			)
		)
			return json({ ok: false, error: "unauthorized" }, 401);
		if (request.method !== "POST")
			return json({ ok: false, error: "method_not_allowed" }, 405);
		if (!env.DB) return json({ ok: false, error: "unavailable" }, 503);
		try {
			const { downstream_order_nos } = inputSchema.parse(
				JSON.parse(await readBoundedRequestText(request, 40000)),
			);
			const db = env.DB as D1Database;
			const factors = parseCostFactors(
				(await loadSettings(db, ["pricing.cost_factors"])).get(
					"pricing.cost_factors",
				),
			);
			const highest = (["86", "xiaojiu", "aisou"] as const).reduce((a, b) =>
				factors[a] > factors[b] ? a : b,
			);
			const rows: Item[] = [];
			const nos = [...new Set(downstream_order_nos)];
			// D1's bound parameter budget is smaller than the public batch limit.
			for (let i = 0; i < nos.length; i += 90) {
				const batch = nos.slice(i, i + 90);
				const result = await db
					.prepare(`SELECT api.downstream_order_no, api.id AS supplier_api_order_id, api.shop_order_id, o.paid_minor, o.currency, o.currency_decimals,
    item.id AS item_id, ${itemCostSql("item")} AS cost_minor, item.quantity,
    (SELECT GROUP_CONCAT(COALESCE(stock.procurement_source,
       CASE WHEN json_extract(stock_supplier.binding_snapshot_json,'$.normalizedApiOrigin')='https://aisou.pro'
       THEN 'aisou' ELSE 'unknown' END)) FROM stock_entries stock
     LEFT JOIN supplier_orders stock_supplier ON stock_supplier.id=stock.supplier_order_id AND stock_supplier.state='supplied'
     WHERE stock.order_item_id=item.id AND stock.status IN ('reserved','delivered')) AS sources,
    (SELECT json_extract(supplied.binding_snapshot_json,'$.normalizedApiOrigin') FROM supplier_orders supplied
     WHERE supplied.order_item_id=item.id AND supplied.state='supplied' ORDER BY supplied.updated_at DESC, supplied.id DESC LIMIT 1) AS supplier_origin
    FROM supplier_api_orders api JOIN shop_orders o ON o.id=api.shop_order_id
    LEFT JOIN shop_order_items item ON item.order_id=o.id
    WHERE api.downstream_order_no IN (${batch.map(() => "?").join(",")})`)
					.bind(...batch)
					.all<Item>();
				rows.push(...result.results);
			}
			const byNumber = new Map<string, Item[]>();
			for (const row of rows) {
				const group = byNumber.get(row.downstream_order_no) ?? [];
				group.push(row);
				byNumber.set(row.downstream_order_no, group);
			}
			const orders = nos.map((no) => {
				const items = byNumber.get(no) ?? [];
				const ids = new Set(items.map((row) => row.supplier_api_order_id));
				const first = items[0];
				// Duplicate downstream numbers across supplier accounts are ambiguous, never summed.
				let known =
					ids.size === 1 &&
					!!first &&
					first.currency === "CNY" &&
					first.currency_decimals === 2;
				let cost = 0n;
				for (const item of items) {
					if (
						!item.item_id ||
						item.cost_minor === null ||
						!Number.isSafeInteger(item.cost_minor) ||
						item.cost_minor <= 0 ||
						!item.quantity ||
						item.quantity < 1
					) {
						known = false;
						continue;
					}
					const sources = item.sources?.split(",") ?? [];
					if (sources.length === 0 && item.supplier_origin !== null)
						sources.push(
							item.supplier_origin === "https://aisou.pro"
								? "aisou"
								: "unknown",
						);
					if (sources.length === 0) sources.push("unknown");
					const source = sources
						.map((source) =>
							source === "86" || source === "xiaojiu" || source === "aisou"
								? source
								: highest,
						)
						.reduce((a, b) => (factors[a] > factors[b] ? a : b));
					// Reuse accounting's fulfillment-cost precedence and pricing's rounding.
					// The rebate guard always uses the approved 1.01 buffer.
					const trueCost = realCostMinor(item.cost_minor, source, {
						...factors,
						buffer: 1_010_000n,
					});
					if (!Number.isSafeInteger(trueCost)) {
						known = false;
						continue;
					}
					cost += BigInt(trueCost);
				}
				const revenue = ids.size === 1 && first ? BigInt(first.paid_minor) : 0n;
				return {
					downstream_order_no: no,
					supplier_api_order_id:
						ids.size === 1 ? first?.supplier_api_order_id : null,
					shop_order_id: ids.size === 1 ? first?.shop_order_id : null,
					revenue_minor: revenue.toString(),
					true_cost_minor: cost.toString(),
					profit_minor: known ? (revenue - cost).toString() : "0",
					cost_known: known,
				};
			});
			return json({ ok: true, orders });
		} catch (error) {
			if (error instanceof BodyLimitExceededError)
				return json({ ok: false, error: "body_too_large" }, 413);
			if (error instanceof z.ZodError || error instanceof SyntaxError)
				return json({ ok: false, error: "invalid_input" }, 400);
			return json({ ok: false, error: "profit_unavailable" }, 500);
		}
	} finally {
		console.info(
			JSON.stringify({
				event: "agent_program_internal_request",
				endpoint: "/api/internal/agent-program/order-profit",
				duration_ms: Math.round(performance.now() - started),
			}),
		);
	}
}
