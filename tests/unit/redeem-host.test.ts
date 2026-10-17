import { describe, expect, it } from "vitest";
import {
	RESELLER_REDEEM_URL,
	redeemUrlForOrder,
	STOREFRONT_REDEEM_URL,
	withOrderRedeemHost,
	withRedeemHost,
} from "#/features/redeem-warehouse/redeem-host";

const dbWith = (apiOrder: boolean) =>
	({
		prepare: (sql: string) => ({
			bind: (id: string) => ({
				first: async () => {
					expect(sql).toContain("supplier_api_orders");
					expect(id).toBe("order-1");
					return apiOrder ? { 1: 1 } : null;
				},
			}),
		}),
	}) as unknown as D1Database;

describe("redemption host by order channel", () => {
	it("gives API (reseller) orders the reseller host and storefront orders the storefront host", async () => {
		expect(await redeemUrlForOrder(dbWith(true), "order-1")).toBe(
			RESELLER_REDEEM_URL,
		);
		expect(await redeemUrlForOrder(dbWith(false), "order-1")).toBe(
			STOREFRONT_REDEEM_URL,
		);
	});

	it("rewrites either stored host, with or without a trailing slash, and leaves other links alone", () => {
		const stored = [
			"CDK：gpt-plus-ph-AAAA\n充值地址：https://redeem.lsrai.shop",
			"CDK：gpt-5x-ph-BBBB\n充值地址：https://redeem.laoshirenvip.com/",
			"CDK：OTHER\n充值地址：https://verified.example/redeem",
		].join("\n");
		expect(withRedeemHost(stored, STOREFRONT_REDEEM_URL)).toBe(
			[
				"CDK：gpt-plus-ph-AAAA\n充值地址：https://redeem.laoshirenvip.com",
				"CDK：gpt-5x-ph-BBBB\n充值地址：https://redeem.laoshirenvip.com",
				"CDK：OTHER\n充值地址：https://verified.example/redeem",
			].join("\n"),
		);
		expect(withRedeemHost(stored, RESELLER_REDEEM_URL)).not.toContain(
			"laoshirenvip",
		);
	});

	it("shows admins the host of the order's own channel", async () => {
		const stored =
			"CDK：claude-max-5x-ios-AAAA\n充值地址：https://redeem.lsrai.shop";
		expect(await withOrderRedeemHost(dbWith(false), "order-1", stored)).toBe(
			"CDK：claude-max-5x-ios-AAAA\n充值地址：https://redeem.laoshirenvip.com",
		);
		expect(await withOrderRedeemHost(dbWith(true), "order-1", stored)).toBe(
			stored,
		);
	});
});
