import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { useState } from "react";
import { toast } from "sonner";
import { ModalForm } from "#/components/pro/form";
import { ProModal } from "#/components/pro/overlay";
import { ProTable } from "#/components/pro/table";
import { Button } from "#/components/ui/button";
import {
	money,
	ProgramError,
	statusLabel,
	tierGuardLabel,
} from "#/features/agent-program/presentation";
import {
	amountMinor,
	type FeeSource,
	feeSourceSchema,
	type ProgramRules,
} from "#/features/agent-program/schema";
import {
	getAgentFn,
	updateOpeningFeeFn,
} from "#/features/agent-program/server/admin";
import { formatDate, formatNumber } from "#/lib/format";
import { m } from "#/paraglide/messages";
import { getLocale } from "#/paraglide/runtime";

function sourceLabel(source: FeeSource) {
	switch (source) {
		case "offline_alipay":
			return m.agent_program_offline_alipay();
		case "shop_order":
			return m.agent_program_shop_order();
		case "manual":
			return m.agent_program_manual_source();
		default:
			return m.agent_program_none();
	}
}
export function AgentDetail({
	id,
	month,
	currency = "CNY",
	onClose,
}: {
	id: number | null;
	month: string;
	currency?: string;
	onClose: () => void;
}) {
	const client = useQueryClient();
	const [editing, setEditing] = useState<number | null>(null);
	const query = useQuery({
		queryKey: ["agent-program", "detail", id, month],
		enabled: id !== null,
		queryFn: () => getAgentFn({ data: { id: id ?? 0, month } }),
	});
	const mutation = useMutation({
		mutationFn: updateOpeningFeeFn,
		onSuccess: async (_result, variables) => {
			setEditing((current) => (current === variables.data.id ? null : current));
			await client.invalidateQueries({ queryKey: ["agent-program"] });
			toast.success(m.agent_program_success());
		},
		onError: () => toast.error(m.agent_program_error()),
	});
	const agent = query.data?.agent;
	const seriesColumns: ColumnDef<
		NonNullable<typeof query.data>["monthly_series"][number]
	>[] = [
		{ accessorKey: "month", header: m.agent_program_month() },
		{
			accessorKey: "orders",
			header: m.agent_program_orders(),
			cell: ({ row }) => formatNumber(row.original.orders),
		},
		{
			accessorKey: "sales",
			header: m.agent_program_sales(),
			cell: ({ row }) => money(row.original.sales, currency),
		},
		{
			accessorKey: "profit",
			header: m.agent_program_profit(),
			cell: ({ row }) => money(row.original.profit, currency),
		},
		{
			accessorKey: "wholesale",
			header: m.agent_program_wholesale(),
			cell: ({ row }) => money(row.original.wholesale, currency),
		},
	];
	const creditColumns: ColumnDef<
		NonNullable<typeof query.data>["credit_history"][number]
	>[] = [
		{
			accessorKey: "created_at",
			header: m.agent_program_created(),
			cell: ({ row }) =>
				formatDate(row.original.created_at, getLocale(), "Asia/Shanghai"),
		},
		{
			accessorKey: "amount",
			header: m.agent_program_amount(),
			cell: ({ row }) => money(row.original.amount, row.original.currency),
		},
		{ accessorKey: "remark", header: m.agent_program_remark() },
	];
	return (
		<ProModal
			open={id !== null}
			onOpenChange={(open) => {
				if (!open && !mutation.isPending) {
					setEditing(null);
					onClose();
				}
			}}
			title={agent ? `${agent.label} #${agent.id}` : m.agent_program_details()}
			description={agent?.email_masked}
			className="sm:max-w-4xl"
		>
			<div className="space-y-6 overflow-y-auto">
				{query.isError ? (
					<ProgramError retry={() => void query.refetch()} />
				) : !agent ? (
					<output>{m.agent_program_loading()}</output>
				) : (
					<>
						<dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
							{[
								[m.agent_program_status(), statusLabel(agent.status)],
								[m.agent_program_domains(), agent.domains.join(", ") || "—"],
								[
									m.agent_program_opened(),
									formatDate(agent.opened_at, getLocale(), "Asia/Shanghai"),
								],
								[
									m.agent_program_fee(),
									`${money(agent.opening_fee_paid, currency)} · ${sourceLabel(agent.opening_fee_source)}`,
								],
								[
									m.agent_program_last_month(),
									money(agent.last_month.sales, currency),
								],
								[
									m.agent_program_all_time(),
									money(agent.all_time.sales, currency),
								],
								[
									m.agent_program_available(),
									money(agent.withdrawable, currency),
								],
								[m.agent_program_locked(), money(agent.locked, currency)],
								[
									m.agent_program_our_profit(),
									agent.our_profit_in_window === null
										? m.agent_program_profit_unavailable()
										: money(agent.our_profit_in_window, currency),
									agent.unknown_profit_order_count > 0
										? m.agent_program_cost_unknown({
												count: formatNumber(agent.unknown_profit_order_count),
												amount: money(
													agent.unknown_profit_assumed_loss,
													currency,
												),
											}) +
											(agent.unknown_profit_orders.length
												? ` #${agent.unknown_profit_orders.map((order) => order.order_id).join(", #")}`
												: "")
										: "",
								],
								[
									m.agent_program_pending(),
									money(agent.pending_withdrawal, currency),
								],
								[
									m.agent_program_last_order(),
									agent.last_order_at
										? formatDate(
												agent.last_order_at,
												getLocale(),
												"Asia/Shanghai",
											)
										: "—",
								],
							].map(([label, value, note]) => (
								<div key={label} className="min-w-0 rounded-lg bg-muted/50 p-3">
									<dt className="text-muted-foreground">{label}</dt>
									<dd className="break-words font-medium">{value}</dd>
									{note && (
										<dd className="text-xs text-amber-700 dark:text-amber-400">
											{note}
										</dd>
									)}
								</div>
							))}
						</dl>
						<Button
							variant="outline"
							disabled={mutation.isPending}
							onClick={() => setEditing(agent.id)}
						>
							{m.agent_program_edit_fee()}
						</Button>
						<section className="space-y-3 rounded-xl border p-4">
							<h3 className="font-semibold">
								{m.agent_program_rebate_progress()}
							</h3>
							{agent.rebate.manual_confirmation ? (
								<p>{m.agent_program_manual()}</p>
							) : !agent.rebate.eligible ? (
								<p>{m.agent_program_no_rebate()}</p>
							) : (
								<>
									<p className="text-sm">
										{m.agent_program_window()}:{" "}
										{formatDate(
											agent.rebate.window_start,
											getLocale(),
											"Asia/Shanghai",
										)}{" "}
										–{" "}
										{formatDate(
											agent.rebate.window_end,
											getLocale(),
											"Asia/Shanghai",
										)}
									</p>
									<p>
										{m.agent_program_wholesale()}:{" "}
										{money(agent.rebate.wholesale, currency)} ·{" "}
										{m.agent_program_rebates()}:{" "}
										{money(agent.rebate.credited_total, currency)} /{" "}
										{money(agent.rebate.max_total, currency)}
									</p>
									{amountMinor(agent.rebate.next_amount) > 0n && (
										<p>
											{m.agent_program_remaining({
												days: formatNumber(agent.rebate.days_left),
												gap: money(agent.rebate.next_gap, currency),
												amount: money(agent.rebate.next_amount, currency),
											})}
										</p>
									)}
									<ul className="space-y-2 text-sm">
										{agent.rebate.tiers.map((tier) => (
											<li
												key={tier.threshold}
												className="flex flex-wrap justify-between gap-2"
											>
												<span>
													{m.agent_program_tier({
														threshold: money(tier.threshold, currency),
														amount: money(tier.amount, currency),
													})}
												</span>
												<strong>{tierGuardLabel(tier, currency)}</strong>
											</li>
										))}
									</ul>
								</>
							)}
						</section>
						<section>
							<h3 className="mb-3 font-semibold">{m.agent_program_series()}</h3>
							<ProTable
								columns={seriesColumns}
								data={query.data?.monthly_series ?? []}
								layout="auto"
								toolbarSearch={false}
								pagination={false}
							/>
						</section>
						<section>
							<h3 className="mb-3 font-semibold">
								{m.agent_program_history()}
							</h3>
							<ProTable
								columns={creditColumns}
								data={query.data?.credit_history ?? []}
								layout="auto"
								toolbarSearch={false}
							/>
						</section>
						<ModalForm
							open={editing === agent.id}
							onOpenChange={(open) => {
								if (!mutation.isPending)
									setEditing((current) =>
										open ? agent.id : current === agent.id ? null : current,
									);
							}}
							title={m.agent_program_edit_fee()}
							initialValues={{
								amount: agent.opening_fee_paid,
								source: agent.opening_fee_source,
								reason: "",
							}}
							schema={[
								{
									name: "amount",
									label: m.agent_program_fee(),
									required: true,
								},
								{
									name: "source",
									label: m.agent_program_source(),
									valueType: "select",
									required: true,
									fieldProps: {
										options: feeSourceSchema.options.map((source) => ({
											value: source,
											label: sourceLabel(source),
										})),
									},
								},
								{
									name: "reason",
									label: m.agent_program_reason(),
									required: true,
								},
							]}
							onFinish={async (values) => {
								if (mutation.isPending) return;
								await mutation.mutateAsync({
									data: {
										id: agent.id,
										amount: String(values.amount ?? ""),
										source: feeSourceSchema.parse(values.source),
										reason: String(values.reason ?? ""),
									},
								});
							}}
						/>
					</>
				)}
			</div>
		</ProModal>
	);
}

export function ProgramRulesView({ rules }: { rules: ProgramRules }) {
	const weekday = new Intl.DateTimeFormat(getLocale(), {
		weekday: "long",
		timeZone: "UTC",
	}).format(
		new Date(Date.UTC(2026, 9, 18 + rules.withdraw_settlement_weekday)),
	);
	return (
		<div className="space-y-5 rounded-xl border bg-card p-5 text-sm">
			<section className="space-y-2">
				<h3 className="font-semibold">{m.agent_program_rebate_progress()}</h3>
				<p>{m.agent_program_rules_eligibility()}</p>
				<p>{m.agent_program_rules_guard()}</p>
				<p>{m.agent_program_rules_email()}</p>
				{!rules.rebate_enabled ? (
					<p>{m.agent_program_rules_disabled()}</p>
				) : (
					Object.entries(rules.schedules).map(([fee, tiers]) => (
						<div key={fee}>
							<p>
								{m.agent_program_rules_rebate({
									fee: money(fee, rules.currency),
									days: formatNumber(rules.rebate_window_days),
								})}
							</p>
							<ul className="mt-1 list-inside list-disc text-muted-foreground">
								{tiers.map((tier) => (
									<li key={tier.threshold}>
										{m.agent_program_tier({
											threshold: money(tier.threshold, rules.currency),
											amount: money(tier.amount, rules.currency),
										})}
									</li>
								))}
							</ul>
						</div>
					))
				)}
				<p className="text-muted-foreground">
					{m.agent_program_rules_count({
						start: formatDate(rules.start_date, getLocale(), "Asia/Shanghai"),
					})}
				</p>
			</section>
			<section className="space-y-2">
				<h3 className="font-semibold">{m.agent_program_leaderboard()}</h3>
				<p>
					{rules.leaderboard_enabled
						? m.agent_program_rules_leaderboard({
								rewards: rules.leaderboard_rewards
									.map((value) => money(value, rules.currency))
									.join(" / "),
							})
						: m.agent_program_rules_disabled()}
				</p>
			</section>
			<section className="space-y-2">
				<h3 className="font-semibold">{m.agent_program_withdrawals()}</h3>
				<p>
					{m.agent_program_rules_withdraw({
						day: weekday,
						minimum: money(rules.withdraw_min_amount, rules.currency),
					})}
				</p>
			</section>
			<p>
				{m.agent_program_rules_markup({
					min: rules.min_markup_percent,
					default: rules.default_markup_percent,
				})}
			</p>
		</div>
	);
}
