import { z } from "zod";
import {
	formatInventoryDelivery,
	maskInventorySecret,
} from "#/features/catalog/server/inventory-secrets";
import { RESELLER_REDEEM_URL } from "#/features/redeem-warehouse/redeem-host";
import { DomainError } from "#/lib/domain-error";
import { decryptSecret, encryptSecret } from "#/lib/secrets";
import { requestWarehouse } from "./warehouse-client";

export const phRedeemSkuSchema = z.enum([
	"GPT_PLUS_PH",
	"GPT_5X_PH",
	"GPT_20X_PH",
]);
export type ConvertibleStock = {
	id: string;
	content_encrypted: string;
	content_fingerprint: string;
	unit_cost_minor: string | null;
	redeem_sku: string | null;
};
const resultSchema = z.object({
	success: z.literal(true),
	data: z.object({ sku: phRedeemSkuSchema, cdkey: z.string().max(100) }),
});

export async function convertReservedStock(
	db: D1Database,
	entry: ConvertibleStock,
	orderItemId: string,
	sku: string,
	commerceSecret: string,
	token: string,
	requester: typeof requestWarehouse = requestWarehouse,
) {
	phRedeemSkuSchema.parse(sku);
	const original = await decryptSecret(
		entry.content_encrypted,
		commerceSecret,
		"stock-entry",
	);
	if (entry.redeem_sku) {
		if (entry.redeem_sku !== sku)
			throw new DomainError(
				"redeem_delivery_sku_conflict",
				409,
				"Inventory plan mismatch",
			);
		const prefix = sku.toLowerCase().replaceAll("_", "-");
		if (
			!new RegExp(
				`^CDK：${prefix}-[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}\\n充值地址：https://redeem\\.lsrai\\.shop$`,
			).test(original)
		)
			throw new DomainError(
				"redeem_delivery_marker_conflict",
				409,
				"Converted inventory content mismatch",
			);
		return original;
	}
	const key = upstreamKeyForDelivery(original);
	const response = resultSchema.parse(
		await requester(token, "/api/internal/fulfillment/convert", {
			method: "POST",
			body: JSON.stringify({
				sku,
				source_ref: `gmstock-${entry.id}`,
				key,
				...(entry.unit_cost_minor
					? { unit_cost_minor: entry.unit_cost_minor }
					: {}),
			}),
		}),
	);
	const prefix = sku.toLowerCase().replaceAll("_", "-");
	if (
		response.data.sku !== sku ||
		!new RegExp(`^${prefix}-[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$`).test(
			response.data.cdkey,
		)
	)
		throw new DomainError(
			"redeem_delivery_response_mismatch",
			502,
			"Warehouse response mismatch",
		);
	const content = formatInventoryDelivery(
		response.data.cdkey,
		RESELLER_REDEEM_URL,
		true,
	);
	const changed = await db
		.prepare(`UPDATE stock_entries SET content_encrypted=?,content_mask=?,redeem_sku=?,updated_at=?
    WHERE id=? AND order_item_id=? AND status='reserved' AND content_fingerprint=? AND redeem_sku IS NULL
      AND EXISTS (SELECT 1 FROM shop_order_items oi JOIN shop_orders o ON o.id=oi.order_id WHERE oi.id=? AND o.status IN ('paid','fulfilling'))`)
		.bind(
			await encryptSecret(content, commerceSecret, "stock-entry"),
			maskInventorySecret(response.data.cdkey),
			sku,
			Date.now(),
			entry.id,
			orderItemId,
			entry.content_fingerprint,
			orderItemId,
		)
		.run();
	if (changed.meta.changes === 1) return content;
	const replay = await db
		.prepare(
			"SELECT content_encrypted FROM stock_entries WHERE id=? AND order_item_id=? AND status='reserved' AND redeem_sku=?",
		)
		.bind(entry.id, orderItemId, sku)
		.first<{ content_encrypted: string }>();
	if (replay)
		return decryptSecret(
			replay.content_encrypted,
			commerceSecret,
			"stock-entry",
		);
	// Cancellation/refund won. No customer content is returned, and raw fingerprint is kept for deduplication.
	throw new DomainError(
		"redeem_delivery_state_changed",
		409,
		"Inventory ownership changed",
	);
}

function upstreamKeyForDelivery(content: string) {
	const match = content
		.trim()
		.match(
			/^(?:CDK[：:]\s*)?([A-Za-z0-9_-]{1,64})(?:\r?\n充值地址[：:]\s*https:\/\/[^\s]+)?$/,
		);
	if (!match?.[1])
		throw new DomainError(
			"redeem_delivery_format_unsupported",
			409,
			"Inventory format requires review",
		);
	return match[1];
}
