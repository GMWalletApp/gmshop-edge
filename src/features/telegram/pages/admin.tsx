"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Settings2 } from "lucide-react";
import { useRef } from "react";
import { toast } from "sonner";
import { ProButton } from "#/components/pro/base/button";
import { Switch } from "#/components/pro/base/fields/checkbox";
import { ProDescriptions } from "#/components/pro/descriptions";
import { formBooleanValue, ModalForm } from "#/components/pro/form";
import { Badge } from "#/components/ui/badge";
import { PageHeader } from "#/layouts/components/page-header";
import { formatDateTime } from "#/lib/format";
import { m } from "#/paraglide/messages";
import { telegramErrorLabel, telegramErrorMessage } from "../error-message";
import {
	getTelegramSettingsFn,
	saveTelegramSettingsFn,
	syncTelegramBotFn,
} from "../server/admin";

const queryKey = ["admin", "telegram-settings"] as const;

export function TelegramSettingsPage() {
	const client = useQueryClient();
	const query = useQuery({ queryKey, queryFn: () => getTelegramSettingsFn() });
	const refresh = () => client.invalidateQueries({ queryKey });
	const sync = useMutation({
		mutationFn: () => syncTelegramBotFn(),
		onSuccess: async () => {
			await refresh();
			toast.success(m.telegram_sync_succeeded());
		},
		onError: (error) => toast.error(telegramErrorMessage(error)),
	});
	const data = query.data;
	return (
		<div className="flex min-h-0 w-full flex-1 flex-col">
			<PageHeader
				title={m.telegram_settings_title()}
				description={m.telegram_settings_description()}
				actions={
					<div className="flex items-center gap-2">
						{data ? (
							<>
								<SupportSettingsModal data={data} onSaved={refresh} />
								<SyncSettingsModal
									data={data}
									onSaved={refresh}
									onSync={() => sync.mutateAsync()}
									syncing={sync.isPending}
								/>
							</>
						) : null}
					</div>
				}
			/>
			<div className="mt-6 min-h-0 flex-1 space-y-8 overflow-y-auto pe-3">
				<ProDescriptions
					title={m.telegram_support_status()}
					bordered
					columns={2}
					items={supportStatusItems(data)}
				/>
				<ProDescriptions
					title={m.telegram_bot_status()}
					bordered
					columns={2}
					items={botStatusItems(data)}
				/>
				<ProDescriptions
					title={m.telegram_commands()}
					bordered
					columns={2}
					items={commandItems()}
				/>
			</div>
		</div>
	);
}

function SupportSettingsModal({
	data,
	onSaved,
}: {
	data: Awaited<ReturnType<typeof getTelegramSettingsFn>>;
	onSaved: () => Promise<unknown>;
}) {
	return (
		<ModalForm
			title={m.telegram_support_settings()}
			description={m.telegram_support_enabled_description()}
			trigger={
				<ProButton>
					<Settings2 />
					{m.telegram_support_action()}
				</ProButton>
			}
			schema={supportSettingsSchema(data.activeConversationCount > 0)}
			initialValues={{
				supportEnabled: data.supportEnabled,
				webSupportEnabled: data.webSupportEnabled,
				supportChatId: data.supportChatId ?? "",
				idleMinutes: data.idleTimeoutMs / 60_000,
			}}
			fieldsClassName="grid grid-cols-1 gap-5 space-y-0 md:grid-cols-2"
			onFinish={async (values) => {
				await saveTelegramSettingsFn({
					data: {
						autoSyncEnabled: data.autoSyncEnabled,
						autoSyncIntervalMs: data.autoSyncIntervalMs,
						supportEnabled: formBooleanValue(values.supportEnabled),
						webSupportEnabled: formBooleanValue(values.webSupportEnabled),
						supportChatId: String(values.supportChatId ?? "").trim() || null,
						idleTimeoutMs: Number(values.idleMinutes) * 60_000,
					},
				});
				await onSaved();
				toast.success(m.settings_saved());
			}}
			onFinishFailed={(error) => toast.error(telegramErrorMessage(error))}
		/>
	);
}

function SyncSettingsModal({
	data,
	onSaved,
	onSync,
	syncing,
}: {
	data: Awaited<ReturnType<typeof getTelegramSettingsFn>>;
	onSaved: () => Promise<unknown>;
	onSync: () => Promise<unknown>;
	syncing: boolean;
}) {
	const syncAfterSave = useRef(false);
	return (
		<ModalForm
			title={m.telegram_sync_settings()}
			description={m.telegram_auto_sync_description()}
			trigger={
				<ProButton variant="outline">
					<Settings2 />
					{m.telegram_sync_action()}
				</ProButton>
			}
			schema={[
				{
					name: "autoSyncEnabled",
					label: m.telegram_auto_sync(),
					tooltip: m.telegram_auto_sync_description(),
					valueType: "switch",
					render: switchField(m.telegram_auto_sync()),
				},
				{
					name: "intervalMinutes",
					label: m.telegram_auto_sync_interval(),
					tooltip: m.telegram_auto_sync_interval_description(),
					required: true,
					fieldProps: {
						inputMode: "numeric",
						min: 1,
						max: 1_440,
						suffix: m.unit_minutes(),
					},
				},
			]}
			initialValues={{
				autoSyncEnabled: data.autoSyncEnabled,
				intervalMinutes: data.autoSyncIntervalMs / 60_000,
			}}
			fieldsClassName="grid grid-cols-1 gap-5 space-y-0"
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
						{m.telegram_sync_now()}
					</ProButton>
					<ProButton
						type="submit"
						disabled={submitting || syncing}
						loading={submitting && !syncAfterSave.current}
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
					await saveTelegramSettingsFn({
						data: {
							autoSyncEnabled: formBooleanValue(values.autoSyncEnabled),
							autoSyncIntervalMs: Number(values.intervalMinutes) * 60_000,
							supportEnabled: data.supportEnabled,
							webSupportEnabled: data.webSupportEnabled,
							supportChatId: data.supportChatId,
							idleTimeoutMs: data.idleTimeoutMs,
						},
					});
					await onSaved();
					if (syncAfterSave.current) await onSync();
					else toast.success(m.settings_saved());
				} finally {
					syncAfterSave.current = false;
				}
			}}
			onFinishFailed={(error) => toast.error(telegramErrorMessage(error))}
		/>
	);
}

function supportSettingsSchema(hasActiveConversations: boolean) {
	return [
		{
			name: "supportEnabled",
			label: m.telegram_support_enabled(),
			tooltip: m.telegram_support_enabled_description(),
			valueType: "switch" as const,
			required: true,
			render: switchField(m.telegram_support_enabled()),
		},
		{
			name: "webSupportEnabled",
			label: m.telegram_web_support_enabled(),
			tooltip: m.telegram_web_support_enabled_description(),
			valueType: "switch" as const,
			required: true,
			render: switchField(m.telegram_web_support_enabled()),
		},
		{
			name: "supportChatId",
			label: m.telegram_support_chat_id(),
			tooltip: m.telegram_support_chat_id_description(),
			valueType: "text" as const,
			required: false,
			disabled: hasActiveConversations,
			fieldProps: { placeholder: "-1001234567890" },
			description: hasActiveConversations
				? m.telegram_chat_locked_by_active_conversations()
				: undefined,
		},
		{
			name: "idleMinutes",
			label: m.telegram_support_idle_minutes(),
			tooltip: m.telegram_support_idle_timeout_description(),
			valueType: "text" as const,
			required: true,
			fieldProps: {
				inputMode: "numeric",
				min: 5,
				max: 43_200,
				suffix: m.unit_minutes(),
			},
		},
	];
}

function switchField(label: string) {
	return (control: { value: unknown; onChange: (value: boolean) => void }) => (
		<Switch
			aria-label={label}
			value={control.value === true}
			onChange={control.onChange}
		/>
	);
}

function botStatusItems(
	data: Awaited<ReturnType<typeof getTelegramSettingsFn>> | undefined,
) {
	return [
		{
			label: m.telegram_bot_identity(),
			value: data
				? textValue(
						[data.botName, data.botUsername ? `@${data.botUsername}` : null]
							.filter(Boolean)
							.join(" · "),
					)
				: undefined,
			span: 2 as const,
		},
		{
			label: m.telegram_status(),
			value: (
				<div className="flex flex-wrap items-center gap-2">
					<Badge variant="outline">{statusLabel(data?.status)}</Badge>
					{data?.nextRetryAt ? (
						<span className="text-muted-foreground text-xs">
							{m.telegram_retry_at({ time: formatDateTime(data.nextRetryAt) })}
						</span>
					) : null}
				</div>
			),
			span: 2 as const,
		},
		{
			label: m.telegram_webhook_url(),
			value: textValue(data?.webhookUrl),
			span: 2 as const,
		},
		{
			label: m.telegram_webhook_delivery(),
			value: data
				? m.telegram_webhook_delivery_summary({
						status: webhookStatusLabel(data.webhookHealth.status),
						count: data.webhookHealth.pendingUpdates,
					})
				: undefined,
		},
		{
			label: m.telegram_last_update(),
			value: dateValue(data?.lastWebhookUpdateAt),
		},
		{
			label: m.telegram_webhook_last_error(),
			value: data?.webhookHealth.errorCode
				? `${webhookErrorLabel(data.webhookHealth.errorCode)} · ${dateValue(data.webhookHealth.lastErrorAt) ?? "—"}`
				: undefined,
			span: 2 as const,
		},
		{
			label: m.telegram_last_sync(),
			value: data
				? m.telegram_last_sync_summary({
						bot: dateValue(data.lastSyncedAt) ?? "—",
						administrators: dateValue(data.lastAdminSyncAt) ?? "—",
					})
				: undefined,
			span: 2 as const,
		},
		{
			label: m.telegram_error_code(),
			value: telegramErrorLabel(data?.lastErrorCode),
			span: 2 as const,
		},
	];
}

function supportStatusItems(
	data: Awaited<ReturnType<typeof getTelegramSettingsFn>> | undefined,
) {
	return [
		{
			label: m.telegram_support_enabled(),
			value: data
				? data.supportEnabled
					? m.telegram_support_status_enabled()
					: m.telegram_support_status_disabled()
				: undefined,
		},
		{
			label: m.telegram_support_chat_id(),
			value: textValue(data?.supportChatId),
		},
		{
			label: m.telegram_web_support_enabled(),
			value: data
				? data.webSupportEnabled
					? m.telegram_support_status_enabled()
					: m.telegram_support_status_disabled()
				: undefined,
		},
		{
			label: m.telegram_active_conversations(),
			value: data?.activeConversationCount,
		},
		{
			label: m.telegram_administrator_count(),
			value: data?.administratorCount,
		},
		{
			label: m.telegram_forum_permissions(),
			value: data?.supportChatId
				? data.lastAdminSyncAt
					? m.telegram_forum_permissions_verified()
					: m.telegram_validation_required()
				: undefined,
			span: 2 as const,
		},
	];
}

function commandItems() {
	return [
		{ label: "/start", value: m.telegram_command_start() },
		{ label: "/support", value: m.telegram_command_support() },
		{ label: "/close", value: m.telegram_command_close() },
		{ label: "/language", value: m.telegram_command_language() },
		{ label: "/help", value: m.telegram_command_help(), span: 2 as const },
	];
}

function dateValue(value: number | null | undefined) {
	return value ? formatDateTime(value) : undefined;
}

function textValue(value: string | null | undefined) {
	return value ? <span className="break-all">{value}</span> : undefined;
}

function statusLabel(status: string | undefined) {
	if (!status) return "—";
	const labels: Record<string, () => string> = {
		unsynced: m.telegram_status_unsynced,
		pending_sync: m.telegram_status_pending,
		syncing: m.telegram_status_syncing,
		active: m.telegram_status_active,
		sync_failed: m.telegram_status_failed,
		dependency_unavailable: m.telegram_status_dependency_unavailable,
	};
	return labels[status]?.() ?? m.status_unknown();
}

function webhookStatusLabel(status: string) {
	const labels: Record<string, () => string> = {
		ready: m.telegram_webhook_ready,
		unconfigured: m.telegram_webhook_unconfigured,
		url_mismatch: m.telegram_webhook_url_mismatch,
		delivery_failed: m.telegram_webhook_delivery_failed,
		unavailable: m.telegram_webhook_unavailable,
	};
	return labels[status]?.() ?? m.status_unknown();
}

function webhookErrorLabel(code: string) {
	const labels: Record<string, () => string> = {
		timeout: m.telegram_webhook_error_timeout,
		tls: m.telegram_webhook_error_tls,
		dns: m.telegram_webhook_error_dns,
		connection: m.telegram_webhook_error_connection,
		http: m.telegram_webhook_error_http,
		unknown: m.telegram_webhook_error_unknown,
	};
	return labels[code]?.() ?? m.telegram_webhook_error_unknown();
}
