import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { systemPermission } from "#/features/access/system-rbac";
import {
	productContentInputSchema,
	productCreateInputSchema,
	productEditorIdSchema,
	productSaleDisabledInputSchema,
	productSellableItemsInputSchema,
	publishProductInputSchema,
	sellableItemSaleDisabledInputSchema,
} from "#/features/catalog/editor-schema";
import { assertProductTypeChange } from "#/features/catalog/product-type-invariant";
import { removeSellableItemsFromAllCarts } from "#/features/storefront/server/cart";
import { supplierFallbackEnabledExpression } from "#/features/storefront/server/stock-availability";
import { DomainError } from "#/lib/domain-error";
import { getAdminServerContext } from "#/server/context";

type EditorContext = Awaited<ReturnType<typeof getAdminServerContext>>;
type Row = Record<string, unknown>;

export const createProductDraftFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof productCreateInputSchema>) =>
		productCreateInputSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await getAdminServerContext(
			systemPermission("products", "create"),
		);
		return createProductDraft(context, data);
	});

export async function createProductDraft(
	context: EditorContext,
	data: z.infer<typeof productCreateInputSchema>,
) {
	const id = crypto.randomUUID();
	const now = Date.now();
	const token = crypto.randomUUID();
	await context.db.$client.batch([
		context.db.$client
			.prepare(
				`INSERT INTO products
					 (id, name, description, tag_names, product_type, status, revision, revision_token, sort_order, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, 'draft', 1, ?,
					 COALESCE((SELECT MAX(sort_order) + 100 FROM products), 100), ?, ?)`,
			)
			.bind(
				id,
				data.name,
				data.description,
				JSON.stringify(data.tagNames),
				data.productType,
				token,
				now,
				now,
			),
		audit(context, "product.draft_created", "product", id, now),
	]);
	return { id, revision: 1 };
}

export const duplicateProductFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof productEditorIdSchema>) =>
		productEditorIdSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await getAdminServerContext(
			systemPermission("products", "create"),
		);
		return duplicateProduct(context, data.productId);
	});

export async function duplicateProduct(
	context: EditorContext,
	sourceProductId: string,
) {
	const source = await context.db.$client
		.prepare("SELECT * FROM products WHERE id = ? LIMIT 1")
		.bind(sourceProductId)
		.first<Row>();
	if (!source)
		throw new DomainError("product_not_found", 404, "Product not found");
	const sellableItems = await all(
		context,
		"SELECT * FROM product_sellable_items WHERE product_id = ?",
		sourceProductId,
	);
	const productId = crypto.randomUUID();
	if (
		sellableItems.some((row) => String(row.fulfillment_source) === "supplier")
	)
		throw new DomainError(
			"supplier_product_cannot_be_duplicated",
			409,
			"Supplier products must be imported from the supplier catalog",
		);
	const sellableItemIds = new Map(
		sellableItems.map((row) => [String(row.id), crypto.randomUUID()]),
	);
	const now = Date.now();
	const statements: D1PreparedStatement[] = [
		context.db.$client
			.prepare(
				`INSERT INTO products
					 (id, name, description, tag_names, product_type, status, revision, revision_token, sort_order, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, 'draft', 1, ?, COALESCE((SELECT MAX(sort_order) + 100 FROM products), 100), ?, ?)`,
			)
			.bind(
				productId,
				`${String(source.name)} (Copy)`,
				source.description ?? null,
				source.tag_names,
				source.product_type,
				crypto.randomUUID(),
				now,
				now,
			),
	];
	for (const [index, row] of sellableItems.entries()) {
		const sellableItemId = requiredMappedId(sellableItemIds, row.id);
		statements.push(
			context.db.$client
				.prepare(
					`INSERT INTO product_sellable_items
						 (id, product_id, name, policy_json, duration_ms, usage_limit, access_limit,
						  renewal_mode, email_mode, show_on_order_page, allow_resend,
						  low_stock_threshold, version, currency, currency_decimals,
						  list_price_minor, price_minor,
						  cost_minor, minimum_quantity, maximum_quantity, maximum_per_customer,
						  sort_order, enabled, created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.bind(
					sellableItemId,
					productId,
					row.name,
					row.policy_json ?? "{}",
					row.duration_ms ?? null,
					row.usage_limit ?? null,
					row.access_limit ?? null,
					row.renewal_mode,
					row.email_mode,
					row.show_on_order_page,
					row.allow_resend,
					row.low_stock_threshold,
					row.currency,
					row.currency_decimals,
					row.list_price_minor ?? null,
					row.price_minor,
					row.cost_minor ?? null,
					row.minimum_quantity,
					row.maximum_quantity,
					row.maximum_per_customer ?? null,
					(index + 1) * 100,
					row.enabled,
					now,
					now,
				),
		);
	}
	statements.push(
		audit(context, "product.duplicated", "product", productId, now),
	);
	await context.db.$client.batch(statements);
	return { id: productId, revision: 1 };
}

export const getProductEditorFn = createServerFn({ method: "GET" })
	.validator((input: z.input<typeof productEditorIdSchema>) =>
		productEditorIdSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await getAdminServerContext(
			systemPermission("products", "read"),
		);
		const [product, sellableItems] = await Promise.all([
			context.db.$client
				.prepare("SELECT * FROM products WHERE id = ? LIMIT 1")
				.bind(data.productId)
				.first<Row>(),
			all(
				context,
				`SELECT item.*, ${supplierFallbackEnabledExpression("item")} AS supplier_fallback_enabled, binding.id AS supplier_binding_id,
				        binding.provider AS supplier_provider,
				        binding.normalized_api_origin AS supplier_api_origin,
				        binding.upstream_product_id, binding.upstream_sku_id,
				        binding.upstream_product_name, binding.upstream_sku_name,
				        binding.reference_cost_minor, binding.max_cost_minor,
				        binding.stock_quantity AS supplier_stock_quantity,
				        binding.remote_status AS supplier_remote_status,
				        binding.last_synced_at AS supplier_last_synced_at
				 FROM product_sellable_items item
				 LEFT JOIN supplier_bindings binding
				  ON binding.sellable_item_id = item.id AND binding.enabled = 1
				 WHERE item.product_id = ? ORDER BY item.sort_order, item.id`,
				data.productId,
			),
		]);
		if (!product)
			throw new DomainError("product_not_found", 404, "Product not found");
		return {
			product: {
				id: String(product.id),
				name: String(product.name),
				description:
					product.description == null ? null : String(product.description),
				productType: String(product.product_type) as
					| "stock"
					| "download"
					| "automation",
				tagNames: z
					.array(z.string())
					.parse(JSON.parse(String(product.tag_names))),
				status: String(product.status) as "draft" | "active" | "trashed",
				saleDisabled: Boolean(product.sale_disabled),
				revision: Number(product.revision),
				coverObjectKey: product.cover_object_key
					? String(product.cover_object_key)
					: null,
			},
			sellableItems: sellableItems.map((sellableItem) => ({
				id: String(sellableItem.id),
				name: String(sellableItem.name),
				listPriceMinor:
					sellableItem.list_price_minor == null
						? null
						: String(sellableItem.list_price_minor),
				priceMinor: String(sellableItem.price_minor),
				costMinor:
					sellableItem.cost_minor == null
						? null
						: String(sellableItem.cost_minor),
				currency: String(sellableItem.currency),
				currencyDecimals: Number(sellableItem.currency_decimals),
				minimumQuantity: Number(sellableItem.minimum_quantity),
				maximumQuantity: Number(sellableItem.maximum_quantity),
				maximumPerCustomer:
					sellableItem.maximum_per_customer == null
						? null
						: Number(sellableItem.maximum_per_customer),
				reminderCycleDays:
					sellableItem.reminder_cycle_days == null
						? null
						: Number(sellableItem.reminder_cycle_days),
				deliveryComponentId: String(sellableItem.id),
				enabled: Boolean(sellableItem.enabled),
				saleDisabled: Boolean(sellableItem.sale_disabled),
				supplierFallbackEnabled: Boolean(
					sellableItem.supplier_fallback_enabled,
				),
				fulfillmentSource: String(sellableItem.fulfillment_source) as
					| "local"
					| "manual"
					| "supplier",
				supplierStatus:
					sellableItem.supplier_status == null
						? null
						: (String(sellableItem.supplier_status) as
								| "available"
								| "unavailable"
								| "sync_error"),
				supplierBinding:
					sellableItem.supplier_binding_id == null
						? null
						: {
								id: String(sellableItem.supplier_binding_id),
								provider: String(sellableItem.supplier_provider) as
									| "acg"
									| "dujiao_next"
									| "gmshop_edge"
									| "shared_stock",
								normalizedApiOrigin: String(sellableItem.supplier_api_origin),
								upstreamProductId: String(sellableItem.upstream_product_id),
								upstreamSkuId: String(sellableItem.upstream_sku_id),
								upstreamProductName: String(sellableItem.upstream_product_name),
								upstreamSkuName: String(sellableItem.upstream_sku_name),
								referenceCostMinor: String(sellableItem.reference_cost_minor),
								maxCostMinor: String(sellableItem.max_cost_minor),
								stockQuantity: Number(sellableItem.supplier_stock_quantity),
								remoteStatus: String(sellableItem.supplier_remote_status) as
									| "active"
									| "inactive"
									| "deleted"
									| "unknown",
								lastSyncedAt:
									sellableItem.supplier_last_synced_at == null
										? null
										: Number(sellableItem.supplier_last_synced_at),
							},
			})),
			components: sellableItems.map((item) =>
				componentResult(item, String(product.product_type)),
			),
			publishCheck: await checkProduct(context, data.productId),
		};
	});

export const saveProductContentFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof productContentInputSchema>) =>
		productContentInputSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await getAdminServerContext(
			systemPermission("products", "update"),
		);
		if (data.coverObjectKey) {
			const media = await context.db.$client
				.prepare(
					"SELECT 1 FROM product_media WHERE product_id = ? AND object_key = ? LIMIT 1",
				)
				.bind(data.productId, data.coverObjectKey)
				.first();
			if (!media)
				throw new DomainError(
					"product_cover_invalid",
					400,
					"Select a cover uploaded for this product",
				);
		}
		await assertProductTypeChange(
			context.db.$client,
			data.productId,
			data.productType,
		);
		const revision = await claimRevision(
			context,
			data.productId,
			data.expectedRevision,
		);
		const now = Date.now();
		await context.db.$client.batch([
			context.db.$client
				.prepare(
					"UPDATE products SET name = ?, description = ?, tag_names = ?, product_type = ?, cover_object_key = ?, status = 'draft', updated_at = ? WHERE id = ?",
				)
				.bind(
					data.name,
					data.description,
					JSON.stringify(data.tagNames),
					data.productType,
					data.coverObjectKey,
					now,
					data.productId,
				),
			audit(context, "product.content_updated", "product", data.productId, now),
		]);
		return { id: data.productId, revision };
	});

export const saveProductSellableItemsFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof productSellableItemsInputSchema>) =>
		productSellableItemsInputSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await getAdminServerContext(
			systemPermission("products", "update"),
		);
		await assertSellableItemOwnership(context, data);
		const product = await context.db.$client
			.prepare("SELECT product_type FROM products WHERE id = ? LIMIT 1")
			.bind(data.productId)
			.first<{ product_type: string }>();
		if (!product)
			throw new DomainError("product_not_found", 404, "Product not found");
		if (
			data.sellableItems.some(
				(item) => item.delivery.type !== product.product_type,
			)
		)
			throw new DomainError(
				"sellable_item_delivery_type_mismatch",
				409,
				"Every sellable item must use the product delivery type",
			);
		await assertSupplierSellableItemChanges(context, data);
		const revision = await claimRevision(
			context,
			data.productId,
			data.expectedRevision,
		);
		const now = Date.now();
		const existing = await all(
			context,
			"SELECT * FROM product_sellable_items WHERE product_id = ?",
			data.productId,
		);
		const submittedIds = new Set<string>();
		const removedSellableItemIds: string[] = [];
		const itemIdMap: Record<string, string> = {};
		const statements: D1PreparedStatement[] = [
			context.db.$client
				.prepare(
					"UPDATE products SET status = 'draft', updated_at = ? WHERE id = ?",
				)
				.bind(now, data.productId),
		];
		for (const [index, item] of data.sellableItems.entries()) {
			const id = item.id ?? crypto.randomUUID();
			if (item.id) itemIdMap[item.id] = id;
			submittedIds.add(id);
			const delivery = {
				...item.delivery,
				renewalMode: inferRenewalMode(item.delivery),
				emailMode:
					item.delivery.emailMode === "none"
						? ("none" as const)
						: inferEmailMode(item.delivery),
			};
			const current = existing.find((row) => String(row.id) === id);
			const version =
				Number(current?.version ?? 0) +
				(current && !componentChanged(current, delivery) ? 0 : 1);
			statements.push(
				context.db.$client
					.prepare(
						`INSERT INTO product_sellable_items
						 (id, product_id, name, duration_ms, usage_limit, access_limit,
						  renewal_mode, email_mode, show_on_order_page, allow_resend,
						  low_stock_threshold, version, currency, currency_decimals,
						  list_price_minor, price_minor, cost_minor, minimum_quantity,
						  maximum_quantity, maximum_per_customer, sort_order, enabled, sale_disabled,
						  reminder_cycle_days, created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
						 ON CONFLICT(id) DO UPDATE SET name = excluded.name,
						  duration_ms = excluded.duration_ms,
						  usage_limit = excluded.usage_limit,
						  access_limit = excluded.access_limit,
						  renewal_mode = excluded.renewal_mode,
						  email_mode = excluded.email_mode,
						  show_on_order_page = excluded.show_on_order_page,
						  allow_resend = excluded.allow_resend,
						  low_stock_threshold = excluded.low_stock_threshold,
						  version = excluded.version,
						  currency = excluded.currency,
						  currency_decimals = excluded.currency_decimals,
						  list_price_minor = excluded.list_price_minor,
						  price_minor = excluded.price_minor,
						  cost_minor = excluded.cost_minor,
						  minimum_quantity = excluded.minimum_quantity,
						  maximum_quantity = excluded.maximum_quantity,
						  maximum_per_customer = excluded.maximum_per_customer,
						  sort_order = excluded.sort_order,
						  enabled = excluded.enabled,
						  sale_disabled = excluded.sale_disabled,
						  reminder_cycle_days = excluded.reminder_cycle_days,
						  updated_at = excluded.updated_at`,
					)
					.bind(
						id,
						data.productId,
						item.name,
						delivery.durationMs,
						delivery.usageLimit,
						delivery.accessLimit,
						delivery.renewalMode,
						delivery.emailMode,
						delivery.showOnOrderPage ? 1 : 0,
						delivery.allowResend ? 1 : 0,
						delivery.lowStockThreshold,
						version,
						item.currency,
						item.currencyDecimals,
						item.listPriceMinor,
						item.priceMinor,
						item.costMinor,
						item.minimumQuantity,
						item.maximumQuantity,
						item.maximumPerCustomer,
						(index + 1) * 100,
						item.enabled ? 1 : 0,
						item.saleDisabled ? 1 : 0,
						item.reminderCycleDays === undefined
							? current?.reminder_cycle_days == null
								? null
								: Number(current.reminder_cycle_days)
							: item.reminderCycleDays,
						now,
						now,
					),
			);
		}
		for (const old of existing) {
			const id = String(old.id);
			if (!submittedIds.has(id)) {
				removedSellableItemIds.push(id);
				statements.push(
					context.db.$client
						.prepare(
							`DELETE FROM product_sellable_items WHERE id = ? AND NOT EXISTS (SELECT 1 FROM shop_order_items WHERE sellable_item_id = ?) AND NOT EXISTS (SELECT 1 FROM customer_entitlements WHERE sellable_item_id = ?);`,
						)
						.bind(id, id, id),
					context.db.$client
						.prepare(
							"UPDATE product_sellable_items SET enabled = 0, updated_at = ? WHERE id = ?",
						)
						.bind(now, id),
				);
			}
		}
		statements.push(
			audit(
				context,
				"product.sellable_items_updated",
				"product",
				data.productId,
				now,
			),
		);
		await removeSellableItemsFromAllCarts(
			context.db.$client,
			removedSellableItemIds,
		);
		await context.db.$client.batch(statements);
		await removeSellableItemsFromAllCarts(
			context.db.$client,
			removedSellableItemIds,
		);
		return { id: data.productId, revision, itemIdMap };
	});

export const publishProductFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof publishProductInputSchema>) =>
		publishProductInputSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await getAdminServerContext(
			systemPermission("products", "update"),
		);
		const product = await context.db.$client
			.prepare("SELECT status FROM products WHERE id = ? LIMIT 1")
			.bind(data.productId)
			.first<{ status: string }>();
		if (!product)
			throw new DomainError("product_not_found", 404, "Product not found");
		if (product.status === "trashed")
			throw new DomainError(
				"product_trashed",
				409,
				"Restore the product before changing its selling status",
			);
		const check = await checkProduct(context, data.productId);
		if (data.publish && check.blockers.length)
			throw new DomainError(
				"product_publish_blocked",
				409,
				check.blockers.map((item) => item.message).join("; "),
			);
		const revision = await claimRevision(
			context,
			data.productId,
			data.expectedRevision,
		);
		const now = Date.now();
		await context.db.$client.batch([
			context.db.$client
				.prepare("UPDATE products SET status = ?, updated_at = ? WHERE id = ?")
				.bind(data.publish ? "active" : "draft", now, data.productId),
			audit(
				context,
				data.publish ? "product.published" : "product.unpublished",
				"product",
				data.productId,
				now,
			),
		]);
		return {
			id: data.productId,
			revision,
			status: data.publish ? ("active" as const) : ("draft" as const),
		};
	});

export const setProductSaleDisabledFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof productSaleDisabledInputSchema>) =>
		productSaleDisabledInputSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await getAdminServerContext(
			systemPermission("products", "update"),
		);
		return setProductSaleDisabled(context, data);
	});

export async function setProductSaleDisabled(
	context: EditorContext,
	data: z.infer<typeof productSaleDisabledInputSchema>,
) {
	const product = await context.db.$client
		.prepare("SELECT status FROM products WHERE id = ? LIMIT 1")
		.bind(data.productId)
		.first<{ status: string }>();
	if (!product)
		throw new DomainError("product_not_found", 404, "Product not found");
	if (product.status !== "active")
		throw new DomainError(
			"product_not_active",
			409,
			"Only an active product can change its sale-disabled state",
		);
	const revision = await claimRevision(
		context,
		data.productId,
		data.expectedRevision,
	);
	const now = Date.now();
	await context.db.$client.batch([
		context.db.$client
			.prepare(
				"UPDATE products SET sale_disabled = ?, updated_at = ? WHERE id = ?",
			)
			.bind(data.disabled ? 1 : 0, now, data.productId),
		context.db.$client
			.prepare(
				`INSERT OR IGNORE INTO outbox_events
				 (id, event_type, aggregate_type, aggregate_id, idempotency_key, payload,
				  status, attempt_count, created_at, updated_at)
				 SELECT ?, 'inventory.changed', 'sellable_item', item.id, ?,
				  json_object('sellableItemId', item.id, 'changedAt', ?),
				  'pending', 0, ?, ?
				 FROM product_sellable_items item
				 JOIN supplier_export_listings listing
				  ON listing.sellable_item_id = item.id AND listing.enabled = 1
				 WHERE item.product_id = ? AND item.enabled = 1
				 ORDER BY item.sort_order, item.id LIMIT 1`,
			)
			.bind(
				`sale-product:${data.productId}:${revision}`,
				`sale-product:${data.productId}:${revision}`,
				now,
				now,
				now,
				data.productId,
			),
		audit(
			context,
			data.disabled ? "product.sale_disabled" : "product.sale_enabled",
			"product",
			data.productId,
			now,
		),
	]);
	return {
		id: data.productId,
		revision,
		saleDisabled: data.disabled,
	};
}

export const setSellableItemSaleDisabledFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof sellableItemSaleDisabledInputSchema>) =>
		sellableItemSaleDisabledInputSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await getAdminServerContext(
			systemPermission("products", "update"),
		);
		return setSellableItemSaleDisabled(context, data);
	});

export async function setSellableItemSaleDisabled(
	context: EditorContext,
	data: z.infer<typeof sellableItemSaleDisabledInputSchema>,
) {
	const item = await context.db.$client
		.prepare(
			`SELECT item.id, product.status
			 FROM product_sellable_items item
			 JOIN products product ON product.id = item.product_id
			 WHERE item.id = ? AND item.product_id = ? LIMIT 1`,
		)
		.bind(data.sellableItemId, data.productId)
		.first<{ id: string; status: string }>();
	if (!item)
		throw new DomainError(
			"sellable_item_not_found",
			404,
			"Sellable item not found",
		);
	if (item.status !== "active")
		throw new DomainError(
			"product_not_active",
			409,
			"Only an active product can change its sale-disabled state",
		);
	const revision = await claimRevision(
		context,
		data.productId,
		data.expectedRevision,
	);
	const now = Date.now();
	await context.db.$client.batch([
		context.db.$client
			.prepare(
				"UPDATE product_sellable_items SET sale_disabled = ?, updated_at = ? WHERE id = ?",
			)
			.bind(data.disabled ? 1 : 0, now, data.sellableItemId),
		context.db.$client
			.prepare(
				`INSERT OR IGNORE INTO outbox_events
				 (id, event_type, aggregate_type, aggregate_id, idempotency_key, payload,
				  status, attempt_count, created_at, updated_at)
				 SELECT ?, 'inventory.changed', 'sellable_item', item.id, ?,
				  json_object('sellableItemId', item.id, 'changedAt', ?),
				  'pending', 0, ?, ?
				 FROM product_sellable_items item
				 JOIN supplier_export_listings listing
				  ON listing.sellable_item_id = item.id AND listing.enabled = 1
				 WHERE item.id = ? AND item.enabled = 1`,
			)
			.bind(
				`sale-item:${data.sellableItemId}:${revision}`,
				`sale-item:${data.sellableItemId}:${revision}`,
				now,
				now,
				now,
				data.sellableItemId,
			),
		audit(
			context,
			data.disabled
				? "product.sellable_item_sale_disabled"
				: "product.sellable_item_sale_enabled",
			"sellable_item",
			data.sellableItemId,
			now,
		),
	]);
	return {
		id: data.sellableItemId,
		revision,
		saleDisabled: data.disabled,
	};
}

export async function checkProduct(context: EditorContext, productId: string) {
	const rows = await all(
		context,
		`SELECT sellableItem.id, product.product_type AS type,
		        sellableItem.duration_ms, sellableItem.usage_limit,
		        sellableItem.fulfillment_source, sellableItem.supplier_status,
		        binding.id AS supplier_binding_id,
		        binding.remote_status AS supplier_remote_status,
		        CASE WHEN EXISTS (
		         SELECT 1 FROM supplier_accounts account
		         WHERE account.provider = binding.provider
		          AND account.normalized_api_origin = binding.normalized_api_origin
		          AND account.protocol_version = binding.protocol_version
		          AND account.enabled = 1
		          AND account.health_status <> 'unavailable'
		          AND (account.cooldown_until IS NULL OR account.cooldown_until <= ?)
		        ) THEN 1 ELSE 0 END AS supplier_account_available
		 FROM product_sellable_items sellableItem
		 INNER JOIN products product ON product.id = sellableItem.product_id
		 LEFT JOIN supplier_bindings binding
		  ON binding.sellable_item_id = sellableItem.id AND binding.enabled = 1
		 WHERE sellableItem.product_id = ? AND sellableItem.enabled = 1`,
		Date.now(),
		productId,
	);
	const blockers: { code: string; message: string; target: string }[] = [];
	const warnings: { code: string; message: string; target: string }[] = [];
	const product = await context.db.$client
		.prepare("SELECT name FROM products WHERE id = ? LIMIT 1")
		.bind(productId)
		.first<{ name: string }>();
	if (!product?.name.trim())
		blockers.push(
			issue("content_incomplete", "A product name is required", "content"),
		);
	if (!rows.length)
		blockers.push(
			issue(
				"no_active_sellable_item",
				"At least one enabled sellable item is required",
				"sellableItems",
			),
		);
	for (const row of rows) {
		if (row.fulfillment_source === "supplier") {
			if (!row.supplier_binding_id)
				blockers.push(
					issue(
						"supplier_binding_missing",
						"Supplier fulfillment requires an enabled binding",
						`sellableItem:${String(row.id)}`,
					),
				);
			else {
				if (
					row.supplier_status !== "available" ||
					row.supplier_remote_status !== "active"
				)
					blockers.push(
						issue(
							"supplier_unavailable",
							"The bound supplier item is currently unavailable",
							`sellableItem:${String(row.id)}`,
						),
					);
				if (!row.supplier_account_available)
					blockers.push(
						issue(
							"supplier_account_unavailable",
							"No eligible purchasing account is available",
							`sellableItem:${String(row.id)}`,
						),
					);
			}
		}
		if (row.type === "stock" && row.fulfillment_source === "local") {
			const stock = await context.db.$client
				.prepare(
					"SELECT COUNT(*) AS total FROM stock_entries WHERE sellable_item_id = ? AND status = 'available'",
				)
				.bind(row.id)
				.first<{ total: number }>();
			if (!stock?.total)
				warnings.push(
					issue(
						"stock_out_of_stock",
						"Stock inventory is empty",
						`sellableItem:${String(row.id)}`,
					),
				);
		}
		if (row.type === "stock" && row.fulfillment_source === "manual")
			warnings.push(
				issue(
					"manual_fulfillment_required",
					"Paid orders require an operator to procure and enter delivery content",
					`sellableItem:${String(row.id)}`,
				),
			);
		if (row.type === "download") {
			const asset = await context.db.$client
				.prepare(
					`SELECT 1 FROM download_asset_sellable_items binding
					 JOIN download_assets asset ON asset.id = binding.download_asset_id
					 WHERE binding.sellable_item_id = ?
					  AND asset.download_enabled = 1 LIMIT 1`,
				)
				.bind(row.id)
				.first();
			if (!asset)
				blockers.push(
					issue(
						"download_file_missing",
						"Download items require an enabled file",
						`sellableItem:${String(row.id)}`,
					),
				);
		}
		if (row.type === "automation") {
			const config = await context.db.$client
				.prepare(
					`SELECT 1 FROM product_sellable_items item
					 WHERE item.id = ? AND item.enabled = 1
					  AND item.automation_provider IN ('github_actions', 'gitlab_ci')
					  AND TRIM(item.automation_base_url) <> ''
					  AND TRIM(item.automation_repository_owner) <> ''
					  AND TRIM(item.automation_repository_name) <> ''
					  AND TRIM(item.automation_workflow_file) <> ''
					  AND TRIM(item.automation_credential_encrypted) <> ''
					  AND EXISTS (
					   SELECT 1 FROM product_automation_methods method
					   WHERE method.sellable_item_id = item.id
					    AND method.config_version = item.version
					    AND method.enabled = 1
					    AND TRIM(method.name) <> ''
					    AND (
					     (method.artifact_policy = 'none' AND method.output_pattern = '')
					     OR (method.artifact_policy IN ('optional', 'required')
					      AND TRIM(method.output_pattern) <> '')
					    )
					  )
					  AND EXISTS (
					   SELECT 1 FROM system_settings setting
					   WHERE setting.key = 'runtime.automation_callback_secret'
					    AND json_valid(setting.value)
					    AND LENGTH(CAST(json_extract(setting.value, '$') AS TEXT)) >= 32
					  )
					 LIMIT 1`,
				)
				.bind(row.id)
				.first();
			if (!config)
				blockers.push(
					issue(
						"automation_configuration_missing",
						"Automation items require a valid provider, method, credential, webhook, and artifact policy",
						`sellableItem:${String(row.id)}`,
					),
				);
		}
	}
	return {
		canPublish: blockers.length === 0,
		blockers,
		warnings,
		suggestions: [] as typeof warnings,
	};
}

async function claimRevision(
	context: EditorContext,
	productId: string,
	expected: number,
) {
	const token = crypto.randomUUID();
	const result = await context.db.$client
		.prepare(
			"UPDATE products SET revision = revision + 1, revision_token = ? WHERE id = ? AND revision = ?",
		)
		.bind(token, productId, expected)
		.run();
	if (Number(result.meta.changes) !== 1)
		throw new DomainError(
			"product_revision_conflict",
			409,
			"This product changed in another tab. Reload before saving.",
		);
	return expected + 1;
}

async function assertSellableItemOwnership(
	context: EditorContext,
	input: z.infer<typeof productSellableItemsInputSchema>,
) {
	const sellableItemIds = input.sellableItems.flatMap((item) =>
		item.id ? [item.id] : [],
	);
	const items = await rowsByIds(
		context,
		"SELECT id, product_id FROM product_sellable_items WHERE id IN",
		sellableItemIds,
	);
	for (const row of items)
		if (String(row.product_id) !== input.productId)
			throw new DomainError(
				"product_sellable_item_not_owned",
				409,
				"A sellable item belongs to another product",
			);
}

async function assertSupplierSellableItemChanges(
	context: EditorContext,
	input: z.infer<typeof productSellableItemsInputSchema>,
) {
	const supplierItems = await all(
		context,
		`SELECT id, currency, currency_decimals, cost_minor, low_stock_threshold
		 FROM product_sellable_items
		 WHERE product_id = ? AND fulfillment_source = 'supplier'`,
		input.productId,
	);
	for (const existing of supplierItems) {
		const submitted = input.sellableItems.find(
			(item) => item.id === String(existing.id),
		);
		if (!submitted)
			throw new DomainError(
				"supplier_sellable_item_managed_externally",
				409,
				"Unbind supplier sellable items from supplier management",
			);
		if (
			submitted.currency !== String(existing.currency) ||
			submitted.currencyDecimals !== Number(existing.currency_decimals) ||
			submitted.costMinor !==
				(existing.cost_minor == null ? null : String(existing.cost_minor)) ||
			submitted.delivery.lowStockThreshold !==
				Number(existing.low_stock_threshold)
		)
			throw new DomainError(
				"supplier_sellable_item_managed_externally",
				409,
				"Supplier cost, currency, and inventory settings are read-only",
			);
	}
}

async function rowsByIds(
	context: EditorContext,
	sqlPrefix: string,
	ids: string[],
) {
	const result: Row[] = [];
	for (let offset = 0; offset < ids.length; offset += 50) {
		const chunk = ids.slice(offset, offset + 50);
		result.push(
			...(await all(
				context,
				`${sqlPrefix} (${chunk.map(() => "?").join(",")})`,
				...chunk,
			)),
		);
	}
	return result;
}

function componentChanged(
	row: Row,
	component: z.infer<
		typeof productSellableItemsInputSchema
	>["sellableItems"][number]["delivery"],
) {
	return (
		nullableNumber(row.duration_ms) !== component.durationMs ||
		nullableNumber(row.usage_limit) !== component.usageLimit ||
		nullableNumber(row.access_limit) !== component.accessLimit ||
		String(row.renewal_mode) !== component.renewalMode ||
		String(row.email_mode) !== component.emailMode ||
		Boolean(row.show_on_order_page) !== component.showOnOrderPage ||
		Boolean(row.allow_resend) !== component.allowResend
	);
}

function componentResult(row: Row, type: string) {
	return {
		id: String(row.id),
		type: type as "stock" | "download" | "automation",
		durationMs: nullableNumber(row.duration_ms),
		usageLimit: nullableNumber(row.usage_limit),
		accessLimit: nullableNumber(row.access_limit),
		renewalMode: String(row.renewal_mode) as "stack" | "disabled",
		emailMode: String(row.email_mode) as "none" | "link" | "content",
		showOnOrderPage: Boolean(row.show_on_order_page),
		allowResend: Boolean(row.allow_resend),
		lowStockThreshold: Number(row.low_stock_threshold),
		version: Number(row.version),
		enabled: Boolean(row.enabled),
	};
}

function nullableNumber(value: unknown) {
	return value == null ? null : Number(value);
}
function requiredMappedId(map: Map<string, string>, source: unknown) {
	const result = map.get(String(source));
	if (!result) throw new Error("Missing copied product entity mapping");
	return result;
}
function issue(code: string, message: string, target: string) {
	return { code, message, target };
}
async function all(
	context: EditorContext,
	sql: string,
	...bindings: unknown[]
) {
	const result = await context.db.$client
		.prepare(sql)
		.bind(...bindings)
		.all<Row>();
	return result.results;
}
function inferRenewalMode(policy: {
	durationMs: number | null;
	usageLimit: number | null;
	accessLimit: number | null;
}) {
	return policy.durationMs != null ||
		policy.usageLimit != null ||
		policy.accessLimit != null
		? ("stack" as const)
		: ("disabled" as const);
}
function inferEmailMode(policy: {
	type: "stock" | "download" | "automation";
	durationMs: number | null;
	usageLimit: number | null;
	accessLimit: number | null;
}) {
	const contentSafe =
		policy.type === "stock" &&
		policy.durationMs == null &&
		policy.usageLimit == null &&
		policy.accessLimit == null;
	return contentSafe ? ("content" as const) : ("link" as const);
}
function audit(
	context: EditorContext,
	action: string,
	targetType: string,
	targetId: string,
	now: number,
) {
	return context.db.$client
		.prepare(
			`INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, request_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			crypto.randomUUID(),
			context.currentUser.id,
			action,
			targetType,
			targetId,
			context.request.headers.get("x-request-id"),
			now,
		);
}
