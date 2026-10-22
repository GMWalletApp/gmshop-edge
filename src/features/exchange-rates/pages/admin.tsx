"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import {
	MoreHorizontal,
	Pencil,
	RefreshCw,
	Settings2,
	Trash2,
} from "lucide-react";
import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ProButton } from "#/components/pro/base/button";
import { formBooleanValue, ModalForm } from "#/components/pro/form";
import { ProTable, type ProTableState } from "#/components/pro/table";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { Switch } from "#/components/ui/switch";
import { exchangeRateErrorMessage } from "#/features/exchange-rates/error-message";
import {
	deleteExchangeRateFn,
	getExchangeRateSyncSettingsFn,
	listExchangeRatesFn,
	saveExchangeRateFn,
	saveExchangeRateSyncSettingsFn,
	setExchangeRateEnabledFn,
	syncExchangeRatesNowFn,
} from "#/features/exchange-rates/server/admin";
import { ConfirmDialog } from "#/layouts/components/confirm-dialog";
import { PageHeader } from "#/layouts/components/page-header";
import { formatBasisPoints, formatDateTime } from "#/lib/format";
import { useCurrentProTableUrlState } from "#/lib/pro-table-url-state";
import { m } from "#/paraglide/messages";

type PageResult = Awaited<ReturnType<typeof listExchangeRatesFn>>;
type ExchangeRate = PageResult["data"][number];
type SyncSettings = Awaited<ReturnType<typeof getExchangeRateSyncSettingsFn>>;

export function ExchangeRatesTable({
	baseCurrency,
	settingsAction,
}: {
	baseCurrency: string;
	settingsAction?: ReactNode;
}) {
	const client = useQueryClient();
	const urlState = useCurrentProTableUrlState({ searchColumnId: "pair" });
	const [refreshKey, setRefreshKey] = useState(0);
	const [editing, setEditing] = useState<ExchangeRate | null>(null);
	const [deleting, setDeleting] = useState<ExchangeRate | null>(null);
	const syncSettings = useQuery({
		queryKey: ["admin", "exchange-rate-sync-settings"],
		queryFn: () => getExchangeRateSyncSettingsFn(),
	});
	const refresh = useCallback(async () => {
		await Promise.all([
			client.invalidateQueries({ queryKey: ["admin", "exchange-rates"] }),
			client.invalidateQueries({
				queryKey: ["admin", "exchange-rate-sync-settings"],
			}),
		]);
		setRefreshKey((current) => current + 1);
	}, [client]);
	const request = useCallback(
		(state: ProTableState) => {
			const search = String(
				state.columnFilters.find((filter) => filter.id === "pair")?.value ?? "",
			);
			const input = {
				pageIndex: state.pagination.pageIndex,
				pageSize: state.pagination.pageSize,
				search,
			};
			return client.fetchQuery({
				queryKey: ["admin", "exchange-rates", input],
				queryFn: () => listExchangeRatesFn({ data: input }),
			});
		},
		[client],
	);
	const save = useMutation({
		mutationFn: saveExchangeRateFn,
		onSuccess: async () => {
			setEditing(null);
			await refresh();
			toast.success(m.settings_saved());
		},
		onError: showError,
	});
	const saveSyncSettings = useMutation({
		mutationFn: saveExchangeRateSyncSettingsFn,
		onSuccess: async () => {
			await refresh();
			toast.success(m.settings_saved());
		},
		onError: showError,
	});
	const setEnabled = useMutation({
		mutationFn: setExchangeRateEnabledFn,
		onSuccess: refresh,
		onError: showError,
	});
	const syncNow = useMutation({
		mutationFn: syncExchangeRatesNowFn,
		onSuccess: async (result) => {
			await refresh();
			toast.success(
				result.failed
					? m.exchange_rates_sync_partial(result)
					: m.exchange_rates_sync_success(result),
			);
		},
		onError: showError,
	});
	const remove = useMutation({
		mutationFn: deleteExchangeRateFn,
		onSuccess: async () => {
			setDeleting(null);
			await refresh();
		},
		onError: showError,
	});
	const columns = useMemo<ColumnDef<ExchangeRate>[]>(
		() => [
			{
				accessorKey: "enabled",
				header: m.common_enabled(),
				cell: ({ row }) => (
					<Switch
						aria-label={m.common_enabled()}
						checked={row.original.enabled}
						disabled={setEnabled.isPending}
						onCheckedChange={(enabled) =>
							setEnabled.mutate({ data: { id: row.original.id, enabled } })
						}
					/>
				),
			},
			{
				id: "pair",
				header: m.exchange_rates_pair(),
				accessorFn: (row) => `${row.baseCurrency}/${row.quoteCurrency}`,
				meta: { search: true },
				cell: ({ row }) => (
					<strong>
						{row.original.baseCurrency} / {row.original.quoteCurrency}
					</strong>
				),
			},
			{
				accessorKey: "rawRate",
				header: m.exchange_rates_raw_rate(),
			},
			{
				accessorKey: "rate",
				header: m.exchange_rates_effective_rate(),
				cell: ({ row }) => (
					<div>
						<span className="block">{row.original.rate}</span>
						<span className="text-muted-foreground text-xs">
							{formatBasisPoints(row.original.adjustmentBps)}
						</span>
					</div>
				),
			},
			{
				accessorKey: "observedAt",
				header: m.exchange_rates_observed_at(),
				cell: ({ row }) =>
					row.original.observedAt <= 1
						? m.exchange_rates_sync_status_waiting()
						: formatDateTime(row.original.observedAt),
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
									variant="ghost"
									tooltip={m.common_actions()}
								>
									<MoreHorizontal />
								</ProButton>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuItem onClick={() => setEditing(row.original)}>
									<Pencil />
									{m.common_edit()}
								</DropdownMenuItem>
								<DropdownMenuItem
									variant="destructive"
									onClick={() => setDeleting(row.original)}
								>
									<Trash2 />
									{m.common_delete()}
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				),
			},
		],
		[setEnabled.isPending, setEnabled.mutate],
	);
	const syncStatus = syncStatusText(syncSettings.data);

	async function submit(values: Record<string, unknown>, rate: ExchangeRate) {
		const expiresAt = values.expiresAt;
		await save.mutateAsync({
			data: {
				id: rate.id,
				baseCurrency: String(values.baseCurrency ?? baseCurrency),
				quoteCurrency: String(values.quoteCurrency ?? ""),
				rawRate: String(values.rawRate ?? ""),
				adjustmentBps: Number(values.adjustmentBps ?? 0),
				expiresAt: expiresAt instanceof Date ? expiresAt.getTime() : null,
			},
		});
	}

	return (
		<section className="flex min-h-0 flex-1 flex-col gap-4">
			<PageHeader
				title={m.settings_group_commerce()}
				description={m.exchange_rates_description()}
				actions={
					<div className="flex flex-wrap gap-2">
						{settingsAction}
						<RateSyncSettingsForm
							settings={syncSettings.data}
							pending={saveSyncSettings.isPending || syncSettings.isLoading}
							syncing={syncNow.isPending}
							onSave={(data) => saveSyncSettings.mutateAsync({ data })}
							onSync={() => syncNow.mutateAsync({ data: {} })}
						/>
					</div>
				}
			/>
			{syncStatus ? (
				<p className="text-muted-foreground text-xs">{syncStatus}</p>
			) : null}
			<ProTable
				className="min-h-0 flex-1"
				columns={columns}
				initialState={urlState.initialState}
				onChange={urlState.onChange}
				onRefresh={refresh}
				request={request}
				requestKey={refreshKey}
				layout="full"
				table={{ stickyHeader: true }}
				toolbarSearch={{
					columnId: "pair",
					placeholder: m.exchange_rates_search(),
				}}
			/>
			{editing ? (
				<ModalForm
					key={editing.id}
					open
					title={m.exchange_rates_edit()}
					schema={exchangeRateSchema()}
					initialValues={{
						baseCurrency: editing.baseCurrency,
						quoteCurrency: editing.quoteCurrency,
						rawRate: editing.rawRate,
						adjustmentBps: editing.adjustmentBps,
						expiresAt: editing.expiresAt
							? new Date(editing.expiresAt)
							: undefined,
					}}
					onOpenChange={(open) => !open && setEditing(null)}
					onFinish={(values) => submit(values, editing)}
					onFinishFailed={showError}
				/>
			) : null}
			<ConfirmDialog
				open={Boolean(deleting)}
				onOpenChange={(open) => !open && setDeleting(null)}
				title={m.exchange_rates_delete_title()}
				desc={m.exchange_rates_delete_description({
					pair: `${deleting?.baseCurrency ?? ""}/${deleting?.quoteCurrency ?? ""}`,
				})}
				confirmText={m.common_delete()}
				destructive
				isLoading={remove.isPending}
				handleConfirm={() =>
					deleting && remove.mutate({ data: { id: deleting.id } })
				}
			/>
		</section>
	);
}

function exchangeRateSchema() {
	return [
		{
			name: "baseCurrency",
			label: m.exchange_rates_base_currency(),
			required: true,
			tooltip: m.exchange_rates_base_currency_tooltip(),
			fieldProps: { disabled: true },
		},
		{
			name: "quoteCurrency",
			label: m.exchange_rates_quote_currency(),
			required: true,
			tooltip: m.exchange_rates_quote_currency_tooltip(),
		},
		{
			name: "rawRate",
			label: m.exchange_rates_raw_rate(),
			required: true,
			tooltip: m.exchange_rates_raw_rate_tooltip(),
			fieldProps: { inputMode: "decimal" },
		},
		{
			name: "adjustmentBps",
			label: m.exchange_rates_adjustment(),
			required: true,
			tooltip: m.exchange_rates_adjustment_tooltip(),
			fieldProps: { inputMode: "numeric", min: -9_999, max: 100_000 },
		},
		{
			name: "expiresAt",
			label: m.exchange_rates_expires_at(),
			valueType: "dateTime" as const,
			tooltip: m.exchange_rates_expires_at_tooltip(),
		},
	];
}

function RateSyncSettingsForm({
	settings,
	pending,
	syncing,
	onSave,
	onSync,
}: {
	settings: SyncSettings | undefined;
	pending: boolean;
	syncing: boolean;
	onSave: (data: {
		provider: SyncSettings["provider"];
		enabled: boolean;
		intervalMs: number;
		adjustmentBps: number;
		apiKey?: string;
	}) => Promise<unknown>;
	onSync: () => Promise<unknown>;
}) {
	const syncAfterSave = useRef(false);

	return (
		<ModalForm
			title={m.exchange_rates_sync_settings()}
			description={m.exchange_rates_sync_settings_description()}
			trigger={
				<ProButton disabled={pending} variant="outline">
					<Settings2 />
					{m.exchange_rates_sync_settings()}
				</ProButton>
			}
			schema={[
				{
					name: "enabled",
					label: m.exchange_rates_auto_sync(),
					valueType: "switch",
					tooltip: m.exchange_rates_auto_sync_tooltip(),
				},
				{
					name: "provider",
					label: m.exchange_rates_source(),
					valueType: "select",
					required: true,
					fieldProps: {
						options: [
							{
								label: "exchangerate.host",
								value: "exchangerate_host",
							},
							{
								label: "AllRatesToday",
								value: "allratestoday",
							},
						],
					},
				},
				{
					name: "apiKey",
					label: m.exchange_rates_api_key(),
					valueType: "password",
					hidden: (values) => values.provider === "allratestoday",
					required: !settings?.hasApiKey,
					tooltip: m.exchange_rates_api_key_tooltip(),
					fieldProps: {
						placeholder: settings?.hasApiKey
							? m.settings_secret_configured()
							: undefined,
					},
				},
				{
					name: "intervalMinutes",
					label: m.exchange_rates_sync_interval(),
					required: true,
					tooltip: m.exchange_rates_sync_interval_tooltip(),
					fieldProps: {
						inputMode: "numeric",
						min: 5,
						max: 43_200,
						suffix: m.unit_minutes(),
					},
				},
				{
					name: "adjustmentBps",
					label: m.exchange_rates_adjustment(),
					required: true,
					tooltip: m.exchange_rates_adjustment_tooltip(),
					fieldProps: {
						inputMode: "numeric",
						min: -9_999,
						max: 100_000,
						step: 1,
					},
				},
			]}
			initialValues={{
				enabled: settings?.enabled ?? false,
				provider: settings?.provider ?? "exchangerate_host",
				intervalMinutes: (settings?.intervalMs ?? 86_400_000) / 60_000,
				adjustmentBps: settings?.adjustmentBps ?? 0,
			}}
			submitter={({ submitting }) => (
				<>
					<ProButton
						type="submit"
						variant="outline"
						disabled={submitting || syncing}
						loading={(submitting || syncing) && syncAfterSave.current}
						onClick={() => {
							syncAfterSave.current = true;
						}}
					>
						<RefreshCw />
						{m.exchange_rates_sync_now()}
					</ProButton>
					<ProButton
						type="submit"
						loading={submitting && !syncAfterSave.current}
						disabled={submitting || syncing}
						onClick={() => {
							syncAfterSave.current = false;
						}}
					>
						{m.settings_save_changes()}
					</ProButton>
				</>
			)}
			onFinish={async (values) => {
				try {
					await onSave({
						provider:
							values.provider === "allratestoday"
								? "allratestoday"
								: "exchangerate_host",
						enabled: formBooleanValue(values.enabled),
						intervalMs: Number(values.intervalMinutes ?? 1_440) * 60_000,
						adjustmentBps: Number(values.adjustmentBps ?? 0),
						...(String(values.apiKey ?? "").trim()
							? { apiKey: String(values.apiKey).trim() }
							: {}),
					});
					if (syncAfterSave.current) await onSync();
				} finally {
					syncAfterSave.current = false;
				}
			}}
			onFinishFailed={showError}
		/>
	);
}

function syncStatusText(settings: SyncSettings | undefined) {
	if (!settings) return m.exchange_rates_sync_status_loading();
	if (settings.provider === "exchangerate_host" && !settings.hasApiKey)
		return null;
	if (settings.lastStatus === "failed")
		return m.exchange_rates_sync_status_failed();
	if (settings.lastSyncedAt)
		return m.exchange_rates_sync_status_last({
			time: formatDateTime(settings.lastSyncedAt),
		});
	return settings.enabled
		? m.exchange_rates_sync_status_waiting()
		: m.exchange_rates_sync_status_disabled();
}

function showError(error: unknown) {
	toast.error(exchangeRateErrorMessage(error));
}
