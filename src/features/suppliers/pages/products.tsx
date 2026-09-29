"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import type { ColumnDef, RowSelectionState } from "@tanstack/react-table";
import {
	ArrowRightLeft,
	Download,
	MoreHorizontal,
	Pencil,
	RefreshCw,
	Settings2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ProButton } from "#/components/pro/base/button";
import { CheckboxControl } from "#/components/pro/base/fields/checkbox";
import { Select } from "#/components/pro/base/fields/select";
import { formBooleanValue, ModalForm } from "#/components/pro/form";
import { type ColumnFilterConfig, ProTable } from "#/components/pro/table";
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
	getSupplierSyncSettingsFn,
	saveSupplierSyncSettingsFn,
	syncAllSupplierSourcesFn,
} from "../server/admin";
import {
	importSupplierProductsFn,
	listSupplierBindingTargetsFn,
	listSupplierProductsFn,
	listSupplierSourcesFn,
	switchSupplierBindingFn,
} from "../server/catalog-admin";

type Sources = Awaited<ReturnType<typeof listSupplierSourcesFn>>;
type Source = Sources[number];
type Products = Awaited<ReturnType<typeof listSupplierProductsFn>>;
type ProductRow = Products["data"][number] & {
	source: Source;
	selectionKey: string;
};
type SyncSettings = Awaited<ReturnType<typeof getSupplierSyncSettingsFn>>;

const ALL_SOURCES = "all";
const PRODUCT_FILTERS = [
	{ columnId: "imported", searchKey: "status" },
] satisfies ColumnFilterConfig[];

export function SupplierProductsPage() {
	const client = useQueryClient();
	const locationSearch = useLocation({
		select: (location) => location.search as Record<string, unknown>,
	});
	const navigate = useNavigate({ from: "/admin/suppliers/products" });
	const urlState = useCurrentProTableUrlState({
		searchColumnId: "productName",
		columnFilters: PRODUCT_FILTERS,
	});
	const sources = useQuery({
		queryKey: ["admin", "suppliers", "sources"],
		queryFn: () => listSupplierSourcesFn(),
	});
	const sourceKey =
		typeof locationSearch.source === "string" ? locationSearch.source : "";
	const source = sourceKey
		? (sources.data?.find((item) => keyOf(item) === sourceKey) ?? null)
		: null;
	useEffect(() => {
		if (!sourceKey || !sources.data || source) return;
		void navigate({
			replace: true,
			search: (previous) => ({
				...previous,
				source: undefined,
			}),
		});
	}, [navigate, source, sourceKey, sources.data]);
	const products = useQuery({
		queryKey: [
			"admin",
			"suppliers",
			"products",
			source ? keyOf(source) : ALL_SOURCES,
		],
		queryFn: async () => {
			const selectedSources = source ? [source] : (sources.data ?? []);
			const sourcesWithResults = await Promise.all(
				selectedSources.map(async (item) => ({
					source: item,
					result: await listSupplierProductsFn({
						data: {
							provider: item.provider,
							baseUrl: item.baseUrl,
							search: "",
						},
					}),
				})),
			);
			return {
				syncedAt:
					sourcesWithResults.reduce<number | null>(
						(latest, entry) =>
							entry.result.syncedAt != null &&
							(latest == null || entry.result.syncedAt > latest)
								? entry.result.syncedAt
								: latest,
						null,
					) ?? null,
				cacheAvailable: sourcesWithResults.every(
					(entry) => entry.result.cacheAvailable,
				),
				data: sourcesWithResults.flatMap((entry) =>
					entry.result.data.map((row) => ({
						...row,
						source: entry.source,
						selectionKey: JSON.stringify([
							keyOf(entry.source),
							String(row.productId),
							String(row.skuId),
						]),
					})),
				),
			};
		},
		enabled: Boolean(sources.data?.length) && (!sourceKey || Boolean(source)),
	});
	const [selected, setSelected] = useState<ProductRow[] | null>(null);
	const [switching, setSwitching] = useState<ProductRow | null>(null);
	const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
	const syncSettings = useQuery({
		queryKey: ["admin", "suppliers", "sync-settings"],
		queryFn: () => getSupplierSyncSettingsFn(),
	});
	const saveSyncSettings = useMutation({
		mutationFn: saveSupplierSyncSettingsFn,
		onSuccess: async () => {
			await client.invalidateQueries({
				queryKey: ["admin", "suppliers", "sync-settings"],
			});
			toast.success(m.settings_saved());
		},
		onError: showError,
	});
	const sync = useMutation({
		mutationFn: syncAllSupplierSourcesFn,
		onSuccess: async (result) => {
			toast.success(m.supplier_sync_result(result));
			await Promise.all([
				client.invalidateQueries({
					queryKey: ["admin", "suppliers", "products"],
				}),
				client.invalidateQueries({
					queryKey: ["admin", "suppliers", "sync-settings"],
				}),
			]);
		},
		onError: showError,
	});
	const targets = useQuery({
		queryKey: ["admin", "suppliers", "binding-targets"],
		queryFn: () => listSupplierBindingTargetsFn(),
		enabled: Boolean(switching),
	});
	const columns = useMemo<ColumnDef<ProductRow>[]>(
		() => [
			{
				id: "select",
				header: ({ table }) => {
					const rows = table
						.getRowModel()
						.rows.filter((row) => !row.original.imported);
					const selectedCount = rows.filter((row) =>
						row.getIsSelected(),
					).length;
					return (
						<CheckboxControl
							aria-label={m.supplier_import_selected()}
							checked={
								selectedCount === 0
									? false
									: selectedCount === rows.length
										? true
										: "indeterminate"
							}
							disabled={rows.length === 0}
							onClick={() => {
								const select = selectedCount !== rows.length;
								setRowSelection((current) => ({
									...current,
									...Object.fromEntries(
										rows.map((row) => [row.original.selectionKey, select]),
									),
								}));
							}}
						/>
					);
				},
				cell: ({ row }) =>
					row.original.imported ? null : (
						<CheckboxControl
							aria-label={`${m.supplier_import_selected()} · ${String(row.original.productName)}`}
							checked={row.getIsSelected()}
							onClick={() => {
								setRowSelection((current) => ({
									...current,
									[row.original.selectionKey]:
										!current[row.original.selectionKey],
								}));
							}}
						/>
					),
				enableSorting: false,
			},
			{
				id: "productName",
				accessorFn: (row) =>
					[
						row.productName,
						row.skuName,
						row.productId,
						row.skuId,
						row.localProductName,
						row.sellableItemName,
					]
						.filter(Boolean)
						.join(" "),
				header: m.supplier_upstream_details(),
				meta: { search: true },
				cell: ({ row }) => (
					<div className="flex min-w-64 flex-col gap-1.5">
						<div className="flex items-start justify-between gap-3">
							<strong className="min-w-0 truncate">
								{String(row.original.productName)}
							</strong>
							<Badge variant="outline">
								{supplierProviderLabel(row.original.source.provider)}
							</Badge>
						</div>
						<div className="flex items-center justify-between gap-3">
							<span className="min-w-0 truncate text-sm">
								{String(row.original.skuName)}
							</span>
							<span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-xs tabular-nums">
								<span className="mr-1 text-muted-foreground">
									{m.supplier_stock()}
								</span>
								{formatNumber(Number(row.original.stockQuantity))}
							</span>
						</div>
					</div>
				),
			},
			{
				accessorKey: "costMinor",
				header: m.supplier_price_details(),
				cell: ({ row }) => (
					<div className="flex min-w-48 flex-col gap-1">
						<div className="flex items-baseline justify-between gap-3">
							<span className="text-muted-foreground text-xs">
								{m.supplier_cost()}
							</span>
							<span className="tabular-nums">
								{formatMinorAmount(
									row.original.costMinor,
									row.original.currency,
									row.original.currencyDecimals,
								)}
							</span>
						</div>
						<div className="flex items-baseline justify-between gap-3">
							<span className="text-muted-foreground text-xs">
								{m.supplier_cost_limit()}
							</span>
							<span className="tabular-nums">
								{formatMinorAmount(
									row.original.maxCostMinor,
									row.original.currency,
									row.original.currencyDecimals,
								)}
							</span>
						</div>
						<div className="flex items-baseline justify-between gap-3 border-t pt-1">
							<span className="text-muted-foreground text-xs">
								{m.catalog_price_minor()}
							</span>
							<span className="tabular-nums">
								{row.original.priceMinor == null
									? "—"
									: formatMinorAmount(
											row.original.priceMinor,
											row.original.currency,
											row.original.currencyDecimals,
										)}
							</span>
						</div>
					</div>
				),
			},
			{
				accessorKey: "availableAccountCount",
				header: m.supplier_account(),
				cell: ({ row }) =>
					formatNumber(Number(row.original.availableAccountCount)),
			},
			{
				accessorKey: "imported",
				header: m.common_status(),
				filterFn: (row, _columnId, value) =>
					matchesStatusFilter(row.original, String(value)),
				meta: {
					filter: {
						placeholder: m.supplier_all_statuses(),
						options: [
							{
								value: "not_imported",
								label: m.supplier_not_imported(),
							},
							{ value: "imported", label: m.supplier_imported() },
							{
								value: "stopped",
								label: m.supplier_filter_stopped(),
							},
							{
								value: "cost_changed",
								label: m.supplier_filter_cost_changed(),
							},
							{
								value: "no_account",
								label: m.supplier_filter_no_account(),
							},
							{
								value: "sync_error",
								label: m.supplier_filter_sync_error(),
							},
						],
					},
				},
				cell: ({ row }) => (
					<div className="flex min-w-40 flex-col items-start gap-1.5">
						<div className="flex flex-wrap gap-1">
							<Badge variant={row.original.imported ? "default" : "outline"}>
								{row.original.imported
									? m.supplier_imported()
									: m.supplier_not_imported()}
							</Badge>
							<SupplierAvailabilityBadge
								status={String(
									row.original.supplierStatus ?? row.original.remoteStatus,
								)}
							/>
						</div>
						{row.original.lastErrorCode ? (
							<span
								className="max-w-52 truncate text-destructive text-xs"
								title={supplierErrorLabel(String(row.original.lastErrorCode))}
							>
								{supplierErrorLabel(String(row.original.lastErrorCode))}
							</span>
						) : row.original.lastSyncedAt ? (
							<span className="whitespace-nowrap text-muted-foreground text-xs">
								{formatDateTime(Number(row.original.lastSyncedAt))}
							</span>
						) : null}
					</div>
				),
			},
			{
				accessorKey: "localProductName",
				header: m.supplier_local_product(),
				cell: ({ row }) => String(row.original.localProductName ?? "—"),
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
								{row.original.imported &&
								row.original.localProductId != null ? (
									<DropdownMenuItem asChild>
										<Link
											params={{ productId: row.original.localProductId }}
											to="/admin/products/$productId/edit"
										>
											<Pencil />
											{m.catalog_product_edit()}
										</Link>
									</DropdownMenuItem>
								) : (
									<DropdownMenuItem onClick={() => setSelected([row.original])}>
										<Download />
										{m.supplier_import_selected()}
									</DropdownMenuItem>
								)}
								{row.original.imported ? (
									<DropdownMenuItem onClick={() => setSwitching(row.original)}>
										<ArrowRightLeft />
										{m.supplier_switch_source()}
									</DropdownMenuItem>
								) : null}
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				),
			},
		],
		[],
	);
	return (
		<>
			<div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
				<PageHeader
					title={m.supplier_products_title()}
					description={m.supplier_products_description()}
					actions={
						<SupplierSyncSettingsForm
							settings={syncSettings.data}
							pending={syncSettings.isLoading || saveSyncSettings.isPending}
							syncing={sync.isPending}
							onSave={(data) => saveSyncSettings.mutateAsync({ data })}
							onSync={(full) => sync.mutateAsync({ data: { full } })}
						/>
					}
				/>
				<p className="text-muted-foreground text-xs">
					{supplierSyncStatusText(syncSettings.data)}
				</p>
				{source &&
				!products.isLoading &&
				products.data?.cacheAvailable === false &&
				products.data.data.length === 0 ? (
					<div className="rounded-md border border-dashed p-8 text-center text-muted-foreground">
						{m.supplier_sync_required()}
					</div>
				) : null}
				<ProTable
					bulkToolbar={({ selectedRows }) => {
						const unimported = selectedRows
							.map((row) => row.original)
							.filter((row) => !row.imported);
						return (
							<>
								<ProButton
									disabled={!unimported.length}
									onClick={() => setSelected(unimported)}
								>
									<Download />
									{m.supplier_import_selected()}
								</ProButton>
								<ProButton
									disabled={unimported.length !== 1}
									onClick={() => setSwitching(unimported[0] ?? null)}
									variant="outline"
								>
									<ArrowRightLeft />
									{m.supplier_switch_source()}
								</ProButton>
							</>
						);
					}}
					className="min-h-0 flex-1"
					columns={columns}
					data={(products.data?.data ?? []) as ProductRow[]}
					initialState={urlState.initialState}
					loading={products.isLoading}
					onChange={urlState.onChange}
					onRefresh={() => products.refetch()}
					pagination={false}
					toolbarFilters={
						<Select
							ariaLabel={m.supplier_select_source()}
							className="h-9 w-full md:w-[180px]"
							value={source ? keyOf(source) : ALL_SOURCES}
							options={[
								{ value: ALL_SOURCES, label: m.supplier_all_sources() },
								...(sources.data ?? []).map((item) => ({
									value: keyOf(item),
									label: `${supplierProviderLabel(item.provider)} · ${item.normalizedApiOrigin}`,
								})),
							]}
							placeholder={m.supplier_no_source()}
							searchable
							onChange={(nextValue) => {
								const value = typeof nextValue === "string" ? nextValue : "";
								void navigate({
									search: (previous) => ({
										...previous,
										source: value && value !== ALL_SOURCES ? value : undefined,
									}),
								});
							}}
						/>
					}
					toolbarSearch={{
						columnId: "productName",
						placeholder: m.common_search(),
					}}
					table={{
						stickyHeader: true,
						rowKey: "selectionKey",
						rowSelection: {
							value: rowSelection,
							onChange: setRowSelection,
						},
					}}
				/>
			</div>
			{selected ? (
				<ModalForm
					open
					onOpenChange={(open) => !open && setSelected(null)}
					title={m.supplier_import_selected()}
					schema={[
						{
							name: "fixedMarkupMinor",
							label: m.supplier_fixed_markup(),
							required: true,
							fieldProps: { inputMode: "numeric" },
						},
						{
							name: "markupBps",
							label: m.supplier_markup_bps(),
							required: true,
							fieldProps: { inputMode: "numeric" },
						},
						{
							name: "publish",
							label: m.supplier_publish_after_import(),
							valueType: "switch",
						},
					]}
					initialValues={{
						fixedMarkupMinor: "0",
						markupBps: 0,
						publish: false,
					}}
					onFinish={async (values) => {
						await Promise.all(
							groupProductsBySource(selected).map((rows) => {
								const first = rows[0];
								if (!first) throw new Error("supplier_product_group_empty");
								return importSupplierProductsFn({
									data: {
										provider: first.source.provider,
										baseUrl: first.source.baseUrl,
										items: rows.map((row) => ({
											productId: String(row.productId),
											skuId: String(row.skuId),
										})),
										fixedMarkupMinor: String(values.fixedMarkupMinor),
										markupBps: Number(values.markupBps),
										publish: Boolean(values.publish),
									},
								});
							}),
						);
						toast.success(m.supplier_import_succeeded());
						setSelected(null);
						await products.refetch();
					}}
					onFinishFailed={showError}
				/>
			) : null}
			{switching ? (
				<ModalForm
					open
					onOpenChange={(open) => !open && setSwitching(null)}
					title={m.supplier_switch_source()}
					schema={[
						{
							name: "sellableItemId",
							label: m.supplier_binding_target(),
							valueType: "select",
							required: true,
							fieldProps: {
								options: (targets.data ?? []).map((target) => ({
									value: target.id,
									label: `${target.product_name} · ${target.sellable_item_name} · ${supplierProviderLabel(target.provider)}`,
								})),
							},
						},
					]}
					initialValues={{ sellableItemId: "" }}
					onFinish={async (values) => {
						await switchSupplierBindingFn({
							data: {
								provider: switching.source.provider,
								baseUrl: switching.source.baseUrl,
								productId: String(switching.productId),
								skuId: String(switching.skuId),
								sellableItemId: String(values.sellableItemId),
							},
						});
						toast.success(m.supplier_source_switched());
						setSwitching(null);
						await products.refetch();
					}}
					onFinishFailed={showError}
				/>
			) : null}
		</>
	);
}

function SupplierSyncSettingsForm({
	settings,
	pending,
	syncing,
	onSave,
	onSync,
}: {
	settings: SyncSettings | undefined;
	pending: boolean;
	syncing: boolean;
	onSave: (data: { enabled: boolean; intervalMs: number }) => Promise<unknown>;
	onSync: (full: boolean) => Promise<unknown>;
}) {
	const syncAfterSave = useRef(false);
	return (
		<ModalForm
			title={m.supplier_sync_catalog()}
			description={m.supplier_sync_catalog_description()}
			trigger={
				<ProButton disabled={pending}>
					<Settings2 />
					{m.supplier_sync_catalog()}
				</ProButton>
			}
			schema={[
				{
					name: "enabled",
					label: m.exchange_rates_auto_sync(),
					valueType: "switch",
					tooltip: m.supplier_sync_all_sources(),
				},
				{
					name: "intervalMinutes",
					label: m.exchange_rates_sync_interval(),
					required: true,
					tooltip: m.supplier_sync_all_sources(),
					fieldProps: {
						inputMode: "numeric",
						min: 10,
						max: 43_200,
						suffix: m.unit_minutes(),
					},
				},
				{
					name: "syncMode",
					label: m.supplier_sync_mode(),
					valueType: "select",
					required: true,
					fieldProps: {
						options: [
							{
								value: "smart",
								label: m.supplier_sync_mode_smart(),
							},
							{
								value: "full",
								label: m.supplier_sync_mode_full(),
							},
						],
					},
					tooltip: (
						<div className="space-y-1">
							<p>
								<strong>{m.supplier_sync_mode_smart()}：</strong>
								{m.supplier_sync_mode_smart_description()}
							</p>
							<p>
								<strong>{m.supplier_sync_mode_full()}：</strong>
								{m.supplier_sync_mode_full_description()}
							</p>
						</div>
					),
				},
			]}
			initialValues={{
				enabled: settings?.enabled ?? true,
				intervalMinutes: (settings?.intervalMs ?? 600_000) / 60_000,
				syncMode: "smart",
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
						enabled: formBooleanValue(values.enabled),
						intervalMs: Number(values.intervalMinutes ?? 10) * 60_000,
					});
					if (syncAfterSave.current) await onSync(values.syncMode === "full");
				} finally {
					syncAfterSave.current = false;
				}
			}}
			onFinishFailed={showError}
		/>
	);
}

function supplierSyncStatusText(settings: SyncSettings | undefined) {
	if (!settings) return m.supplier_sync_status_loading();
	if (settings.lastStatus === "failed") return m.supplier_sync_status_failed();
	if (settings.lastSyncedAt)
		return m.supplier_sync_status_last({
			time: formatDateTime(settings.lastSyncedAt),
		});
	return settings.enabled
		? m.supplier_sync_status_waiting()
		: m.supplier_sync_status_disabled();
}

function keyOf(source: Source) {
	return `${source.provider}:${source.normalizedApiOrigin}`;
}

function SupplierAvailabilityBadge({ status }: { status: string }) {
	const available = status === "active" || status === "available";
	const unavailable =
		status === "inactive" || status === "unavailable" || status === "deleted";
	return (
		<Badge
			variant={
				available ? "secondary" : unavailable ? "destructive" : "outline"
			}
		>
			{supplierStatusLabel(status)}
		</Badge>
	);
}

function supplierStatusLabel(status: string) {
	if (status === "active" || status === "available")
		return m.supplier_status_available();
	if (status === "inactive" || status === "unavailable")
		return m.supplier_status_unavailable();
	if (status === "deleted") return m.supplier_status_deleted();
	return m.supplier_status_unknown();
}

function matchesStatusFilter(row: ProductRow, filter: string) {
	if (filter === "not_imported") return !row.imported;
	if (filter === "imported") return row.imported;
	if (filter === "stopped")
		return (
			row.remoteStatus !== "active" ||
			row.supplierStatus === "unavailable" ||
			(row.localProductStatus != null && row.localProductStatus !== "active")
		);
	if (filter === "cost_changed")
		return (
			row.importCostMinor != null &&
			BigInt(row.costMinor) !== BigInt(row.importCostMinor)
		);
	if (filter === "no_account") return row.availableAccountCount < 1;
	if (filter === "sync_error") return row.lastErrorCode != null;
	return true;
}

function groupProductsBySource(rows: ProductRow[]) {
	const grouped = new Map<string, ProductRow[]>();
	for (const row of rows) {
		const key = keyOf(row.source);
		const products = grouped.get(key);
		if (products) products.push(row);
		else grouped.set(key, [row]);
	}
	return [...grouped.values()];
}

function showError() {
	toast.error(m.common_operation_failed());
}
