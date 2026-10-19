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
	money,
	ProgramError,
	statusLabel,
} from "#/features/agent-program/presentation";
import { type Agent, amountMinor } from "#/features/agent-program/schema";
import {
	getLeaderboardFn,
	getWithdrawalsFn,
	listAgentsFn,
	markWithdrawalPaidFn,
	reviewLeaderboardFn,
} from "#/features/agent-program/server/admin";
import { AgentDetail, ProgramRulesView } from "#/features/agent-program/views";
import { PageHeader } from "#/layouts/components/page-header";
import { formatNumber } from "#/lib/format";
import { m } from "#/paraglide/messages";

function beijingMonth() {
	return new Intl.DateTimeFormat("sv-SE", {
		year: "numeric",
		month: "2-digit",
		timeZone: "Asia/Shanghai",
	}).format(new Date());
}

export function AgentProgramPage() {
	const [month, setMonth] = useState(beijingMonth);
	const [selected, setSelected] = useState<number | null>(null);
	const agents = useQuery({
		queryKey: ["agent-program", "agents", month],
		queryFn: () => listAgentsFn({ data: { month } }),
	});
	const withdrawals = useQuery({
		queryKey: ["agent-program", "withdrawals"],
		queryFn: () => getWithdrawalsFn(),
	});
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
						<div className="text-muted-foreground text-xs">
							#{row.original.id} · {row.original.email_masked}
						</div>
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
				id: "profit",
				accessorFn: (agent) => amountMinor(agent.month.profit),
				header: m.agent_program_profit(),
				cell: ({ row }) => money(row.original.month.profit, currency),
			},

			{
				accessorKey: "our_profit_in_window",
				header: m.agent_program_our_profit(),
				cell: ({ row }) => (
					<div>
						{row.original.our_profit_in_window === null
							? m.agent_program_profit_unavailable()
							: money(row.original.our_profit_in_window, currency)}
						{row.original.unknown_profit_order_count > 0 && (
							<p className="text-xs text-muted-foreground">
								{m.agent_program_cost_unknown({
									count: formatNumber(row.original.unknown_profit_order_count),
									amount: money(
										row.original.unknown_profit_assumed_loss,
										currency,
									),
								})}
							</p>
						)}
					</div>
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
			{agents.isError ? (
				<ProgramError retry={() => void agents.refetch()} />
			) : agents.isPending ? (
				<output>{m.agent_program_loading()}</output>
			) : (
				<>
					<div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
						{[
							[
								m.agent_program_active(),
								formatNumber(rows.filter((a) => a.status === "active").length),
							],
							[m.agent_program_sales(), money(totals.sales, currency)],
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
					<Tabs defaultValue="agents">
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
							<Leaderboard month={month} />
						</TabsContent>
						<TabsContent value="withdrawals">
							<Withdrawals />
						</TabsContent>
						<TabsContent value="rules">
							<ProgramRulesView rules={agents.data.rules} />
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
	const query = useQuery({
		queryKey: ["agent-program", "leaderboard", month],
		queryFn: () => getLeaderboardFn({ data: { month } }),
	});
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
	if (query.isError) return <ProgramError retry={() => void query.refetch()} />;
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
	const query = useQuery({
		queryKey: ["agent-program", "withdrawals"],
		queryFn: () => getWithdrawalsFn(),
	});
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
	if (query.isError) return <ProgramError retry={() => void query.refetch()} />;
	if (!query.data) return <output>{m.agent_program_loading()}</output>;
	const columns: ColumnDef<(typeof query.data)[number]>[] = [
		{
			accessorKey: "label",
			header: m.agent_program_agents(),
			cell: ({ row }) => `${row.original.label} #${row.original.reseller_id}`,
		},
		{
			accessorKey: "amount",
			header: m.agent_program_amount(),
			cell: ({ row }) => money(row.original.amount, row.original.currency),
		},
		{ accessorKey: "account_masked", header: m.agent_program_account() },
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
