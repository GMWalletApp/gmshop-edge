"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { Eye, MoreHorizontal, RefreshCw, Repeat2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { ProButton } from "#/components/pro/base/button";
import { ProTable, type ProTableState } from "#/components/pro/table";
import { Badge } from "#/components/ui/badge";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { PageHeader } from "#/layouts/components/page-header";
import { formatDateTime, formatMinorAmount, formatNumber } from "#/lib/format";
import { useCurrentProTableUrlState } from "#/lib/pro-table-url-state";
import { m } from "#/paraglide/messages";
import { supplierErrorLabel } from "../error-label";
import { supplierProviderLabel } from "../provider-label";
import {
	actSupplierOrderFn,
	listSupplierOrdersFn,
} from "../server/orders-admin";

type Result = Awaited<ReturnType<typeof listSupplierOrdersFn>>;
type Order = Result["data"][number];

export function SupplierOrdersPage() {
	const urlState = useCurrentProTableUrlState({
		searchColumnId: "order_number",
	});
	const client = useQueryClient();
	const [refreshKey, setRefreshKey] = useState(0);
	const action = useMutation({
		mutationFn: actSupplierOrderFn,
		onSuccess: () => {
			toast.success(m.supplier_action_queued());
			setRefreshKey((value) => value + 1);
		},
		onError: () => toast.error(m.common_operation_failed()),
	});
	const request = useCallback(
		(state: ProTableState) => {
			const search = String(
				state.columnFilters.find((filter) => filter.id === "order_number")
					?.value ?? "",
			);
			const input = {
				pageIndex: state.pagination.pageIndex,
				pageSize: state.pagination.pageSize,
				search,
			};
			return client.fetchQuery({
				queryKey: ["admin", "suppliers", "orders", input],
				queryFn: () => listSupplierOrdersFn({ data: input }),
			});
		},
		[client],
	);
	const columns = useMemo<ColumnDef<Order>[]>(
		() => [
			{
				accessorKey: "order_number",
				header: m.supplier_order_details(),
				meta: { search: true },
				cell: ({ row }) => (
					<div className="flex min-w-64 flex-col gap-1">
						<Link
							className="font-semibold hover:underline"
							params={{ orderId: String(row.original.order_id) }}
							to="/admin/orders/$orderId"
						>
							{String(row.original.order_number)}
						</Link>
						<div className="text-muted-foreground text-xs">
							{String(row.original.product_name)} ·{" "}
							{String(row.original.sellable_item_name)}
						</div>
						<div className="text-muted-foreground text-xs">
							{formatDateTime(Number(row.original.created_at))}
						</div>
					</div>
				),
			},
			{
				accessorKey: "upstream_order_id",
				header: m.supplier_upstream_details(),
				cell: ({ row }) => (
					<div className="flex min-w-72 flex-col gap-1">
						<div className="flex items-center justify-between gap-2">
							<span className="font-medium">
								{String(row.original.account_name ?? "—")}
							</span>
							<Badge variant="outline">
								{supplierProviderLabel(String(row.original.provider))}
							</Badge>
						</div>
						<div className="text-sm">
							{String(row.original.upstream_product_name)} ·{" "}
							{String(row.original.upstream_sku_name)}
						</div>
						<div className="truncate font-mono text-muted-foreground text-xs">
							{String(
								row.original.upstream_order_id ??
									row.original.provider_request_no ??
									"—",
							)}
						</div>
						<div
							className="truncate text-muted-foreground text-xs"
							title={String(row.original.normalized_api_origin)}
						>
							{String(row.original.normalized_api_origin)}
						</div>
					</div>
				),
			},
			{
				accessorKey: "total_cost_minor",
				header: m.supplier_purchase_details(),
				cell: ({ row }) => (
					<div className="flex min-w-48 flex-col gap-1">
						<OrderMetric
							label={m.supplier_quantity()}
							value={formatNumber(Number(row.original.quantity))}
						/>
						<OrderMetric
							label={m.supplier_unit_cost()}
							value={formatSupplierOrderAmount(
								row.original.quoted_unit_cost_minor,
								row.original,
							)}
						/>
						<OrderMetric
							border
							label={m.supplier_total_cost()}
							value={formatSupplierOrderAmount(
								row.original.total_cost_minor,
								row.original,
							)}
						/>
					</div>
				),
			},
			{
				accessorKey: "state",
				header: m.supplier_order_state(),
				cell: ({ row }) => (
					<div className="flex min-w-40 flex-col items-start gap-1.5">
						<SupplierOrderStateBadge state={String(row.original.state)} />
						<div className="text-muted-foreground text-xs">
							{m.supplier_attempt_count()}{" "}
							{formatNumber(Number(row.original.attempt_count))}
							<span className="px-1" aria-hidden="true">
								·
							</span>
							{m.supplier_selection_count()}{" "}
							{formatNumber(Number(row.original.selection_count))}
						</div>
						{row.original.last_error_code ? (
							<span
								className="max-w-52 truncate text-destructive text-xs"
								title={supplierErrorLabel(String(row.original.last_error_code))}
							>
								{supplierErrorLabel(String(row.original.last_error_code))}
							</span>
						) : null}
					</div>
				),
			},
			{
				id: "actions",
				header: m.common_actions(),
				cell: ({ row }) => (
					<div className="flex justify-end">
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<ProButton
									size="icon-sm"
									tooltip={m.common_actions()}
									variant="ghost"
								>
									<MoreHorizontal />
								</ProButton>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuItem asChild>
									<Link
										params={{ orderId: String(row.original.order_id) }}
										to="/admin/orders/$orderId"
									>
										<Eye />
										{m.shop_orders_view()}
									</Link>
								</DropdownMenuItem>
								<DropdownMenuItem
									disabled={
										action.isPending ||
										!row.original.account_id ||
										row.original.state === "supplied" ||
										row.original.state === "refunded"
									}
									onClick={() =>
										action.mutate({
											data: {
												id: row.original.id,
												action: "reconcile",
											},
										})
									}
								>
									<RefreshCw />
									{m.supplier_reconcile()}
								</DropdownMenuItem>
								<DropdownMenuItem
									disabled={
										action.isPending ||
										row.original.state === "uncertain" ||
										row.original.state === "supplied" ||
										row.original.state === "refunded"
									}
									onClick={() =>
										action.mutate({
											data: {
												id: row.original.id,
												action: "reselect",
											},
										})
									}
								>
									<Repeat2 />
									{m.supplier_reselect()}
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				),
			},
		],
		[action],
	);
	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
			<PageHeader
				title={m.supplier_orders_title()}
				description={m.supplier_orders_description()}
			/>
			<ProTable
				className="min-h-0 flex-1"
				columns={columns}
				initialState={urlState.initialState}
				onChange={urlState.onChange}
				onRefresh={() => setRefreshKey((value) => value + 1)}
				request={request}
				requestKey={refreshKey}
				table={{ stickyHeader: true }}
				toolbarSearch={{
					columnId: "order_number",
					placeholder: m.common_search(),
				}}
			/>
		</div>
	);
}

function OrderMetric({
	label,
	value,
	border = false,
}: {
	label: string;
	value: string;
	border?: boolean;
}) {
	return (
		<div
			className={`flex items-baseline justify-between gap-3 ${border ? "border-t pt-1" : ""}`}
		>
			<span className="text-muted-foreground text-xs">{label}</span>
			<span className="tabular-nums">{value}</span>
		</div>
	);
}

function formatSupplierOrderAmount(
	value: string | null,
	order: Pick<Order, "currency" | "currency_decimals">,
) {
	return value == null
		? "—"
		: formatMinorAmount(value, order.currency, order.currency_decimals);
}

function SupplierOrderStateBadge({ state }: { state: string }) {
	const variant =
		state === "supplied"
			? "default"
			: state === "failed"
				? "destructive"
				: state === "selecting" ||
						state === "submitting" ||
						state === "uncertain"
					? "secondary"
					: "outline";
	return <Badge variant={variant}>{supplierOrderStateLabel(state)}</Badge>;
}

function supplierOrderStateLabel(state: string) {
	if (state === "pending") return m.supplier_order_state_pending();
	if (state === "selecting") return m.supplier_order_state_selecting();
	if (state === "submitting") return m.supplier_order_state_submitting();
	if (state === "uncertain") return m.supplier_order_state_uncertain();
	if (state === "supplied") return m.supplier_order_state_supplied();
	if (state === "failed") return m.supplier_order_state_failed();
	if (state === "refunded") return m.supplier_order_state_refunded();
	return state;
}
