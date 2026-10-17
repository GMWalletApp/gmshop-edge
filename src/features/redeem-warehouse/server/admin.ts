import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { systemPermission } from "#/features/access/system-rbac";
import {
	fingerprintInventorySecret,
	formatInventoryDelivery,
	maskInventorySecret,
} from "#/features/catalog/server/inventory-secrets";
import { RESELLER_REDEEM_URL } from "#/features/redeem-warehouse/redeem-host";
import { sha256Hex } from "#/lib/crypto";
import { DomainError } from "#/lib/domain-error";
import { decryptSecret, encryptSecret } from "#/lib/secrets";
import { decimalToMinor } from "#/lib/units";
import { getAdminRuntimeServerContext } from "#/server/context";
import {
	loadDeliveryWarehouseToken,
	requestWarehouse,
} from "./warehouse-client";

const tokenKey = "integration.redeem_warehouse_token";

// The admin session context, or the ops API's token-authenticated one
// (no acting user).
export type WarehouseContext = {
	db: D1Database;
	currentUser: { id: string | null };
	request: Request;
	runtime: { commerceSecret: string };
};
// Last storefront item restocked per SKU; the card shows what it feeds.
const targetsKey = "integration.redeem_warehouse_targets";
const tokenPurpose = "redeem-warehouse-token";

const configurationSchema = z.object({
	token: z.string().trim().min(32).max(500).optional(),
});

const importSchema = z.object({
	sku: z.string().trim().min(1).max(100),
	unitCostYuan: z
		.string()
		.trim()
		.regex(/^(0|[1-9]\d*)(\.\d{1,2})?$/)
		.optional(),
	content: z.string().trim().min(1).max(250_000),
});

export const quickRestockSchema = importSchema.extend({
	requestRef: z
		.string()
		.trim()
		.regex(/^[A-Za-z0-9_-]{16,100}$/),
	componentId: z.uuid(),
});

export const generateSellableSchema = z.object({
	requestRef: z
		.string()
		.trim()
		.regex(/^[A-Za-z0-9_-]{16,100}$/),
	sku: z.string().trim().min(1).max(100),
	componentId: z.uuid(),
	count: z.number().int().min(1).max(100),
});

const importEnvelopeSchema = z.object({
	success: z.literal(true),
	data: z.object({
		imported: z.number().int().nonnegative(),
		total: z.number().int().positive(),
		results: z.array(
			z.object({
				index: z.number().int().nonnegative(),
				status: z.string(),
				reason: z.string().optional(),
			}),
		),
	}),
});

const batchIssueEnvelopeSchema = z.object({
	success: z.literal(true),
	data: z.object({
		sku: z.string(),
		count: z.number().int().positive(),
		codes: z.array(z.string().min(20).max(200)).min(1).max(100),
	}),
});

export const getRedeemWarehouseConfigurationFn = createServerFn({
	method: "GET",
}).handler(async () => {
	const context = await getAdminRuntimeServerContext(
		systemPermission("settings", "read"),
	);
	const rows = await loadSettingRows(context.db);
	return {
		configured: Boolean(rows.get(tokenKey)),
	};
});

export const saveRedeemWarehouseConfigurationFn = createServerFn({
	method: "POST",
})
	.validator((input: z.input<typeof configurationSchema>) =>
		configurationSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await getAdminRuntimeServerContext(
			systemPermission("settings", "update"),
		);
		if (!context.runtime.commerceSecret) throw unavailable();
		const rows = await loadSettingRows(context.db);
		const existingToken = rows.get(tokenKey)
			? await decryptSecret(
					settingString(rows.get(tokenKey)),
					context.runtime.commerceSecret,
					tokenPurpose,
				)
			: "";
		const token = data.token || existingToken;
		if (!token)
			throw new DomainError(
				"redeem_warehouse_token_required",
				400,
				"Token required",
			);
		await requestWarehouse(token, "/api/internal/inventory/summary");
		const now = Date.now();
		const encryptedToken = data.token
			? await encryptSecret(
					data.token,
					context.runtime.commerceSecret,
					tokenPurpose,
				)
			: settingString(rows.get(tokenKey));
		await context.db.batch([
			upsertSetting(
				context.db,
				tokenKey,
				encryptedToken,
				true,
				context.currentUser.id,
				now,
			),
			context.db
				.prepare(
					`INSERT INTO audit_logs
				 (id, actor_user_id, action, target_type, target_id, request_id, ip_address, after, created_at)
				 VALUES (?, ?, 'redeem_warehouse.configuration_saved', 'system_setting', ?, ?, ?, ?, ?)`,
				)
				.bind(
					crypto.randomUUID(),
					context.currentUser.id,
					tokenKey,
					context.request.headers.get("x-request-id"),
					context.request.headers.get("cf-connecting-ip"),
					JSON.stringify({ tokenUpdated: Boolean(data.token) }),
					now,
				),
		]);
		return { configured: true };
	});

export async function quickRestockRedeemWarehouse(
	data: z.infer<typeof quickRestockSchema>,
	context: WarehouseContext,
	requester: typeof requestWarehouse = requestWarehouse,
) {
	const targets = await listRestockTargets(context.db);
	if (!targets.some((item) => item.componentId === data.componentId))
		throw new DomainError(
			"redeem_sellable_component_not_found",
			404,
			"Stock item not found",
		);
	const imported = await importWarehouseKeys(data, context, requester);
	let generated = 0;
	let generationFailed = false;
	if (imported.imported > 0) {
		try {
			generated = (
				await generateRedeemSellableInventory(
					{
						requestRef: data.requestRef,
						sku: data.sku,
						componentId: data.componentId,
						count: imported.imported,
					},
					context,
					requester,
				)
			).imported;
		} catch {
			// Keys are already in the warehouse; the owner can finish with
			// "generate sellable" for the reported count.
			generationFailed = true;
		}
	}
	const current = await loadTargets(context.db);
	await upsertSetting(
		context.db,
		targetsKey,
		JSON.stringify({ ...current, [data.sku]: data.componentId }),
		false,
		context.currentUser.id,
		Date.now(),
	).run();
	return { ...imported, generated, generationFailed };
}

async function importWarehouseKeys(
	data: z.infer<typeof importSchema>,
	context: WarehouseContext,
	requester: typeof requestWarehouse = requestWarehouse,
) {
	const config = await loadWarehouseConfig(context);
	const keys = data.content
		.split(/\r?\n/)
		.map((value) => value.trim())
		.filter(Boolean);
	if (keys.length > 100)
		throw new DomainError(
			"redeem_warehouse_batch_too_large",
			400,
			"Import at most 100 keys",
		);
	const unitCostMinor = data.unitCostYuan
		? decimalToMinor(data.unitCostYuan, 2).toString()
		: undefined;
	const result = importEnvelopeSchema.parse(
		await requester(config.token, "/api/internal/inventory/import", {
			method: "POST",
			body: JSON.stringify({
				sku: data.sku,
				keys,
				...(unitCostMinor ? { unit_cost_minor: unitCostMinor } : {}),
			}),
		}),
	);
	const counts = result.data.results.reduce<Record<string, number>>(
		(summary, item) => {
			summary[item.status] = (summary[item.status] ?? 0) + 1;
			return summary;
		},
		{},
	);
	await context.db
		.prepare(
			`INSERT INTO audit_logs
		 (id, actor_user_id, action, target_type, target_id, request_id, ip_address, after, created_at)
		 VALUES (?, ?, 'redeem_warehouse.inventory_imported', 'redeem_sku', ?, ?, ?, ?, ?)`,
		)
		.bind(
			crypto.randomUUID(),
			context.currentUser.id,
			data.sku,
			context.request.headers.get("x-request-id"),
			context.request.headers.get("cf-connecting-ip"),
			JSON.stringify({
				total: result.data.total,
				imported: result.data.imported,
				counts,
				unitCostMinor: unitCostMinor ?? null,
			}),
			Date.now(),
		)
		.run();
	return { total: result.data.total, imported: result.data.imported, counts };
}

export const generateRedeemSellableInventoryFn = createServerFn({
	method: "POST",
})
	.validator((input: z.input<typeof generateSellableSchema>) =>
		generateSellableSchema.parse(input),
	)
	.handler(async ({ data }) =>
		generateRedeemSellableInventory(
			data,
			await getAdminRuntimeServerContext(
				systemPermission("inventory", "create"),
			),
		),
	);

export async function generateRedeemSellableInventory(
	data: z.infer<typeof generateSellableSchema>,
	context: WarehouseContext,
	requester: typeof requestWarehouse = requestWarehouse,
) {
	if (!context.runtime.commerceSecret) throw unavailable();
	const component = await context.db
		.prepare(
			`SELECT item.id FROM product_sellable_items item JOIN products product ON product.id = item.product_id
			 WHERE item.id = ? AND item.enabled = 1 AND item.fulfillment_source = 'local'
			  AND product.status = 'active' AND product.product_type = 'stock' LIMIT 1`,
		)
		.bind(data.componentId)
		.first<{ id: string }>();
	if (!component)
		throw new DomainError(
			"redeem_sellable_component_not_found",
			404,
			"Stock item not found",
		);
	const payloadDigest = await sha256Hex(
		JSON.stringify({
			sku: data.sku,
			componentId: data.componentId,
			count: data.count,
		}),
	);
	const existing = await context.db
		.prepare(
			`SELECT payload_digest FROM replay_receipts
			 WHERE namespace = 'redeem_sellable_generation' AND scope_id = ? AND external_id = ? LIMIT 1`,
		)
		.bind(data.componentId, data.requestRef)
		.first<{ payload_digest: string }>();
	if (existing) {
		if (existing.payload_digest !== payloadDigest)
			throw new DomainError(
				"redeem_sellable_request_conflict",
				409,
				"Request reference already used",
			);
		return { idempotent: true, imported: 0, count: data.count };
	}
	const config = await loadWarehouseConfig(context);
	const batch = batchIssueEnvelopeSchema.parse(
		await requester(config.token, "/api/internal/codes/batch", {
			method: "POST",
			body: JSON.stringify({
				sku: data.sku,
				storefront: "lsrai",
				request_ref: data.requestRef,
				count: data.count,
			}),
		}),
	);
	if (
		batch.data.sku !== data.sku ||
		batch.data.count !== data.count ||
		batch.data.codes.length !== data.count ||
		new Set(batch.data.codes).size !== data.count ||
		batch.data.codes.some(
			(code) =>
				!code.startsWith(`${data.sku.toLowerCase().replaceAll("_", "-")}-`),
		)
	) {
		throw new DomainError(
			"redeem_warehouse_batch_mismatch",
			502,
			"Redemption batch does not match the requested SKU and count",
		);
	}
	const commerceSecret = context.runtime.commerceSecret;
	const prepared = await Promise.all(
		batch.data.codes.map(async (code) => ({
			id: crypto.randomUUID(),
			fingerprint: await fingerprintInventorySecret(code, commerceSecret),
			mask: maskInventorySecret(code),
			encrypted: await encryptSecret(
				formatInventoryDelivery(code, RESELLER_REDEEM_URL, true),
				commerceSecret,
				"stock-entry",
			),
		})),
	);
	const now = Date.now();
	await context.db.batch([
		context.db
			.prepare(
				`INSERT INTO replay_receipts
				 (id, namespace, scope_id, external_id, event_type, payload_digest, status, processed_at, created_at, updated_at)
				 VALUES (?, 'redeem_sellable_generation', ?, ?, 'inventory_generation', ?, 'processed', ?, ?, ?)`,
			)
			.bind(
				crypto.randomUUID(),
				data.componentId,
				data.requestRef,
				payloadDigest,
				now,
				now,
				now,
			),
		...prepared.map((item) =>
			context.db
				.prepare(
					`INSERT OR IGNORE INTO stock_entries
					 (id, sellable_item_id, content_encrypted, key_version, content_fingerprint, content_mask,
					  status, note, created_at, updated_at, redeem_sku)
					 VALUES (?, ?, ?, 1, ?, ?, 'available', ?, ?, ?, ?)`,
				)
				.bind(
					item.id,
					data.componentId,
					item.encrypted,
					item.fingerprint,
					item.mask,
					`source=redeem-warehouse; sku=${data.sku}; request_ref=${data.requestRef}`,
					now,
					now,
					["GPT_PLUS_PH", "GPT_5X_PH", "GPT_20X_PH"].includes(data.sku)
						? data.sku
						: null,
				),
		),
		context.db
			.prepare(
				`INSERT INTO audit_logs
				 (id, actor_user_id, action, target_type, target_id, request_id, ip_address, after, created_at)
				 VALUES (?, ?, 'redeem_warehouse.sellable_inventory_generated', 'sellable_item', ?, ?, ?, ?, ?)`,
			)
			.bind(
				crypto.randomUUID(),
				context.currentUser.id,
				data.componentId,
				context.request.headers.get("x-request-id"),
				context.request.headers.get("cf-connecting-ip"),
				JSON.stringify({
					sku: data.sku,
					count: data.count,
					requestRef: data.requestRef,
				}),
				now,
			),
	]);
	// D1 changes includes trigger writes, so it is not a stock-entry count.
	// Read back only the fresh IDs from this batch (ignored duplicates do not
	// acquire these IDs), excluding audit/replay and inventory-counter writes.
	const persisted = await context.db
		.prepare(
			`SELECT COUNT(*) AS count FROM stock_entries WHERE id IN (${prepared.map(() => "?").join(",")})`,
		)
		.bind(...prepared.map((item) => item.id))
		.first<{ count: number }>();
	const imported = Number(persisted?.count ?? 0);
	return { idempotent: false, imported, count: data.count };
}

async function loadWarehouseConfig(context: WarehouseContext) {
	if (!context.runtime.commerceSecret) throw unavailable();
	return {
		token: await loadDeliveryWarehouseToken(
			context.db,
			context.runtime.commerceSecret,
		),
	};
}

async function loadTargets(db: D1Database): Promise<Record<string, string>> {
	const row = await db
		.prepare("SELECT value FROM system_settings WHERE key = ?")
		.bind(targetsKey)
		.first<{ value: string }>();
	if (!row) return {};
	const parsed = z
		.record(z.string(), z.string())
		.safeParse(JSON.parse(settingString(row.value) || "{}"));
	return parsed.success ? parsed.data : {};
}

async function listRestockTargets(db: D1Database) {
	const rows = await db
		.prepare(
			`SELECT item.id, item.name, product.name AS product_name,
			 (SELECT COUNT(*) FROM stock_entries entry
			  WHERE entry.sellable_item_id = item.id AND entry.status = 'available') AS available
			 FROM product_sellable_items item JOIN products product ON product.id = item.product_id
			 WHERE item.enabled = 1 AND item.sale_disabled = 0 AND item.fulfillment_source = 'local'
			  AND product.status = 'active' AND product.sale_disabled = 0
			  AND product.product_type = 'stock'
			 ORDER BY product.sort_order, item.sort_order, item.name`,
		)
		.all<{
			id: string;
			name: string;
			product_name: string;
			available: number;
		}>();
	return rows.results.map((row) => ({
		componentId: row.id,
		itemName: row.name,
		productName: row.product_name,
		available: Number(row.available),
	}));
}

async function loadSettingRows(db: D1Database) {
	const rows = await db
		.prepare("SELECT key, value FROM system_settings WHERE key = ?")
		.bind(tokenKey)
		.all<{ key: string; value: string }>();
	return new Map(rows.results.map((row) => [row.key, row.value]));
}

function settingString(value: string | undefined) {
	if (!value) return "";
	const parsed: unknown = JSON.parse(value);
	return typeof parsed === "string" ? parsed : "";
}

function upsertSetting(
	db: D1Database,
	key: string,
	value: string,
	secret: boolean,
	userId: string | null,
	now: number,
) {
	return db
		.prepare(
			`INSERT INTO system_settings (key, value, is_secret, updated_by, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value, is_secret = excluded.is_secret,
		 updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
		)
		.bind(key, JSON.stringify(value), secret ? 1 : 0, userId, now, now);
}

export { requestWarehouse } from "./warehouse-client";

function unavailable() {
	return new DomainError(
		"redeem_warehouse_unavailable",
		503,
		"Warehouse configuration unavailable",
	);
}
