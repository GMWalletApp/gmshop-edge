"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCw, Save, Settings2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ProButton } from "#/components/pro/base/button";
import { Switch } from "#/components/pro/base/fields/checkbox";
import {
	formBooleanValue,
	ModalForm,
	ProSchemaForm,
} from "#/components/pro/form";
import { Button } from "#/components/ui/button";
import { ExchangeRatesTable } from "#/features/exchange-rates/pages/admin";
import { settingsErrorMessage } from "#/features/settings/error-message";
import {
	systemSettingsQueryKey,
	systemSettingsQueryOptions,
} from "#/features/settings/queries";
import {
	rotateRuntimeSecretFn,
	updateSystemSettingsFn,
} from "#/features/settings/server/admin";
import type {
	SettingKey,
	SettingValue,
} from "#/features/settings/server/system-settings";
import { ConfirmDialog } from "#/layouts/components/confirm-dialog";
import { PageHeader } from "#/layouts/components/page-header";
import { fiatCurrencyOptions } from "#/lib/fiat-currencies";
import { m } from "#/paraglide/messages";
import { getLocale } from "#/paraglide/runtime";
import { clientIpSources } from "#/server/client-ip";

export type SettingsGroup =
	| "orders"
	| "fulfillment"
	| "access"
	| "operations"
	| "commerce"
	| "secrets"
	| "retention";

type Field = {
	key: SettingKey;
	label: string;
	description: string;
	type: "text" | "password" | "number" | "origins" | "switch" | "select";
	min?: number;
	max?: number;
	options?: readonly string[];
};

function settingsFields(): Record<SettingsGroup, Field[]> {
	return {
		orders: [
			{
				key: "orders.allow_guest_checkout",
				label: m.settings_guest_checkout(),
				description: m.settings_guest_checkout_description(),
				type: "switch",
			},
			{
				key: "orders.default_expiry_ms",
				label: m.settings_default_expiry(),
				description: m.settings_default_expiry_description(),
				type: "number",
			},
			{
				key: "orders.max_quantity",
				label: m.settings_order_max_quantity(),
				description: m.settings_order_max_quantity_description(),
				type: "number",
				min: 1,
				max: 1_000,
			},
		],
		fulfillment: [
			{
				key: "automation.artifact_retention_ms",
				label: m.settings_artifact_retention(),
				description: m.settings_artifact_retention_description(),
				type: "number",
			},
		],
		access: [
			{
				key: "runtime.better_auth_url",
				label: m.settings_application_url(),
				description: m.settings_application_url_description(),
				type: "text",
			},
			{
				key: "security.allowed_hosts",
				label: m.settings_allowed_hosts(),
				description: m.settings_allowed_hosts_description(),
				type: "origins",
			},
			{
				key: "security.client_ip_source",
				label: m.settings_client_ip_source(),
				description: m.settings_client_ip_source_description(),
				type: "select",
				options: clientIpSources,
			},
		],
		commerce: [
			{
				key: "commerce.default_currency",
				label: m.settings_default_currency(),
				description: m.settings_default_currency_description(),
				type: "text",
			},
			{
				key: "commerce.currency_symbol",
				label: m.settings_currency_symbol(),
				description: m.settings_currency_symbol_description(),
				type: "text",
			},
			{
				key: "commerce.currency_decimals",
				label: m.settings_currency_decimals(),
				description: m.settings_currency_decimals_description(),
				type: "number",
				min: 0,
				max: 8,
			},
		],
		operations: [
			{
				key: "queue.publish_batch_size",
				label: m.settings_queue_batch_size(),
				description: m.settings_queue_batch_size_description(),
				type: "number",
				min: 1,
				max: 100,
			},
			{
				key: "queue.retry_base_ms",
				label: m.settings_queue_retry_delay(),
				description: m.settings_queue_retry_delay_description(),
				type: "number",
			},
		],
		retention: [
			{
				key: "retention.audit_ms",
				label: m.settings_audit_retention(),
				description: m.settings_audit_retention_description(),
				type: "number",
			},
		],
		secrets: [
			{
				key: "runtime.better_auth_secret",
				label: m.settings_auth_secret(),
				description: m.settings_auth_secret_description(),
				type: "password",
			},
			{
				key: "runtime.automation_callback_secret",
				label: m.settings_automation_callback_secret(),
				description: m.settings_automation_callback_secret_description(),
				type: "password",
			},
		],
	};
}

export function SystemSettingsSection({ group }: { group: SettingsGroup }) {
	const formId = `system-settings-${group}`;
	const client = useQueryClient();
	const query = useQuery(systemSettingsQueryOptions);
	const values = new Map(query.data?.map((item) => [item.key, item.value]));
	const configuredSecrets = new Map(
		query.data?.map((item) => [item.key, item.configured]),
	);
	const selected = settingsFields()[group];
	return (
		<div className="flex min-h-0 w-full flex-1 flex-col">
			{group !== "commerce" ? (
				<PageHeader
					title={groupMeta(group).title}
					description={groupMeta(group).description}
					actions={
						<div className="flex items-center gap-2">
							{group === "secrets" ? <SecretRotationAction /> : null}
							<Button form={formId} type="submit">
								<Save />
								{m.settings_save_changes()}
							</Button>
						</div>
					}
				/>
			) : null}
			<div
				className={
					group === "commerce"
						? "mt-6 flex min-h-0 flex-1 overflow-hidden pe-3"
						: "mt-6 min-h-0 flex-1 overflow-y-auto pe-3"
				}
			>
				{group !== "commerce" ? (
					<ProSchemaForm
						id={formId}
						key={`${group}-${query.data?.map((item) => item.updatedAt).join(":")}`}
						schema={settingsSchema(selected, configuredSecrets)}
						initialValues={settingsInitialValues(selected, values)}
						onFinish={async (formValues) => {
							await saveSettings(selected, formValues);
							await client.invalidateQueries({
								queryKey: systemSettingsQueryKey,
							});
							toast.success(m.settings_saved());
						}}
						onFinishFailed={(error) => toast.error(settingsErrorMessage(error))}
						submitter={false}
					/>
				) : null}
				{group === "commerce" ? (
					<div className="flex min-h-0 flex-1 flex-col gap-4">
						<ExchangeRatesTable
							baseCurrency={String(
								values.get("commerce.default_currency") ?? "USD",
							)}
							settingsAction={
								<DefaultCurrencySettingsModal
									configuredSecrets={configuredSecrets}
									fields={selected}
									values={values}
									onSaved={async () => {
										await client.invalidateQueries({
											queryKey: systemSettingsQueryKey,
										});
										toast.success(m.settings_saved());
									}}
								/>
							}
						/>
					</div>
				) : null}
			</div>
		</div>
	);
}

function DefaultCurrencySettingsModal({
	configuredSecrets,
	fields,
	values,
	onSaved,
}: {
	configuredSecrets: Map<SettingKey, boolean | undefined>;
	fields: Field[];
	values: Map<SettingKey, SettingValue | undefined>;
	onSaved: () => Promise<void>;
}) {
	const schema = settingsSchema(fields, configuredSecrets).map((field) =>
		field.name === "commerce.default_currency"
			? {
					...field,
					valueType: "select" as const,
					fieldProps: {
						options: fiatCurrencyOptions(getLocale()),
						showSearch: true,
					},
				}
			: field,
	);
	return (
		<ModalForm
			title={m.settings_commerce_defaults_title()}
			description={m.settings_commerce_defaults_description()}
			trigger={
				<ProButton>
					<Settings2 />
					{m.settings_commerce_defaults_action()}
				</ProButton>
			}
			schema={schema}
			initialValues={settingsInitialValues(fields, values)}
			onFinish={async (formValues) => {
				await saveSettings(fields, formValues);
				await onSaved();
			}}
			onFinishFailed={(error) => toast.error(settingsErrorMessage(error))}
		/>
	);
}

function settingsInitialValues(
	fields: Field[],
	values: Map<SettingKey, SettingValue | undefined>,
) {
	return Object.fromEntries(
		fields.map((field) => [
			field.key,
			displayValue(field.key, values.get(field.key)),
		]),
	);
}

async function saveSettings(
	fields: Field[],
	formValues: Record<string, unknown>,
) {
	await updateSystemSettingsFn({
		data: {
			items: fields.map((field) => ({
				key: field.key,
				value: storageValue(
					field.key,
					normalizeValue(formValues[field.key], field.type),
				),
			})),
		},
	});
}

const rotatableSecrets = [
	{
		key: "runtime.data_encryption_secret",
		label: () => m.settings_data_encryption_secret(),
	},
] as const;

function SecretRotationAction() {
	const client = useQueryClient();
	const [confirming, setConfirming] = useState<
		(typeof rotatableSecrets)[number] | null
	>(null);
	const rotate = useMutation({
		mutationFn: rotateRuntimeSecretFn,
		onSuccess: async () => {
			setConfirming(null);
			await client.invalidateQueries({ queryKey: systemSettingsQueryKey });
			toast.success(m.settings_secret_rotated());
		},
		onError: (error) => toast.error(settingsErrorMessage(error)),
	});
	return (
		<>
			{rotatableSecrets.map((item) => (
				<ProButton
					disabled={rotate.isPending}
					key={item.key}
					loading={rotate.isPending}
					onClick={() => setConfirming(item)}
					tooltip={m.settings_secret_rotation_description()}
					variant="outline"
				>
					<RotateCw />
					{m.settings_rotate_secret({ name: item.label() })}
				</ProButton>
			))}
			<ConfirmDialog
				open={Boolean(confirming)}
				onOpenChange={(open) => !open && setConfirming(null)}
				title={m.settings_secret_rotation_confirm_title()}
				desc={m.settings_secret_rotation_confirm_description({
					name: confirming?.label() ?? m.settings_data_encryption_secret(),
				})}
				confirmText={m.settings_secret_rotation_confirm_action()}
				isLoading={rotate.isPending}
				handleConfirm={() => {
					if (confirming) rotate.mutate({ data: { key: confirming.key } });
				}}
			/>
		</>
	);
}

function settingsSchema(
	selected: Field[],
	configuredSecrets: Map<SettingKey, boolean | undefined>,
) {
	return selected.map((field) => ({
		name: field.key,
		label: field.label,
		tooltip: multilineDescription(field.description),
		valueType:
			field.type === "switch"
				? ("switch" as const)
				: field.type === "password"
					? ("password" as const)
					: field.type === "origins"
						? ("textarea" as const)
						: field.type === "select"
							? ("select" as const)
							: ("text" as const),
		required: field.type !== "password",
		...(field.type === "switch"
			? {
					render: (control: {
						value: unknown;
						onChange: (value: boolean) => void;
					}) => (
						<Switch
							aria-label={field.label}
							value={control.value === true}
							onChange={control.onChange}
						/>
					),
				}
			: {}),
		fieldProps:
			field.type === "password" && configuredSecrets.get(field.key)
				? { placeholder: m.settings_secret_configured() }
				: field.type === "select"
					? {
							options: (field.options ?? []).map((value) => ({
								label: value,
								value,
							})),
						}
					: field.type === "origins"
						? { rows: 6 }
						: field.type === "number"
							? {
									inputMode: "numeric",
									suffix: durationUnit(field.key),
									...(field.min == null ? {} : { min: field.min }),
									...(field.max == null ? {} : { max: field.max }),
								}
							: undefined,
	}));
}

function multilineDescription(description: string) {
	const lines = description.split("\n");
	if (lines.length === 1) return description;
	return (
		<span className="block text-start">
			{lines.map((line) => (
				<span className="block" key={line}>
					{line}
				</span>
			))}
		</span>
	);
}

const durationFields = {
	"orders.default_expiry_ms": { divisor: 60_000, unit: "minutes" },
	"automation.artifact_retention_ms": { divisor: 86_400_000, unit: "days" },
	"queue.retry_base_ms": { divisor: 1_000, unit: "seconds" },
	"retention.audit_ms": { divisor: 86_400_000, unit: "days" },
} as const;

function displayValue(key: SettingKey, value: SettingValue | undefined) {
	if (Array.isArray(value)) return value.join("\n");
	const duration = durationFields[key as keyof typeof durationFields];
	return duration && typeof value === "number"
		? value / duration.divisor
		: value;
}

function storageValue(key: SettingKey, value: SettingValue) {
	const duration = durationFields[key as keyof typeof durationFields];
	return duration && typeof value === "number"
		? value * duration.divisor
		: value;
}

function durationUnit(key: SettingKey) {
	const unit = durationFields[key as keyof typeof durationFields]?.unit;
	if (unit === "seconds") return m.unit_seconds();
	if (unit === "minutes") return m.unit_minutes();
	if (unit === "days") return m.unit_days();
	return undefined;
}

function normalizeValue(value: unknown, type: Field["type"]): SettingValue {
	if (type === "switch") return formBooleanValue(value);
	if (type === "number") return Number(value);
	if (type === "origins")
		return String(value ?? "")
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean);
	return String(value ?? "");
}

function groupMeta(group: SettingsGroup) {
	return {
		orders: {
			title: m.settings_group_orders(),
			description: m.settings_group_orders_description(),
		},
		fulfillment: {
			title: m.settings_group_fulfillment(),
			description: m.settings_group_fulfillment_description(),
		},
		access: {
			title: m.settings_group_access(),
			description: m.settings_group_access_description(),
		},
		operations: {
			title: m.settings_group_operations(),
			description: m.settings_group_operations_description(),
		},
		commerce: {
			title: m.settings_group_commerce(),
			description: m.settings_group_commerce_description(),
		},
		secrets: {
			title: m.settings_group_secrets(),
			description: m.settings_group_secrets_description(),
		},
		retention: {
			title: m.settings_group_retention(),
			description: m.settings_group_retention_description(),
		},
	}[group];
}
