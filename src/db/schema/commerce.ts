import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { users } from "./auth";
import { timestamps } from "./common";

const moneyCheck = (column: { name: string }) =>
	sql.raw(`"${column.name}" <> '' AND "${column.name}" NOT GLOB '*[^0-9]*'`);

const shopOrderStatusValues = [
	"pending_payment",
	"paid",
	"fulfilling",
	"completed",
	"cancelled",
	"expired",
	"refunding",
	"refunded",
	"failed",
] as const;

export const products = sqliteTable(
	"products",
	{
		id: text("id").primaryKey(),
		name: text("name").notNull(),
		description: text("description"),
		tagNames: text("tag_names", { mode: "json" })
			.$type<string[]>()
			.notNull()
			.default([]),
		productType: text("product_type", {
			enum: ["stock", "download", "automation"],
		}).notNull(),
		status: text("status", { enum: ["draft", "active", "trashed"] })
			.notNull()
			.default("draft"),
		trashedAt: integer("trashed_at", { mode: "timestamp_ms" }),
		coverObjectKey: text("cover_object_key"),
		revision: integer("revision").notNull().default(1),
		revisionToken: text("revision_token")
			.notNull()
			.default(sql`(lower(hex(randomblob(16))))`),
		sortOrder: integer("sort_order").notNull().default(100),
		...timestamps,
	},
	(table) => [
		index("products_status_sort_idx").on(
			table.status,
			table.sortOrder,
			table.id,
		),
		check("products_revision_check", sql`${table.revision} > 0`),
		check(
			"products_status_check",
			sql`${table.status} IN ('draft', 'active', 'trashed')`,
		),
		check(
			"products_trash_shape_check",
			sql`(${table.status} = 'trashed' AND ${table.trashedAt} IS NOT NULL) OR
				(${table.status} <> 'trashed' AND ${table.trashedAt} IS NULL)`,
		),
		check(
			"products_product_type_check",
			sql`${table.productType} IN ('stock', 'download', 'automation')`,
		),
	],
);

export const productMedia = sqliteTable(
	"product_media",
	{
		id: text("id").primaryKey(),
		productId: text("product_id")
			.notNull()
			.references(() => products.id, { onDelete: "cascade" }),
		objectKey: text("object_key").notNull(),
		altText: text("alt_text"),
		contentType: text("content_type").notNull(),
		sizeBytes: integer("size_bytes").notNull(),
		sortOrder: integer("sort_order").notNull().default(100),
		...timestamps,
	},
	(table) => [
		uniqueIndex("product_media_object_key_uidx").on(table.objectKey),
		index("product_media_product_sort_idx").on(
			table.productId,
			table.sortOrder,
			table.id,
		),
		check("product_media_size_bytes_check", sql`${table.sizeBytes} > 0`),
	],
);

export const downloadAssets = sqliteTable(
	"download_assets",
	{
		id: text("id").primaryKey(),
		productId: text("product_id")
			.notNull()
			.references(() => products.id),
		objectKey: text("object_key").notNull(),
		fileName: text("file_name").notNull(),
		contentType: text("content_type").notNull(),
		sizeBytes: integer("size_bytes").notNull(),
		checksumSha256: text("checksum_sha256").notNull(),
		version: integer("version").notNull().default(1),
		downloadEnabled: integer("download_enabled", { mode: "boolean" })
			.notNull()
			.default(true),
		sortOrder: integer("sort_order").notNull().default(100),
		...timestamps,
	},
	(table) => [
		uniqueIndex("download_assets_object_key_uidx").on(table.objectKey),
		index("download_assets_product_sort_idx").on(
			table.productId,
			table.downloadEnabled,
			table.sortOrder,
			table.id,
		),
		check("download_assets_size_check", sql`${table.sizeBytes} > 0`),
		check("download_assets_version_check", sql`${table.version} > 0`),
	],
);

export const productSellableItems = sqliteTable(
	"product_sellable_items",
	{
		id: text("id").primaryKey(),
		productId: text("product_id")
			.notNull()
			.references(() => products.id),
		name: text("name").notNull(),
		durationMs: integer("duration_ms"),
		usageLimit: integer("usage_limit"),
		accessLimit: integer("access_limit"),
		renewalMode: text("renewal_mode", { enum: ["stack", "disabled"] })
			.notNull()
			.default("stack"),
		emailMode: text("email_mode", { enum: ["none", "link", "content"] })
			.notNull()
			.default("none"),
		showOnOrderPage: integer("show_on_order_page", { mode: "boolean" })
			.notNull()
			.default(true),
		allowResend: integer("allow_resend", { mode: "boolean" })
			.notNull()
			.default(true),
		fulfillmentSource: text("fulfillment_source", {
			enum: ["local", "supplier"],
		})
			.notNull()
			.default("local"),
		supplierStatus: text("supplier_status", {
			enum: ["available", "unavailable", "sync_error"],
		}),
		lowStockThreshold: integer("low_stock_threshold").notNull().default(5),
		version: integer("version").notNull().default(1),
		automationProvider: text("automation_provider", {
			enum: ["github_actions", "gitlab_ci"],
		}),
		automationBaseUrl: text("automation_base_url"),
		automationRepositoryOwner: text("automation_repository_owner"),
		automationRepositoryName: text("automation_repository_name"),
		automationDefaultBranch: text("automation_default_branch"),
		automationWorkflowFile: text("automation_workflow_file"),
		automationCredentialEncrypted: text("automation_credential_encrypted"),
		automationCredentialKeyVersion: integer(
			"automation_credential_key_version",
		),
		activeDefinitionVersionId: text("active_definition_version_id"),
		currency: text("currency").notNull().default("USD"),
		currencyDecimals: integer("currency_decimals").notNull().default(2),
		listPriceMinor: text("list_price_minor"),
		priceMinor: text("price_minor").notNull(),
		costMinor: text("cost_minor"),
		minimumQuantity: integer("minimum_quantity").notNull().default(1),
		maximumQuantity: integer("maximum_quantity").notNull().default(1),
		maximumPerCustomer: integer("maximum_per_customer"),
		sortOrder: integer("sort_order").notNull().default(100),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
		...timestamps,
	},
	(table) => [
		uniqueIndex("product_sellable_items_product_name_uidx").on(
			table.productId,
			table.name,
		),
		index("product_sellable_items_product_enabled_sort_idx").on(
			table.productId,
			table.enabled,
			table.sortOrder,
			table.id,
		),
		check(
			"product_sellable_items_price_minor_check",
			moneyCheck(table.priceMinor),
		),
		check(
			"product_sellable_items_list_price_minor_check",
			sql`${table.listPriceMinor} IS NULL OR (${moneyCheck(table.listPriceMinor)})`,
		),
		check(
			"product_sellable_items_cost_minor_check",
			sql`${table.costMinor} IS NULL OR (${moneyCheck(table.costMinor)})`,
		),
		check(
			"product_sellable_items_currency_decimals_check",
			sql`${table.currencyDecimals} BETWEEN 0 AND 8`,
		),
		check(
			"product_sellable_items_minimum_quantity_check",
			sql`${table.minimumQuantity} > 0`,
		),
		check(
			"product_sellable_items_maximum_quantity_check",
			sql`${table.maximumQuantity} >= ${table.minimumQuantity}`,
		),
		check(
			"product_sellable_items_maximum_per_customer_check",
			sql`${table.maximumPerCustomer} IS NULL OR ${table.maximumPerCustomer} > 0`,
		),
		check(
			"product_sellable_items_duration_check",
			sql`${table.durationMs} IS NULL OR ${table.durationMs} > 0`,
		),
		check(
			"product_sellable_items_usage_limit_check",
			sql`${table.usageLimit} IS NULL OR ${table.usageLimit} > 0`,
		),
		check(
			"product_sellable_items_access_limit_check",
			sql`${table.accessLimit} IS NULL OR ${table.accessLimit} > 0`,
		),
		check("product_sellable_items_version_check", sql`${table.version} > 0`),
		check(
			"product_sellable_items_fulfillment_source_check",
			sql`${table.fulfillmentSource} IN ('local', 'supplier')`,
		),
		check(
			"product_sellable_items_supplier_status_check",
			sql`(${table.fulfillmentSource} = 'local' AND ${table.supplierStatus} IS NULL) OR
				(${table.fulfillmentSource} = 'supplier' AND ${table.supplierStatus} IS NOT NULL)`,
		),
		check(
			"product_sellable_items_automation_credential_check",
			sql`(${table.automationCredentialEncrypted} IS NULL AND ${table.automationCredentialKeyVersion} IS NULL) OR
				(${table.automationCredentialEncrypted} IS NOT NULL AND ${table.automationCredentialKeyVersion} > 0)`,
		),
	],
);

export const supplierAccounts = sqliteTable(
	"supplier_accounts",
	{
		id: text("id").primaryKey(),
		provider: text("provider", {
			enum: ["acg", "dujiao_next", "gmshop_edge"],
		}).notNull(),
		baseUrl: text("base_url").notNull(),
		normalizedApiOrigin: text("normalized_api_origin").notNull(),
		protocolVersion: text("protocol_version").notNull(),
		currency: text("currency").notNull().default("CNY"),
		currencyDecimals: integer("currency_decimals").notNull().default(2),
		name: text("name").notNull(),
		credentialsEncrypted: text("credentials_encrypted").notNull(),
		credentialsRevision: integer("credentials_revision").notNull().default(1),
		credentialFingerprint: text("credential_fingerprint").notNull(),
		balanceMinor: text("balance_minor"),
		balanceSyncedAt: integer("balance_synced_at", { mode: "timestamp_ms" }),
		reserveBalanceMinor: text("reserve_balance_minor").notNull().default("0"),
		lowBalanceMinor: text("low_balance_minor").notNull().default("0"),
		maxOrderCostMinor: text("max_order_cost_minor"),
		healthStatus: text("health_status", {
			enum: ["unknown", "healthy", "degraded", "unavailable"],
		})
			.notNull()
			.default("unknown"),
		consecutiveFailures: integer("consecutive_failures").notNull().default(0),
		cooldownUntil: integer("cooldown_until", { mode: "timestamp_ms" }),
		lastSelectedAt: integer("last_selected_at", { mode: "timestamp_ms" }),
		lastErrorCode: text("last_error_code"),
		lastErrorAt: integer("last_error_at", { mode: "timestamp_ms" }),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
		...timestamps,
	},
	(table) => [
		uniqueIndex("supplier_accounts_source_name_uidx").on(
			table.provider,
			table.normalizedApiOrigin,
			table.protocolVersion,
			table.name,
		),
		uniqueIndex("supplier_accounts_source_credential_uidx").on(
			table.provider,
			table.normalizedApiOrigin,
			table.protocolVersion,
			table.credentialFingerprint,
		),
		index("supplier_accounts_source_eligible_idx").on(
			table.provider,
			table.normalizedApiOrigin,
			table.protocolVersion,
			table.enabled,
			table.healthStatus,
			table.cooldownUntil,
			table.lastSelectedAt,
			table.id,
		),
		check(
			"supplier_accounts_provider_check",
			sql`${table.provider} IN ('acg', 'dujiao_next', 'gmshop_edge')`,
		),
		check(
			"supplier_accounts_currency_decimals_check",
			sql`${table.currencyDecimals} BETWEEN 0 AND 8`,
		),
		check(
			"supplier_accounts_credentials_revision_check",
			sql`${table.credentialsRevision} > 0`,
		),
		check(
			"supplier_accounts_balance_check",
			sql`${table.balanceMinor} IS NULL OR (${moneyCheck(table.balanceMinor)})`,
		),
		check(
			"supplier_accounts_reserve_balance_check",
			moneyCheck(table.reserveBalanceMinor),
		),
		check(
			"supplier_accounts_low_balance_check",
			moneyCheck(table.lowBalanceMinor),
		),
		check(
			"supplier_accounts_max_order_cost_check",
			sql`${table.maxOrderCostMinor} IS NULL OR (${moneyCheck(table.maxOrderCostMinor)})`,
		),
		check(
			"supplier_accounts_failures_check",
			sql`${table.consecutiveFailures} >= 0`,
		),
	],
);

export const supplierBindings = sqliteTable(
	"supplier_bindings",
	{
		id: text("id").primaryKey(),
		sellableItemId: text("sellable_item_id")
			.notNull()
			.references(() => productSellableItems.id),
		provider: text("provider", {
			enum: ["acg", "dujiao_next", "gmshop_edge"],
		}).notNull(),
		normalizedApiOrigin: text("normalized_api_origin").notNull(),
		protocolVersion: text("protocol_version").notNull(),
		upstreamProductId: text("upstream_product_id").notNull(),
		upstreamSkuId: text("upstream_sku_id").notNull(),
		upstreamProductName: text("upstream_product_name").notNull(),
		upstreamSkuName: text("upstream_sku_name").notNull(),
		referenceCostMinor: text("reference_cost_minor").notNull(),
		maxCostMinor: text("max_cost_minor").notNull(),
		stockQuantity: integer("stock_quantity").notNull().default(0),
		remoteStatus: text("remote_status", {
			enum: ["active", "inactive", "deleted", "unknown"],
		})
			.notNull()
			.default("unknown"),
		lastSyncedAt: integer("last_synced_at", { mode: "timestamp_ms" }),
		lastErrorCode: text("last_error_code"),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
		...timestamps,
	},
	(table) => [
		uniqueIndex("supplier_bindings_enabled_item_uidx")
			.on(table.sellableItemId)
			.where(sql`${table.enabled} = 1`),
		uniqueIndex("supplier_bindings_enabled_source_sku_uidx")
			.on(
				table.provider,
				table.normalizedApiOrigin,
				table.protocolVersion,
				table.upstreamProductId,
				table.upstreamSkuId,
			)
			.where(sql`${table.enabled} = 1`),
		index("supplier_bindings_source_status_sync_idx").on(
			table.provider,
			table.normalizedApiOrigin,
			table.protocolVersion,
			table.enabled,
			table.remoteStatus,
			table.lastSyncedAt,
			table.id,
		),
		check(
			"supplier_bindings_provider_check",
			sql`${table.provider} IN ('acg', 'dujiao_next', 'gmshop_edge')`,
		),
		check(
			"supplier_bindings_reference_cost_check",
			moneyCheck(table.referenceCostMinor),
		),
		check("supplier_bindings_max_cost_check", moneyCheck(table.maxCostMinor)),
		check(
			"supplier_bindings_stock_quantity_check",
			sql`${table.stockQuantity} >= 0`,
		),
	],
);

export const downloadAssetSellableItems = sqliteTable(
	"download_asset_sellable_items",
	{
		downloadAssetId: text("download_asset_id")
			.notNull()
			.references(() => downloadAssets.id, { onDelete: "cascade" }),
		sellableItemId: text("sellable_item_id")
			.notNull()
			.references(() => productSellableItems.id, { onDelete: "cascade" }),
		sortOrder: integer("sort_order").notNull().default(100),
	},
	(table) => [
		uniqueIndex("download_asset_sellable_items_asset_item_uidx").on(
			table.downloadAssetId,
			table.sellableItemId,
		),
		index("download_asset_sellable_items_item_sort_idx").on(
			table.sellableItemId,
			table.sortOrder,
			table.downloadAssetId,
		),
	],
);

export const productAutomationMethods = sqliteTable(
	"product_automation_methods",
	{
		id: text("id").primaryKey(),
		sellableItemId: text("sellable_item_id")
			.notNull()
			.references(() => productSellableItems.id, { onDelete: "cascade" }),
		configVersion: integer("config_version").notNull(),
		key: text("key").notNull(),
		name: text("name").notNull(),
		description: text("description"),
		runtime: text("runtime").notNull(),
		branch: text("branch"),
		command: text("command"),
		artifactPolicy: text("artifact_policy", {
			enum: ["none", "optional", "required"],
		})
			.notNull()
			.default("required"),
		outputPattern: text("output_pattern").notNull(),
		sortOrder: integer("sort_order").notNull().default(100),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
		...timestamps,
	},
	(table) => [
		uniqueIndex("product_automation_methods_config_version_key_uidx").on(
			table.sellableItemId,
			table.configVersion,
			table.key,
		),
		index("product_automation_methods_config_version_sort_idx").on(
			table.sellableItemId,
			table.configVersion,
			table.enabled,
			table.sortOrder,
			table.id,
		),
		check(
			"product_automation_methods_version_check",
			sql`${table.configVersion} > 0`,
		),
		check(
			"product_automation_methods_artifact_shape_check",
			sql`(${table.artifactPolicy} = 'none' AND ${table.outputPattern} = '') OR
				(${table.artifactPolicy} IN ('optional', 'required') AND TRIM(${table.outputPattern}) <> '')`,
		),
	],
);

export const productDefinitionVersions = sqliteTable(
	"product_definition_versions",
	{
		id: text("id").primaryKey(),
		productId: text("product_id")
			.notNull()
			.references(() => products.id),
		sellableItemId: text("sellable_item_id")
			.notNull()
			.references(() => productSellableItems.id),
		version: integer("version").notNull(),
		schemaJson: text("schema_json", { mode: "json" })
			.$type<
				Array<{
					key: string;
					name: string;
					description: string;
					inputType: "text" | "number" | "boolean" | "select" | "multiselect";
					scope: "authorization" | "automation" | "order";
					required: boolean;
					sensitive: boolean;
					validationPattern: string;
					minimumValue: number | null;
					maximumValue: number | null;
					defaultValue: string;
					exampleValue: string;
					sortOrder: number;
					options: Array<{ value: string; label: string }>;
				}>
			>()
			.notNull(),
		publishedAt: integer("published_at", { mode: "timestamp_ms" }).notNull(),
		createdBy: text("created_by").references(() => users.id, {
			onDelete: "set null",
		}),
		...timestamps,
	},
	(table) => [
		uniqueIndex("product_definition_versions_item_version_uidx").on(
			table.sellableItemId,
			table.version,
		),
		check(
			"product_definition_versions_version_check",
			sql`${table.version} > 0`,
		),
		check(
			"product_definition_versions_schema_check",
			sql`json_valid(${table.schemaJson}) AND json_type(${table.schemaJson}) = 'array'`,
		),
	],
);

export const shoppingCarts = sqliteTable(
	"shopping_carts",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		itemsJson: text("items_json").notNull().default("[]"),
		version: integer("version").notNull().default(1),
		expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
		...timestamps,
	},
	(table) => [
		uniqueIndex("shopping_carts_user_uidx").on(table.userId),
		index("shopping_carts_expiry_idx").on(table.expiresAt, table.id),
		check("shopping_carts_version_check", sql`${table.version} > 0`),
	],
);

export const commerceEvents = sqliteTable(
	"commerce_events",
	{
		id: text("id").primaryKey(),
		eventType: text("event_type", {
			enum: [
				"catalog_viewed",
				"product_viewed",
				"cart_item_added",
				"checkout_started",
				"order_created",
				"payment_started",
				"payment_succeeded",
				"fulfillment_completed",
			],
		}).notNull(),
		sessionId: text("session_id").notNull(),
		productId: text("product_id").references(() => products.id, {
			onDelete: "set null",
		}),
		sellableItemId: text("sellable_item_id").references(
			() => productSellableItems.id,
			{
				onDelete: "set null",
			},
		),
		orderId: text("order_id"),
		currency: text("currency"),
		amountMinor: text("amount_minor"),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
	},
	(table) => [
		index("commerce_events_type_created_idx").on(
			table.eventType,
			table.createdAt,
			table.id,
		),
		index("commerce_events_product_created_idx").on(
			table.productId,
			table.createdAt,
			table.id,
		),
		index("commerce_events_order_type_idx").on(table.orderId, table.eventType),
		check(
			"commerce_events_amount_check",
			sql`${table.amountMinor} IS NULL OR (${moneyCheck(table.amountMinor)})`,
		),
	],
);

export const shopOrders = sqliteTable(
	"shop_orders",
	{
		id: text("id").primaryKey(),
		orderNumber: text("order_number").notNull(),
		idempotencyKey: text("idempotency_key"),
		userId: text("user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		contactEmail: text("contact_email"),
		normalizedContactEmail: text("normalized_contact_email"),
		locale: text("locale", { enum: ["en-US", "zh-CN"] })
			.notNull()
			.default("en-US"),
		status: text("status", { enum: shopOrderStatusValues })
			.notNull()
			.default("pending_payment"),
		currency: text("currency").notNull(),
		currencyDecimals: integer("currency_decimals").notNull(),
		subtotalMinor: text("subtotal_minor").notNull(),
		discountMinor: text("discount_minor").notNull().default("0"),
		totalMinor: text("total_minor").notNull(),
		paidMinor: text("paid_minor").notNull().default("0"),
		couponId: text("coupon_id").references(() => coupons.id),
		customerNote: text("customer_note"),
		adminNote: text("admin_note"),
		version: integer("version").notNull().default(1),
		expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
		paidAt: integer("paid_at", { mode: "timestamp_ms" }),
		completedAt: integer("completed_at", { mode: "timestamp_ms" }),
		cancelledAt: integer("cancelled_at", { mode: "timestamp_ms" }),
		refundedAt: integer("refunded_at", { mode: "timestamp_ms" }),
		...timestamps,
	},
	(table) => [
		uniqueIndex("shop_orders_number_uidx").on(table.orderNumber),
		uniqueIndex("shop_orders_idempotency_uidx").on(table.idempotencyKey),
		index("shop_orders_status_created_idx").on(
			table.status,
			table.createdAt,
			table.id,
		),
		index("shop_orders_status_expires_idx").on(
			table.status,
			table.expiresAt,
			table.id,
		),
		index("shop_orders_user_created_idx").on(
			table.userId,
			table.createdAt,
			table.id,
		),
		index("shop_orders_email_created_idx").on(
			table.normalizedContactEmail,
			table.createdAt,
			table.id,
		),
		check(
			"shop_orders_currency_decimals_check",
			sql`${table.currencyDecimals} BETWEEN 0 AND 8`,
		),
		check("shop_orders_subtotal_minor_check", moneyCheck(table.subtotalMinor)),
		check("shop_orders_discount_minor_check", moneyCheck(table.discountMinor)),
		check("shop_orders_total_minor_check", moneyCheck(table.totalMinor)),
		check("shop_orders_paid_minor_check", moneyCheck(table.paidMinor)),
		check("shop_orders_version_check", sql`${table.version} > 0`),
	],
);

export const shopOrderEvents = sqliteTable(
	"shop_order_events",
	{
		id: text("id").primaryKey(),
		orderId: text("order_id")
			.notNull()
			.references(() => shopOrders.id, { onDelete: "cascade" }),
		eventType: text("event_type").notNull(),
		visibility: text("visibility", { enum: ["internal", "customer"] })
			.notNull()
			.default("internal"),
		fromStatus: text("from_status", { enum: shopOrderStatusValues }),
		toStatus: text("to_status", { enum: shopOrderStatusValues }),
		orderVersion: integer("order_version"),
		afterSaleCaseId: text("after_sale_case_id"),
		caseAction: text("case_action"),
		note: text("note"),
		actorType: text("actor_type", {
			enum: ["system", "customer", "admin", "provider"],
		}).notNull(),
		actorUserId: text("actor_user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
	},
	(table) => [
		index("shop_order_events_order_created_idx").on(
			table.orderId,
			table.createdAt,
			table.id,
		),
		index("shop_order_events_type_created_idx").on(
			table.eventType,
			table.createdAt,
			table.id,
		),
		index("shop_order_events_case_created_idx").on(
			table.afterSaleCaseId,
			table.createdAt,
			table.id,
		),
		uniqueIndex("shop_order_events_order_version_uidx").on(
			table.orderId,
			table.orderVersion,
		),
		check(
			"shop_order_events_transition_check",
			sql`(${table.fromStatus} IS NULL AND ${table.toStatus} IS NULL) OR
				(${table.fromStatus} IS NOT NULL AND ${table.toStatus} IS NOT NULL AND
				 ${table.fromStatus} <> ${table.toStatus})`,
		),
		check(
			"shop_order_events_version_check",
			sql`${table.orderVersion} IS NULL OR ${table.orderVersion} > 0`,
		),
		check(
			"shop_order_events_case_shape_check",
			sql`(${table.afterSaleCaseId} IS NULL AND ${table.caseAction} IS NULL) OR
				(${table.afterSaleCaseId} IS NOT NULL AND ${table.caseAction} IS NOT NULL)`,
		),
	],
);

export const shopOrderItems = sqliteTable(
	"shop_order_items",
	{
		id: text("id").primaryKey(),
		orderId: text("order_id")
			.notNull()
			.references(() => shopOrders.id, { onDelete: "cascade" }),
		productId: text("product_id").notNull(),
		sellableItemId: text("sellable_item_id").notNull(),
		productName: text("product_name").notNull(),
		deliveryComponentId: text("delivery_component_id").notNull(),
		deliveryComponentType: text("delivery_component_type", {
			enum: ["stock", "download", "automation"],
		}).notNull(),
		deliveryComponentVersion: integer("delivery_component_version").notNull(),
		sellableItemName: text("sellable_item_name").notNull(),
		definitionVersionId: text("definition_version_id"),
		inputValuesJson: text("input_values_json", { mode: "json" })
			.$type<Record<string, string>>()
			.notNull()
			.default({}),
		sensitiveInputValuesJson: text("sensitive_input_values_json", {
			mode: "json",
		})
			.$type<Record<string, { envelope: string; keyVersion: number }>>()
			.notNull()
			.default({}),
		quantity: integer("quantity").notNull(),
		unitPriceMinor: text("unit_price_minor").notNull(),
		unitCostMinor: text("unit_cost_minor"),
		discountMinor: text("discount_minor").notNull().default("0"),
		subtotalMinor: text("subtotal_minor").notNull(),
		renewedFromEntitlementId: text("renewed_from_entitlement_id"),
		durationMs: integer("duration_ms"),
		usageLimit: integer("usage_limit"),
		accessLimit: integer("access_limit"),
		activationTrigger: text("activation_trigger", {
			enum: ["delivery_completed"],
		})
			.notNull()
			.default("delivery_completed"),
		exhaustionRule: text("exhaustion_rule", {
			enum: ["first_limit_reached"],
		})
			.notNull()
			.default("first_limit_reached"),
		renewalMode: text("renewal_mode", { enum: ["stack", "disabled"] })
			.notNull()
			.default("stack"),
		showOnOrderPage: integer("show_on_order_page", { mode: "boolean" })
			.notNull()
			.default(true),
		accountLibraryEnabled: integer("account_library_enabled", {
			mode: "boolean",
		})
			.notNull()
			.default(true),
		emailMode: text("email_mode", {
			enum: ["none", "link", "content"],
		})
			.notNull()
			.default("none"),
		allowResend: integer("allow_resend", {
			mode: "boolean",
		})
			.notNull()
			.default(true),
		...timestamps,
	},
	(table) => [
		index("shop_order_items_order_idx").on(table.orderId, table.id),
		index("shop_order_items_sellable_item_idx").on(
			table.sellableItemId,
			table.id,
		),
		check(
			"shop_order_items_delivery_component_type_check",
			sql`${table.deliveryComponentType} IN ('stock', 'download', 'automation')`,
		),
		check("shop_order_items_quantity_check", sql`${table.quantity} > 0`),
		check(
			"shop_order_items_unit_price_check",
			moneyCheck(table.unitPriceMinor),
		),
		check(
			"shop_order_items_unit_cost_check",
			sql`${table.unitCostMinor} IS NULL OR (${moneyCheck(table.unitCostMinor)})`,
		),
		check("shop_order_items_discount_check", moneyCheck(table.discountMinor)),
		check("shop_order_items_subtotal_check", moneyCheck(table.subtotalMinor)),
		check(
			"shop_order_items_duration_check",
			sql`${table.durationMs} IS NULL OR ${table.durationMs} > 0`,
		),
		check(
			"shop_order_items_usage_limit_check",
			sql`${table.usageLimit} IS NULL OR ${table.usageLimit} > 0`,
		),
		check(
			"shop_order_items_access_limit_check",
			sql`${table.accessLimit} IS NULL OR ${table.accessLimit} > 0`,
		),
		check(
			"shop_order_items_email_content_check",
			sql`${table.emailMode} <> 'content' OR
				(${table.deliveryComponentType} = 'stock' AND
				 ${table.durationMs} IS NULL AND ${table.usageLimit} IS NULL AND
				 ${table.accessLimit} IS NULL)`,
		),
		check(
			"shop_order_items_account_library_check",
			sql`${table.accountLibraryEnabled} = true`,
		),
		check(
			"shop_order_items_input_json_check",
			sql`json_valid(${table.inputValuesJson}) AND json_type(${table.inputValuesJson}) = 'object'
				AND json_valid(${table.sensitiveInputValuesJson})
				AND json_type(${table.sensitiveInputValuesJson}) = 'object'`,
		),
	],
);

export const orderItemDownloadAssets = sqliteTable(
	"order_item_download_assets",
	{
		id: text("id").primaryKey(),
		orderItemId: text("order_item_id")
			.notNull()
			.references(() => shopOrderItems.id, { onDelete: "cascade" }),
		downloadAssetId: text("download_asset_id"),
		assetVersion: integer("asset_version").notNull().default(1),
		objectKey: text("object_key").notNull(),
		fileName: text("file_name").notNull(),
		contentType: text("content_type").notNull(),
		sizeBytes: integer("size_bytes").notNull(),
		checksumSha256: text("checksum_sha256").notNull(),
		...timestamps,
	},
	(table) => [
		uniqueIndex("order_item_download_assets_item_asset_uidx").on(
			table.orderItemId,
			table.downloadAssetId,
		),
		index("order_item_download_assets_item_created_idx").on(
			table.orderItemId,
			table.createdAt,
			table.id,
		),
		check(
			"order_item_download_assets_version_check",
			sql`${table.assetVersion} > 0`,
		),
		check("order_item_download_assets_size_check", sql`${table.sizeBytes} > 0`),
	],
);

export const walletEntries = sqliteTable(
	"wallet_entries",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id),
		direction: text("direction", { enum: ["credit", "debit"] }).notNull(),
		amountMinor: text("amount_minor").notNull(),
		balanceBeforeMinor: text("balance_before_minor").notNull(),
		balanceAfterMinor: text("balance_after_minor").notNull(),
		currency: text("currency").notNull(),
		sourceType: text("source_type", {
			enum: ["topup", "adjustment", "shop_order", "supplier_order", "refund"],
		}).notNull(),
		sourceId: text("source_id").notNull(),
		idempotencyKey: text("idempotency_key").notNull(),
		reason: text("reason"),
		actorUserId: text("actor_user_id").references(() => users.id),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
	},
	(table) => [
		uniqueIndex("wallet_entries_idempotency_uidx").on(table.idempotencyKey),
		index("wallet_entries_user_created_idx").on(
			table.userId,
			table.createdAt,
			table.id,
		),
		index("wallet_entries_source_idx").on(table.sourceType, table.sourceId),
		check("wallet_entries_amount_check", moneyCheck(table.amountMinor)),
		check("wallet_entries_before_check", moneyCheck(table.balanceBeforeMinor)),
		check("wallet_entries_after_check", moneyCheck(table.balanceAfterMinor)),
		check(
			"wallet_entries_direction_check",
			sql`${table.direction} IN ('credit', 'debit')`,
		),
	],
);

export const walletTopups = sqliteTable(
	"wallet_topups",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id),
		amountMinor: text("amount_minor").notNull(),
		currency: text("currency").notNull(),
		currencyDecimals: integer("currency_decimals").notNull(),
		status: text("status", {
			enum: ["pending", "paid", "failed", "expired", "refunded"],
		})
			.notNull()
			.default("pending"),
		idempotencyKey: text("idempotency_key").notNull(),
		paidAt: integer("paid_at", { mode: "timestamp_ms" }),
		refundedAt: integer("refunded_at", { mode: "timestamp_ms" }),
		...timestamps,
	},
	(table) => [
		uniqueIndex("wallet_topups_user_idempotency_uidx").on(
			table.userId,
			table.idempotencyKey,
		),
		index("wallet_topups_user_created_idx").on(
			table.userId,
			table.createdAt,
			table.id,
		),
		check("wallet_topups_amount_check", moneyCheck(table.amountMinor)),
		check(
			"wallet_topups_currency_decimals_check",
			sql`${table.currencyDecimals} BETWEEN 0 AND 8`,
		),
	],
);

export const paymentChannels = sqliteTable(
	"payment_channels",
	{
		id: text("id").primaryKey(),
		provider: text("provider").notNull(),
		name: text("name").notNull(),
		currency: text("currency").notNull(),
		defaultToken: text("default_token").notNull().default(""),
		defaultNetwork: text("default_network").notNull().default(""),
		logoObjectKey: text("logo_object_key"),
		logoUpdatedAt: integer("logo_updated_at", { mode: "timestamp_ms" }),
		credentialEncrypted: text("credential_encrypted"),
		credentialKeyVersion: integer("credential_key_version"),
		feeBps: integer("fee_bps").notNull().default(0),
		fixedFeeMinor: text("fixed_fee_minor").notNull().default("0"),
		sortOrder: integer("sort_order").notNull().default(100),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
		lastHealthStatus: text("last_health_status", {
			enum: ["unknown", "healthy", "unhealthy"],
		})
			.notNull()
			.default("unknown"),
		lastCheckedAt: integer("last_checked_at", { mode: "timestamp_ms" }),
		...timestamps,
	},
	(table) => [
		index("payment_channels_enabled_sort_idx").on(
			table.enabled,
			table.sortOrder,
			table.id,
		),
		check(
			"payment_channels_fee_bps_check",
			sql`${table.feeBps} BETWEEN 0 AND 10000`,
		),
		check("payment_channels_fixed_fee_check", moneyCheck(table.fixedFeeMinor)),
		check(
			"payment_channels_default_asset_check",
			sql`(${table.defaultToken} = '' AND ${table.defaultNetwork} = '') OR
				(${table.defaultToken} <> '' AND ${table.defaultNetwork} <> '')`,
		),
		check(
			"payment_channels_credential_shape_check",
			sql`(${table.credentialEncrypted} IS NULL AND ${table.credentialKeyVersion} IS NULL) OR
				(${table.credentialEncrypted} IS NOT NULL AND ${table.credentialKeyVersion} > 0)`,
		),
	],
);

export const exchangeRates = sqliteTable(
	"exchange_rates",
	{
		id: text("id").primaryKey(),
		baseCurrency: text("base_currency").notNull(),
		quoteCurrency: text("quote_currency").notNull(),
		rawRate: text("raw_rate").notNull(),
		rate: text("rate").notNull(),
		source: text("source").notNull().default("manual"),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
		adjustmentBps: integer("adjustment_bps").notNull().default(0),
		sortOrder: integer("sort_order").notNull().default(100),
		observedAt: integer("observed_at", { mode: "timestamp_ms" }).notNull(),
		expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
		...timestamps,
	},
	(table) => [
		uniqueIndex("exchange_rates_pair_uidx").on(
			table.baseCurrency,
			table.quoteCurrency,
		),
		index("exchange_rates_sort_idx").on(table.sortOrder, table.quoteCurrency),
		check(
			"exchange_rates_pair_check",
			sql`${table.baseCurrency} <> ${table.quoteCurrency}`,
		),
		check(
			"exchange_rates_adjustment_bps_check",
			sql`${table.adjustmentBps} BETWEEN -9999 AND 100000`,
		),
		check(
			"exchange_rates_expiry_check",
			sql`${table.expiresAt} IS NULL OR ${table.expiresAt} > ${table.observedAt}`,
		),
	],
);

export const paymentAttempts = sqliteTable(
	"payment_attempts",
	{
		id: text("id").primaryKey(),
		orderId: text("order_id").references(() => shopOrders.id),
		walletTopupId: text("wallet_topup_id").references(() => walletTopups.id),
		channelId: text("channel_id")
			.notNull()
			.references(() => paymentChannels.id),
		providerPaymentId: text("provider_payment_id"),
		idempotencyKey: text("idempotency_key").notNull(),
		status: text("status", {
			enum: [
				"created",
				"pending",
				"succeeded",
				"failed",
				"cancelled",
				"expired",
			],
		})
			.notNull()
			.default("created"),
		amountMinor: text("amount_minor").notNull(),
		currency: text("currency").notNull(),
		currencyDecimals: integer("currency_decimals").notNull().default(2),
		exchangeRateId: text("exchange_rate_id").references(
			() => exchangeRates.id,
			{
				onDelete: "set null",
			},
		),
		exchangeRate: text("exchange_rate").notNull().default("1"),
		exchangeRateDirection: text("exchange_rate_direction", {
			enum: ["parity", "multiply", "divide"],
		})
			.notNull()
			.default("parity"),
		exchangeRateSource: text("exchange_rate_source")
			.notNull()
			.default("parity"),
		exchangeRateAdjustmentBps: integer("exchange_rate_adjustment_bps")
			.notNull()
			.default(0),
		exchangeRateObservedAt: integer("exchange_rate_observed_at", {
			mode: "timestamp_ms",
		})
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		checkoutUrl: text("checkout_url"),
		providerExpiresAt: integer("provider_expires_at", { mode: "timestamp_ms" }),
		succeededAt: integer("succeeded_at", { mode: "timestamp_ms" }),
		failureCode: text("failure_code"),
		...timestamps,
	},
	(table) => [
		uniqueIndex("payment_attempts_idempotency_uidx").on(table.idempotencyKey),
		uniqueIndex("payment_attempts_channel_provider_uidx").on(
			table.channelId,
			table.providerPaymentId,
		),
		index("payment_attempts_order_created_idx").on(
			table.orderId,
			table.createdAt,
			table.id,
		),
		index("payment_attempts_topup_created_idx").on(
			table.walletTopupId,
			table.createdAt,
			table.id,
		),
		index("payment_attempts_status_created_idx").on(
			table.status,
			table.createdAt,
			table.id,
		),
		check("payment_attempts_amount_check", moneyCheck(table.amountMinor)),
		check(
			"payment_attempts_subject_check",
			sql`(${table.orderId} IS NOT NULL AND ${table.walletTopupId} IS NULL) OR
				(${table.orderId} IS NULL AND ${table.walletTopupId} IS NOT NULL)`,
		),
		check(
			"payment_attempts_currency_decimals_check",
			sql`${table.currencyDecimals} BETWEEN 0 AND 8`,
		),
	],
);

export const replayReceipts = sqliteTable(
	"replay_receipts",
	{
		id: text("id").primaryKey(),
		namespace: text("namespace").notNull(),
		scopeId: text("scope_id").notNull(),
		paymentAttemptId: text("payment_attempt_id").references(
			() => paymentAttempts.id,
		),
		externalId: text("external_id").notNull(),
		eventType: text("event_type").notNull(),
		payloadDigest: text("payload_digest").notNull(),
		status: text("status", {
			enum: ["received", "processed", "rejected", "failed"],
		})
			.notNull()
			.default("received"),
		failureCode: text("failure_code"),
		processedAt: integer("processed_at", { mode: "timestamp_ms" }),
		...timestamps,
	},
	(table) => [
		uniqueIndex("replay_receipts_namespace_scope_external_uidx").on(
			table.namespace,
			table.scopeId,
			table.externalId,
		),
		index("replay_receipts_status_created_idx").on(
			table.status,
			table.createdAt,
			table.id,
		),
		index("replay_receipts_namespace_created_idx").on(
			table.namespace,
			table.createdAt,
			table.id,
		),
	],
);

export const customerEntitlements = sqliteTable(
	"customer_entitlements",
	{
		id: text("id").primaryKey(),
		userId: text("user_id").references(() => users.id),
		orderItemId: text("order_item_id")
			.notNull()
			.references(() => shopOrderItems.id),
		productId: text("product_id").notNull(),
		sellableItemId: text("sellable_item_id").notNull(),
		deliveryComponentId: text("delivery_component_id").notNull(),
		entitlementType: text("entitlement_type", {
			enum: ["stock", "download", "automation"],
		}).notNull(),
		status: text("status", {
			enum: ["pending", "active", "expired", "exhausted", "revoked"],
		})
			.notNull()
			.default("pending"),
		definitionVersionId: text("definition_version_id"),
		usageLimit: integer("usage_limit"),
		usageCount: integer("usage_count").notNull().default(0),
		accessLimit: integer("access_limit"),
		accessCount: integer("access_count").notNull().default(0),
		activatedAt: integer("activated_at", { mode: "timestamp_ms" }),
		expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
		revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
		...timestamps,
	},
	(table) => [
		uniqueIndex("customer_entitlements_order_item_uidx").on(table.orderItemId),
		index("customer_entitlements_user_status_idx").on(
			table.userId,
			table.status,
			table.createdAt,
			table.id,
		),
		index("customer_entitlements_status_expiry_idx").on(
			table.status,
			table.expiresAt,
		),
		check(
			"customer_entitlements_type_check",
			sql`${table.entitlementType} IN ('stock', 'download', 'automation')`,
		),
		check(
			"customer_entitlements_usage_count_check",
			sql`${table.usageCount} >= 0`,
		),
		check(
			"customer_entitlements_access_count_check",
			sql`${table.accessCount} >= 0`,
		),
		check(
			"customer_entitlements_usage_limit_check",
			sql`${table.usageLimit} IS NULL OR ${table.usageLimit} > 0`,
		),
		check(
			"customer_entitlements_access_limit_check",
			sql`${table.accessLimit} IS NULL OR ${table.accessLimit} > 0`,
		),
	],
);

export const entitlementGrants = sqliteTable(
	"entitlement_grants",
	{
		id: text("id").primaryKey(),
		entitlementId: text("entitlement_id")
			.notNull()
			.references(() => customerEntitlements.id),
		sourceOrderItemId: text("source_order_item_id")
			.notNull()
			.references(() => shopOrderItems.id),
		renewedFromEntitlementId: text("renewed_from_entitlement_id").references(
			() => customerEntitlements.id,
		),
		status: text("status", {
			enum: ["pending", "active", "refunded", "revoked"],
		})
			.notNull()
			.default("pending"),
		durationMs: integer("duration_ms"),
		usageGranted: integer("usage_granted"),
		accessGranted: integer("access_granted"),
		activatedAt: integer("activated_at", { mode: "timestamp_ms" }),
		appliedAt: integer("applied_at", { mode: "timestamp_ms" }),
		revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
		revocationReason: text("revocation_reason"),
		...timestamps,
	},
	(table) => [
		uniqueIndex("entitlement_grants_source_order_item_uidx").on(
			table.sourceOrderItemId,
		),
		index("entitlement_grants_entitlement_created_idx").on(
			table.entitlementId,
			table.createdAt,
			table.id,
		),
		check(
			"entitlement_grants_duration_check",
			sql`${table.durationMs} IS NULL OR ${table.durationMs} > 0`,
		),
		check(
			"entitlement_grants_usage_check",
			sql`${table.usageGranted} IS NULL OR ${table.usageGranted} > 0`,
		),
		check(
			"entitlement_grants_access_check",
			sql`${table.accessGranted} IS NULL OR ${table.accessGranted} > 0`,
		),
	],
);

export const entitlementEvents = sqliteTable(
	"entitlement_events",
	{
		id: text("id").primaryKey(),
		kind: text("kind", { enum: ["usage", "access"] }).notNull(),
		entitlementId: text("entitlement_id")
			.notNull()
			.references(() => customerEntitlements.id),
		eventType: text("event_type").notNull(),
		amount: integer("amount"),
		sourceType: text("source_type"),
		sourceId: text("source_id"),
		assetType: text("asset_type", {
			enum: ["stock_secret", "download_asset", "automation_artifact"],
		}),
		assetId: text("asset_id"),
		consumed: integer("consumed", { mode: "boolean" }),
		actorType: text("actor_type", {
			enum: ["customer", "admin", "system"],
		}),
		idempotencyKey: text("idempotency_key"),
		requestId: text("request_id"),
		ipAddress: text("ip_address"),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
	},
	(table) => [
		uniqueIndex("entitlement_events_idempotency_uidx").on(table.idempotencyKey),
		index("entitlement_events_entitlement_created_idx").on(
			table.entitlementId,
			table.createdAt,
			table.id,
		),
		index("entitlement_events_kind_created_idx").on(
			table.kind,
			table.createdAt,
			table.id,
		),
		check(
			"entitlement_events_shape_check",
			sql`(
				${table.kind} = 'usage'
				AND ${table.eventType} IN ('consumed', 'restored')
				AND ${table.amount} > 0
				AND ${table.sourceType} IS NOT NULL
				AND ${table.sourceId} IS NOT NULL
				AND ${table.idempotencyKey} IS NOT NULL
				AND ${table.assetType} IS NULL
				AND ${table.assetId} IS NULL
				AND ${table.consumed} IS NULL
				AND ${table.actorType} IS NULL
				AND ${table.requestId} IS NULL
				AND ${table.ipAddress} IS NULL
			) OR (
				${table.kind} = 'access'
				AND ${table.eventType} IN ('revealed', 'downloaded', 'email_content_sent', 'copied', 'link_sent')
				AND ${table.amount} IS NULL
				AND ${table.sourceType} IS NULL
				AND ${table.sourceId} IS NULL
				AND ${table.assetType} IS NOT NULL
				AND ${table.assetId} IS NOT NULL
				AND ${table.consumed} IN (0, 1)
				AND ${table.actorType} IN ('customer', 'admin', 'system')
			)`,
		),
	],
);

export const entitlementAuthorizationValues = sqliteTable(
	"entitlement_authorization_values",
	{
		id: text("id").primaryKey(),
		entitlementId: text("entitlement_id")
			.notNull()
			.references(() => customerEntitlements.id, { onDelete: "cascade" }),
		definitionKey: text("definition_key").notNull(),
		valueEncrypted: text("value_encrypted").notNull(),
		keyVersion: integer("key_version").notNull(),
		maskedValue: text("masked_value").notNull(),
		...timestamps,
	},
	(table) => [
		uniqueIndex("entitlement_authorization_values_entitlement_key_uidx").on(
			table.entitlementId,
			table.definitionKey,
		),
		check(
			"entitlement_authorization_values_key_version_check",
			sql`${table.keyVersion} > 0`,
		),
	],
);

export const stockEntries = sqliteTable(
	"stock_entries",
	{
		id: text("id").primaryKey(),
		sellableItemId: text("sellable_item_id")
			.notNull()
			.references(() => productSellableItems.id),
		contentEncrypted: text("content_encrypted").notNull(),
		keyVersion: integer("key_version").notNull(),
		contentFingerprint: text("content_fingerprint").notNull(),
		contentMask: text("content_mask").notNull(),
		status: text("status", {
			enum: ["available", "reserved", "delivered", "disabled"],
		})
			.notNull()
			.default("available"),
		orderItemId: text("order_item_id").references(() => shopOrderItems.id),
		supplierOrderId: text("supplier_order_id"),
		note: text("note"),
		reservedAt: integer("reserved_at", { mode: "timestamp_ms" }),
		deliveredAt: integer("delivered_at", { mode: "timestamp_ms" }),
		...timestamps,
	},
	(table) => [
		uniqueIndex("stock_entries_item_fingerprint_uidx").on(
			table.sellableItemId,
			table.contentFingerprint,
		),
		index("stock_entries_item_status_created_idx").on(
			table.sellableItemId,
			table.status,
			table.createdAt,
			table.id,
		),
		index("stock_entries_order_item_idx").on(table.orderItemId),
		index("stock_entries_supplier_order_idx").on(table.supplierOrderId),
		check("stock_entries_key_version_check", sql`${table.keyVersion} > 0`),
	],
);

export const deliveryRecords = sqliteTable(
	"delivery_records",
	{
		id: text("id").primaryKey(),
		orderItemId: text("order_item_id")
			.notNull()
			.references(() => shopOrderItems.id),
		deliveryType: text("delivery_type", {
			enum: ["stock", "download", "automation"],
		}).notNull(),
		requestKey: text("request_key"),
		status: text("status", {
			enum: ["awaiting_supply", "pending", "processing", "delivered", "failed"],
		})
			.notNull()
			.default("pending"),
		contentEncrypted: text("content_encrypted"),
		contentKeyVersion: integer("content_key_version"),
		attemptCount: integer("attempt_count").notNull().default(0),
		nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }),
		deliveredAt: integer("delivered_at", { mode: "timestamp_ms" }),
		errorCode: text("error_code"),
		...timestamps,
	},
	(table) => [
		uniqueIndex("delivery_records_request_key_uidx").on(table.requestKey),
		index("delivery_records_order_item_created_idx").on(
			table.orderItemId,
			table.createdAt,
			table.id,
		),
		index("delivery_records_status_attempt_idx").on(
			table.status,
			table.nextAttemptAt,
			table.id,
		),
		check(
			"delivery_records_type_check",
			sql`${table.deliveryType} IN ('stock', 'download', 'automation')`,
		),
		check(
			"delivery_records_attempt_count_check",
			sql`${table.attemptCount} >= 0`,
		),
		check(
			"delivery_records_content_shape_check",
			sql`(${table.contentEncrypted} IS NULL AND ${table.contentKeyVersion} IS NULL) OR
				(${table.contentEncrypted} IS NOT NULL AND ${table.contentKeyVersion} > 0)`,
		),
	],
);

export const supplierOrders = sqliteTable(
	"supplier_orders",
	{
		id: text("id").primaryKey(),
		orderId: text("order_id")
			.notNull()
			.references(() => shopOrders.id),
		orderItemId: text("order_item_id")
			.notNull()
			.references(() => shopOrderItems.id),
		deliveryRecordId: text("delivery_record_id")
			.notNull()
			.references(() => deliveryRecords.id),
		supplierBindingId: text("supplier_binding_id")
			.notNull()
			.references(() => supplierBindings.id),
		selectedAccountId: text("selected_account_id").references(
			() => supplierAccounts.id,
		),
		selectedCredentialsRevision: integer("selected_credentials_revision"),
		providerRequestNo: text("provider_request_no"),
		upstreamOrderId: text("upstream_order_id"),
		quantity: integer("quantity").notNull(),
		quotedUnitCostMinor: text("quoted_unit_cost_minor"),
		totalCostMinor: text("total_cost_minor"),
		currency: text("currency").notNull(),
		bindingSnapshot: text("binding_snapshot_json", { mode: "json" })
			.$type<Record<string, unknown>>()
			.notNull(),
		state: text("state", {
			enum: [
				"pending",
				"selecting",
				"submitting",
				"uncertain",
				"supplied",
				"failed",
				"refunded",
			],
		})
			.notNull()
			.default("pending"),
		attemptCount: integer("attempt_count").notNull().default(0),
		selectionCount: integer("selection_count").notNull().default(0),
		accountLockedAt: integer("account_locked_at", { mode: "timestamp_ms" }),
		nextRetryAt: integer("next_retry_at", { mode: "timestamp_ms" }),
		lastErrorCode: text("last_error_code"),
		lastErrorMessageRedacted: text("last_error_message_redacted"),
		submittedAt: integer("submitted_at", { mode: "timestamp_ms" }),
		suppliedAt: integer("supplied_at", { mode: "timestamp_ms" }),
		...timestamps,
	},
	(table) => [
		uniqueIndex("supplier_orders_order_item_uidx").on(table.orderItemId),
		uniqueIndex("supplier_orders_account_request_uidx").on(
			table.selectedAccountId,
			table.providerRequestNo,
		),
		index("supplier_orders_state_retry_idx").on(
			table.state,
			table.nextRetryAt,
			table.id,
		),
		index("supplier_orders_account_state_idx").on(
			table.selectedAccountId,
			table.state,
			table.id,
		),
		index("supplier_orders_upstream_order_idx").on(
			table.selectedAccountId,
			table.upstreamOrderId,
		),
		index("supplier_orders_order_idx").on(table.orderId),
		check("supplier_orders_quantity_check", sql`${table.quantity} > 0`),
		check(
			"supplier_orders_quoted_cost_check",
			sql`${table.quotedUnitCostMinor} IS NULL OR (${moneyCheck(table.quotedUnitCostMinor)})`,
		),
		check(
			"supplier_orders_total_cost_check",
			sql`${table.totalCostMinor} IS NULL OR (${moneyCheck(table.totalCostMinor)})`,
		),
		check(
			"supplier_orders_attempt_count_check",
			sql`${table.attemptCount} >= 0`,
		),
		check(
			"supplier_orders_selection_count_check",
			sql`${table.selectionCount} >= 0`,
		),
		check(
			"supplier_orders_account_shape_check",
			sql`(${table.selectedAccountId} IS NULL AND
				 ${table.selectedCredentialsRevision} IS NULL AND
				 ${table.providerRequestNo} IS NULL AND
				 ${table.accountLockedAt} IS NULL) OR
				(${table.selectedAccountId} IS NOT NULL AND
				 ${table.selectedCredentialsRevision} > 0 AND
				 ${table.providerRequestNo} IS NOT NULL)`,
		),
		check(
			"supplier_orders_cost_shape_check",
			sql`(${table.quotedUnitCostMinor} IS NULL AND ${table.totalCostMinor} IS NULL) OR
				(${table.quotedUnitCostMinor} IS NOT NULL AND ${table.totalCostMinor} IS NOT NULL)`,
		),
	],
);

export const supplierApiKeys = sqliteTable(
	"supplier_api_keys",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		keyId: text("key_id").notNull(),
		secretEncrypted: text("secret_encrypted").notNull(),
		secretRevision: integer("secret_revision").notNull().default(1),
		allowedCallbackOrigin: text("allowed_callback_origin"),
		lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
		revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
		...timestamps,
	},
	(table) => [
		uniqueIndex("supplier_api_keys_key_id_uidx").on(table.keyId),
		uniqueIndex("supplier_api_keys_user_name_uidx").on(
			table.userId,
			table.name,
		),
		index("supplier_api_keys_user_active_idx").on(
			table.userId,
			table.revokedAt,
			table.id,
		),
		check("supplier_api_keys_revision_check", sql`${table.secretRevision} > 0`),
	],
);

export const supplierExportListings = sqliteTable(
	"supplier_export_listings",
	{
		id: text("id").primaryKey(),
		sellableItemId: text("sellable_item_id")
			.notNull()
			.references(() => productSellableItems.id, { onDelete: "cascade" }),
		priceMinor: text("price_minor").notNull(),
		currency: text("currency").notNull(),
		currencyDecimals: integer("currency_decimals").notNull(),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
		...timestamps,
	},
	(table) => [
		uniqueIndex("supplier_export_listings_item_uidx").on(table.sellableItemId),
		index("supplier_export_listings_enabled_updated_idx").on(
			table.enabled,
			table.updatedAt,
			table.id,
		),
		check("supplier_export_listings_price_check", moneyCheck(table.priceMinor)),
		check(
			"supplier_export_listings_decimals_check",
			sql`${table.currencyDecimals} BETWEEN 0 AND 8`,
		),
	],
);

export const supplierApiOrders = sqliteTable(
	"supplier_api_orders",
	{
		id: text("id").primaryKey(),
		shopOrderId: text("shop_order_id")
			.notNull()
			.references(() => shopOrders.id),
		userId: text("user_id")
			.notNull()
			.references(() => users.id),
		apiKeyId: text("api_key_id")
			.notNull()
			.references(() => supplierApiKeys.id),
		downstreamOrderNo: text("downstream_order_no").notNull(),
		requestDigest: text("request_digest").notNull(),
		callbackUrl: text("callback_url"),
		state: text("state", {
			enum: ["processing", "supplied", "cancelled", "failed", "refunded"],
		})
			.notNull()
			.default("processing"),
		callbackAttemptCount: integer("callback_attempt_count")
			.notNull()
			.default(0),
		nextCallbackAt: integer("next_callback_at", { mode: "timestamp_ms" }),
		lastCallbackError: text("last_callback_error"),
		...timestamps,
	},
	(table) => [
		uniqueIndex("supplier_api_orders_shop_order_uidx").on(table.shopOrderId),
		uniqueIndex("supplier_api_orders_user_request_uidx").on(
			table.userId,
			table.downstreamOrderNo,
		),
		index("supplier_api_orders_callback_idx").on(
			table.state,
			table.nextCallbackAt,
			table.id,
		),
		check(
			"supplier_api_orders_callback_attempt_check",
			sql`${table.callbackAttemptCount} >= 0`,
		),
	],
);

export const automationJobs = sqliteTable(
	"automation_jobs",
	{
		id: text("id").primaryKey(),
		entitlementId: text("entitlement_id")
			.notNull()
			.references(() => customerEntitlements.id),
		orderItemId: text("order_item_id")
			.notNull()
			.references(() => shopOrderItems.id),
		sellableItemId: text("sellable_item_id")
			.notNull()
			.references(() => productSellableItems.id),
		automationMethodId: text("automation_method_id")
			.notNull()
			.references(() => productAutomationMethods.id),
		definitionVersionId: text("definition_version_id")
			.notNull()
			.references(() => productDefinitionVersions.id),
		provider: text("provider", {
			enum: ["github_actions", "gitlab_ci"],
		}).notNull(),
		providerBaseUrl: text("provider_base_url").notNull(),
		repositoryOwner: text("repository_owner").notNull(),
		repositoryName: text("repository_name").notNull(),
		branch: text("branch").notNull(),
		workflowFile: text("workflow_file").notNull(),
		methodKey: text("method_key").notNull(),
		runtime: text("runtime").notNull(),
		command: text("command"),
		artifactPolicy: text("artifact_policy", {
			enum: ["none", "optional", "required"],
		})
			.notNull()
			.default("required"),
		outputPattern: text("output_pattern").notNull(),
		callbackSecretEncrypted: text("callback_secret_encrypted").notNull(),
		callbackSecretKeyVersion: integer("callback_secret_key_version").notNull(),
		idempotencyKey: text("idempotency_key").notNull(),
		notificationChannel: text("notification_channel", {
			enum: ["none", "email"],
		})
			.notNull()
			.default("none"),
		status: text("status", {
			enum: [
				"queued",
				"dispatching",
				"running",
				"succeeded",
				"failed",
				"cancelled",
				"expired",
			],
		})
			.notNull()
			.default("queued"),
		providerJobId: text("provider_job_id"),
		attemptCount: integer("attempt_count").notNull().default(0),
		nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }),
		timeoutAt: integer("timeout_at", { mode: "timestamp_ms" }).notNull(),
		startedAt: integer("started_at", { mode: "timestamp_ms" }),
		completedAt: integer("completed_at", { mode: "timestamp_ms" }),
		runUrl: text("run_url"),
		failureCode: text("failure_code"),
		usageRestoredAt: integer("usage_restored_at", { mode: "timestamp_ms" }),
		inputsJson: text("inputs_json", { mode: "json" })
			.$type<
				Record<
					string,
					{
						value?: string;
						authorizationValueId?: string;
						maskedValue?: string;
					}
				>
			>()
			.notNull()
			.default({}),
		sensitiveInputsJson: text("sensitive_inputs_json", { mode: "json" })
			.$type<Record<string, { envelope: string; keyVersion: number }>>()
			.notNull()
			.default({}),
		...timestamps,
	},
	(table) => [
		uniqueIndex("automation_jobs_idempotency_uidx").on(table.idempotencyKey),
		uniqueIndex("automation_jobs_item_provider_uidx").on(
			table.sellableItemId,
			table.providerJobId,
		),
		index("automation_jobs_entitlement_created_idx").on(
			table.entitlementId,
			table.createdAt,
			table.id,
		),
		index("automation_jobs_status_attempt_idx").on(
			table.status,
			table.nextAttemptAt,
			table.id,
		),
		check(
			"automation_jobs_attempt_count_check",
			sql`${table.attemptCount} >= 0`,
		),
		check(
			"automation_jobs_callback_key_version_check",
			sql`${table.callbackSecretKeyVersion} > 0`,
		),
		check(
			"automation_jobs_input_json_check",
			sql`json_valid(${table.inputsJson}) AND json_type(${table.inputsJson}) = 'object'
				AND json_valid(${table.sensitiveInputsJson})
				AND json_type(${table.sensitiveInputsJson}) = 'object'`,
		),
		check(
			"automation_jobs_notification_channel_check",
			sql`${table.notificationChannel} IN ('none', 'email')`,
		),
	],
);

export const automationArtifacts = sqliteTable(
	"automation_artifacts",
	{
		id: text("id").primaryKey(),
		automationJobId: text("automation_job_id")
			.notNull()
			.references(() => automationJobs.id, { onDelete: "cascade" }),
		objectKey: text("object_key").notNull(),
		fileName: text("file_name").notNull(),
		contentType: text("content_type").notNull(),
		sizeBytes: integer("size_bytes").notNull(),
		checksumSha256: text("checksum_sha256").notNull(),
		uploadStatus: text("upload_status", { enum: ["uploading", "ready"] })
			.notNull()
			.default("ready"),
		downloadEnabled: integer("download_enabled", { mode: "boolean" })
			.notNull()
			.default(true),
		downloadCount: integer("download_count").notNull().default(0),
		deleteAfter: integer("delete_after", { mode: "timestamp_ms" }).notNull(),
		deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
		...timestamps,
	},
	(table) => [
		uniqueIndex("automation_artifacts_object_key_uidx").on(table.objectKey),
		index("automation_artifacts_job_created_idx").on(
			table.automationJobId,
			table.createdAt,
			table.id,
		),
		index("automation_artifacts_retention_idx").on(table.deleteAfter, table.id),
		check("automation_artifacts_size_check", sql`${table.sizeBytes} > 0`),
		check(
			"automation_artifacts_download_count_check",
			sql`${table.downloadCount} >= 0`,
		),
	],
);

export const coupons = sqliteTable(
	"coupons",
	{
		id: text("id").primaryKey(),
		code: text("code").notNull(),
		name: text("name").notNull(),
		type: text("type", { enum: ["fixed", "percentage"] }).notNull(),
		currency: text("currency"),
		currencyDecimals: integer("currency_decimals"),
		valueMinor: text("value_minor"),
		valueBps: integer("value_bps"),
		minimumOrderMinor: text("minimum_order_minor"),
		maximumDiscountMinor: text("maximum_discount_minor"),
		usageLimit: integer("usage_limit"),
		usageLimitPerCustomer: integer("usage_limit_per_customer"),
		usedCount: integer("used_count").notNull().default(0),
		scopeJson: text("scope_json", { mode: "json" })
			.$type<{ productIds: string[]; tagNames: string[] }>()
			.notNull()
			.default({ productIds: [], tagNames: [] }),
		startsAt: integer("starts_at", { mode: "timestamp_ms" }),
		endsAt: integer("ends_at", { mode: "timestamp_ms" }),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
		...timestamps,
	},
	(table) => [
		uniqueIndex("coupons_code_uidx").on(table.code),
		index("coupons_enabled_ends_idx").on(table.enabled, table.endsAt, table.id),
		check(
			"coupons_value_shape_check",
			sql`(${table.type} = 'fixed' AND ${table.currency} IS NOT NULL AND ${table.currencyDecimals} IS NOT NULL AND ${table.valueMinor} IS NOT NULL AND ${table.valueBps} IS NULL) OR
				(${table.type} = 'percentage' AND ${table.valueMinor} IS NULL AND
				 ${table.valueBps} IS NOT NULL AND ${table.valueBps} BETWEEN 1 AND 10000)`,
		),
		check(
			"coupons_currency_shape_check",
			sql`(${table.currency} IS NULL AND ${table.currencyDecimals} IS NULL) OR
				(${table.currency} IS NOT NULL AND ${table.currencyDecimals} BETWEEN 0 AND 8)`,
		),
		check(
			"coupons_monetary_scope_check",
			sql`(${table.minimumOrderMinor} IS NULL AND ${table.maximumDiscountMinor} IS NULL) OR
				${table.currency} IS NOT NULL`,
		),
		check(
			"coupons_minimum_order_check",
			sql`${table.minimumOrderMinor} IS NULL OR (${moneyCheck(table.minimumOrderMinor)})`,
		),
		check(
			"coupons_maximum_discount_check",
			sql`${table.maximumDiscountMinor} IS NULL OR (${moneyCheck(table.maximumDiscountMinor)})`,
		),
		check("coupons_used_count_check", sql`${table.usedCount} >= 0`),
		check(
			"coupons_usage_limit_check",
			sql`${table.usageLimit} IS NULL OR ${table.usageLimit} > 0`,
		),
		check(
			"coupons_customer_limit_check",
			sql`${table.usageLimitPerCustomer} IS NULL OR ${table.usageLimitPerCustomer} > 0`,
		),
		check(
			"coupons_scope_json_check",
			sql`json_valid(${table.scopeJson}) AND json_type(${table.scopeJson}) = 'object'
				AND json_type(${table.scopeJson}, '$.productIds') = 'array'
				AND json_type(${table.scopeJson}, '$.tagNames') = 'array'`,
		),
	],
);

export const couponRedemptions = sqliteTable(
	"coupon_redemptions",
	{
		id: text("id").primaryKey(),
		couponId: text("coupon_id")
			.notNull()
			.references(() => coupons.id),
		orderId: text("order_id")
			.notNull()
			.references(() => shopOrders.id),
		userId: text("user_id").references(() => users.id),
		normalizedEmail: text("normalized_email").notNull(),
		discountMinor: text("discount_minor").notNull(),
		status: text("status", { enum: ["reserved", "consumed", "released"] })
			.notNull()
			.default("reserved"),
		consumedAt: integer("consumed_at", { mode: "timestamp_ms" }),
		releasedAt: integer("released_at", { mode: "timestamp_ms" }),
		...timestamps,
	},
	(table) => [
		uniqueIndex("coupon_redemptions_order_uidx").on(table.orderId),
		index("coupon_redemptions_coupon_email_idx").on(
			table.couponId,
			table.normalizedEmail,
			table.status,
			table.id,
		),
		check("coupon_redemptions_discount_check", moneyCheck(table.discountMinor)),
	],
);

export const refunds = sqliteTable(
	"refunds",
	{
		id: text("id").primaryKey(),
		orderId: text("order_id")
			.notNull()
			.references(() => shopOrders.id),
		paymentAttemptId: text("payment_attempt_id").references(
			() => paymentAttempts.id,
		),
		providerRefundId: text("provider_refund_id"),
		idempotencyKey: text("idempotency_key").notNull(),
		amountMinor: text("amount_minor").notNull(),
		currency: text("currency").notNull(),
		paymentAmountMinor: text("payment_amount_minor").notNull(),
		paymentCurrency: text("payment_currency").notNull(),
		paymentCurrencyDecimals: integer("payment_currency_decimals").notNull(),
		orderStatusBefore: text("order_status_before", {
			enum: shopOrderStatusValues,
		}).notNull(),
		status: text("status", {
			enum: ["pending", "processing", "succeeded", "failed", "cancelled"],
		})
			.notNull()
			.default("pending"),
		reason: text("reason").notNull(),
		requestedBy: text("requested_by").references(() => users.id, {
			onDelete: "set null",
		}),
		completedAt: integer("completed_at", { mode: "timestamp_ms" }),
		failureCode: text("failure_code"),
		attemptCount: integer("attempt_count").notNull().default(0),
		nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }),
		...timestamps,
	},
	(table) => [
		uniqueIndex("refunds_idempotency_uidx").on(table.idempotencyKey),
		uniqueIndex("refunds_attempt_provider_uidx").on(
			table.paymentAttemptId,
			table.providerRefundId,
		),
		index("refunds_order_created_idx").on(
			table.orderId,
			table.createdAt,
			table.id,
		),
		index("refunds_status_updated_idx").on(table.status, table.updatedAt),
		check(
			"refunds_amount_check",
			sql`${moneyCheck(table.amountMinor)} AND ${table.amountMinor} <> '0'`,
		),
		check(
			"refunds_payment_amount_check",
			sql`${moneyCheck(table.paymentAmountMinor)} AND ${table.paymentAmountMinor} <> '0'`,
		),
		check(
			"refunds_payment_currency_decimals_check",
			sql`${table.paymentCurrencyDecimals} BETWEEN 0 AND 8`,
		),
		check("refunds_attempt_count_check", sql`${table.attemptCount} >= 0`),
	],
);

export const afterSaleCases = sqliteTable(
	"after_sale_cases",
	{
		id: text("id").primaryKey(),
		orderId: text("order_id")
			.notNull()
			.references(() => shopOrders.id),
		orderItemId: text("order_item_id").references(() => shopOrderItems.id),
		caseNumber: text("case_number").notNull(),
		type: text("type", {
			enum: ["refund", "redelivery", "rebuild", "dispute"],
		}).notNull(),
		status: text("status", {
			enum: ["open", "processing", "resolved", "rejected", "closed"],
		})
			.notNull()
			.default("open"),
		reason: text("reason").notNull(),
		resolution: text("resolution"),
		openedByUserId: text("opened_by_user_id").references(() => users.id),
		assignedUserId: text("assigned_user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
		...timestamps,
	},
	(table) => [
		uniqueIndex("after_sale_cases_number_uidx").on(table.caseNumber),
		index("after_sale_cases_status_created_idx").on(
			table.status,
			table.createdAt,
			table.id,
		),
		index("after_sale_cases_order_created_idx").on(
			table.orderId,
			table.createdAt,
			table.id,
		),
	],
);

export const notificationTemplates = sqliteTable(
	"notification_templates",
	{
		id: text("id").primaryKey(),
		event: text("event").notNull(),
		channel: text("channel", { enum: ["email"] }).notNull(),
		locale: text("locale", {
			enum: ["en-US", "zh-CN"],
		}).notNull(),
		subject: text("subject"),
		body: text("body").notNull(),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
		...timestamps,
	},
	(table) => [
		uniqueIndex("notification_templates_event_channel_locale_uidx").on(
			table.event,
			table.channel,
			table.locale,
		),
	],
);

export const notificationChannelConfigs = sqliteTable(
	"notification_channel_configs",
	{
		id: text("id").primaryKey(),
		channel: text("channel", { enum: ["email"] }).notNull(),
		name: text("name").notNull(),
		provider: text("provider", {
			enum: [
				"resend",
				"postmark",
				"sendgrid",
				"mailgun",
				"smtp",
				"cloudflare_email",
			],
		}).notNull(),
		apiKeyEncrypted: text("api_key_encrypted"),
		apiKeyVersion: integer("api_key_version"),
		domain: text("domain"),
		region: text("region", { enum: ["us", "eu"] })
			.notNull()
			.default("us"),
		smtpHost: text("smtp_host"),
		smtpPort: integer("smtp_port"),
		smtpUser: text("smtp_user"),
		fromAddress: text("from_address").notNull(),
		replyTo: text("reply_to"),
		sortOrder: integer("sort_order").notNull().default(100),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
		lastHealthStatus: text("last_health_status", {
			enum: ["unknown", "healthy", "unhealthy"],
		})
			.notNull()
			.default("unknown"),
		lastCheckedAt: integer("last_checked_at", { mode: "timestamp_ms" }),
		...timestamps,
	},
	(table) => [
		uniqueIndex("notification_channel_configs_channel_name_uidx").on(
			table.channel,
			table.name,
		),
		check(
			"notification_channel_configs_key_version_check",
			sql`(${table.apiKeyEncrypted} IS NULL AND ${table.apiKeyVersion} IS NULL) OR
				(${table.apiKeyEncrypted} IS NOT NULL AND ${table.apiKeyVersion} > 0)`,
		),
	],
);

export const notificationSubscriptions = sqliteTable(
	"notification_subscriptions",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		event: text("event").notNull(),
		channel: text("channel", { enum: ["email"] }).notNull(),
		destinationEncrypted: text("destination_encrypted"),
		destinationKeyVersion: integer("destination_key_version"),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
		...timestamps,
	},
	(table) => [
		index("notification_subscriptions_event_enabled_idx").on(
			table.event,
			table.enabled,
			table.id,
		),
		uniqueIndex("notification_subscriptions_user_event_channel_uidx").on(
			table.userId,
			table.event,
			table.channel,
		),
		check(
			"notification_subscriptions_destination_check",
			sql`(${table.destinationEncrypted} IS NULL AND ${table.destinationKeyVersion} IS NULL) OR
				(${table.destinationEncrypted} IS NOT NULL AND ${table.destinationKeyVersion} > 0)`,
		),
		check(
			"notification_subscriptions_channel_check",
			sql`${table.channel} = 'email'`,
		),
	],
);

export const notificationDeliveries = sqliteTable(
	"notification_deliveries",
	{
		id: text("id").primaryKey(),
		templateId: text("template_id").references(() => notificationTemplates.id),
		subscriptionId: text("subscription_id").references(
			() => notificationSubscriptions.id,
		),
		channelConfigId: text("channel_config_id").references(
			() => notificationChannelConfigs.id,
		),
		event: text("event").notNull(),
		channel: text("channel", { enum: ["email"] }).notNull(),
		locale: text("locale", {
			enum: ["en-US", "zh-CN"],
		})
			.notNull()
			.default("en-US"),
		idempotencyKey: text("idempotency_key").notNull(),
		messageEncrypted: text("message_encrypted").notNull(),
		messageKeyVersion: integer("message_key_version").notNull(),
		providerMessageId: text("provider_message_id"),
		entitlementId: text("entitlement_id").references(
			() => customerEntitlements.id,
		),
		assetType: text("asset_type", {
			enum: ["stock_secret", "download_asset", "automation_artifact"],
		}),
		assetId: text("asset_id"),
		accessEventType: text("access_event_type", {
			enum: ["email_content_sent", "link_sent"],
		}),
		status: text("status", {
			enum: ["pending", "sending", "delivered", "failed"],
		})
			.notNull()
			.default("pending"),
		attemptCount: integer("attempt_count").notNull().default(0),
		nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }),
		deliveredAt: integer("delivered_at", { mode: "timestamp_ms" }),
		errorCode: text("error_code"),
		...timestamps,
	},
	(table) => [
		uniqueIndex("notification_deliveries_idempotency_uidx").on(
			table.idempotencyKey,
		),
		index("notification_deliveries_status_attempt_idx").on(
			table.status,
			table.nextAttemptAt,
			table.id,
		),
		check(
			"notification_deliveries_attempt_count_check",
			sql`${table.attemptCount} >= 0`,
		),
		check(
			"notification_deliveries_message_version_check",
			sql`${table.messageKeyVersion} > 0`,
		),
		check(
			"notification_deliveries_asset_shape_check",
			sql`(${table.entitlementId} IS NULL AND ${table.assetType} IS NULL AND
				 ${table.assetId} IS NULL AND ${table.accessEventType} IS NULL) OR
				(${table.entitlementId} IS NOT NULL AND ${table.assetType} IS NOT NULL AND
				 ${table.assetId} IS NOT NULL AND ${table.accessEventType} IS NOT NULL)`,
		),
	],
);

export const outboxEvents = sqliteTable(
	"outbox_events",
	{
		id: text("id").primaryKey(),
		eventType: text("event_type").notNull(),
		aggregateType: text("aggregate_type").notNull(),
		aggregateId: text("aggregate_id").notNull(),
		idempotencyKey: text("idempotency_key").notNull(),
		payload: text("payload", { mode: "json" })
			.$type<Record<string, string | number | boolean | null>>()
			.notNull(),
		status: text("status", {
			enum: ["pending", "processing", "published", "failed"],
		})
			.notNull()
			.default("pending"),
		attemptCount: integer("attempt_count").notNull().default(0),
		nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }),
		publishedAt: integer("published_at", { mode: "timestamp_ms" }),
		lastErrorCode: text("last_error_code"),
		...timestamps,
	},
	(table) => [
		uniqueIndex("outbox_events_idempotency_uidx").on(table.idempotencyKey),
		index("outbox_events_status_attempt_idx").on(
			table.status,
			table.nextAttemptAt,
			table.createdAt,
			table.id,
		),
		index("outbox_events_aggregate_idx").on(
			table.aggregateType,
			table.aggregateId,
			table.createdAt,
			table.id,
		),
		check("outbox_events_attempt_count_check", sql`${table.attemptCount} >= 0`),
	],
);
