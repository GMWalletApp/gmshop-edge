import { z } from "zod";
import { sha256Hex } from "#/lib/crypto";
import { DomainError } from "#/lib/domain-error";
import { decryptSecret } from "#/lib/secrets";
import { loadRuntimeConfig } from "#/server/runtime-config";
import {
	loadDeliveryWarehouseToken,
	requestWarehouse,
} from "./warehouse-client";

// Upstream capacity is operational telemetry, never a gate for issuing owned codes.
const capacitySchema = z.object({
	success: z.literal(true),
	data: z.object({
		available: z.number().int().nonnegative(),
		outstanding: z.number().int().nonnegative(),
		sellable: z.number().int().nonnegative(),
	}),
});
// Codes issued before the iOS Pro SKUs were renamed keep their original prefix.
const LEGACY_CODE_PREFIXES: Record<string, string[]> = {
	GPT_100_IOS: ["gpt-5x-ios"],
	GPT_200_IOS: ["gpt-20x-ios"],
};

export function ownedCodePattern(sku: string) {
	const prefixes = [
		sku.toLowerCase().replaceAll("_", "-"),
		...(LEGACY_CODE_PREFIXES[sku] ?? []),
	];
	return new RegExp(
		`(?:${prefixes.join("|")})-[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}`,
		"gi",
	);
}

// Tells the warehouse which owned codes were just sold so it can buy their upstream keys before
// the customer redeems. Best effort: delivery never waits on it or fails because of it.
export async function notifyWarehouseSale(
	db: D1Database,
	orderItemId: string,
	plaintext: string,
	commerceSecret: string,
	requester: typeof requestWarehouse = requestWarehouse,
) {
	try {
		const item = await db
			.prepare("SELECT sellable_item_id FROM shop_order_items WHERE id=?")
			.bind(orderItemId)
			.first<{ sellable_item_id: string }>();
		const sku = item ? (await saleComponents(db))[item.sellable_item_id] : null;
		if (!sku) return;
		const codes = plaintext.match(ownedCodePattern(sku)) ?? [];
		if (codes.length === 0) return;
		const token = await loadDeliveryWarehouseToken(db, commerceSecret);
		await requester(token, "/api/internal/faka/sold", {
			method: "POST",
			body: JSON.stringify({
				code_hashes: await Promise.all(
					codes.map((code) => sha256Hex(code.toLowerCase())),
				),
			}),
		});
	} catch {
		// The warehouse still buys on demand when the customer redeems.
	}
}

export async function saleComponents(db: D1Database) {
	const row = await db
		.prepare(
			"SELECT value FROM system_settings WHERE key='integration.supply_console_map'",
		)
		.first<{ value: string }>();
	if (!row) return {} as Record<string, string>;
	let map: unknown = JSON.parse(row.value);
	if (typeof map === "string") map = JSON.parse(map);
	const parsed = z
		.record(z.string(), z.string().regex(/^[A-Z0-9_]+$/))
		.parse(map);
	if (new Set(Object.values(parsed)).size !== Object.keys(parsed).length)
		throw new DomainError(
			"redeem_capacity_mapping_conflict",
			503,
			"Shared pool must have one sales authority",
		);
	return parsed;
}

export async function refreshSaleCapacity(
	db: D1Database,
	component: string,
	commerceSecret?: string,
	requester: typeof requestWarehouse = requestWarehouse,
) {
	const sku = (await saleComponents(db))[component];
	if (!sku) return null;
	const codePattern = ownedCodePattern(sku);
	const secret = commerceSecret ?? (await loadRuntimeConfig(db)).commerceSecret;
	await db
		.prepare(
			"INSERT OR IGNORE INTO redeem_sale_capacity (component_id,free_budget,generation,updated_at) VALUES (?,0,0,0)",
		)
		.bind(component)
		.run();
	try {
		const token = await loadDeliveryWarehouseToken(db, secret);
		for (let retry = 0; retry < 3; retry++) {
			const version = await db
				.prepare(
					"SELECT generation FROM redeem_sale_capacity WHERE component_id=?",
				)
				.bind(component)
				.first<{ generation: number }>();
			if (!version) throw new Error("Capacity row missing");
			const rows = await db
				.prepare(`SELECT content_encrypted,'stock-entry' AS purpose,redeem_sku FROM stock_entries WHERE sellable_item_id=? AND status IN ('reserved','delivered')
     UNION ALL SELECT d.content_encrypted,'delivery-content' AS purpose,d.redeem_sku FROM delivery_records d JOIN shop_order_items i ON i.id=d.order_item_id WHERE i.sellable_item_id=? AND d.content_encrypted IS NOT NULL`)
				.bind(component, component)
				.all<{
					content_encrypted: string;
					purpose: string;
					redeem_sku: string | null;
				}>();
			const missingPaid = await db
				.prepare(`SELECT COALESCE(SUM(MAX(0,i.quantity-(SELECT COUNT(*) FROM stock_entries s WHERE s.order_item_id=i.id AND s.status IN ('reserved','delivered')))),0) AS quantity
                FROM shop_order_items i JOIN shop_orders o ON o.id=i.order_id WHERE i.delivery_component_id=? AND (o.status IN ('paid','fulfilling','completed','refunding') OR (o.status='failed' AND o.paid_minor<>'0'))
                AND NOT EXISTS (SELECT 1 FROM delivery_records d WHERE d.order_item_id=i.id AND d.status='delivered')`)
				.bind(component)
				.first<{ quantity: number }>();
			const hashes = new Set<string>();
			for (const row of rows.results) {
				const content = await decryptSecret(
					row.content_encrypted,
					secret,
					row.purpose,
				);
				const matches = content.match(codePattern) ?? [];
				if (row.redeem_sku && (row.redeem_sku !== sku || matches.length === 0))
					throw new Error("Unresolved owned-code obligation");
				for (const code of matches)
					hashes.add(await sha256Hex(code.toLowerCase()));
			}
			const { data } = capacitySchema.parse(
				await requester(token, "/api/internal/inventory/sale-capacity", {
					method: "POST",
					body: JSON.stringify({ sku, code_hashes: [...hashes] }),
				}),
			);
			if (data.sellable !== Math.max(0, data.available - data.outstanding))
				throw new Error("Invalid capacity arithmetic");
			// An already-paid legacy order remains an obligation even before a
			// customer code could be allocated. A failed delivery is not a refund.
			const raw = await db
				.prepare(`SELECT COUNT(*) AS count FROM stock_entries s
    WHERE s.sellable_item_id=? AND s.status='available' AND s.redeem_sku IS NULL
    AND EXISTS(SELECT 1 FROM system_settings WHERE key='integration.redeem_delivery.'||s.sellable_item_id AND json_extract(value,'$')=?)`)
				.bind(
					component,
					["GPT_PLUS_PH", "GPT_5X_PH", "GPT_20X_PH"].includes(sku) ? sku : "",
				)
				.first<{ count: number }>();
			data.available += Number(raw?.count ?? 0);
			data.outstanding += Number(missingPaid?.quantity ?? 0);
			data.sellable = Math.max(0, data.available - data.outstanding);
			// A checkout changes generation in the same D1 transaction as its stock
			// reservation. Never overwrite that reservation with an older read.
			const saved = await db
				.prepare(
					"UPDATE redeem_sale_capacity SET free_budget=?,updated_at=? WHERE component_id=? AND generation=?",
				)
				.bind(data.sellable, Date.now(), component, version.generation)
				.run();
			if (saved.meta.changes === 1) return { componentId: component, ...data };
		}
		throw new Error("Capacity changed during refresh");
	} catch {
		await db
			.prepare(
				"UPDATE redeem_sale_capacity SET free_budget=0,updated_at=0,generation=generation+1 WHERE component_id=?",
			)
			.bind(component)
			.run();
		throw new DomainError(
			"redeem_sale_capacity_unavailable",
			503,
			"Verified sale capacity unavailable",
		);
	}
}

export async function prepareSale(
	db: D1Database,
	componentId: string,
	quantity: number,
) {
	if (!(componentId in (await saleComponents(db)))) return false;
	const count = await db
		.prepare(
			"SELECT COUNT(*) AS count FROM stock_entries WHERE sellable_item_id=? AND status='available'",
		)
		.bind(componentId)
		.first<{ count: number }>();
	if (Number(count?.count ?? 0) < quantity)
		throw new DomainError(
			"inventory_unavailable",
			409,
			"Insufficient owned codes",
		);
	return true;
}

// Keep payment statement row counts unchanged: D1 reports trigger updates in
// meta.changes, so unallocated cash obligations bump the read version explicitly
// at the end of the same financial transaction, not in a shop_orders trigger.
export function unallocatedPaymentStatement(db: D1Database, orderId: string) {
	return db
		.prepare(`UPDATE redeem_sale_capacity SET generation=generation+1 WHERE component_id IN
   (SELECT i.delivery_component_id FROM shop_order_items i JOIN shop_orders o ON o.id=i.order_id WHERE o.id=?
    AND (o.status IN ('paid','fulfilling','completed','refunding') OR (o.status='failed' AND o.paid_minor<>'0'))
    AND i.quantity>(SELECT COUNT(*) FROM stock_entries s WHERE s.order_item_id=i.id AND s.status IN ('reserved','delivered'))
    AND NOT EXISTS (SELECT 1 FROM delivery_records d WHERE d.order_item_id=i.id AND d.status='delivered'))`)
		.bind(orderId);
}

// Used inside the order-creation D1 transaction, never as a separate preflight.
export function reserveSaleStatements(
	db: D1Database,
	componentId: string,
	orderItemId: string,
	quantity: number,
	now: number,
) {
	return [
		db
			.prepare(
				"UPDATE stock_entries SET status='reserved',order_item_id=?,reserved_at=?,updated_at=? WHERE id IN (SELECT id FROM stock_entries WHERE sellable_item_id=? AND status='available' ORDER BY created_at,id LIMIT ?)",
			)
			.bind(orderItemId, now, now, componentId, quantity),
	];
}

export function releaseSaleStatements(
	db: D1Database,
	orderId: string,
	now: number,
) {
	return [
		db
			.prepare(`UPDATE stock_entries SET status='available',order_item_id=NULL,reserved_at=NULL,updated_at=? WHERE status='reserved'
    AND order_item_id IN (SELECT i.id FROM shop_order_items i JOIN shop_orders o ON o.id=i.order_id WHERE o.id=? AND o.status IN ('cancelled','expired','failed','refunded'))`)
			.bind(now, orderId),
	];
}
