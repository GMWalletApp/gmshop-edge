// @vitest-environment jsdom
import { type ColumnDef, flexRender } from "@tanstack/react-table";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	pending: new Map<unknown, boolean>(),
	mutations: new Map<
		unknown,
		{
			onSuccess: (
				result: unknown,
				variables: { data: { id: number; action?: string } },
			) => Promise<void>;
		}
	>(),
	detailId: 33,
	unknownCount: 0,
	unavailable: false,
}));
vi.mock("#/features/agent-program/server/admin", () => ({
	listAgentsFn: vi.fn(),
	getProgramRulesFn: vi.fn(),
	getWithdrawalsFn: vi.fn(),
	getLeaderboardFn: vi.fn(),
	getAgentFn: vi.fn(),
	updateOpeningFeeFn: vi.fn(),
	reviewLeaderboardFn: vi.fn(),
	markWithdrawalPaidFn: vi.fn(),
}));

import {
	markWithdrawalPaidFn,
	reviewLeaderboardFn,
	updateOpeningFeeFn,
} from "#/features/agent-program/server/admin";

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
function agent(id: number) {
	return {
		id,
		user_id: id,
		label: `Agent ${id}`,
		email: "agent-full@example.test",
		payout_alipay_account: "full-alipay@example.test",
		status: "active",
		domains: [
			{ domain: "demo.lsrai.shop", type: "subdomain", status: "active" },
			{
				domain: "custom.example.test",
				type: "custom",
				status: "pending_review",
			},
		],
		our_profit_month: {
			profit: state.unavailable ? null : "123.00",
			unknown_order_count: state.unknownCount,
			unknown_amount: state.unknownCount ? "1065.00" : "0.00",
		},
		our_profit_last_month: {
			profit: state.unavailable ? null : "-25.00",
			unknown_order_count: 0,
			unknown_amount: "0.00",
		},
		opened_at: "2026-10-18",
		opening_fee_paid: "99.00",
		opening_fee_source: "manual",
		our_profit_in_window: "45.00",
		profit_data_state: "available",
		unknown_profit_orders: state.unknownCount
			? [{ order_id: 9981, reason: "cost_unknown" }]
			: [],
		unknown_profit_order_count: state.unknownCount,
		unknown_profit_assumed_loss: state.unknownCount ? "7.00" : "0.00",
		month: { orders: 0, sales: "0.00", profit: "0.00" },
		last_month: { orders: 0, sales: "0.00", profit: "0.00" },
		all_time: { orders: 0, sales: "0.00", profit: "0.00" },
		own_month: { orders: 3, amount: "920.00" },
		own_last_month: { orders: 11, amount: "2315.00" },
		own_all_time: { orders: 14, amount: "3235.00" },
		withdrawable: "0.00",
		locked: "0.00",
		pending_withdrawal: "0.00",
		last_order_at: null,
		rebate: {
			eligible: false,
			manual_confirmation: false,
			fee_paid: "99.00",
			window_start: "2026-10-18",
			window_end: "2027-01-16",
			days_left: 90,
			wholesale: "0.00",
			tiers: [],
			credited_total: "0.00",
			max_total: "99.00",
			next_gap: "0.00",
			next_amount: "0.00",
		},
	};
}
vi.mock("@tanstack/react-query", () => ({
	keepPreviousData: (v: unknown) => v,
	queryOptions: (v: unknown) => v,
	useQueryClient: () => ({ invalidateQueries: vi.fn(async () => {}) }),
	useMutation: (options: {
		mutationFn: unknown;
		onSuccess: (
			result: unknown,
			variables: { data: { id: number; action?: string } },
		) => Promise<void>;
	}) => {
		state.mutations.set(options.mutationFn, options);
		return {
			isPending: state.pending.get(options.mutationFn) ?? false,
			mutateAsync: vi.fn(),
		};
	},
	useQuery: ({ queryKey }: { queryKey: unknown[] }) => ({
		isSuccess: true,
		isPending: false,
		isError: false,
		data:
			queryKey[1] === "agents"
				? {
						data_updated_at: Date.UTC(2026, 9, 18),
						month: "2026-10",
						agents: [agent(33), agent(34)],
						rules,
					}
				: queryKey[1] === "withdrawals"
					? [1, 2].map((id) => ({
							id,
							reseller_id: id,
							label: `Payout ${id}`,
							amount: "50.00",
							currency: "CNY",
							account: "full-payout@example.test",
							email: "payout-owner@example.test",
							created_at: "2026-10-19T00:00:00+08:00",
						}))
					: queryKey[1] === "leaderboard"
						? {
								rules,
								ranking: [],
								drafts: [1, 2].map((id) => ({
									id,
									reseller_id: id,
									rank: id,
									status: "pending_approval",
									reward_amount: "50.00",
								})),
							}
						: {
								agent: agent(queryKey[2] as number),
								monthly_series: [],
								credit_history: [],
							},
	}),
}));
vi.mock("#/components/pro/table", () => ({
	ProTable: ({
		columns,
		data,
	}: {
		columns: ColumnDef<Record<string, unknown>>[];
		data: Record<string, unknown>[];
	}) => (
		<div>
			{data.map((row) => (
				<div key={String(row.id)}>
					{columns.map((column, index) => (
						<span
							key={
								column.id ??
								("accessorKey" in column ? column.accessorKey : index)
							}
						>
							{column.cell
								? flexRender(column.cell, { row: { original: row } } as never)
								: null}
						</span>
					))}
				</div>
			))}
		</div>
	),
}));
vi.mock("#/components/pro/form", () => ({
	ModalForm: ({
		open,
		title,
		onOpenChange,
	}: {
		open: boolean;
		title: string;
		onOpenChange: (open: boolean) => void;
	}) =>
		open ? (
			<div data-form={title}>
				<span>{title}</span>
				<button type="button" onClick={() => onOpenChange(false)}>
					Dismiss form
				</button>
			</div>
		) : null,
}));
vi.mock("#/components/pro/overlay", () => ({
	ProModal: ({
		open,
		children,
		onOpenChange,
	}: {
		open: boolean;
		children: ReactNode;
		onOpenChange: (open: boolean) => void;
	}) =>
		open ? (
			<section>
				<button type="button" onClick={() => onOpenChange(false)}>
					Dismiss detail
				</button>
				{children}
			</section>
		) : null,
}));

import { AgentProgramPage } from "#/features/agent-program/page";
import { AgentDetail } from "#/features/agent-program/views";
import { overwriteGetLocale } from "#/paraglide/runtime";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
	state.unknownCount = 0;
	state.unavailable = false;
	overwriteGetLocale(() => "en-US");
	state.pending.clear();
	state.mutations.clear();
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
});
function click(text: string, index = 0) {
	const button = Array.from(container.querySelectorAll("button")).filter(
		(button) => button.textContent === text,
	)[index];
	if (!button) throw new Error(`missing ${text}`);
	act(() => button.click());
}
function openTab(text: string) {
	const tab = Array.from(container.querySelectorAll('[role="tab"]')).find(
		(t) => t.textContent === text,
	);
	if (!tab) throw Error(`missing tab ${text}`);
	act(() =>
		tab.dispatchEvent(
			new MouseEvent("mousedown", { button: 0, bubbles: true }),
		),
	);
}
function renderPage() {
	act(() => root.render(<AgentProgramPage />));
}

describe("agent mutation dialog identity", () => {
	it.each([
		["payout", markWithdrawalPaidFn, "Record payout", undefined],
		["reward", reviewLeaderboardFn, "Approve reward", "approve"],
	] as const)("locks pending %s dismissal/replacement and ignores stale completion", async (_kind, fn, title, action) => {
		renderPage();
		openTab(_kind === "payout" ? "Pending payouts" : "Leaderboard");
		click(title, 0);
		const firstSuccess = state.mutations.get(fn)?.onSuccess;
		state.pending.set(fn, true);
		renderPage();
		click("Dismiss form");
		expect(container.querySelector(`[data-form="${title}"]`)).not.toBeNull();
		expect(
			Array.from(container.querySelectorAll("button"))
				.filter((button) => button.textContent === title)
				.every((button) => button.disabled),
		).toBe(true);
		state.pending.set(fn, false);
		renderPage();
		click("Dismiss form");
		click(title, 1);
		await act(async () => {
			await firstSuccess?.({}, { data: { id: 1, action } });
		});
		expect(container.querySelector(`[data-form="${title}"]`)).not.toBeNull();
	});
	it("locks fee edit and detail dismissal while pending and keeps a newer agent edit open", async () => {
		const close = vi.fn();
		const render = (id: number) =>
			act(() =>
				root.render(<AgentDetail id={id} month="2026-10" onClose={close} />),
			);
		render(33);
		click("Edit opening fee paid");
		const firstSuccess = state.mutations.get(updateOpeningFeeFn)?.onSuccess;
		state.pending.set(updateOpeningFeeFn, true);
		render(33);
		click("Dismiss form");
		click("Dismiss detail");
		expect(close).not.toHaveBeenCalled();
		expect(
			container.querySelector('[data-form="Edit opening fee paid"]'),
		).not.toBeNull();
		state.pending.set(updateOpeningFeeFn, false);
		render(34);
		click("Edit opening fee paid");
		await act(async () => {
			await firstSuccess?.({}, { data: { id: 33 } });
		});
		expect(
			container.querySelector('[data-form="Edit opening fee paid"]'),
		).not.toBeNull();
	});
});

it("renders our profit and waiting tier without inferring agent profit", () => {
	overwriteGetLocale(() => "zh-CN");
	act(() =>
		root.render(<AgentDetail id={33} month="2026-10" onClose={() => {}} />),
	);
	expect(container.textContent).toContain("我们赚了");
	expect(container.textContent).toContain("45.00");
	overwriteGetLocale(() => "en-US");
});

it.each([
	"en-US",
	"zh-CN",
] as const)("shows unknown-cost losses beside our profit in %s", (locale) => {
	state.unknownCount = 2;
	overwriteGetLocale(() => locale);
	act(() =>
		root.render(<AgentDetail id={33} month="2026-10" onClose={() => {}} />),
	);
	const stat = Array.from(container.querySelectorAll("h3")).find(
		(el) =>
			el.textContent ===
			(locale === "zh-CN" ? "本月我们赚了" : "Our profit this month"),
	)?.parentElement;
	expect(stat?.textContent).toContain(
		locale === "zh-CN"
			? "另有 2 单成本未知（¥1,065.00），未计入"
			: "2 more orders with unknown costs",
	);
	expect(stat?.textContent).toContain("123.00");
	expect(container.textContent).toContain("#9981");
	// The agent's own main-site purchases are shown, not folded into sales.
	expect(container.textContent).toContain(
		locale === "zh-CN" ? "上月主站进货" : "Main-site purchases last month",
	);
	expect(container.textContent).toContain("2,315.00");
	act(() => root.render(<AgentProgramPage />));
	expect(container.textContent).toContain(
		locale === "zh-CN"
			? "另有 2 单成本未知（¥1,065.00），未计入"
			: "2 more orders with unknown costs",
	);
	expect(container.textContent).toContain("123.00");
	state.unknownCount = 0;
	overwriteGetLocale(() => "en-US");
});

it.each([
	"en-US",
	"zh-CN",
] as const)("renders full owner account, all domain types/statuses, separate periods in %s", (locale) => {
	overwriteGetLocale(() => locale);
	renderPage();
	expect(container.textContent).toContain("agent-full@example.test");
	expect(container.textContent).toContain("demo.lsrai.shop");
	expect(container.textContent).toContain("custom.example.test");
	expect(container.textContent).toContain(
		locale === "zh-CN" ? "二级域名" : "Subdomain",
	);
	expect(container.textContent).toContain(
		locale === "zh-CN" ? "独立域名" : "Custom domain",
	);
	expect(container.textContent).toContain(
		locale === "zh-CN" ? "待审核" : "Pending review",
	);
	// The table and payouts are intentionally lazy, not simultaneously mounted.
	expect(container.textContent).toContain("123.00");
	expect(container.textContent).not.toContain("45.00");
	openTab(locale === "zh-CN" ? "待打款" : "Pending payouts");
	expect(container.textContent).toContain("full-payout@example.test");
	expect(container.textContent).toContain("payout-owner@example.test");
	expect(container.textContent).toContain("2026");
	expect(container.textContent).toContain("00:00");

	act(() =>
		root.render(<AgentDetail id={33} month="2026-10" onClose={() => {}} />),
	);
	expect(container.textContent).toContain("full-alipay@example.test");
	expect(container.textContent).toContain(
		locale === "zh-CN" ? "支付宝账户" : "Alipay account",
	);
	expect(container.textContent).not.toContain(
		locale === "zh-CN" ? "脱敏" : "masked",
	);
	expect(container.textContent).toContain("123.00");
	expect(container.textContent).toContain("25.00");
	expect(container.textContent).toContain("45.00");
	expect(container.textContent).toContain(
		locale === "zh-CN" ? "返还期内我们赚了" : "Our profit in the rebate window",
	);
});
it.each([
	"en-US",
	"zh-CN",
] as const)("does not render zero for unavailable monthly profit in %s", (locale) => {
	overwriteGetLocale(() => locale);
	state.unavailable = true;
	renderPage();
	expect(container.textContent).toContain(
		locale === "zh-CN" ? "暂时取不到" : "Temporarily unavailable",
	);
	expect(container.textContent).not.toContain("123.00");
});
