import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { systemPermission } from "#/features/access/system-rbac";
import { verifySensitiveAdminAction } from "#/features/auth/server/reauthenticate";
import {
	adminListSchema,
	inventoryExportSchema,
	inventoryImportSchema,
	inventoryListSchema,
	inventoryRevealSchema,
	inventoryStatusInputSchema,
	productLifecycleInputSchema,
	productMediaIdSchema,
	productMediaListSchema,
	productMediaOrderSchema,
	productMediaUploadSchema,
	productOrderInputSchema,
	recordIdSchema,
} from "#/features/catalog/schema";
import { removeSellableItemsFromAllCarts } from "#/features/storefront/server/cart";
import { csvCell } from "#/lib/csv";
import { DomainError } from "#/lib/domain-error";
import { decryptSecret, encryptSecret } from "#/lib/secrets";
import { clientIp } from "#/server/client-ip";
import { getAdminRuntimeServerContext } from "#/server/context";
import { readImageDimensions } from "./image-dimensions";
import {
	fingerprintInventorySecret,
	maskInventorySecret,
	normalizeInventorySecrets,
} from "./inventory-secrets";

type AuditContext = Awaited<ReturnType<typeof adminContext>>;

export const listProductsFn = createServerFn({ method: "GET" })
	.validator((input: z.input<typeof adminListSchema>) =>
		adminListSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const { db } = await adminContext(systemPermission("products", "read"));
		const search = data.search ? `%${data.search}%` : null;
		const conditions: string[] = [
			data.view === "trash" ? "p.status = 'trashed'" : "p.status <> 'trashed'",
		];
		const bindings: unknown[] = [];
		if (search) {
			conditions.push(`(p.name LIKE ? OR EXISTS (
			 SELECT 1 FROM json_each(p.tag_names) search_tag
			 WHERE search_tag.value LIKE ?))`);
			bindings.push(search, search);
		}
		const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
		const offset = data.pageIndex * data.pageSize;
		const page = pageResults(
			await db.batch([
				db
					.prepare(`SELECT COUNT(*) AS total FROM products p ${where}`)
					.bind(...bindings),
				db
					.prepare(
						`SELECT p.id, p.name, p.description, p.product_type,
						 p.status, p.cover_object_key, p.revision, p.sort_order,
					 p.created_at, p.updated_at,
						 COUNT(DISTINCT s.id) AS sellable_item_count,
							 COUNT(DISTINCT CASE WHEN s.enabled = 1 THEN s.id END) AS enabled_sellable_item_count,
							 MAX(CASE WHEN s.enabled = 1 THEN s.currency END) AS currency,
							 MAX(CASE WHEN s.enabled = 1 THEN s.currency_decimals END) AS currency_decimals,
						 MIN(CASE WHEN s.enabled = 1 THEN CAST(s.price_minor AS INTEGER) END) AS minimum_price_minor,
						 MAX(CASE WHEN s.enabled = 1 THEN CAST(s.price_minor AS INTEGER) END) AS maximum_price_minor,
						 CASE WHEN COUNT(DISTINCT CASE WHEN s.enabled = 1 THEN s.id END) > 0
						  THEN json_array(p.product_type) ELSE '[]' END AS delivery_types,
						 (SELECT COUNT(*) FROM stock_entries secret
						  JOIN product_sellable_items stock_item
						   ON stock_item.id = secret.sellable_item_id
						  WHERE stock_item.product_id = p.id
						   AND stock_item.enabled = 1
						   AND secret.status = 'available') AS available_stock,
						 p.tag_names AS tags_json
						 FROM products p
					 LEFT JOIN product_sellable_items s ON s.product_id = p.id
					 ${where}
					 GROUP BY p.id
					 ORDER BY p.sort_order, p.created_at DESC, p.id DESC
					 LIMIT ? OFFSET ?`,
					)
					.bind(...bindings, data.pageSize, offset),
			]),
		);
		return {
			data: page.rows.map((row) => ({
				id: String(row.id),
				name: String(row.name),
				description: row.description ? String(row.description) : null,
				productType: String(row.product_type) as
					| "stock"
					| "download"
					| "automation",
				status: String(row.status) as "draft" | "active" | "trashed",
				coverObjectKey: row.cover_object_key
					? String(row.cover_object_key)
					: null,
				tagNames: z.array(z.string()).parse(JSON.parse(String(row.tags_json))),
				revision: Number(row.revision),
				sortOrder: Number(row.sort_order),
				sellableItemCount: Number(row.sellable_item_count),
				enabledSellableItemCount: Number(row.enabled_sellable_item_count),
				currency: row.currency == null ? null : String(row.currency),
				currencyDecimals:
					row.currency_decimals == null ? null : Number(row.currency_decimals),
				minimumPriceMinor:
					row.minimum_price_minor == null
						? null
						: String(row.minimum_price_minor),
				maximumPriceMinor:
					row.maximum_price_minor == null
						? null
						: String(row.maximum_price_minor),
				deliveryTypes: z
					.array(z.enum(["stock", "download", "automation"]))
					.parse(JSON.parse(String(row.delivery_types))),
				availableStock: Number(row.available_stock),
				createdAt: Number(row.created_at),
				updatedAt: Number(row.updated_at),
			})),
			total: page.total,
		};
	});

export const listProductOptionsFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const { db } = await adminContext(systemPermission("products", "read"));
		const [tags, products, sellableItems] = await Promise.all([
			db
				.prepare(
					`SELECT tag.value AS name, COUNT(DISTINCT product.id) AS product_count
					 FROM products product, json_each(product.tag_names) tag
					 GROUP BY tag.value ORDER BY product_count DESC, tag.value`,
				)
				.all(),
			db
				.prepare("SELECT id, name FROM products ORDER BY sort_order, name")
				.all(),
			db
				.prepare(
					`SELECT s.id, s.product_id, s.id AS delivery_component_id,
					 s.name, p.name AS product_name,
					 p.product_type AS delivery_type
					 FROM product_sellable_items s INNER JOIN products p ON p.id = s.product_id
					 ORDER BY p.sort_order, s.sort_order, s.name`,
				)
				.all(),
		]);
		return {
			tags: tags.results.map((row) => ({
				name: String(row.name),
				productCount: Number(row.product_count),
			})),
			products: products.results.map((row) => ({
				id: String(row.id),
				name: String(row.name),
			})),
			sellableItems: sellableItems.results.map((row) => ({
				id: String(row.id),
				productId: String(row.product_id),
				deliveryComponentId: String(row.delivery_component_id),
				name: String(row.name),
				productName: String(row.product_name),
				deliveryType: String(row.delivery_type) as
					| "stock"
					| "download"
					| "automation",
			})),
		};
	},
);

export const listProductTagOptionsFn = createServerFn({
	method: "GET",
}).handler(async () => {
	const { db } = await adminContext(systemPermission("products", "read"));
	const rows = await db
		.prepare(
			`SELECT DISTINCT tag.value AS name
			 FROM products product, json_each(product.tag_names) tag
			 ORDER BY tag.value`,
		)
		.all<{ name: string }>();
	return rows.results;
});

export const listProductMediaFn = createServerFn({ method: "GET" })
	.validator((input: z.input<typeof productMediaListSchema>) =>
		productMediaListSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const { db } = await adminContext(systemPermission("products", "read"));
		const product = await db
			.prepare("SELECT cover_object_key FROM products WHERE id = ? LIMIT 1")
			.bind(data.productId)
			.first<{ cover_object_key: string | null }>();
		if (!product)
			throw new DomainError("product_not_found", 404, "Product not found");
		const rows = await db
			.prepare(
				`SELECT id, object_key, alt_text, content_type, size_bytes, sort_order,
				 created_at FROM product_media WHERE product_id = ? ORDER BY sort_order, id`,
			)
			.bind(data.productId)
			.all<{
				id: string;
				object_key: string;
				alt_text: string | null;
				content_type: string;
				size_bytes: number;
				sort_order: number;
				created_at: number;
			}>();
		return rows.results.map((row) => ({
			id: row.id,
			altText: row.alt_text,
			contentType: row.content_type,
			sizeBytes: row.size_bytes,
			sortOrder: row.sort_order,
			createdAt: row.created_at,
			cover: row.object_key === product.cover_object_key,
			url: `/api/shop/products/${data.productId}/media/${row.id}?v=${row.created_at}`,
		}));
	});

export const uploadProductMediaFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof productMediaUploadSchema>) =>
		productMediaUploadSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await adminContext(systemPermission("products", "update"));
		if (!context.env.FILES)
			throw new DomainError(
				"product_media_storage_unavailable",
				503,
				"Product media storage is unavailable",
			);
		await requireRecord(
			context.db,
			"products",
			data.productId,
			"product_not_found",
		);
		let bytes: Uint8Array;
		try {
			const binary = atob(data.base64);
			bytes = Uint8Array.from(binary, (value) => value.charCodeAt(0));
		} catch {
			throw new DomainError(
				"product_media_invalid",
				400,
				"Product media is invalid",
			);
		}
		if (!bytes.length || bytes.length > 5_000_000)
			throw new DomainError(
				"product_media_too_large",
				400,
				"Product media must not exceed 5 MB",
			);
		assertProductMediaImage(bytes, data.contentType);
		const id = crypto.randomUUID();
		const extension = data.contentType.split("/")[1] ?? "image";
		const objectKey = `products/${data.productId}/media/${id}.${extension}`;
		await context.env.FILES.put(objectKey, bytes, {
			httpMetadata: {
				contentType: data.contentType,
				cacheControl: "public, max-age=31536000, immutable",
			},
		});
		const now = Date.now();
		try {
			await context.db.batch([
				context.db
					.prepare(
						`INSERT INTO product_media
						 (id, product_id, object_key, alt_text, content_type, size_bytes,
						  sort_order, created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?, ?, 100, ?, ?)`,
					)
					.bind(
						id,
						data.productId,
						objectKey,
						data.altText || null,
						data.contentType,
						bytes.length,
						now,
						now,
					),
				...(data.setAsCover
					? [
							context.db
								.prepare(
									"UPDATE products SET cover_object_key = ?, updated_at = ? WHERE id = ?",
								)
								.bind(objectKey, now, data.productId),
						]
					: []),
				auditStatement(context, {
					action: "product.media_uploaded",
					targetType: "product_media",
					targetId: id,
					after: {
						productId: data.productId,
						sizeBytes: bytes.length,
						cover: data.setAsCover,
					},
					now,
				}),
			]);
		} catch (error) {
			await context.env.FILES.delete(objectKey).catch(() => undefined);
			throw error;
		}
		return { id, objectKey };
	});

export const setProductCoverFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof productMediaIdSchema>) =>
		productMediaIdSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await adminContext(systemPermission("products", "update"));
		const media = await context.db
			.prepare(
				"SELECT product_id, object_key, content_type FROM product_media WHERE id = ? LIMIT 1",
			)
			.bind(data.id)
			.first<{
				product_id: string;
				object_key: string;
				content_type: string;
			}>();
		if (!media)
			throw new DomainError(
				"product_media_not_found",
				404,
				"Product media not found",
			);
		if (!context.env.FILES)
			throw new DomainError(
				"product_media_storage_unavailable",
				503,
				"Product media storage is unavailable",
			);
		const object = await context.env.FILES.get(media.object_key);
		if (!object)
			throw new DomainError(
				"product_media_not_found",
				404,
				"Product media object was not found",
			);
		assertProductMediaImage(
			new Uint8Array(await object.arrayBuffer()),
			media.content_type,
		);
		const now = Date.now();
		await context.db.batch([
			context.db
				.prepare(
					"UPDATE products SET cover_object_key = ?, updated_at = ? WHERE id = ?",
				)
				.bind(media.object_key, now, media.product_id),
			auditStatement(context, {
				action: "product.cover_updated",
				targetType: "product",
				targetId: media.product_id,
				after: { mediaId: data.id },
				now,
			}),
		]);
		return { id: data.id };
	});

export const sortProductMediaFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof productMediaOrderSchema>) =>
		productMediaOrderSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await adminContext(systemPermission("products", "update"));
		const media = await context.db
			.prepare(
				"SELECT id FROM product_media WHERE product_id = ? ORDER BY sort_order, id",
			)
			.bind(data.productId)
			.all<{ id: string }>();
		const persistedIds = (media.results ?? []).map((item) => item.id);
		if (
			persistedIds.length !== data.ids.length ||
			persistedIds.some((id) => !data.ids.includes(id))
		)
			throw new DomainError(
				"product_media_invalid",
				400,
				"Product media order must include every product image",
			);
		const now = Date.now();
		await context.db.batch([
			...data.ids.map((id, index) =>
				context.db
					.prepare(
						"UPDATE product_media SET sort_order = ?, updated_at = ? WHERE id = ? AND product_id = ?",
					)
					.bind((index + 1) * 10, now, id, data.productId),
			),
			context.db
				.prepare("UPDATE products SET updated_at = ? WHERE id = ?")
				.bind(now, data.productId),
			auditStatement(context, {
				action: "product.media_sorted",
				targetType: "product",
				targetId: data.productId,
				after: { mediaIds: data.ids },
				now,
			}),
		]);
		return { ids: data.ids };
	});

export const deleteProductMediaFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof productMediaIdSchema>) =>
		productMediaIdSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await adminContext(systemPermission("products", "update"));
		const media = await context.db
			.prepare(
				"SELECT product_id, object_key FROM product_media WHERE id = ? LIMIT 1",
			)
			.bind(data.id)
			.first<{ product_id: string; object_key: string }>();
		if (!media)
			throw new DomainError(
				"product_media_not_found",
				404,
				"Product media not found",
			);
		const now = Date.now();
		await context.db.batch([
			context.db
				.prepare("DELETE FROM product_media WHERE id = ?")
				.bind(data.id),
			context.db
				.prepare(
					`UPDATE products SET cover_object_key = NULL, updated_at = ?
					 WHERE id = ? AND cover_object_key = ?`,
				)
				.bind(now, media.product_id, media.object_key),
			auditStatement(context, {
				action: "product.media_deleted",
				targetType: "product_media",
				targetId: data.id,
				now,
			}),
		]);
		if (context.env.FILES)
			await context.env.FILES.delete(media.object_key).catch(() => undefined);
		return { id: data.id };
	});

export const reorderProductsFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof productOrderInputSchema>) =>
		productOrderInputSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await adminContext(systemPermission("products", "update"));
		const rows = await context.db
			.prepare(
				"SELECT id FROM products WHERE status <> 'trashed' ORDER BY sort_order, created_at, id",
			)
			.all<{ id: string }>();
		const requested = new Set(data.ids);
		const slots = rows.results
			.map((row, index) => (requested.has(row.id) ? index : -1))
			.filter((index) => index >= 0);
		if (slots.length !== data.ids.length)
			throw new DomainError(
				"product_order_invalid",
				409,
				"Product order contains missing records",
			);
		const orderedIds = rows.results.map((row) => row.id);
		for (const [index, slot] of slots.entries()) {
			const id = data.ids[index];
			if (id) orderedIds[slot] = id;
		}
		const now = Date.now();
		await context.db.batch([
			...orderedIds.map((id, index) =>
				context.db
					.prepare(
						"UPDATE products SET sort_order = ?, updated_at = ? WHERE id = ?",
					)
					.bind((index + 1) * 100, now, id),
			),
			auditStatement(context, {
				action: "product.reordered",
				targetType: "product",
				targetId: "catalog",
				after: { ids: data.ids },
				now,
			}),
		]);
		return { ids: data.ids };
	});

export const trashProductFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof productLifecycleInputSchema>) =>
		productLifecycleInputSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await adminContext(systemPermission("products", "delete"));
		const now = Date.now();
		const product = await updateProductLifecycle(
			context,
			data.id,
			data.expectedRevision,
			"not_trashed",
		);
		await context.db.batch([
			context.db
				.prepare(
					`UPDATE products SET status = 'trashed', trashed_at = ?, updated_at = ?
					 WHERE id = ?`,
				)
				.bind(now, now, data.id),
			auditStatement(context, {
				action: "product.trashed",
				targetType: "product",
				targetId: data.id,
				before: product,
				after: { status: "trashed", trashedAt: now },
				now,
			}),
		]);
		return {
			id: data.id,
			revision: product.revision,
			status: "trashed" as const,
		};
	});

export const restoreProductFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof productLifecycleInputSchema>) =>
		productLifecycleInputSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await adminContext(systemPermission("products", "delete"));
		const now = Date.now();
		const product = await updateProductLifecycle(
			context,
			data.id,
			data.expectedRevision,
			"trashed",
		);
		await context.db.batch([
			context.db
				.prepare(
					`UPDATE products SET status = 'draft', trashed_at = NULL, updated_at = ?
					 WHERE id = ?`,
				)
				.bind(now, data.id),
			auditStatement(context, {
				action: "product.restored",
				targetType: "product",
				targetId: data.id,
				before: product,
				after: { status: "draft", trashedAt: null },
				now,
			}),
		]);
		return {
			id: data.id,
			revision: product.revision,
			status: "draft" as const,
		};
	});

/**
 * Orders, deliveries and entitlements are immutable history; a product that
 * was ever sold stays in the recycle bin instead of being erased.
 */
export async function assertProductHasNoOrderHistory(
	db: D1Database,
	productId: string,
) {
	const history = await db
		.prepare(
			`SELECT EXISTS(SELECT 1 FROM shop_order_items WHERE product_id = ?) OR
			 EXISTS(SELECT 1 FROM customer_entitlements WHERE product_id = ?) AS referenced`,
		)
		.bind(productId, productId)
		.first<{ referenced: number }>();
	if (history?.referenced)
		throw new DomainError(
			"product_has_order_history",
			409,
			"Products referenced by orders or entitlements cannot be permanently deleted",
		);
}

export const deleteProductFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof productLifecycleInputSchema>) =>
		productLifecycleInputSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await adminContext(systemPermission("products", "delete"));
		const row = await context.db
			.prepare("SELECT p.* FROM products p WHERE p.id = ? LIMIT 1")
			.bind(data.id)
			.first<Record<string, unknown>>();
		if (!row)
			throw new DomainError("product_not_found", 404, "Product not found");
		if (row.status !== "trashed")
			throw new DomainError(
				"product_not_trashed",
				409,
				"Only products in the recycle bin can be permanently deleted",
			);
		if (Number(row.revision) !== data.expectedRevision)
			throw new DomainError(
				"product_revision_conflict",
				409,
				"Product has changed since it was loaded",
			);
		await assertProductHasNoOrderHistory(context.db, data.id);
		const objectRows = await context.db
			.prepare(
				`SELECT object_key FROM product_media WHERE product_id = ?
				 UNION ALL
				 SELECT object_key FROM download_assets WHERE product_id = ?
				 UNION ALL
				 SELECT artifact.object_key FROM automation_artifacts artifact
				 JOIN automation_jobs job ON job.id = artifact.automation_job_id
				 JOIN customer_entitlements entitlement ON entitlement.id = job.entitlement_id
				 WHERE entitlement.product_id = ?`,
			)
			.bind(data.id, data.id, data.id)
			.all<{ object_key: string }>();
		const sellableItems = await context.db
			.prepare("SELECT id FROM product_sellable_items WHERE product_id = ?")
			.bind(data.id)
			.all<{ id: string }>();
		const sellableItemIds = sellableItems.results.map((item) => item.id);
		await removeSellableItemsFromAllCarts(context.db, sellableItemIds);
		const now = Date.now();
		await context.db.batch([
			context.db
				.prepare(
					`UPDATE coupons SET scope_json = json_set(
					 scope_json, '$.productIds',
					 json(COALESCE((SELECT json_group_array(value)
					  FROM json_each(scope_json, '$.productIds') WHERE value <> ?), '[]'))
					 ), updated_at = ? WHERE EXISTS (
					  SELECT 1 FROM json_each(scope_json, '$.productIds') WHERE value = ?
					 )`,
				)
				.bind(data.id, now, data.id),
			context.db
				.prepare(
					`DELETE FROM notification_deliveries WHERE entitlement_id IN
					 (SELECT id FROM customer_entitlements WHERE product_id = ?)`,
				)
				.bind(data.id),
			context.db
				.prepare(
					`DELETE FROM entitlement_events WHERE entitlement_id IN
					 (SELECT id FROM customer_entitlements WHERE product_id = ?)`,
				)
				.bind(data.id),
			context.db
				.prepare(
					`DELETE FROM entitlement_grants WHERE entitlement_id IN
					 (SELECT id FROM customer_entitlements WHERE product_id = ?)
					 OR renewed_from_entitlement_id IN
					 (SELECT id FROM customer_entitlements WHERE product_id = ?)`,
				)
				.bind(data.id, data.id),
			context.db
				.prepare(
					`DELETE FROM automation_jobs WHERE entitlement_id IN
					 (SELECT id FROM customer_entitlements WHERE product_id = ?)`,
				)
				.bind(data.id),
			context.db
				.prepare(
					`DELETE FROM delivery_records WHERE order_item_id IN
					 (SELECT id FROM shop_order_items WHERE product_id = ?)`,
				)
				.bind(data.id),
			context.db
				.prepare(
					`DELETE FROM stock_entries WHERE sellable_item_id IN
					 (SELECT id FROM product_sellable_items WHERE product_id = ?)`,
				)
				.bind(data.id),
			context.db
				.prepare("DELETE FROM customer_entitlements WHERE product_id = ?")
				.bind(data.id),
			context.db
				.prepare("DELETE FROM product_definition_versions WHERE product_id = ?")
				.bind(data.id),
			context.db
				.prepare("DELETE FROM download_assets WHERE product_id = ?")
				.bind(data.id),
			context.db
				.prepare("DELETE FROM product_sellable_items WHERE product_id = ?")
				.bind(data.id),
			context.db.prepare("DELETE FROM products WHERE id = ?").bind(data.id),
			auditStatement(context, {
				action: "product.permanently_deleted",
				targetType: "product",
				targetId: data.id,
				before: row,
				now,
			}),
		]);
		await removeSellableItemsFromAllCarts(context.db, sellableItemIds);
		if (context.env.FILES) {
			await Promise.allSettled(
				objectRows.results.map((object) =>
					context.env.FILES?.delete(object.object_key),
				),
			);
		}
		return { id: data.id };
	});

export const listInventoryFn = createServerFn({ method: "GET" })
	.validator((input: z.input<typeof inventoryListSchema>) =>
		inventoryListSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const { db } = await adminContext(systemPermission("inventory", "read"));
		const search = data.search ? `%${data.search}%` : null;
		const conditions = ["p.id = ?"];
		const bindings: unknown[] = [data.productId];
		if (data.componentId) {
			conditions.push("sellableItem.id = ?");
			bindings.push(data.componentId);
		}
		if (search) {
			conditions.push("(cs.content_mask LIKE ? OR sellableItem.name LIKE ?)");
			bindings.push(search, search);
		}
		const where = `WHERE ${conditions.join(" AND ")}`;
		const offset = data.pageIndex * data.pageSize;
		const page = pageResults(
			await db.batch([
				db
					.prepare(
						`SELECT COUNT(*) AS total FROM stock_entries cs
						 INNER JOIN product_sellable_items sellableItem
						  ON sellableItem.id = cs.sellable_item_id
						 INNER JOIN products p ON p.id = sellableItem.product_id ${where}`,
					)
					.bind(...bindings),
				db
					.prepare(
						`SELECT cs.id, cs.sellable_item_id AS delivery_component_id,
						 cs.content_mask, cs.status, cs.note,
					 cs.order_item_id, cs.reserved_at, cs.delivered_at, cs.created_at,
					 sellableItem.name AS sellable_item_name, p.name AS product_name
					 FROM stock_entries cs
					 INNER JOIN product_sellable_items sellableItem
					  ON sellableItem.id = cs.sellable_item_id
					 INNER JOIN products p ON p.id = sellableItem.product_id
					 ${where}
					 ORDER BY cs.created_at DESC, cs.id DESC LIMIT ? OFFSET ?`,
					)
					.bind(...bindings, data.pageSize, offset),
			]),
		);
		return {
			data: page.rows.map((row) => ({
				id: String(row.id),
				componentId: String(row.delivery_component_id),
				productName: String(row.product_name),
				sellableItemName: String(row.sellable_item_name),
				secretMask: String(row.content_mask),
				status: String(row.status) as
					| "available"
					| "reserved"
					| "delivered"
					| "disabled",
				note: row.note ? String(row.note) : null,
				orderItemId: row.order_item_id ? String(row.order_item_id) : null,
				reservedAt: row.reserved_at ? Number(row.reserved_at) : null,
				deliveredAt: row.delivered_at ? Number(row.delivered_at) : null,
				createdAt: Number(row.created_at),
			})),
			total: page.total,
		};
	});

export const importInventoryFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof inventoryImportSchema>) =>
		inventoryImportSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await adminContext(systemPermission("inventory", "create"));
		const component = await context.db
			.prepare(
				`SELECT item.id FROM product_sellable_items item
				 JOIN products product ON product.id = item.product_id
				 WHERE item.id = ? AND product.product_type = 'stock'
				  AND item.fulfillment_source = 'local'
				  AND item.enabled = 1 LIMIT 1`,
			)
			.bind(data.componentId)
			.first<{ id: string }>();
		if (!component)
			throw new DomainError(
				"stock_component_not_found",
				404,
				"Stock delivery component not found",
			);
		const secrets = normalizeInventorySecrets(data.content);
		if (secrets.length > 5_000)
			throw new DomainError(
				"inventory_batch_too_large",
				400,
				"Import at most 5000 stock entries at a time",
			);
		if (!context.runtime.commerceSecret)
			throw new DomainError(
				"inventory_secret_unavailable",
				503,
				"Inventory encryption secret is unavailable",
			);
		const prepared = await Promise.all(
			secrets.map(async (secret) => ({
				id: crypto.randomUUID(),
				fingerprint: await fingerprintInventorySecret(
					secret,
					context.runtime.commerceSecret,
				),
				mask: maskInventorySecret(secret),
				encrypted: await encryptSecret(
					secret,
					context.runtime.commerceSecret,
					"stock-entry",
				),
			})),
		);
		const now = Date.now();
		let imported = 0;
		for (let offset = 0; offset < prepared.length; offset += 100) {
			const results = await context.db.batch(
				prepared.slice(offset, offset + 100).map((item) =>
					context.db
						.prepare(
							`INSERT OR IGNORE INTO stock_entries
							 (id, sellable_item_id, content_encrypted, key_version, content_fingerprint, content_mask,
							  status, note, created_at, updated_at)
							 VALUES (?, ?, ?, 1, ?, ?, 'available', ?, ?, ?)`,
						)
						.bind(
							item.id,
							data.componentId,
							item.encrypted,
							item.fingerprint,
							item.mask,
							data.note ?? null,
							now,
							now,
						),
				),
			);
			imported += results.reduce(
				(count, result) => count + Number(result.meta.changes ?? 0),
				0,
			);
		}
		await context.db.batch([
			auditStatement(context, {
				action: "inventory.imported",
				targetType: "delivery_component",
				targetId: data.componentId,
				after: {
					imported,
					duplicates: prepared.length - imported,
				},
				now,
			}),
		]);
		return {
			imported,
			duplicates: prepared.length - imported,
		};
	});

export const setInventoryStatusFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof inventoryStatusInputSchema>) =>
		inventoryStatusInputSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await adminContext(systemPermission("inventory", "update"));
		const before = await context.db
			.prepare("SELECT id, status FROM stock_entries WHERE id = ? LIMIT 1")
			.bind(data.id)
			.first<{ id: string; status: string }>();
		if (!before)
			throw new DomainError(
				"inventory_not_found",
				404,
				"Stock entry not found",
			);
		if (!["available", "disabled"].includes(before.status))
			throw new DomainError(
				"inventory_locked",
				409,
				"Reserved or delivered inventory cannot be changed",
			);
		const now = Date.now();
		await context.db.batch([
			context.db
				.prepare(
					"UPDATE stock_entries SET status = ?, updated_at = ? WHERE id = ?",
				)
				.bind(data.status, now, data.id),
			auditStatement(context, {
				action: "inventory.status_updated",
				targetType: "stock_secret",
				targetId: data.id,
				before,
				after: { status: data.status },
				now,
			}),
		]);
		return data;
	});

export const revealInventorySecretFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof inventoryRevealSchema>) =>
		inventoryRevealSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await adminContext(systemPermission("inventory", "update"));
		await verifySensitiveAdminAction(context.request, context.user.id, data);
		const row = await context.db
			.prepare(
				"SELECT content_encrypted, content_mask FROM stock_entries WHERE id = ? LIMIT 1",
			)
			.bind(data.id)
			.first<{ content_encrypted: string; content_mask: string }>();
		if (!row)
			throw new DomainError(
				"inventory_not_found",
				404,
				"Stock entry not found",
			);
		if (!context.runtime.commerceSecret)
			throw new DomainError(
				"inventory_secret_unavailable",
				503,
				"Inventory encryption secret is unavailable",
			);
		const now = Date.now();
		await context.db.batch([
			auditStatement(context, {
				action: "inventory.revealed",
				targetType: "stock_secret",
				targetId: data.id,
				after: { mask: row.content_mask },
				now,
			}),
		]);
		return {
			id: data.id,
			secret: await decryptSecret(
				row.content_encrypted,
				context.runtime.commerceSecret,
				"stock-entry",
			),
		};
	});

export const exportInventoryFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof inventoryExportSchema>) =>
		inventoryExportSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await adminContext(systemPermission("inventory", "update"));
		await verifySensitiveAdminAction(context.request, context.user.id, data);
		if (!context.runtime.commerceSecret)
			throw new DomainError(
				"inventory_secret_unavailable",
				503,
				"Inventory encryption secret is unavailable",
			);
		const conditions: string[] = [];
		const bindings: unknown[] = [];
		if (data.componentId) {
			conditions.push("cs.sellable_item_id = ?");
			bindings.push(data.componentId);
		}
		if (data.status) {
			conditions.push("cs.status = ?");
			bindings.push(data.status);
		}
		const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
		const rows = await context.db
			.prepare(
				`SELECT cs.id, cs.content_encrypted, cs.content_mask, cs.status,
				 sellableItem.id AS component_id,
				 sellableItem.name AS sellable_item_name, p.name AS product_name
				 FROM stock_entries cs JOIN product_sellable_items sellableItem
				  ON sellableItem.id = cs.sellable_item_id
				 JOIN products p ON p.id = sellableItem.product_id ${where}
				 ORDER BY cs.created_at, cs.id LIMIT 1001`,
			)
			.bind(...bindings)
			.all<{
				id: string;
				content_encrypted: string;
				content_mask: string;
				status: string;
				component_id: string;
				sellable_item_name: string;
				product_name: string;
			}>();
		if (rows.results.length > 1_000)
			throw new DomainError(
				"inventory_export_too_large",
				400,
				"Narrow the export to at most 1000 stock entries",
			);
		const secrets = await Promise.all(
			rows.results.map((row) =>
				decryptSecret(
					row.content_encrypted,
					context.runtime.commerceSecret,
					"stock-entry",
				),
			),
		);
		const now = Date.now();
		await context.db.batch([
			auditStatement(context, {
				action: "inventory.exported",
				targetType: "stock_secret_export",
				targetId: data.componentId ?? "all",
				after: { count: rows.results.length, status: data.status ?? null },
				now,
			}),
		]);
		const header = [
			"product",
			"sellable_item",
			"component_id",
			"status",
			"mask",
			"secret",
		];
		const content = [
			header,
			...rows.results.map((row, index) => [
				row.product_name,
				row.sellable_item_name,
				row.component_id,
				row.status,
				row.content_mask,
				secrets[index] ?? "",
			]),
		]
			.map((values) => values.map(csvCell).join(","))
			.join("\r\n");
		return {
			filename: `gmshop-inventory-${new Date(now).toISOString().slice(0, 10)}.csv`,
			content,
		};
	});

export const deleteInventoryFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof recordIdSchema>) =>
		recordIdSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await adminContext(systemPermission("inventory", "delete"));
		const row = await context.db
			.prepare(
				"SELECT id, sellable_item_id AS delivery_component_id, content_mask, status FROM stock_entries WHERE id = ? LIMIT 1",
			)
			.bind(data.id)
			.first<Record<string, unknown> & { status: string }>();
		if (!row)
			throw new DomainError(
				"inventory_not_found",
				404,
				"Stock entry not found",
			);
		if (!["available", "disabled"].includes(row.status))
			throw new DomainError(
				"inventory_locked",
				409,
				"Reserved or delivered inventory cannot be deleted",
			);
		const now = Date.now();
		await context.db.batch([
			context.db
				.prepare("DELETE FROM stock_entries WHERE id = ?")
				.bind(data.id),
			auditStatement(context, {
				action: "inventory.deleted",
				targetType: "stock_secret",
				targetId: data.id,
				before: row,
				now,
			}),
		]);
		return { id: data.id };
	});

async function adminContext(permission: ReturnType<typeof systemPermission>) {
	const { currentUser, ...context } =
		await getAdminRuntimeServerContext(permission);
	return { ...context, user: currentUser };
}

async function updateProductLifecycle(
	context: AuditContext,
	id: string,
	expectedRevision: number,
	currentState: "trashed" | "not_trashed",
) {
	const product = await context.db
		.prepare(
			"SELECT id, status, revision, trashed_at FROM products WHERE id = ?",
		)
		.bind(id)
		.first<Record<string, unknown>>();
	if (!product)
		throw new DomainError("product_not_found", 404, "Product not found");
	const stateCondition =
		currentState === "trashed" ? "status = 'trashed'" : "status <> 'trashed'";
	const result = await context.db
		.prepare(
			`UPDATE products SET revision = revision + 1, revision_token = ?
			 WHERE id = ? AND revision = ? AND ${stateCondition}`,
		)
		.bind(crypto.randomUUID(), id, expectedRevision)
		.run();
	if (Number(result.meta.changes) !== 1)
		throw new DomainError(
			"product_revision_conflict",
			409,
			"Product changed since it was loaded",
		);
	return { ...product, revision: expectedRevision + 1 };
}

function auditStatement(
	context: AuditContext,
	entry: {
		action: string;
		targetType: string;
		targetId: string;
		before?: unknown;
		after?: unknown;
		now: number;
	},
) {
	return context.db
		.prepare(
			`INSERT INTO audit_logs
			 (id, actor_user_id, action, target_type, target_id, request_id, ip_address, before, after, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			crypto.randomUUID(),
			context.user.id,
			entry.action,
			entry.targetType,
			entry.targetId,
			context.request.headers.get("x-request-id"),
			clientIp(context.request),
			entry.before == null ? null : JSON.stringify(entry.before),
			entry.after == null ? null : JSON.stringify(entry.after),
			entry.now,
		);
}

async function requireRecord(
	db: D1Database,
	table: "products" | "product_sellable_items",
	id: string,
	code: string,
) {
	const row = await db
		.prepare(`SELECT id FROM ${table} WHERE id = ? LIMIT 1`)
		.bind(id)
		.first();
	if (!row) throw new DomainError(code, 404, "Referenced record was not found");
}

function assertProductMediaImage(bytes: Uint8Array, contentType: string) {
	const dimensions = readImageDimensions(bytes, contentType);
	if (!dimensions)
		throw new DomainError(
			"product_media_invalid",
			400,
			"Product media is not a valid image",
		);
}

function pageResults(results: D1Result<unknown>[]) {
	const [countResult, rowsResult] = results;
	const countRow = countResult?.results?.[0] as { total?: unknown } | undefined;
	return {
		rows: (rowsResult?.results ?? []) as Array<Record<string, unknown>>,
		total: Number(countRow?.total ?? 0),
	};
}
