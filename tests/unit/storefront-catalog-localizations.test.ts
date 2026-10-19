import { describe, expect, it } from "vitest";
import { localizeSellableItem } from "#/features/storefront/catalog-localizations";

const fallback = {
	name: "测试规格",
	policy: {
		delivery: "付款确认后人工处理",
		deliveryTime: "24小时内交付；可在订单页查看交付状态和内容",
		coverage: "覆盖规则",
		warranty: "质保规则",
		restrictions: "限制规则",
	},
};

describe("storefront catalog localizations", () => {
	it.each([
		"3小时内交付；可在订单页查看交付状态和内容",
		"6小时内交付；可在订单页查看交付状态和内容",
		"12小时内交付；可在订单页查看交付状态和内容",
		"24小时内交付；可在订单页查看交付状态和内容",
	])("standardizes English online-delivery timing", (deliveryTime) => {
		const item = localizeSellableItem(
			"983f6e73-061e-419d-a7d5-8ac5ec5648ab",
			"en-US",
			{
				...fallback,
				policy: { ...fallback.policy, deliveryTime },
			},
			"manual",
		);

		expect(item.policy.delivery).toBe(
			"Processed online after payment confirmation",
		);
		expect(item.policy.deliveryTime).toContain("1–30 minutes");
		expect(item.policy.deliveryTime).toContain("3 hours");
		expect(item.policy.coverage).toContain("Replacement supported");
	});
});

it("names every ChatGPT plan in English, grouped as plan｜channel｜term", () => {
	const ids = {
		"21859feb-e4d5-469f-9ca8-11fa4b9e5d18": "ChatGPT Pro 100｜Chile｜1 month",
		"0829de43-da22-420c-9866-38c83dd420f0":
			"ChatGPT Pro 200｜Philippines new｜1 month",
		"030582df-98c1-5b87-914d-28ddc606e163":
			"ChatGPT Pro 500｜Philippines｜1 month",
		"521968d1-5c64-45bf-a4bc-7df906dcc1cb": "ChatGPT Pro 500｜Chile｜1 month",
		"ceab0998-9dc1-4f3e-94e4-a8332a311eaf":
			"ChatGPT Business｜2 Standard seats｜1 month",
		"30754dc5-5ba6-4923-9527-62dd91b8e19e":
			"ChatGPT Business｜Premium + Standard seat｜1 month",
	};
	for (const [id, name] of Object.entries(ids)) {
		const item = localizeSellableItem(id, "en-US", fallback);
		expect(item.name).toBe(name);
		expect(`${item.name}${Object.values(item.policy).join("")}`).not.toMatch(
			/[\u4e00-\u9fff]/,
		);
	}
	const chile = localizeSellableItem(
		"521968d1-5c64-45bf-a4bc-7df906dcc1cb",
		"en-US",
		fallback,
	);
	expect(chile.policy.delivery).toBe("24/7 automatic delivery");
	expect(chile.policy.coverage).toContain("must currently be on Free");
});
