import {
	agentAccessKind,
	agentAccessProducts,
} from "#/features/agent-access/products";
import {
	agentCheckoutStatement,
	prepareAgentCheckout,
} from "#/features/agent-access/server/checkout";
import {
	assertKnownInputKeys,
	type ProductInputDefinition,
	parseProductInputDefinitions,
	serializeInputValue,
} from "#/features/catalog/input-values";
import { couponScopeSchema } from "#/features/coupons/schema";
import { pricePromotion } from "#/features/promotions/pricing";
import {
	assertPromotionOwner,
	type PromotionCoupon,
} from "#/features/promotions/server/coupons";
import {
	prepareSale,
	reserveSaleStatements,
} from "#/features/redeem-warehouse/server/sale-capacity";
import { multiStoreOrderSchema } from "#/features/storefront/schema";
import { DomainError } from "#/lib/domain-error";
import { loadRuntimeConfig } from "#/server/runtime-config";
import { encryptOrderInput } from "./order-input-secrets";
import {
	SUPPLIER_SNAPSHOT_MAX_AGE_MS,
	supplierFallbackEnabledExpression,
	supplierUnfundedCheckoutExpression,
} from "./stock-availability";

type MultiOrderInput = ReturnType<typeof multiStoreOrderSchema.parse>;
type SellableItemContext = {
	sellable_item_id: string;
	sellable_item_name: string;
	price_minor: string;
	cost_minor: string | null;
	promotion_budget_minor: string;
	currency: string;
	currency_decimals: number;
	delivery_component_id: string;
	delivery_component_type: "stock" | "download" | "automation";
	delivery_component_version: number;
	duration_ms: number | null;
	usage_limit: number | null;
	access_limit: number | null;
	activation_trigger: "delivery_completed";
	exhaustion_rule: "first_limit_reached";
	renewal_mode: "stack" | "disabled";
	show_on_order_page: number;
	account_library_enabled: number;
	email_mode: "none" | "link" | "content";
	allow_resend: number;
	item_minimum_quantity: number;
	item_maximum_quantity: number;
	item_maximum_per_customer: number | null;
	product_id: string;
	product_name: string;
	definition_version_id: string | null;
	download_asset_count: number;
	fulfillment_source: "local" | "manual" | "supplier";
	supplier_fallback_enabled: number;
	supplier_status: "not_applicable" | "available" | "unavailable";
};

type Line = {
	input: MultiOrderInput["items"][number];
	sellableItem: SellableItemContext;
	subtotal: bigint;
	discount: bigint;
	orderItemId: string;
	inputs: Awaited<ReturnType<typeof prepareInputs>>;
};

type PricingLine = Omit<Line, "inputs">;

type CouponRow = PromotionCoupon & {
	id: string;
	type: "fixed" | "percentage";
	currency: string | null;
	currency_decimals: number | null;
	value_minor: string | null;
	value_bps: number | null;
	minimum_order_minor: string | null;
	maximum_discount_minor: string | null;
	usage_limit: number | null;
	usage_limit_per_customer: number | null;
	used_count: number;
	customer_use_count: number;
};

export async function createMultiStoreOrder(
	db: D1Database,
	rawInput: unknown,
	access: {
		userId?: string;
		identityEmail?: string;
		pricingChannelId?: string;
	} = {},
) {
	const input = multiStoreOrderSchema.parse(rawInput);
	if (!access.userId && !input.email)
		throw new DomainError(
			"contact_email_required",
			400,
			"Enter an email address to place a guest order",
		);
	const normalizedContactEmail = input.email;
	const existing = await db
		.prepare(
			`SELECT id, order_number, user_id, normalized_contact_email, status,
			 total_minor, currency, currency_decimals, expires_at
			 FROM shop_orders WHERE idempotency_key = ? LIMIT 1`,
		)
		.bind(input.idempotencyKey)
		.first<{
			id: string;
			order_number: string;
			user_id: string | null;
			normalized_contact_email: string;
			status: string;
			total_minor: string;
			currency: string;
			currency_decimals: number;
			expires_at: number;
		}>();
	if (existing) {
		const sameOwner = access.userId
			? existing.user_id === access.userId
			: existing.normalized_contact_email === normalizedContactEmail;
		if (!sameOwner)
			throw new DomainError(
				"idempotency_key_conflict",
				409,
				"Idempotency key belongs to another checkout",
			);
		return {
			id: existing.id,
			orderNumber: existing.order_number,
			status: existing.status,
			totalMinor: existing.total_minor,
			currency: existing.currency,
			currencyDecimals: existing.currency_decimals,
			expiresAt: existing.expires_at,
			duplicate: true,
		};
	}

	const policy = await loadOrderPolicy(db);
	if (!access.userId && !policy.allowGuestCheckout)
		throw new DomainError(
			"guest_checkout_disabled",
			403,
			"Sign in to place an order",
		);
	const runtime = await loadRuntimeConfig(db);
	if (access.pricingChannelId) {
		const channel = await db
			.prepare("SELECT id FROM payment_channels WHERE id = ? AND enabled = 1")
			.bind(access.pricingChannelId)
			.first<{ id: string }>();
		if (!channel)
			throw new DomainError(
				"payment_channel_unavailable",
				404,
				"Payment channel unavailable",
			);
	}

	const agentCheckout = await prepareAgentCheckout(db, input, access.userId);
	const lines: Line[] = [];
	const capacityComponents = new Set<string>();
	for (const item of input.items) {
		const sellableItem = await loadSellableItem(
			db,
			item.sellableItemId,
			access.pricingChannelId,
		);
		if (!access.userId && sellableItem.delivery_component_type === "automation")
			throw new DomainError(
				"account_required_for_delivery",
				403,
				"Sign in to purchase this item",
			);
		validateQuantity(sellableItem, item.quantity, policy.maxQuantity);
		await assertPurchaseLimit(
			db,
			{ userId: access.userId, normalizedEmail: input.email },
			sellableItem,
			item.quantity,
		);
		if (sellableItem.delivery_component_type === "stock") {
			if (
				await prepareSale(db, sellableItem.delivery_component_id, item.quantity)
			)
				capacityComponents.add(sellableItem.delivery_component_id);
			await assertStockAvailability(db, sellableItem, item.quantity);
		}
		if (item.renewedFromEntitlementId)
			await assertRenewal(
				db,
				access.userId,
				item.renewedFromEntitlementId,
				sellableItem.sellable_item_id,
				sellableItem.renewal_mode,
			);
		const definitions =
			sellableItem.delivery_component_type !== "automation" &&
			sellableItem.definition_version_id
				? await loadDefinitions(db, sellableItem.definition_version_id)
				: [];
		assertKnownInputKeys(item.inputValues, definitions, "order", "order");
		lines.push({
			input: item,
			sellableItem,
			subtotal: BigInt(sellableItem.price_minor) * BigInt(item.quantity),
			discount: 0n,
			orderItemId: crypto.randomUUID(),
			inputs: await prepareInputs(
				item.inputValues,
				definitions,
				runtime.commerceSecret,
			),
		});
	}
	assertSingleCurrency(lines);
	const subtotal = lines.reduce((sum, line) => sum + line.subtotal, 0n);
	const couponIdentity = access.identityEmail ?? normalizedContactEmail;
	if (input.couponCode && !couponIdentity)
		throw new DomainError(
			"contact_email_required",
			400,
			"An account email is required to use this coupon",
		);
	const coupon = input.couponCode
		? await loadCoupon(db, input.couponCode, {
				userId: access.userId,
				normalizedEmail: couponIdentity,
			})
		: null;
	const priced = await priceStoreCoupon(db, coupon, lines);
	const promotion = coupon && coupon.purpose !== "standard" ? priced : null;
	const discount = BigInt(priced.discountMinor);
	const total = subtotal - discount;
	if (
		agentCheckout &&
		(discount !== 0n ||
			lines[0]?.sellableItem.price_minor !==
				agentAccessProducts[agentCheckout.kind].priceMinor)
	)
		throw new DomainError(
			"agent_access_price_invalid",
			409,
			"Access price cannot be overridden",
		);

	const orderId = crypto.randomUUID();
	const now = Date.now();
	const expiresAt = now + policy.expiryMs;
	const orderNumber = createOrderNumber();
	const firstItem = lines[0]?.sellableItem;
	if (!firstItem) throw new DomainError("order_empty", 400, "Order is empty");
	const statements: D1PreparedStatement[] = [];
	if (coupon) {
		statements.push(
			db
				.prepare(
					`UPDATE coupons SET used_count = used_count + 1, updated_at = ?
					 WHERE id = ? AND enabled = 1 AND used_count = ?
					 AND (usage_limit IS NULL OR used_count < usage_limit)`,
				)
				.bind(now, coupon.id, coupon.used_count),
			db
				.prepare(
					`INSERT INTO shop_orders
				 (id, order_number, idempotency_key, user_id,
					  contact_email, normalized_contact_email, locale, status, currency, currency_decimals,
					  subtotal_minor, discount_minor, total_minor, paid_minor, coupon_id,
					  customer_note, version, expires_at, created_at, updated_at, pricing_channel_id)
					 SELECT ?, ?, ?, ?, ?, ?, ?, 'pending_payment', ?, ?, ?, ?, ?, '0', ?, ?, 1, ?, ?, ?, ?
					 FROM coupons WHERE id = ? AND changes() = 1`,
				)
				.bind(
					orderId,
					orderNumber,
					input.idempotencyKey,
					access.userId ?? null,
					input.email,
					normalizedContactEmail,
					input.locale,
					firstItem.currency,
					firstItem.currency_decimals,
					subtotal.toString(),
					discount.toString(),
					total.toString(),
					coupon.id,
					input.customerNote || null,
					expiresAt,
					now,
					now,
					access.pricingChannelId ?? null,
					coupon.id,
				),
		);
	} else {
		statements.push(
			db
				.prepare(
					`INSERT INTO shop_orders
				 (id, order_number, idempotency_key, user_id,
					  contact_email, normalized_contact_email, locale, status, currency, currency_decimals,
					  subtotal_minor, discount_minor, total_minor, paid_minor, customer_note,
					  version, expires_at, created_at, updated_at, pricing_channel_id)
					 VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_payment', ?, ?, ?, ?, ?, '0', ?, 1, ?, ?, ?, ?)`,
				)
				.bind(
					orderId,
					orderNumber,
					input.idempotencyKey,
					access.userId ?? null,
					input.email,
					normalizedContactEmail,
					input.locale,
					firstItem.currency,
					firstItem.currency_decimals,
					subtotal.toString(),
					discount.toString(),
					total.toString(),
					input.customerNote || null,
					expiresAt,
					now,
					now,
					access.pricingChannelId ?? null,
				),
		);
	}

	for (const line of lines) {
		statements.push(
			db
				.prepare(
					`INSERT INTO shop_order_items
					 (id, order_id, product_id, sellable_item_id, product_name, delivery_component_id,
					  delivery_component_type, delivery_component_version,
					  sellable_item_name, definition_version_id, input_values_json,
					  sensitive_input_values_json, quantity,
					  unit_price_minor, unit_cost_minor, discount_minor, subtotal_minor,
					  renewed_from_entitlement_id, duration_ms, usage_limit, access_limit,
					  activation_trigger, exhaustion_rule, renewal_mode,
					  show_on_order_page, account_library_enabled, email_mode, allow_resend,
					  created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.bind(
					line.orderItemId,
					orderId,
					line.sellableItem.product_id,
					line.sellableItem.sellable_item_id,
					line.sellableItem.product_name,
					line.sellableItem.delivery_component_id,
					line.sellableItem.delivery_component_type,
					line.sellableItem.delivery_component_version,
					line.sellableItem.sellable_item_name,
					line.sellableItem.definition_version_id,
					JSON.stringify(
						Object.fromEntries(
							line.inputs
								.filter((item) => item.value !== null)
								.map((item) => [
									item.definition.definition_key,
									item.value as string,
								]),
						),
					),
					JSON.stringify(
						Object.fromEntries(
							line.inputs
								.filter((item) => item.valueEncrypted !== null)
								.map((item) => [
									item.definition.definition_key,
									{
										envelope: item.valueEncrypted as string,
										keyVersion: 1,
									},
								]),
						),
					),
					line.input.quantity,
					line.sellableItem.price_minor,
					line.sellableItem.cost_minor,
					line.discount.toString(),
					line.subtotal.toString(),
					line.input.renewedFromEntitlementId,
					line.sellableItem.duration_ms,
					line.sellableItem.usage_limit,
					line.sellableItem.access_limit,
					line.sellableItem.activation_trigger,
					line.sellableItem.exhaustion_rule,
					line.sellableItem.renewal_mode,
					line.sellableItem.show_on_order_page,
					line.sellableItem.account_library_enabled,
					line.sellableItem.email_mode,
					line.sellableItem.allow_resend,
					now,
					now,
				),
		);
		if (agentCheckout)
			statements.push(
				agentCheckoutStatement(db, agentCheckout, line.orderItemId, now),
			);
		if (capacityComponents.has(line.sellableItem.delivery_component_id))
			statements.push(
				...reserveSaleStatements(
					db,
					line.sellableItem.delivery_component_id,
					line.orderItemId,
					line.input.quantity,
					now,
				),
			);
		if (line.sellableItem.delivery_component_type === "download")
			statements.push(
				db
					.prepare(
						`INSERT INTO order_item_download_assets
						 (id, order_item_id, download_asset_id, asset_version, object_key, file_name, content_type,
						  size_bytes, checksum_sha256, created_at, updated_at)
						 SELECT ? || ':' || asset.id, ?, asset.id, asset.version, asset.object_key, asset.file_name,
						  asset.content_type, asset.size_bytes, asset.checksum_sha256, ?, ?
						 FROM download_assets asset
						 JOIN download_asset_sellable_items binding
						  ON binding.download_asset_id = asset.id
						   AND binding.sellable_item_id = ?
						 WHERE asset.product_id = ? AND asset.download_enabled = 1`,
					)
					.bind(
						line.orderItemId,
						line.orderItemId,
						now,
						now,
						line.sellableItem.delivery_component_id,
						line.sellableItem.product_id,
					),
			);
	}
	statements.push(
		db
			.prepare(
				`INSERT INTO shop_order_events
				 (id, order_id, event_type, visibility, actor_type, created_at)
				 VALUES (?, ?, 'order_created', 'customer', 'customer', ?)`,
			)
			.bind(crypto.randomUUID(), orderId, now),
	);
	if (input.commerceSessionId)
		statements.push(
			db
				.prepare(
					`INSERT INTO commerce_events
					 (id, event_type, session_id, order_id, currency, amount_minor, created_at)
					 VALUES (?, 'order_created', ?, ?, ?, ?, ?)`,
				)
				.bind(
					crypto.randomUUID(),
					input.commerceSessionId,
					orderId,
					firstItem.currency,
					total.toString(),
					now,
				),
		);
	if (coupon)
		statements.push(
			db
				.prepare(
					`INSERT INTO coupon_redemptions
					 (id, coupon_id, order_id, user_id, normalized_email, discount_minor,
					  status, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`,
				)
				.bind(
					crypto.randomUUID(),
					coupon.id,
					orderId,
					access.userId ?? null,
					couponIdentity,
					discount.toString(),
					now,
					now,
				),
		);

	if (promotion && coupon) {
		statements.push(
			db
				.prepare(
					`UPDATE shop_orders SET promotion_purpose = ?, referrer_user_id = ?, referral_reward_minor = ? WHERE id = ?`,
				)
				.bind(
					coupon.purpose,
					coupon.referrer_user_id,
					promotion.rewardMinor,
					orderId,
				),
		);
		for (const line of promotion.lines)
			statements.push(
				db
					.prepare(
						"UPDATE shop_order_items SET referral_reward_minor = ? WHERE id = ?",
					)
					.bind(line.rewardMinor, line.id),
			);
	}
	try {
		await db.batch(statements);
	} catch (error) {
		if (
			error instanceof Error &&
			/owned_code_stock_unavailable/.test(error.message)
		)
			throw new DomainError(
				"inventory_unavailable",
				409,
				"Insufficient owned codes",
			);
		if (coupon)
			throw new DomainError("coupon_unavailable", 409, "Coupon is unavailable");
		throw error;
	}
	return {
		id: orderId,
		orderNumber,
		status: "pending_payment",
		totalMinor: total.toString(),
		currency: firstItem.currency,
		currencyDecimals: firstItem.currency_decimals,
		expiresAt,
		duplicate: false,
	};
}

async function loadSellableItem(
	db: D1Database,
	sellableItemId: string,
	pricingChannelId?: string,
) {
	const sellableItem = await db
		.prepare(
			`SELECT s.id AS sellable_item_id,
			 s.name AS sellable_item_name,
			 COALESCE((
			  SELECT channel_price.price_minor
			  FROM sellable_item_channel_prices channel_price
			  JOIN payment_channels channel ON channel.id = channel_price.channel_id
			  WHERE channel_price.sellable_item_id = s.id
			   AND channel_price.channel_id = ? AND channel_price.enabled = 1
			   AND channel.enabled = 1 LIMIT 1
			 ), s.price_minor) AS price_minor,
			 s.cost_minor, CASE WHEN s.promotion_budget_minor='800' AND CAST(s.price_minor AS INTEGER)<100000
    THEN '0' ELSE s.promotion_budget_minor END AS promotion_budget_minor, s.currency, s.currency_decimals,
			 s.fulfillment_source, s.supplier_status,
 ${supplierFallbackEnabledExpression("s")} AS supplier_fallback_enabled,
			 s.id AS delivery_component_id, p.product_type AS delivery_component_type,
			 s.version AS delivery_component_version,
			 s.duration_ms, s.usage_limit, s.access_limit,
			 CASE WHEN p.product_type = 'download' THEN (
			  SELECT COUNT(*) FROM download_assets asset
			  JOIN download_asset_sellable_items binding
			   ON binding.download_asset_id = asset.id
			  WHERE binding.sellable_item_id = s.id AND asset.product_id = p.id
			   AND asset.download_enabled = 1
			 ) ELSE -1 END AS download_asset_count,
			 'delivery_completed' AS activation_trigger, 'first_limit_reached' AS exhaustion_rule,
			 s.renewal_mode, s.show_on_order_page, 1 AS account_library_enabled,
			 s.email_mode, s.allow_resend,
			 s.minimum_quantity AS item_minimum_quantity, s.maximum_quantity AS item_maximum_quantity,
			 s.maximum_per_customer AS item_maximum_per_customer, p.id AS product_id,
			 p.name AS product_name,
			 CASE WHEN p.product_type = 'automation' THEN (
			  SELECT s.active_definition_version_id
			  WHERE s.automation_provider IS NOT NULL
			   AND s.active_definition_version_id IS NOT NULL AND EXISTS (
			   SELECT 1 FROM product_automation_methods method
			   WHERE method.sellable_item_id = s.id
			    AND method.config_version = s.version
			    AND method.enabled = 1
			  ) LIMIT 1
			 ) ELSE (
			  SELECT pdv.id FROM product_definition_versions pdv
			  WHERE pdv.sellable_item_id = s.id ORDER BY pdv.version DESC LIMIT 1
			 ) END AS definition_version_id
			 FROM product_sellable_items s JOIN products p ON p.id = s.product_id
			 WHERE s.id = ? AND s.enabled = 1 AND s.sale_disabled = 0
			  AND p.status = 'active' AND p.sale_disabled = 0 LIMIT 1`,
		)
		.bind(pricingChannelId ?? null, sellableItemId)
		.first<SellableItemContext>();
	if (!sellableItem)
		throw new DomainError(
			"sellable_item_unavailable",
			404,
			"Product plan is unavailable",
		);
	if (
		sellableItem.delivery_component_type === "automation" &&
		!sellableItem.definition_version_id &&
		!agentAccessKind(sellableItemId)
	)
		throw new DomainError(
			"automation_configuration_unavailable",
			409,
			"Automation configuration is unavailable",
		);
	if (
		sellableItem.delivery_component_type === "download" &&
		Number(sellableItem.download_asset_count) < 1
	)
		throw new DomainError(
			"download_unavailable",
			409,
			"Download files are unavailable",
		);
	return sellableItem;
}

function validateQuantity(
	sellableItem: SellableItemContext,
	quantity: number,
	globalMaximum: number,
) {
	const minimum = sellableItem.item_minimum_quantity;
	const maximum = Math.min(sellableItem.item_maximum_quantity, globalMaximum);
	if (quantity < minimum || quantity > maximum)
		throw new DomainError(
			"quantity_invalid",
			400,
			"Quantity is outside the allowed range",
		);
}

async function assertStockAvailability(
	db: D1Database,
	sellableItem: SellableItemContext,
	quantity: number,
) {
	if (sellableItem.fulfillment_source === "manual") return;
	if (sellableItem.fulfillment_source === "supplier") {
		await assertSupplierAvailability(
			db,
			sellableItem.sellable_item_id,
			quantity,
		);
		return;
	}
	const row = await db
		.prepare(
			"SELECT COUNT(*) AS total FROM stock_entries WHERE sellable_item_id = ? AND status = 'available'",
		)
		.bind(sellableItem.sellable_item_id)
		.first<{ total: number }>();
	if (Number(row?.total ?? 0) >= quantity) return;
	throw new DomainError(
		"inventory_unavailable",
		409,
		"Inventory is unavailable",
	);
}

export async function assertSupplierAvailability(
	db: D1Database,
	sellableItemId: string,
	quantity: number,
	now = Date.now(),
) {
	const binding = await db
		.prepare(
			`SELECT provider, normalized_api_origin, protocol_version,
			 reference_cost_minor, max_cost_minor, stock_quantity,
			 ${supplierUnfundedCheckoutExpression("sellable_item_id")} AS unfunded_checkout
			 FROM supplier_bindings
			 WHERE sellable_item_id = ? AND enabled = 1
			  AND remote_status = 'active' AND last_synced_at >= ?
			 LIMIT 1`,
		)
		.bind(sellableItemId, now - SUPPLIER_SNAPSHOT_MAX_AGE_MS)
		.first<{
			provider: string;
			normalized_api_origin: string;
			protocol_version: string;
			reference_cost_minor: string;
			max_cost_minor: string;
			stock_quantity: number;
			unfunded_checkout: number;
		}>();
	if (
		!binding ||
		BigInt(binding.reference_cost_minor) > BigInt(binding.max_cost_minor) ||
		Number(binding.stock_quantity) < quantity
	)
		throw new DomainError(
			"supplier_inventory_unavailable",
			409,
			"Supplier inventory is unavailable",
		);
	const accounts = await db
		.prepare(
			`SELECT balance_minor, reserve_balance_minor, max_order_cost_minor
			 FROM supplier_accounts
			 WHERE provider = ? AND normalized_api_origin = ? AND protocol_version = ?
			  AND enabled = 1 AND health_status <> 'unavailable'
			  AND (cooldown_until IS NULL OR cooldown_until <= ?)
			  AND balance_minor IS NOT NULL
			 ORDER BY id LIMIT 20`,
		)
		.bind(
			binding.provider,
			binding.normalized_api_origin,
			binding.protocol_version,
			now,
		)
		.all<{
			balance_minor: string;
			reserve_balance_minor: string;
			max_order_cost_minor: string | null;
		}>();
	const required = BigInt(binding.reference_cost_minor) * BigInt(quantity);
	const hasCandidate = accounts.results.some((account) => {
		const maximum =
			account.max_order_cost_minor == null
				? null
				: BigInt(account.max_order_cost_minor);
		return (
			(maximum == null || required <= maximum) &&
			(binding.unfunded_checkout === 1 ||
				BigInt(account.balance_minor) - BigInt(account.reserve_balance_minor) >=
					required)
		);
	});
	if (!hasCandidate)
		throw new DomainError(
			"supplier_account_unavailable",
			409,
			"No supplier account can fulfill this item",
		);
}

async function assertPurchaseLimit(
	db: D1Database,
	owner: { userId?: string; normalizedEmail: string | null },
	sellableItem: SellableItemContext,
	quantity: number,
) {
	const limits = [sellableItem.item_maximum_per_customer].filter(
		(value): value is number => value != null,
	);
	if (!limits.length) return;
	const limit = Math.min(...limits);
	const row = await db
		.prepare(
			`SELECT COALESCE(SUM(oi.quantity), 0) AS total FROM shop_order_items oi
			 JOIN shop_orders o ON o.id = oi.order_id
			 WHERE ${owner.userId ? "o.user_id = ?" : "o.user_id IS NULL AND o.normalized_contact_email = ?"}
			  AND oi.sellable_item_id = ?
			 AND o.status NOT IN ('cancelled', 'expired', 'refunded')`,
		)
		.bind(owner.userId ?? owner.normalizedEmail, sellableItem.sellable_item_id)
		.first<{ total: number }>();
	if (Number(row?.total ?? 0) + quantity > limit)
		throw new DomainError(
			"customer_purchase_limit",
			409,
			"Customer purchase limit reached",
		);
}

async function assertRenewal(
	db: D1Database,
	userId: string | undefined,
	entitlementId: string,
	sellableItemId: string,
	renewalMode: "stack" | "disabled",
) {
	if (!userId)
		throw new DomainError(
			"authentication_required",
			401,
			"Sign in to renew this entitlement",
		);
	if (renewalMode === "disabled")
		throw new DomainError(
			"renewal_disabled",
			409,
			"This product plan cannot be renewed",
		);
	const entitlement = await db
		.prepare(
			"SELECT id FROM customer_entitlements WHERE id = ? AND user_id = ? AND sellable_item_id = ? LIMIT 1",
		)
		.bind(entitlementId, userId, sellableItemId)
		.first();
	if (!entitlement)
		throw new DomainError(
			"renewal_unavailable",
			409,
			"Entitlement cannot be renewed",
		);
}

function assertSingleCurrency(lines: Pick<Line, "sellableItem">[]) {
	const currencies = new Set(
		lines.map(
			(line) =>
				`${line.sellableItem.currency}:${line.sellableItem.currency_decimals}`,
		),
	);
	if (currencies.size !== 1)
		throw new DomainError(
			"cart_currency_conflict",
			409,
			"Checkout items must use one currency",
		);
}

export async function previewStoreCoupon(
	db: D1Database,
	code: string,
	items: readonly { id: string; quantity: number }[],
	owner: { userId?: string; normalizedEmail: string | null },
	channelId?: string,
) {
	const coupon = await loadCoupon(db, code, owner);
	const lines: PricingLine[] = await Promise.all(
		items.map(async (item) => {
			const sellableItem = await loadSellableItem(db, item.id, channelId);
			return {
				orderItemId: item.id,
				sellableItem,
				subtotal: BigInt(sellableItem.price_minor) * BigInt(item.quantity),
				discount: 0n,
				input: {
					sellableItemId: item.id,
					quantity: item.quantity,
					inputValues: {},
					renewedFromEntitlementId: null,
				},
			};
		}),
	);
	assertSingleCurrency(lines);
	return priceStoreCoupon(db, coupon, lines);
}

async function priceStoreCoupon(
	db: D1Database,
	coupon: CouponRow | null,
	lines: PricingLine[],
) {
	const eligible = coupon ? await eligibleLines(db, coupon.id, lines) : lines;
	const subtotal = lines.reduce((sum, line) => sum + line.subtotal, 0n);
	if (!coupon || coupon.purpose === "standard") {
		const discount = allocateDiscount(coupon, subtotal, eligible);
		return {
			purpose: "standard" as const,
			discountMinor: discount.toString(),
			rewardMinor: "0",
			lines: lines.map((line) => ({
				id: line.orderItemId,
				discountMinor: line.discount.toString(),
				rewardMinor: "0",
			})),
		};
	}
	if (
		lines.some(
			(line) =>
				line.sellableItem.currency !== "CNY" ||
				line.sellableItem.currency_decimals !== 2,
		)
	)
		throw new DomainError(
			"coupon_currency_invalid",
			409,
			"Promotions require CNY",
		);
	const pricing = pricePromotion(
		coupon.purpose,
		eligible.map((line) => ({
			id: line.orderItemId,
			budgetMinor: line.sellableItem.promotion_budget_minor,
			subtotalMinor: line.subtotal.toString(),
			quantity: line.input.quantity,
		})),
	);
	if (pricing.discountMinor === "0")
		throw new DomainError(
			"coupon_scope_invalid",
			409,
			"No eligible promotion items",
		);
	for (const line of lines)
		line.discount = BigInt(
			pricing.lines.find((item) => item.id === line.orderItemId)
				?.discountMinor ?? "0",
		);
	return { purpose: coupon.purpose, ...pricing };
}

async function loadCoupon(
	db: D1Database,
	code: string,
	owner: { userId?: string; normalizedEmail: string | null },
) {
	if (!owner.userId && !owner.normalizedEmail)
		throw new DomainError(
			"contact_email_required",
			400,
			"Enter an email address to use this coupon",
		);
	const now = Date.now();
	const coupon = await db
		.prepare(
			`SELECT c.*,
			 (SELECT COUNT(*) FROM coupon_redemptions cr WHERE cr.coupon_id = c.id
			  AND ${owner.userId ? "cr.user_id = ?" : "cr.normalized_email = ?"}
			  AND cr.status IN ('reserved', 'consumed')) AS customer_use_count
			 FROM coupons c WHERE c.code = ? AND c.enabled = 1
			 AND (c.starts_at IS NULL OR c.starts_at <= ?)
			 AND (c.ends_at IS NULL OR c.ends_at > ?) LIMIT 1`,
		)
		.bind(owner.userId ?? owner.normalizedEmail, code, now, now)
		.first<CouponRow>();
	if (
		!coupon ||
		(coupon.usage_limit != null && coupon.used_count >= coupon.usage_limit)
	)
		throw new DomainError("coupon_unavailable", 409, "Coupon is unavailable");
	if (
		coupon.usage_limit_per_customer != null &&
		coupon.customer_use_count >= coupon.usage_limit_per_customer
	)
		throw new DomainError(
			"coupon_customer_limit",
			409,
			"Coupon customer limit reached",
		);
	await assertPromotionOwner(db, coupon, owner);
	return coupon;
}

async function eligibleLines(
	db: D1Database,
	couponId: string,
	lines: PricingLine[],
) {
	const coupon = await db
		.prepare("SELECT scope_json FROM coupons WHERE id = ? LIMIT 1")
		.bind(couponId)
		.first<{ scope_json: string }>();
	const scope = coupon
		? parseCouponScope(coupon.scope_json)
		: { productIds: [], tagNames: [] };
	if (!scope.productIds.length && !scope.tagNames.length) return lines;
	const products = new Set(scope.productIds);
	const tags = new Set(scope.tagNames);
	const tagProducts = new Set<string>();
	if (tags.size > 0) {
		const tagNames = [...tags];
		const productIds = [
			...new Set(lines.map((line) => line.sellableItem.product_id)),
		];
		const matches = await db
			.prepare(
				`SELECT DISTINCT product.id AS product_id
				 FROM products product, json_each(product.tag_names) tag
				 WHERE tag.value IN (${tagNames.map(() => "?").join(", ")})
				 AND product.id IN (${productIds.map(() => "?").join(", ")})`,
			)
			.bind(...tagNames, ...productIds)
			.all<{ product_id: string }>();
		for (const match of matches.results) tagProducts.add(match.product_id);
	}
	const eligible = lines.filter(
		(line) =>
			products.has(line.sellableItem.product_id) ||
			tagProducts.has(line.sellableItem.product_id),
	);
	if (!eligible.length)
		throw new DomainError(
			"coupon_scope_invalid",
			409,
			"Coupon does not apply to this order",
		);
	return eligible;
}

function parseCouponScope(value: string) {
	try {
		return couponScopeSchema.parse(JSON.parse(value));
	} catch {
		throw new DomainError(
			"coupon_scope_invalid",
			409,
			"Coupon scope is invalid",
		);
	}
}

function allocateDiscount(
	coupon: CouponRow | null,
	orderSubtotal: bigint,
	eligible: PricingLine[],
) {
	if (!coupon) return 0n;
	const first = eligible[0]?.sellableItem;
	if (!first) return 0n;
	if (
		coupon.currency &&
		(coupon.currency !== first.currency ||
			coupon.currency_decimals !== first.currency_decimals)
	)
		throw new DomainError(
			"coupon_currency_invalid",
			409,
			"Coupon currency does not match",
		);
	if (
		coupon.minimum_order_minor &&
		orderSubtotal < BigInt(coupon.minimum_order_minor)
	)
		throw new DomainError(
			"coupon_minimum_not_met",
			409,
			"Coupon minimum order is not met",
		);
	const eligibleSubtotal = eligible.reduce(
		(sum, line) => sum + line.subtotal,
		0n,
	);
	let total =
		coupon.type === "fixed"
			? BigInt(coupon.value_minor ?? "0")
			: (eligibleSubtotal * BigInt(coupon.value_bps ?? 0)) / 10_000n;
	if (coupon.maximum_discount_minor)
		total = minBigInt(total, BigInt(coupon.maximum_discount_minor));
	total = minBigInt(total, eligibleSubtotal);
	let allocated = 0n;
	const ordered = [...eligible].sort((left, right) =>
		left.sellableItem.sellable_item_id.localeCompare(
			right.sellableItem.sellable_item_id,
		),
	);
	for (const line of ordered) {
		line.discount = (total * line.subtotal) / eligibleSubtotal;
		allocated += line.discount;
	}
	if (ordered[0]) ordered[0].discount += total - allocated;
	return total;
}

type OrderInputDefinition = ProductInputDefinition & { id: string };
async function loadDefinitions(db: D1Database, versionId: string) {
	const version = await db
		.prepare(
			"SELECT schema_json FROM product_definition_versions WHERE id = ? LIMIT 1",
		)
		.bind(versionId)
		.first<{ schema_json: string }>();
	if (!version) return [];
	return parseProductInputDefinitions(versionId, version.schema_json).filter(
		(definition) => definition.scope === "order",
	);
}

async function prepareInputs(
	values: Record<string, string | number | boolean | string[]>,
	definitions: OrderInputDefinition[],
	commerceSecret: string,
) {
	const writes: Array<{
		definition: OrderInputDefinition;
		value: string | null;
		valueEncrypted: string | null;
	}> = [];
	for (const definition of definitions) {
		const provided = values[definition.definition_key];
		if (
			provided === undefined &&
			!definition.required &&
			definition.default_value == null
		)
			continue;
		const value = serializeInputValue(
			definition,
			provided ?? definition.default_value ?? "",
			"order",
		);
		if (definition.sensitive && !commerceSecret)
			throw new DomainError(
				"order_input_secret_unavailable",
				503,
				"Order input encryption is unavailable",
			);
		writes.push({
			definition,
			value: definition.sensitive ? null : value,
			valueEncrypted: definition.sensitive
				? await encryptOrderInput(value, commerceSecret)
				: null,
		});
	}
	return writes;
}

async function loadOrderPolicy(db: D1Database) {
	const rows = await db
		.prepare(
			`SELECT key, value FROM system_settings WHERE key IN
			 ('orders.allow_guest_checkout', 'orders.default_expiry_ms', 'orders.max_quantity')`,
		)
		.all<{ key: string; value: string }>();
	const values = new Map(
		rows.results.map((row) => [row.key, parseSetting(row.value)]),
	);
	return {
		allowGuestCheckout:
			typeof values.get("orders.allow_guest_checkout") === "boolean"
				? Boolean(values.get("orders.allow_guest_checkout"))
				: true,
		expiryMs:
			typeof values.get("orders.default_expiry_ms") === "number"
				? Number(values.get("orders.default_expiry_ms"))
				: 900_000,
		maxQuantity:
			typeof values.get("orders.max_quantity") === "number"
				? Number(values.get("orders.max_quantity"))
				: 100,
	};
}

function parseSetting(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

function createOrderNumber() {
	const entropy = Array.from(
		crypto.getRandomValues(new Uint8Array(16)),
		(byte) => byte.toString(16).padStart(2, "0"),
	).join("");
	return `GM${entropy.toUpperCase()}`;
}

function minBigInt(left: bigint, right: bigint) {
	return left < right ? left : right;
}
