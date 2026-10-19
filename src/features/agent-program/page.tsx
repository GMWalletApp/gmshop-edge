import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ModalForm } from "#/components/pro/form";
import { ProTable } from "#/components/pro/table";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#/components/ui/tabs";
import {
	AgentDomains,
	money,
	PanelDataAge,
	PeriodProfit,
	ProgramError,
	statusLabel,
} from "#/features/agent-program/presentation";
import {
	agentsQuery,
	beijingMonth,
	leaderboardQuery,
	rulesQuery,
	withdrawalsQuery,
} from "#/features/agent-program/queries";
import { type Agent, amountMinor } from "#/features/agent-program/schema";
import {
	markWithdrawalPaidFn,
	reviewLeaderboardFn,
} from "#/features/agent-program/server/admin";
import { AgentDetail, ProgramRulesView } from "#/features/agent-program/views";
import { PageHeader } from "#/layouts/components/page-header";
import { formatDateTime, formatNumber } from "#/lib/format";
import { m } from "#/paraglide/messages";
import { getLocale } from "#/paraglide/runtime";

export function AgentProgramPage() {
	const [month, setMonth] = useState(beijingMonth);
	const [selected, setSelected] = useState<number | null>(null);
	const client = useQueryClient();
	const [tab, setTab] = useState("agents");
	// Start independent reads on the same render; tab CONTENT remains lazy.
	const agents = useQuery(agentsQuery(month));
	const leaderboard = useQuery(leaderboardQuery(month));
	const withdrawals = useQuery(withdrawalsQuery());
	const rules = useQuery(rulesQuery());
	const updating =
		agents.isFetching ||
		leaderboard.isFetching ||
		withdrawals.isFetching ||
		rules.isFetching;
	const refresh = async () => {
		await Promise.all([
			client.fetchQuery({ ...agentsQuery(month, true), staleTime: 0 }),
			client.fetchQuery({ ...leaderboardQuery(month, true), staleTime: 0 }),
			client.fetchQuery({ ...withdrawalsQuery(), staleTime: 0 }),
			client.fetchQuery({ ...rulesQuery(true), staleTime: 0 }),
		]).catch(() => toast.error(m.agent_program_error()));
	};
	const currency = agents.data?.rules.currency ?? "CNY";
	const columns = useMemo<ColumnDef<Agent>[]>(
		() => [
			{
				accessorKey: "label",
				header: m.agent_program_agent(),
				cell: ({ row }) => (
					<div className="min-w-32">
						<Button
							variant="link"
							className="h-auto p-0"
							onClick={() => setSelected(row.original.id)}
						>
							{row.original.label || `#${row.original.id}`}
						</Button>
						<div className="break-all text-muted-foreground text-xs">
							#{row.original.id} · {row.original.email}
						</div>
						<AgentDomains domains={row.original.domains} />
					</div>
				),
			},
			{
				accessorKey: "status",
				header: m.agent_program_status(),
				cell: ({ row }) => statusLabel(row.original.status),
			},
			{
				id: "sales",
				accessorFn: (agent) => amountMinor(agent.month.sales),
				header: m.agent_program_sales(),
				cell: ({ row }) => money(row.original.month.sales, currency),
			},
			{
				id: "orders",
				accessorFn: (agent) => agent.month.orders,
				header: m.agent_program_orders(),
				cell: ({ row }) => formatNumber(row.original.month.orders),
			},
			{
				id: "own_month",
				accessorFn: (agent) => amountMinor(agent.own_month.amount),
				header: m.agent_program_own_purchases(),
				cell: ({ row }) => (
					<div>
						{money(row.original.own_month.amount, currency)}
						<p className="text-muted-foreground text-xs">
							{m.agent_program_own_orders({
								count: formatNumber(row.original.own_month.orders),
							})}
						</p>
					</div>
				),
			},
			{
				id: "profit",
				accessorFn: (agent) => amountMinor(agent.month.profit),
				header: m.agent_program_profit(),
				cell: ({ row }) => money(row.original.month.profit, currency),
			},

			{
				id: "our_profit_month",
				accessorFn: (agent) =>
					agent.our_profit_month.profit === null
						? undefined
						: amountMinor(agent.our_profit_month.profit),
				header: m.agent_program_our_profit(),
				cell: ({ row }) => (
					<PeriodProfit
						value={row.original.our_profit_month}
						currency={currency}
					/>
				),
			},
			{
				accessorKey: "opening_fee_paid",
				header: m.agent_program_fee(),
				cell: ({ row }) => money(row.original.opening_fee_paid, currency),
			},
			{
				id: "rebates",
				header: m.agent_program_rebates(),
				cell: ({ row }) => money(row.original.rebate.credited_total, currency),
			},
			{
				accessorKey: "withdrawable",
				header: m.agent_program_available(),
				cell: ({ row }) => money(row.original.withdrawable, currency),
			},
		],
		[currency],
	);
	const rows = agents.data?.agents ?? [];
	const totals = {
		sales: rows.reduce((n, a) => n + amountMinor(a.month.sales), 0n),
		own: rows.reduce((n, a) => n + amountMinor(a.own_month.amount), 0n),
		ourProfit: rows.some((a) => a.our_profit_month.profit === null)
			? undefined
			: rows.reduce(
					(n, a) => n + amountMinor(a.our_profit_month.profit ?? "0"),
					0n,
				),
		rebates: rows.reduce(
			(n, a) => n + amountMinor(a.rebate.credited_total),
			0n,
		),
		pending:
			withdrawals.data
				?.filter((w) => w.currency === currency)
				.reduce((n, w) => n + amountMinor(w.amount), 0n) ?? 0n,
	};
	return (
		<div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto pb-6">
			<PageHeader
				title={m.agent_program_title()}
				description={m.agent_program_description()}
				actions={
					<label
						htmlFor="agent-program-month"
						className="flex items-center gap-2 text-sm"
					>
						{m.agent_program_month()}
						<Input
							id="agent-program-month"
							type="month"
							value={month}
							onChange={(event) => {
								if (/^\d{4}-(0[1-9]|1[0-2])$/.test(event.target.value))
									setMonth(event.target.value);
							}}
						/>
					</label>
				}
			/>
			<div
				className="flex flex-wrap items-center gap-3 text-muted-foreground text-sm"
				aria-live="polite"
			>
				{agents.data && (
					<PanelDataAge
						updatedAt={agents.data.data_updated_at}
						month={agents.data.month}
					/>
				)}
				{updating && (
					<span className="whitespace-nowrap">
						{m.agent_program_updating()}
					</span>
				)}
				<Button
					variant="outline"
					size="sm"
					disabled={updating}
					onClick={() => void refresh()}
				>
					{m.agent_program_refresh()}
				</Button>
			</div>
			{agents.isError && <ProgramError retry={() => void agents.refetch()} />}
			{!agents.data && agents.isError ? null : agents.isPending ? (
				<output>{m.agent_program_loading()}</output>
			) : (
				<>
					<div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
						{[
							[
								m.agent_program_active(),
								formatNumber(rows.filter((a) => a.status === "active").length),
							],
							[m.agent_program_sales(), money(totals.sales, currency)],
							[m.agent_program_own_purchases(), money(totals.own, currency)],
							[
								m.agent_program_our_profit_month(),
								totals.ourProfit === undefined
									? m.agent_program_profit_fetch_unavailable()
									: money(totals.ourProfit, currency),
							],
							[m.agent_program_rebates(), money(totals.rebates, currency)],
							[
								m.agent_program_pending(),
								withdrawals.isSuccess ? money(totals.pending, currency) : "—",
							],
						].map(([label, value]) => (
							<div key={label} className="rounded-xl border bg-card p-4">
								<p className="text-muted-foreground text-sm">{label}</p>
								<p className="break-words font-semibold text-xl">{value}</p>
							</div>
						))}
					</div>
					<Tabs value={tab} onValueChange={setTab}>
						<TabsList className="max-w-full overflow-x-auto">
							<TabsTrigger value="agents">
								{m.agent_program_agents()}
							</TabsTrigger>
							<TabsTrigger value="leaderboard">
								{m.agent_program_leaderboard()}
							</TabsTrigger>
							<TabsTrigger value="withdrawals">
								{m.agent_program_withdrawals()}
							</TabsTrigger>
							<TabsTrigger value="rules">{m.agent_program_rules()}</TabsTrigger>
						</TabsList>
						<TabsContent value="agents">
							<ProTable
								columns={columns}
								data={rows}
								layout="auto"
								table={{ rowKey: "id" }}
								initialState={{ sorting: [{ id: "sales", desc: true }] }}
								toolbarSearch={{ columnId: "label" }}
							/>
						</TabsContent>
						<TabsContent value="leaderboard">
							{tab === "leaderboard" && <Leaderboard month={month} />}
						</TabsContent>
						<TabsContent value="withdrawals">
							{tab === "withdrawals" && <Withdrawals />}
						</TabsContent>
						<TabsContent value="rules">
							{tab === "rules" && (
								<ProgramRulesView rules={rules.data ?? agents.data.rules} />
							)}
						</TabsContent>
					</Tabs>
				</>
			)}
			<AgentDetail
				id={selected}
				month={month}
				currency={currency}
				onClose={() => setSelected(null)}
			/>
		</div>
	);
}

function Leaderboard({ month }: { month: string }) {
	const client = useQueryClient();
	const query = useQuery(leaderboardQuery(month));
	const [review, setReview] = useState<{
		id: number;
		action: "approve" | "reject";
	} | null>(null);
	const mutation = useMutation({
		mutationFn: reviewLeaderboardFn,
		onSuccess: async (_result, variables) => {
			setReview((current) =>
				current?.id === variables.data.id &&
				current.action === variables.data.action
					? null
					: current,
			);
			await client.invalidateQueries({ queryKey: ["agent-program"] });
			toast.success(m.agent_program_success());
		},
		onError: () => toast.error(m.agent_program_error()),
	});
	if (query.isError && !query.data)
		return <ProgramError retry={() => void query.refetch()} />;
	if (!query.data) return <output>{m.agent_program_loading()}</output>;
	const currency = query.data.rules.currency;
	const rankingColumns: ColumnDef<(typeof query.data.ranking)[number]>[] = [
		{ accessorKey: "rank", header: m.agent_program_rank() },
		{ accessorKey: "label", header: m.agent_program_agents() },
		{
			accessorKey: "wholesale",
			header: m.agent_program_wholesale(),
			cell: ({ row }) => money(row.original.wholesale, currency),
		},
	];
	const draftColumns: ColumnDef<(typeof query.data.drafts)[number]>[] = [
		{ accessorKey: "rank", header: m.agent_program_rank() },
		{ accessorKey: "reseller_id", header: m.agent_program_agents() },
		{
			accessorKey: "reward_amount",
			header: m.agent_program_reward(),
			cell: ({ row }) => money(row.original.reward_amount, currency),
		},
		{
			accessorKey: "status",
			header: m.agent_program_status(),
			cell: ({ row }) => statusLabel(row.original.status),
		},
		{
			id: "review",
			header: m.agent_program_drafts(),
			cell: ({ row }) =>
				row.original.status === "pending_approval" ? (
					<div className="flex gap-2">
						<Button
							size="sm"
							disabled={mutation.isPending}
							onClick={() =>
								setReview({ id: row.original.id, action: "approve" })
							}
						>
							{m.agent_program_approve()}
						</Button>
						<Button
							size="sm"
							variant="outline"
							disabled={mutation.isPending}
							onClick={() =>
								setReview({ id: row.original.id, action: "reject" })
							}
						>
							{m.agent_program_reject()}
						</Button>
					</div>
				) : (
					row.original.reject_reason
				),
		},
	];
	return (
		<div className="space-y-5">
			<PanelDataAge
				updatedAt={query.data.data_updated_at}
				month={query.data.month}
			/>
			{query.isError && <ProgramError retry={() => void query.refetch()} />}
			<ProTable
				columns={rankingColumns}
				data={query.data.ranking}
				layout="auto"
				toolbarSearch={false}
			/>
			<h3 className="font-semibold">{m.agent_program_drafts()}</h3>
			<ProTable
				columns={draftColumns}
				data={query.data.drafts}
				layout="auto"
				toolbarSearch={false}
			/>
			<ModalForm
				open={Boolean(review)}
				onOpenChange={(open) => {
					if (!open && !mutation.isPending)
						setReview((current) =>
							current?.id === review?.id && current?.action === review?.action
								? null
								: current,
						);
				}}
				title={
					review?.action === "approve"
						? m.agent_program_approve()
						: m.agent_program_reject()
				}
				description={m.agent_program_review_warning()}
				schema={
					review?.action === "reject"
						? [
								{
									name: "reason",
									label: m.agent_program_reason(),
									required: true,
								},
							]
						: []
				}
				onFinish={async (values) => {
					if (review && !mutation.isPending)
						await mutation.mutateAsync({
							data: {
								...review,
								...(review.action === "reject"
									? { reason: String(values.reason ?? "") }
									: {}),
							},
						});
				}}
			/>
		</div>
	);
}

function Withdrawals() {
	const client = useQueryClient();
	const query = useQuery(withdrawalsQuery());
	const [paying, setPaying] = useState<number | null>(null);
	const mutation = useMutation({
		mutationFn: markWithdrawalPaidFn,
		onSuccess: async (_result, variables) => {
			setPaying((current) => (current === variables.data.id ? null : current));
			await client.invalidateQueries({ queryKey: ["agent-program"] });
			toast.success(m.agent_program_success());
		},
		onError: () => toast.error(m.agent_program_error()),
	});
	if (query.isError && !query.data)
		return <ProgramError retry={() => void query.refetch()} />;
	if (!query.data) return <output>{m.agent_program_loading()}</output>;
	const columns: ColumnDef<(typeof query.data)[number]>[] = [
		{
			accessorKey: "label",
			header: m.agent_program_agents(),
			cell: ({ row }) => (
				<div>
					{row.original.label} #{row.original.reseller_id}
					<p className="break-all text-xs text-muted-foreground">
						{row.original.email}
					</p>
				</div>
			),
		},
		{
			accessorKey: "amount",
			header: m.agent_program_amount(),
			cell: ({ row }) => money(row.original.amount, row.original.currency),
		},
		{
			accessorKey: "account",
			header: m.agent_program_account(),
			cell: ({ row }) => (
				<span className="break-all">{row.original.account}</span>
			),
		},
		{
			accessorKey: "created_at",
			header: m.agent_program_requested(),
			cell: ({ row }) =>
				formatDateTime(row.original.created_at, getLocale(), "Asia/Shanghai"),
		},
		{
			id: "payout",
			header: m.agent_program_mark_paid(),
			cell: ({ row }) => (
				<Button
					size="sm"
					variant="outline"
					disabled={mutation.isPending}
					onClick={() => setPaying(row.original.id)}
				>
					{m.agent_program_mark_paid()}
				</Button>
			),
		},
	];
	return (
		<>
			<PanelDataAge updatedAt={query.dataUpdatedAt} />
			{query.isError && <ProgramError retry={() => void query.refetch()} />}
			<ProTable
				columns={columns}
				data={query.data}
				layout="auto"
				toolbarSearch={false}
			/>
			<ModalForm
				open={paying !== null}
				onOpenChange={(open) => {
					if (!open && !mutation.isPending)
						setPaying((current) => (current === paying ? null : current));
				}}
				title={m.agent_program_mark_paid()}
				description={m.agent_program_payout_warning()}
				schema={[
					{
						name: "alipay_trade_no",
						label: m.agent_program_trade_no(),
						required: true,
					},
				]}
				onFinish={async (values) => {
					if (paying !== null && !mutation.isPending)
						await mutation.mutateAsync({
							data: {
								id: paying,
								alipay_trade_no: String(values.alipay_trade_no ?? ""),
							},
						});
				}}
			/>
		</>
	);
}
