"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import {
	ExternalLink,
	MoreHorizontal,
	Pencil,
	Plus,
	TestTube2,
} from "lucide-react";
import { type MouseEvent, useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ProButton } from "#/components/pro/base/button";
import { ModalForm } from "#/components/pro/form";
import { ProTable, type ProTableState } from "#/components/pro/table";
import { Badge } from "#/components/ui/badge";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { Switch } from "#/components/ui/switch";
import { PageHeader } from "#/layouts/components/page-header";
import { formatDateTime, formatMinorAmount } from "#/lib/format";
import { useCurrentProTableUrlState } from "#/lib/pro-table-url-state";
import { m } from "#/paraglide/messages";
import { supplierProviderLabel } from "../provider-label";
import { supplierProviderSchema } from "../schema";
import {
	listSupplierAccountsFn,
	saveSupplierAccountFn,
	setSupplierAccountEnabledFn,
	testSupplierAccountFn,
} from "../server/admin";

type Result = Awaited<ReturnType<typeof listSupplierAccountsFn>>;
type Account = Result["data"][number];

export function SupplierAccountsPage() {
	const urlState = useCurrentProTableUrlState({ searchColumnId: "name" });
	const client = useQueryClient();
	const [refreshKey, setRefreshKey] = useState(0);
	const [editing, setEditing] = useState<Account | "new" | null>(null);
	const modalTrigger = useRef<HTMLElement | null>(null);
	const openEditor = useCallback(
		(value: Account | "new", event: MouseEvent<HTMLElement>) => {
			modalTrigger.current = event.currentTarget;
			setEditing(value);
		},
		[],
	);
	const openEditorFromActions = useCallback((value: Account) => {
		modalTrigger.current = document.getElementById(
			`supplier-account-actions-${value.id}`,
		);
		setEditing(value);
	}, []);
	const closeEditor = useCallback(() => {
		setEditing(null);
		requestAnimationFrame(() => modalTrigger.current?.focus());
	}, []);
	const refresh = useCallback(async () => {
		await client.invalidateQueries({ queryKey: ["admin", "suppliers"] });
		setRefreshKey((value) => value + 1);
	}, [client]);
	const request = useCallback(
		(state: ProTableState) => {
			const search = String(
				state.columnFilters.find((filter) => filter.id === "name")?.value ?? "",
			);
			const input = {
				pageIndex: state.pagination.pageIndex,
				pageSize: state.pagination.pageSize,
				search,
				enabledSort:
					state.sorting[0]?.id === "enabled"
						? state.sorting[0].desc
							? ("desc" as const)
							: ("asc" as const)
						: undefined,
			};
			return client.fetchQuery({
				queryKey: ["admin", "suppliers", "accounts", input],
				queryFn: () => listSupplierAccountsFn({ data: input }),
			});
		},
		[client],
	);
	const toggle = useMutation({
		mutationFn: setSupplierAccountEnabledFn,
		onSuccess: refresh,
		onError: showError,
	});
	const test = useMutation({
		mutationFn: testSupplierAccountFn,
		onSuccess: async () => {
			toast.success(m.supplier_connection_ok());
			await refresh();
		},
		onError: showError,
	});
	const columns = useMemo<ColumnDef<Account>[]>(
		() => [
			{
				accessorKey: "enabled",
				header: m.common_enabled(),
				cell: ({ row }) => (
					<Switch
						aria-label={`${m.common_enabled()} · ${row.original.name}`}
						checked={row.original.enabled}
						disabled={toggle.isPending}
						onCheckedChange={(enabled) =>
							toggle.mutate({ data: { id: row.original.id, enabled } })
						}
					/>
				),
			},
			{
				accessorKey: "name",
				header: m.common_name(),
				meta: { search: true },
				cell: ({ row }) => (
					<button
						className="text-left font-medium hover:underline"
						onClick={(event) => openEditor(row.original, event)}
						type="button"
					>
						{row.original.name}
					</button>
				),
			},
			{
				accessorKey: "normalizedApiOrigin",
				header: m.supplier_api_origin(),
				cell: ({ row }) => (
					<div>
						<div>{row.original.normalizedApiOrigin}</div>
						<div className="text-muted-foreground text-xs">
							{supplierProviderLabel(row.original.provider)} ·{" "}
							{row.original.protocolVersion}
						</div>
					</div>
				),
			},
			{
				accessorKey: "balanceMinor",
				header: m.supplier_balance(),
				cell: ({ row }) =>
					row.original.balanceMinor == null
						? "—"
						: formatMinorAmount(
								row.original.balanceMinor,
								row.original.currency,
								row.original.currencyDecimals,
							),
			},
			{
				accessorKey: "healthStatus",
				header: m.supplier_health(),
				cell: ({ row }) => (
					<div>
						<Badge
							variant={
								row.original.healthStatus === "healthy" ? "default" : "outline"
							}
						>
							{healthLabel(row.original.healthStatus)}
						</Badge>
						{row.original.balanceSyncedAt ? (
							<div className="mt-1 text-muted-foreground text-xs">
								{formatDateTime(row.original.balanceSyncedAt)}
							</div>
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
									id={`supplier-account-actions-${row.original.id}`}
									size="icon-sm"
									tooltip={m.common_actions()}
									variant="ghost"
								>
									<MoreHorizontal />
								</ProButton>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuItem
									onClick={() => openEditorFromActions(row.original)}
								>
									<Pencil />
									{m.common_edit()}
								</DropdownMenuItem>
								<DropdownMenuItem
									disabled={test.isPending}
									onClick={() => test.mutate({ data: { id: row.original.id } })}
								>
									<TestTube2 />
									{m.supplier_test_connection()}
								</DropdownMenuItem>
								<DropdownMenuItem asChild>
									<a
										href={row.original.baseUrl}
										rel="noreferrer"
										target="_blank"
									>
										<ExternalLink />
										{m.supplier_open_recharge()}
									</a>
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				),
			},
		],
		[openEditor, openEditorFromActions, test, toggle],
	);
	const account = editing === "new" ? null : editing;
	return (
		<>
			<div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
				<PageHeader
					title={m.supplier_accounts_title()}
					description={m.supplier_accounts_description()}
					actions={
						<ProButton onClick={(event) => openEditor("new", event)}>
							<Plus />
							{m.supplier_add_account()}
						</ProButton>
					}
				/>
				<ProTable
					className="min-h-0 flex-1"
					columns={columns}
					initialState={urlState.initialState}
					onChange={urlState.onChange}
					onRefresh={refresh}
					request={request}
					requestKey={refreshKey}
					toolbarSearch={{ columnId: "name", placeholder: m.common_search() }}
					table={{ stickyHeader: true }}
				/>
			</div>
			{editing ? (
				<ModalForm
					key={account?.id ?? "new"}
					open
					onOpenChange={(open) => !open && closeEditor()}
					title={
						account
							? `${m.common_edit()} · ${account.name}`
							: m.supplier_add_account()
					}
					description={
						account
							? m.supplier_account_form_edit_description()
							: m.supplier_account_form_create_description()
					}
					schema={accountFormSchema(Boolean(account))}
					initialValues={accountValues(account)}
					fieldsClassName="grid space-y-0 gap-x-4 gap-y-3 sm:grid-cols-2"
					modalClassName="sm:max-w-2xl"
					onFinish={async (values) => {
						const provider =
							values.provider === "acg"
								? "acg"
								: values.provider === "gmshop_edge"
									? "gmshop_edge"
									: "dujiao_next";
						const credentials =
							provider === "acg"
								? values.apiId || values.appKey
									? { apiId: values.apiId, appKey: values.appKey }
									: undefined
								: values.apiKey || values.apiSecret
									? {
											apiKey: values.apiKey,
											apiSecret: values.apiSecret,
										}
									: undefined;
						await saveSupplierAccountFn({
							data: {
								id: account?.id,
								provider,
								baseUrl: String(values.baseUrl),
								name: String(values.name),
								currency: String(values.currency),
								currencyDecimals: Number(values.currencyDecimals),
								reserveBalanceMinor: String(values.reserveBalanceMinor),
								lowBalanceMinor: String(values.lowBalanceMinor),
								maxOrderCostMinor: values.maxOrderCostMinor
									? String(values.maxOrderCostMinor)
									: null,
								enabled: account?.enabled ?? true,
								credentials,
							},
						});
						toast.success(m.supplier_account_saved());
						closeEditor();
						await refresh();
					}}
					onFinishFailed={showError}
				/>
			) : null}
		</>
	);
}

function accountFormSchema(editing: boolean) {
	const credentialTooltip = (
		<div className="space-y-1">
			<p>{m.supplier_credentials_section_description()}</p>
			<p>
				{editing
					? m.supplier_credentials_keep_existing()
					: m.supplier_credentials_required_description()}
			</p>
		</div>
	);
	const minorUnitDescription = m.supplier_minor_unit_description();
	return [
		{
			name: "provider",
			label: m.supplier_provider(),
			valueType: "select" as const,
			required: true,
			fieldProps: {
				disabled: editing,
				options: supplierProviderSchema.options.map((value) => ({
					value,
					label: supplierProviderLabel(value),
				})),
			},
		},
		{
			name: "name",
			label: m.common_name(),
			required: true,
			fieldProps: {
				autoComplete: "off",
				placeholder: m.supplier_account_name_placeholder(),
			},
		},
		{
			name: "baseUrl",
			label: m.supplier_api_address(),
			required: true,
			tooltip: m.supplier_api_origin_description(),
			formItemProps: { className: "sm:col-span-2" },
			fieldProps: {
				disabled: editing,
				autoCapitalize: "none",
				autoComplete: "url",
				spellCheck: false,
				placeholder: "https://shop.example.com",
			},
		},
		{
			name: "currency",
			label: m.common_currency(),
			required: true,
			fieldProps: {
				autoCapitalize: "characters",
				autoComplete: "off",
				maxLength: 3,
				placeholder: "CNY",
				spellCheck: false,
			},
		},
		{
			name: "currencyDecimals",
			label: m.catalog_currency_decimals(),
			required: true,
			tooltip: m.supplier_currency_decimals_description(),
			fieldProps: {
				inputMode: "numeric",
				maxLength: 1,
				pattern: "[0-9]",
			},
		},
		{
			name: "apiId",
			label: m.supplier_api_id(),
			tooltip: credentialTooltip,
			hidden: (values: Record<string, unknown>) => values.provider !== "acg",
			required: !editing,
			fieldProps: {
				autoCapitalize: "none",
				autoComplete: "off",
				spellCheck: false,
			},
		},
		{
			name: "appKey",
			label: m.supplier_app_key(),
			valueType: "password" as const,
			tooltip: credentialTooltip,
			hidden: (values: Record<string, unknown>) => values.provider !== "acg",
			required: !editing,
			fieldProps: {
				autoComplete: "new-password",
				spellCheck: false,
			},
		},
		{
			name: "apiKey",
			label: m.supplier_api_key(),
			tooltip: credentialTooltip,
			hidden: (values: Record<string, unknown>) =>
				values.provider !== "dujiao_next" && values.provider !== "gmshop_edge",
			required: !editing,
			fieldProps: {
				autoCapitalize: "none",
				autoComplete: "off",
				spellCheck: false,
			},
		},
		{
			name: "apiSecret",
			label: m.supplier_api_secret(),
			valueType: "password" as const,
			tooltip: credentialTooltip,
			hidden: (values: Record<string, unknown>) =>
				values.provider !== "dujiao_next" && values.provider !== "gmshop_edge",
			required: !editing,
			fieldProps: {
				autoComplete: "new-password",
				spellCheck: false,
			},
		},
		{
			name: "reserveBalanceMinor",
			label: m.supplier_reserve_balance(),
			required: true,
			tooltip: minorUnitDescription,
			fieldProps: minorAmountFieldProps("0"),
		},
		{
			name: "lowBalanceMinor",
			label: m.supplier_low_balance(),
			required: true,
			tooltip: minorUnitDescription,
			fieldProps: minorAmountFieldProps("0"),
		},
		{
			name: "maxOrderCostMinor",
			label: m.supplier_max_order_cost(),
			tooltip: m.supplier_max_order_cost_description(),
			fieldProps: minorAmountFieldProps(m.supplier_unlimited_placeholder()),
		},
	];
}

function minorAmountFieldProps(placeholder: string) {
	return {
		autoComplete: "off",
		inputMode: "numeric",
		pattern: "[0-9]*",
		placeholder,
	};
}

function accountValues(account: Account | null) {
	return {
		provider: account?.provider ?? "dujiao_next",
		name: account?.name ?? "",
		baseUrl: account?.baseUrl ?? "",
		currency: account?.currency ?? "CNY",
		currencyDecimals: account?.currencyDecimals ?? 2,
		apiId: "",
		appKey: "",
		apiKey: "",
		apiSecret: "",
		reserveBalanceMinor: account?.reserveBalanceMinor ?? "0",
		lowBalanceMinor: account?.lowBalanceMinor ?? "0",
		maxOrderCostMinor: account?.maxOrderCostMinor ?? "",
	};
}

function healthLabel(status: Account["healthStatus"]) {
	if (status === "healthy") return m.supplier_status_healthy();
	if (status === "degraded") return m.supplier_status_degraded();
	if (status === "unavailable") return m.supplier_status_unavailable();
	return m.supplier_status_unknown();
}

function showError() {
	toast.error(m.common_operation_failed());
}
