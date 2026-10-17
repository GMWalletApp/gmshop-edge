// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type PropsWithChildren, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({
	getPromotionAccountFn: vi.fn(),
	openReferralFn: vi.fn(),
	setMarketingConsentFn: vi.fn(),
}));
vi.mock("#/features/promotions/server/functions", () => server);
vi.mock("@tanstack/react-router", () => ({
	Link: ({
		children,
		to,
		search,
	}: PropsWithChildren<{ to: string; search?: { redirect?: string } }>) => (
		<a href={`${to}?redirect=${encodeURIComponent(search?.redirect ?? "")}`}>
			{children}
		</a>
	),
}));
vi.mock("#/paraglide/messages", () => ({
	m: new Proxy(
		{},
		{
			get: (_, key) => (input?: { amount?: string }) =>
				input?.amount ? `${String(key)}:${input.amount}` : String(key),
		},
	),
}));

import {
	CrossSellBlock,
	OrderGrowthBlocks,
} from "#/features/storefront/components/order-growth";
import type { OrderGrowth } from "#/features/storefront/server/order-growth";

const code = "INV-ABCDEFGHIJKLMNOPQRST";
const growth = (patch: Partial<OrderGrowth> = {}): OrderGrowth => ({
	signedIn: true,
	referralRewardMinor: "100",
	crossSell: [],
	...patch,
});
const account = (referral: { code: string; enabled: number } | null) => ({
	balanceMinor: "0",
	marketingConsent: false,
	referral,
	rewards: [],
	coupons: [],
	entries: [],
});

describe("order growth blocks", () => {
	let container: HTMLDivElement;
	let root: Root;
	let client: QueryClient;

	beforeEach(() => {
		(
			globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
		).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		vi.clearAllMocks();
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	async function render(node: ReactNode) {
		await act(async () => {
			root.render(
				<QueryClientProvider client={client}>{node}</QueryClientProvider>,
			);
		});
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	}

	it("renders nothing when the server withholds growth blocks", () => {
		const html = renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<OrderGrowthBlocks growth={null} redirectPath="/account/orders/X" />
			</QueryClientProvider>,
		);
		expect(html).toBe("");
		expect(renderToStaticMarkup(<CrossSellBlock items={[]} />)).toBe("");
	});

	it("asks guests to sign in with the order email", async () => {
		await render(
			<OrderGrowthBlocks
				growth={growth({ signedIn: false })}
				redirectPath="/account/orders/GM1"
			/>,
		);
		expect(container.textContent).toContain("promotion_invite_pitch");
		expect(container.textContent).toContain("promotion_invite_guest");
		expect(
			container
				.querySelector('[data-testid="referral-guest"] a')
				?.getAttribute("href"),
		).toBe(`/sign-in?redirect=${encodeURIComponent("/account/orders/GM1")}`);
		expect(server.getPromotionAccountFn).not.toHaveBeenCalled();
	});

	it("shows an existing invite link with the concrete reward", async () => {
		server.getPromotionAccountFn.mockResolvedValue(
			account({ code, enabled: 1 }),
		);
		await render(
			<OrderGrowthBlocks
				growth={growth()}
				redirectPath="/account/orders/GM1"
			/>,
		);
		const input = container.querySelector<HTMLInputElement>(
			"#referral-invite-link",
		);
		expect(input?.value).toBe(`${window.location.origin}/?ref=${code}`);
		expect(container.textContent).toContain("promotion_invite_amount:¥1.00");
		expect(container.textContent).not.toContain("promotion_open");
	});

	it("hides the amount when the item has no budget and opens a link on demand", async () => {
		server.getPromotionAccountFn.mockResolvedValueOnce(account(null));
		server.getPromotionAccountFn.mockResolvedValue(
			account({ code, enabled: 1 }),
		);
		server.openReferralFn.mockResolvedValue({ code, enabled: 1 });
		await render(
			<OrderGrowthBlocks
				growth={growth({ referralRewardMinor: "0" })}
				redirectPath="/account/orders/GM1"
			/>,
		);
		expect(container.textContent).not.toContain("promotion_invite_amount");
		const button = [...container.querySelectorAll("button")].find((element) =>
			element.textContent?.includes("promotion_open"),
		);
		expect(button).toBeDefined();
		await act(async () => {
			button?.click();
		});
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(server.openReferralFn).toHaveBeenCalledTimes(1);
		expect(
			container.querySelector<HTMLInputElement>("#referral-invite-link")?.value,
		).toBe(`${window.location.origin}/?ref=${code}`);
	});

	it("lists cross-sell cards with prices and preselected item links", async () => {
		server.getPromotionAccountFn.mockResolvedValue(
			account({ code, enabled: 1 }),
		);
		await render(
			<OrderGrowthBlocks
				growth={growth({
					crossSell: [
						{
							sellableItemId: "item-b",
							productId: "product-claude",
							productName: "Claude",
							sellableItemName: "Claude Pro 1个月",
							priceMinor: "16800",
							currency: "CNY",
							currencyDecimals: 2,
							coverUrl: null,
							href: "/products/product-claude?item=item-b&ref=xsell#purchase-options",
						},
					],
				})}
				redirectPath="/account/orders/GM1"
			/>,
		);
		const block = container.querySelector('[data-testid="cross-sell"]');
		expect(block?.textContent).toContain("store_cross_sell_title");
		expect(block?.textContent).toContain("Claude Pro 1个月");
		expect(block?.textContent).toContain("¥168.00");
		expect(block?.querySelector("a")?.getAttribute("href")).toBe(
			"/products/product-claude?item=item-b&ref=xsell#purchase-options",
		);
	});
});
