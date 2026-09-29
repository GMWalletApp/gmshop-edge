import { describe, expect, it } from "vitest";
import {
	productCreateInputSchema,
	productSellableItemsInputSchema,
} from "#/features/catalog/editor-schema";

const productId = "11111111-1111-4111-8111-111111111111";
const componentId = "44444444-4444-4444-8444-444444444444";
const secondComponentId = "55555555-5555-4555-8555-555555555555";

describe("generic product editor schemas", () => {
	it("requires one product name before creating", () => {
		expect(
			productCreateInputSchema.safeParse({
				name: "Product",
				productType: "download",
				description: null,
				tagNames: ["software"],
			}).success,
		).toBe(true);
		expect(
			productCreateInputSchema.safeParse({
				name: "",
				productType: "download",
				description: null,
				tagNames: [],
			}).success,
		).toBe(false);
		expect(
			productCreateInputSchema.safeParse({
				name: "Product",
				productType: "mixed",
				description: null,
				tagNames: [],
			}).success,
		).toBe(false);
	});

	it("trims only tag boundaries and removes exact duplicates", () => {
		expect(
			productCreateInputSchema.parse({
				name: "Product",
				productType: "stock",
				description: null,
				tagNames: [" Tag ", "Tag", "New  Tag"],
			}).tagNames,
		).toEqual(["Tag", "New  Tag"]);
	});

	it("requires at least one sellable item and accepts independent items", () => {
		const input = {
			productId,
			expectedRevision: 1,
			sellableItems: [sellableItem("Standard")],
		};
		expect(productSellableItemsInputSchema.safeParse(input).success).toBe(true);
		expect(
			productSellableItemsInputSchema.safeParse({
				...input,
				sellableItems: [],
			}).success,
		).toBe(false);
		expect(
			productSellableItemsInputSchema.safeParse({
				...input,
				sellableItems: [
					sellableItem("Standard"),
					sellableItem("Premium", secondComponentId),
				],
			}).success,
		).toBe(true);
	});

	it("rejects duplicate sellable item names", () => {
		expect(
			productSellableItemsInputSchema.safeParse({
				productId,
				expectedRevision: 1,
				sellableItems: [sellableItem("Standard"), sellableItem("Standard")],
			}).success,
		).toBe(false);
	});

	it("requires each sellable item to own its delivery policy", () => {
		const withoutDelivery = {
			...sellableItem("Unconfigured"),
			delivery: undefined,
		};
		expect(
			productSellableItemsInputSchema.safeParse({
				productId,
				expectedRevision: 1,
				sellableItems: [withoutDelivery],
			}).success,
		).toBe(false);
	});

	it("keeps entitlement and presentation policy on sellable items", () => {
		expect(
			productSellableItemsInputSchema.safeParse({
				productId,
				expectedRevision: 1,
				sellableItems: [
					sellableItem("Automation", componentId, {
						type: "automation",
						durationMs: 30 * 86_400_000,
						usageLimit: 10,
						accessLimit: null,
						renewalMode: "stack",
						emailMode: "link",
						showOnOrderPage: true,
						allowResend: true,
						lowStockThreshold: 0,
					}),
				],
			}).success,
		).toBe(true);
	});

	it.each(["stock", "automation"] as const)(
		"does not allow an access limit for %s delivery",
		(type) => {
			const delivery = {
				type,
				durationMs: null,
				usageLimit: null,
				accessLimit: 1,
				renewalMode: "disabled" as const,
				emailMode: "link" as const,
				showOnOrderPage: true,
				allowResend: true,
				lowStockThreshold: 0,
			};
			expect(
				productSellableItemsInputSchema.safeParse({
					productId,
					expectedRevision: 1,
					sellableItems: [sellableItem("Limited", componentId, delivery)],
				}).success,
			).toBe(false);
		},
	);

	it("only exposes service usage quota for automation delivery", () => {
		const delivery = {
			type: "download" as const,
			durationMs: null,
			usageLimit: 1,
			accessLimit: null,
			renewalMode: "disabled" as const,
			emailMode: "link" as const,
			showOnOrderPage: true,
			allowResend: true,
			lowStockThreshold: 0,
		};
		expect(
			productSellableItemsInputSchema.safeParse({
				productId,
				expectedRevision: 1,
				sellableItems: [sellableItem("Download", componentId, delivery)],
			}).success,
		).toBe(false);
		expect(
			productSellableItemsInputSchema.safeParse({
				productId,
				expectedRevision: 1,
				sellableItems: [
					sellableItem("Automation", componentId, {
						...delivery,
						type: "automation",
					}),
				],
			}).success,
		).toBe(true);
	});

	it("rejects the retired manual delivery type", () => {
		expect(
			productSellableItemsInputSchema.safeParse({
				productId,
				expectedRevision: 1,
				sellableItems: [
					sellableItem("Manual", componentId, {
						type: "manual",
						durationMs: null,
						usageLimit: null,
						accessLimit: null,
						renewalMode: "disabled",
						emailMode: "none",
						showOnOrderPage: true,
						allowResend: true,
						lowStockThreshold: 0,
					}),
				],
			}).success,
		).toBe(false);
	});
});

function sellableItem(
	name: string,
	id = componentId,
	delivery: {
		type: string;
		durationMs: number | null;
		usageLimit: number | null;
		accessLimit: number | null;
		renewalMode: "stack" | "disabled";
		emailMode: "none" | "link" | "content";
		showOnOrderPage: boolean;
		allowResend: boolean;
		lowStockThreshold: number;
	} = {
		type: "download" as const,
		durationMs: null,
		usageLimit: null,
		accessLimit: null,
		renewalMode: "stack" as const,
		emailMode: "link" as const,
		showOnOrderPage: true,
		allowResend: true,
		lowStockThreshold: 0,
	},
) {
	return {
		id,
		name,
		listPriceMinor: null,
		priceMinor: "1000",
		costMinor: null,
		currency: "USD",
		currencyDecimals: 2,
		minimumQuantity: 1,
		maximumQuantity: 1,
		maximumPerCustomer: null,
		delivery,
		enabled: true,
	};
}
