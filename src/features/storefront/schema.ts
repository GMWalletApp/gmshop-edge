import { z } from "zod";
import { supportedLocales } from "#/lib/locales";

export const storefrontListSchema = z.object({
	search: z.string().trim().max(200).default(""),
	tag: z.string().trim().max(100).default(""),
	sort: z
		.enum(["featured", "newest", "price_asc", "price_desc", "popular"])
		.default("featured"),
});

export const storefrontCatalogSchema = storefrontListSchema.extend({
	locale: z.enum(supportedLocales).default("zh-CN"),
});

export const cartItemSchema = z.object({
	sellableItemId: z.uuid(),
	quantity: z.number().int().min(1).max(1_000),
});

export const storedCartItemsSchema = z
	.array(cartItemSchema.strict())
	.max(50)
	.refine(
		(items) =>
			new Set(items.map((item) => item.sellableItemId)).size === items.length,
		"Each sellable item can appear only once",
	);

export const checkoutSearchSchema = z.object({
	mode: z.enum(["buy-now"]).optional(),
	sellableItemId: z.uuid().optional(),
	quantity: z.coerce.number().int().min(1).max(1_000).default(1),
});

export const cartSyncSchema = z.object({
	items: z.array(cartItemSchema).max(50),
	expectedVersion: z.number().int().positive().nullable().default(null),
});

export const cartMutationSchema = cartItemSchema.extend({
	expectedVersion: z.number().int().positive().nullable().default(null),
});

export const cartRemoveSchema = z.object({
	sellableItemId: z.uuid(),
	expectedVersion: z.number().int().positive(),
});

export const productIdSchema = z.object({
	productId: z.uuid(),
	locale: z.enum(supportedLocales).default("zh-CN"),
});

const orderInputValueSchema = z.union([
	z.string().max(10_000),
	z.number().int(),
	z.boolean(),
	z.array(z.string().max(1_000)).max(100),
]);

const orderInputValuesSchema = z
	.record(z.string().min(1).max(64), orderInputValueSchema)
	.default({});

const orderContactSchema = {
	agentAccessTermsAccepted: z.boolean().optional(),
	// Optional lsrai.shop sub-site label; validated with lsrai.shop at checkout.
	agentSubsitePrefix: z.string().trim().toLowerCase().max(32).nullish(),
	email: z.email().trim().toLowerCase().max(320).nullable().default(null),
	couponCode: z.string().trim().toUpperCase().max(64).default(""),
	idempotencyKey: z.string().trim().min(8).max(200),
	customerNote: z.string().trim().max(500).default(""),
	commerceSessionId: z.uuid().nullable().default(null),
	locale: z.enum(supportedLocales).default("en-US"),
};

export const commerceEventSchema = z.object({
	eventType: z.enum([
		"catalog_viewed",
		"product_viewed",
		"cart_item_added",
		"checkout_started",
		"cross_sell_landed",
		"redeem_landed",
	]),
	sessionId: z.uuid(),
	productId: z.uuid().nullable().default(null),
	sellableItemId: z.uuid().nullable().default(null),
});

export const multiStoreOrderSchema = z.object({
	...orderContactSchema,
	items: z
		.array(
			z.object({
				sellableItemId: z.uuid(),
				quantity: z.number().int().min(1).max(1_000),
				inputValues: orderInputValuesSchema,
				renewedFromEntitlementId: z.uuid().nullable().default(null),
			}),
		)
		.min(1)
		.max(100)
		.refine(
			(items) =>
				new Set(items.map((item) => item.sellableItemId)).size === items.length,
			"Each plan can appear only once",
		),
});

export const createStoreOrderSchema = multiStoreOrderSchema;

const checkoutFields = {
	walletPayment: z.boolean().default(false),
	useBalance: z.boolean().default(false),
	paymentChannelId: z.uuid().nullable().default(null),
	paymentCurrency: z
		.string()
		.trim()
		.toUpperCase()
		.regex(/^[A-Z]{3}$/)
		.nullable()
		.default(null),
	termsAccepted: z.literal(true),
};

export const checkoutStoreOrderSchema = multiStoreOrderSchema
	.extend(checkoutFields)
	.refine(
		(value) => !(value.walletPayment && value.useBalance),
		"Choose either legacy wallet payment or split balance payment",
	);

export const storeOrderLookupSchema = z.object({
	orderNumber: z.string().trim().toUpperCase().min(8).max(80),
	email: z.string().trim().toLowerCase().pipe(z.email().max(320)),
});
