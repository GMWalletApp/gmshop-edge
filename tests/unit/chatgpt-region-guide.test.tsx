// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import {
	ChatGptRegionGuide,
	chatGptRechargeProductId,
} from "#/features/storefront/components/chatgpt-region-guide";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("ChatGPT region guide", () => {
	let root: ReturnType<typeof createRoot> | undefined;
	let container: HTMLDivElement | undefined;

	afterEach(async () => {
		await act(async () => root?.unmount());
		container?.remove();
		root = undefined;
		container = undefined;
	});

	it("explains the purchase decision without claiming different product legitimacy", async () => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		await act(async () => root?.render(<ChatGptRegionGuide />));

		const text = container.textContent ?? "";
		expect(text).toContain("iOS channel");
		expect(text).toContain("Supports replacement");
		expect(text).toContain("You do not provide an Apple ID");
		expect(text).toContain("remaining time is not added");
		expect(text).toContain("Card-pay channels");
		expect(text).toContain("Free plan");
		expect(text).toContain("Business");
		expect(text).toContain("Philippines renewal");
		expect(text).toContain("PHP 8,919.64");
		expect(text).toContain("one day before it expires");
		expect(text).toContain("No upgrades");
		expect(text).not.toContain("Pro 20X");
		expect(text).toContain("official ChatGPT account");
		expect(container.querySelectorAll("li")).toHaveLength(3);
	});

	it("appears on the product page without repeating on checkout", () => {
		expect(chatGptRechargeProductId).toBe(
			"2a794b89-3bb9-49d4-8691-0d13a1606869",
		);
		const product = readFileSync(
			join(process.cwd(), "src/features/storefront/pages/product.tsx"),
			"utf8",
		);
		const checkout = readFileSync(
			join(process.cwd(), "src/features/storefront/pages/checkout.tsx"),
			"utf8",
		);
		expect(product).toContain(
			"data.id === chatGptRechargeProductId ? <ChatGptRegionGuide /> : null",
		);
		expect(product).toContain('href="#chatgpt-region-guide"');
		expect(checkout).not.toContain("chatGptRechargeProductId");
		expect(checkout).not.toContain("<ChatGptRegionGuide />");
	});
});
