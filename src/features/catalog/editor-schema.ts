import { z } from "zod";
import { deliveryEmailModes, renewalModes } from "./schema";

export const deliveryComponentTypes = [
	"stock",
	"download",
	"automation",
] as const;

const id = z.uuid();
const nullablePositiveInt = z.number().int().positive().nullable();
const productTagNamesSchema = z
	.array(z.string().trim().min(1).max(50))
	.max(20)
	.transform((names) => [...new Set(names)]);
const deliveryPolicySchema = z.object({
	type: z.enum(deliveryComponentTypes),
	durationMs: nullablePositiveInt,
	usageLimit: nullablePositiveInt,
	accessLimit: nullablePositiveInt,
	renewalMode: z.enum(renewalModes),
	emailMode: z.enum(deliveryEmailModes),
	showOnOrderPage: z.boolean(),
	allowResend: z.boolean(),
	lowStockThreshold: z.number().int().min(0).max(1_000_000),
});
const productContent = {
	name: z.string().trim().min(1).max(160),
	description: z.string().trim().max(50_000).nullable().default(null),
	tagNames: productTagNamesSchema.default([]),
};

export const productEditorIdSchema = z.object({ productId: id });

export const productCreateInputSchema = z.object({
	productType: z.enum(deliveryComponentTypes),
	...productContent,
});

export const productContentInputSchema = z.object({
	productId: id,
	expectedRevision: z.number().int().positive(),
	productType: z.enum(deliveryComponentTypes),
	...productContent,
	coverObjectKey: z.string().trim().max(1_000).nullable(),
});

export const productSellableItemsInputSchema = z
	.object({
		productId: id,
		expectedRevision: z.number().int().positive(),
		sellableItems: z
			.array(
				z.object({
					id: id.optional(),
					name: z.string().trim().min(1).max(120),
					listPriceMinor: z.string().regex(/^\d+$/).nullable(),
					priceMinor: z.string().regex(/^\d+$/),
					costMinor: z.string().regex(/^\d+$/).nullable(),
					currency: z.string().regex(/^[A-Z]{3}$/),
					currencyDecimals: z.number().int().min(0).max(8),
					minimumQuantity: z.number().int().positive(),
					maximumQuantity: z.number().int().positive(),
					maximumPerCustomer: nullablePositiveInt,
					delivery: deliveryPolicySchema,
					enabled: z.boolean(),
					saleDisabled: z.boolean().default(false),
					reminderCycleDays: z
						.number()
						.int()
						.min(1)
						.max(3650)
						.nullable()
						.optional(),
				}),
			)
			.min(1)
			.max(100),
	})
	.superRefine((input, context) => {
		if (
			new Set(input.sellableItems.map((item) => item.name)).size !==
			input.sellableItems.length
		)
			context.addIssue({
				code: "custom",
				path: ["sellableItems"],
				message: "Sellable item names must be unique",
			});
		for (const [index, item] of input.sellableItems.entries()) {
			if (item.maximumQuantity < item.minimumQuantity)
				context.addIssue({
					code: "custom",
					path: ["sellableItems", index, "maximumQuantity"],
					message:
						"Maximum quantity must be greater than or equal to minimum quantity",
				});
			const component = item.delivery;
			if (component.type !== "download" && component.accessLimit != null)
				context.addIssue({
					code: "custom",
					path: ["sellableItems", index, "delivery", "accessLimit"],
					message: "Only download delivery supports an access limit",
				});
			if (component.type !== "automation" && component.usageLimit != null)
				context.addIssue({
					code: "custom",
					path: ["sellableItems", index, "delivery", "usageLimit"],
					message: "Only automation delivery can consume usage quota",
				});
			if (
				component.emailMode === "content" &&
				(component.type === "download" || component.type === "automation")
			)
				context.addIssue({
					code: "custom",
					path: ["sellableItems", index, "delivery", "emailMode"],
					message:
						"Downloads and automation artifacts can only be emailed as links",
				});
			if (
				component.emailMode === "content" &&
				(component.durationMs != null ||
					component.usageLimit != null ||
					component.accessLimit != null)
			)
				context.addIssue({
					code: "custom",
					path: ["sellableItems", index, "delivery", "emailMode"],
					message: "Limited delivery cannot be sent directly in email",
				});
		}
	});

export const publishProductInputSchema = z.object({
	productId: id,
	expectedRevision: z.number().int().positive(),
	publish: z.boolean().default(true),
});

export const productSaleDisabledInputSchema = z.object({
	productId: id,
	expectedRevision: z.number().int().positive(),
	disabled: z.boolean(),
});

export const sellableItemSaleDisabledInputSchema = z.object({
	productId: id,
	sellableItemId: id,
	expectedRevision: z.number().int().positive(),
	disabled: z.boolean(),
});

export const productRevisionInputSchema = z.object({
	productId: id,
	expectedRevision: z.number().int().positive(),
});
