import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { allSystemPermissionGrants } from "#/features/access/system-rbac";
import {
	money,
	statusLabel,
	tierGuardLabel,
} from "#/features/agent-program/presentation";
import {
	leaderboardSchema,
	type ProgramRules,
	rulesSchema,
} from "#/features/agent-program/schema";
import { systemSidebarData } from "#/layouts/components/data/sidebar-data";
import { overwriteGetLocale } from "#/paraglide/runtime";

vi.mock("#/features/agent-program/server/admin", () => ({
	getAgentFn: vi.fn(),
	updateOpeningFeeFn: vi.fn(),
}));

import { ProgramRulesView } from "#/features/agent-program/views";

const rules: ProgramRules = {
	currency: "CNY",
	start_date: "2026-10-19",
	rebate_enabled: true,
	rebate_window_days: 90,
	schedules: {
		"99": [
			{ threshold: "2000.00", amount: "50.00" },
			{ threshold: "4000.00", amount: "49.00" },
		],
	},
	leaderboard_enabled: true,
	leaderboard_rewards: ["50.00", "30.00", "20.00"],
	withdraw_settlement_weekday: 1,
	withdraw_min_amount: "50.00",
	min_markup_percent: "3.00",
	default_markup_percent: "5.00",
};
afterEach(() => overwriteGetLocale(() => "en-US"));
describe("agent management presentation", () => {
	it.each([
		"en-US",
		"zh-CN",
	] as const)("renders the upstream rules without a second hardcoded schedule in %s", (locale) => {
		overwriteGetLocale(() => locale);
		const rendered = renderToStaticMarkup(<ProgramRulesView rules={rules} />);
		expect(rendered).toContain("2,000.00");
		expect(rendered).toContain("4,000.00");
		expect(rendered).toContain("49.00");
		expect(rendered).toContain(
			locale === "zh-CN" ? "2026年10月19日" : "Oct 19, 2026",
		);
		expect(rendered).not.toContain("2026-10-19");
		expect(rendered).toContain(locale === "zh-CN" ? "星期一" : "Monday");
		expect(rendered).toContain(
			locale === "zh-CN" ? "退款会扣掉" : "less refunds",
		);
		const changed = renderToStaticMarkup(
			<ProgramRulesView
				rules={{
					...rules,
					withdraw_settlement_weekday: 3,
					withdraw_min_amount: "71.23",
					rebate_window_days: 45,
				}}
			/>,
		);
		expect(changed).toContain(locale === "zh-CN" ? "星期三" : "Wednesday");
		expect(changed).toContain("71.23");
		expect(changed).toContain("45");
	});
	it("accepts configured currencies and renders their actual units", () => {
		const usd = rulesSchema.parse({ ...rules, currency: "USD" });
		const rendered = renderToStaticMarkup(<ProgramRulesView rules={usd} />);
		expect(rendered).toContain("$50.00");
		expect(rendered).not.toContain("¥");
		expect(money("50.00", "USDT")).toBe("USDT 50.00");
		expect(rulesSchema.safeParse({ ...rules, currency: "usd" }).success).toBe(
			false,
		);
	});
	it("hides the navigation for non-owner/admin roles even with broad permissions", () => {
		const data = (roles: string[]) =>
			JSON.stringify(systemSidebarData(allSystemPermissionGrants, roles));
		expect(data(["root"])).toContain("/admin/agents");
		expect(data(["admin"])).toContain("/admin/agents");
		expect(data(["support"])).not.toContain("/admin/agents");
	});
	it("accepts pending reward drafts with upstream omitempty review fields", () => {
		const result = leaderboardSchema.parse({
			month: "2026-10",
			ranking: [],
			drafts: [
				{
					id: 1,
					month: "2026-10",
					rank: 1,
					reseller_id: 33,
					user_id: 33,
					wholesale_amount: "2000.00",
					reward_amount: "50.00",
					status: "pending_approval",
					reviewed_operator: "",
				},
			],
			rules,
		});
		expect(result.drafts[0]?.reviewed_at).toBeNull();
		expect(result.drafts[0]?.reject_reason).toBe("");
		expect(statusLabel(result.drafts[0]?.status ?? "")).toBe("Pending");
	});
});

it("shows internal break-even states and exact profit gaps in both locales", () => {
	for (const locale of ["zh-CN", "en-US"] as const) {
		overwriteGetLocale(() => locale);
		expect(
			tierGuardLabel({ guard_state: "waiting_profit", profit_gap: "12.34" }),
		).toContain("12.34");
		expect(
			tierGuardLabel({ guard_state: "waiting_profit", profit_gap: "12.34" }),
		).toContain(
			locale === "zh-CN" ? "已达门槛，等利润覆盖" : "awaiting profit coverage",
		);
		expect(tierGuardLabel({ guard_state: "profit_unavailable" })).toContain(
			locale === "zh-CN" ? "暂停返还" : "rebates paused",
		);
		expect(tierGuardLabel({ guard_state: "credited" })).toBe(
			locale === "zh-CN" ? "已入账" : "Credited",
		);
	}
});
