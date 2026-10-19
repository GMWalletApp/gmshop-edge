// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
	agents: vi.fn(),
	leaderboard: vi.fn(),
	withdrawals: vi.fn(),
	rules: vi.fn(),
}));
vi.mock("#/features/agent-program/server/admin", () => ({
	listAgentsFn: calls.agents,
	getLeaderboardFn: calls.leaderboard,
	getWithdrawalsFn: calls.withdrawals,
	getProgramRulesFn: calls.rules,
	getAgentFn: vi.fn(),
	reviewLeaderboardFn: vi.fn(),
	markWithdrawalPaidFn: vi.fn(),
	updateOpeningFeeFn: vi.fn(),
}));
vi.mock("#/features/agent-program/views", () => ({
	AgentDetail: () => null,
	ProgramRulesView: () => <div>rules mounted</div>,
}));
vi.mock("#/components/pro/table", () => ({
	ProTable: ({ data }: { data: unknown }) => (
		<pre data-table>{JSON.stringify(data)}</pre>
	),
}));
vi.mock("#/layouts/components/page-header", () => ({
	PageHeader: ({ actions }: { actions: React.ReactNode }) => (
		<div>{actions}</div>
	),
}));

import { AgentProgramPage } from "#/features/agent-program/page";
import { agentsQuery, beijingMonth } from "#/features/agent-program/queries";
import { overwriteGetLocale } from "#/paraglide/runtime";

const rules = {
	currency: "CNY",
	start_date: "2026-10-19",
	rebate_enabled: true,
	rebate_window_days: 90,
	schedules: {},
	leaderboard_enabled: true,
	leaderboard_rewards: [],
	withdraw_settlement_weekday: 1,
	withdraw_min_amount: "50.00",
	min_markup_percent: "3.00",
	default_markup_percent: "5.00",
};
const list = (month = beijingMonth()) => ({
	month,
	rules,
	data_updated_at: Date.UTC(2026, 9, 18),
	agents: [
		{
			id: 1,
			label: "Instant agent",
			status: "active",
			month: { sales: "123.45", orders: 2, profit: "9.99" },
			own_month: { orders: 1, amount: "50.00" },
			our_profit_month: {
				profit: "3.21",
				unknown_order_count: 0,
				unknown_amount: "0.00",
			},
			rebate: { credited_total: "1.00" },
		},
	],
});
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}
let root: Root;
let el: HTMLDivElement;
let client: QueryClient;
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	overwriteGetLocale(() => "zh-CN");
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	el = document.createElement("div");
	document.body.appendChild(el);
	root = createRoot(el);
	vi.clearAllMocks();
	calls.agents.mockResolvedValue(list());
	calls.withdrawals.mockResolvedValue([]);
	calls.leaderboard.mockResolvedValue({
		month: beijingMonth(),
		rules,
		ranking: [],
		drafts: [],
	});
	calls.rules.mockResolvedValue(rules);
});
afterEach(async () => {
	await act(async () => root.unmount());
	client.clear();
	el.remove();
	overwriteGetLocale(() => "en-US");
});
const mount = async () => {
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<AgentProgramPage />
			</QueryClientProvider>,
		),
	);
};
const settle = async () => {
	await act(async () => {
		await new Promise((r) => setTimeout(r, 20));
	});
};
it("starts all independent reads together and renders agents without waiting for secondary endpoints", async () => {
	const agents = deferred<ReturnType<typeof list>>();
	const secondary = new Promise(() => {});
	calls.agents.mockReturnValue(agents.promise);
	calls.leaderboard.mockReturnValue(secondary);
	calls.withdrawals.mockReturnValue(secondary);
	calls.rules.mockReturnValue(secondary);
	await mount();
	for (const call of Object.values(calls))
		expect(call).toHaveBeenCalledTimes(1);
	await act(async () => agents.resolve(list()));
	await settle();
	expect(el.querySelector("[data-table]")?.textContent).toContain(
		"Instant agent",
	);
	expect(el.textContent).toContain("123.45");
	expect(el.textContent).toContain("更新中");
	expect(el.textContent).not.toContain("rules mounted");
});
it("reopening within staleTime is instant and a refetch keeps old money visible with an updating indicator", async () => {
	await client.prefetchQuery(agentsQuery(beijingMonth()));
	await mount();
	await settle();
	expect(calls.agents).toHaveBeenCalledTimes(1);
	const next = deferred<ReturnType<typeof list>>();
	calls.agents.mockReturnValue(next.promise);
	let done: Promise<unknown>;
	await act(async () => {
		done = client.refetchQueries({ queryKey: ["agent-program", "agents"] });
	});
	await settle();
	expect(el.querySelector("[data-table]")?.textContent).toContain("123.45");
	expect(el.textContent).toContain("更新中");
	await act(async () => {
		next.resolve(list());
		await done;
	});
});
it("labels retained previous-month data honestly until the new month arrives, and refresh bypasses server cache", async () => {
	await mount();
	await settle();
	const old = beijingMonth();
	const nextMonth = old === "2026-09" ? "2026-08" : "2026-09";
	const next = deferred<ReturnType<typeof list>>();
	calls.agents.mockReturnValueOnce(next.promise);
	await act(async () => {
		const input = el.querySelector("input[type=month]") as HTMLInputElement;
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set?.call(input, nextMonth);
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.dispatchEvent(new Event("change", { bubbles: true }));
	});
	expect(el.textContent).toContain(`显示月份 ${old}`);
	expect(el.querySelector("[data-table]")?.textContent).toContain("123.45");
	await act(async () => next.resolve(list(nextMonth)));
	await settle();
	expect(el.textContent).toContain(`显示月份 ${nextMonth}`);
	await act(async () => {
		Array.from(el.querySelectorAll("button"))
			.find((b) => b.textContent === "刷新")
			?.click();
	});
	await settle();
	expect(calls.agents).toHaveBeenLastCalledWith({
		data: { month: nextMonth, refresh: true },
	});
	expect(calls.leaderboard).toHaveBeenLastCalledWith({
		data: { month: nextMonth, refresh: true },
	});
	expect(calls.rules).toHaveBeenLastCalledWith({ data: { refresh: true } });
});
it("only mounts tab content when opened", async () => {
	await mount();
	await settle();
	expect(el.textContent).not.toContain("rules mounted");
	await act(async () => {
		const tab = Array.from(el.querySelectorAll('[role="tab"]')).find(
			(t) => t.textContent === "规则",
		) as HTMLElement;
		tab.dispatchEvent(
			new MouseEvent("mousedown", { button: 0, bubbles: true }),
		);
	});
	expect(el.textContent).toContain("rules mounted");
});
it("hides pending-review and rejected applicants from the table and totals", async () => {
	const base = list();
	const applicant = (id: number, status: string) => ({
		...base.agents[0],
		id,
		label: `Applicant ${status}`,
		status,
		month: { sales: "1000.00", orders: 1, profit: "0.00" },
		own_month: { orders: 1, amount: "700.00" },
	});
	calls.agents.mockResolvedValue({
		...base,
		agents: [
			...base.agents,
			applicant(2, "pending_review"),
			applicant(3, "rejected"),
		],
	});
	await mount();
	await settle();
	const table = el.querySelector("[data-table]")?.textContent ?? "";
	expect(table).toContain("Instant agent");
	expect(table).not.toContain("Applicant");
	expect(el.textContent).toContain("本月主站进货");
	expect(el.textContent).toContain("123.45");
	expect(el.textContent).not.toContain("2,123.45");
	expect(el.textContent).not.toContain("1,450.00");
});
