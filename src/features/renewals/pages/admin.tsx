"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { Switch } from "#/components/ui/switch";
import type { RenewalStage } from "#/features/renewals/domain";
import {
	getRenewalStatsFn,
	previewRenewalEmailsFn,
	updateRenewalSettingsFn,
} from "#/features/renewals/server/admin";
import { settingsErrorMessage } from "#/features/settings/error-message";
import { PageHeader } from "#/layouts/components/page-header";
import { formatBasisPoints, formatNumber } from "#/lib/format";
import { m } from "#/paraglide/messages";

const statsKey = ["admin", "renewal-reminders"] as const;

function stageLabel(stage: RenewalStage) {
	if (stage === "remind_3d") return m.renewal_stage_remind_3d();
	if (stage === "remind_due") return m.renewal_stage_remind_due();
	return m.renewal_stage_recall();
}

export function RenewalRemindersPage() {
	const client = useQueryClient();
	const stats = useQuery({
		queryKey: statsKey,
		queryFn: () => getRenewalStatsFn(),
		staleTime: 60_000,
	});
	const [previewRequested, setPreviewRequested] = useState(false);
	const preview = useQuery({
		queryKey: [...statsKey, "preview"],
		queryFn: () => previewRenewalEmailsFn(),
		enabled: previewRequested,
		staleTime: 0,
	});
	const save = useMutation({
		mutationFn: updateRenewalSettingsFn,
		onSuccess: async () => {
			await client.invalidateQueries({ queryKey: statsKey });
			toast.success(m.renewal_settings_saved());
		},
		onError: (error) => toast.error(settingsErrorMessage(error)),
	});
	const data = stats.data;
	const columns: Array<
		[string, (row: NonNullable<typeof data>["stages"][number]) => string]
	> = [
		[m.renewal_column_planned(), (row) => formatNumber(row.planned)],
		[m.renewal_column_pending(), (row) => formatNumber(row.pending)],
		[m.renewal_column_sent(), (row) => formatNumber(row.sent)],
		[m.renewal_column_bounced(), (row) => formatNumber(row.bounced)],
		[m.renewal_column_skipped(), (row) => formatNumber(row.skipped)],
		[m.renewal_column_failed(), (row) => formatNumber(row.failed)],
		[m.renewal_column_cancelled(), (row) => formatNumber(row.cancelled)],
		[m.renewal_column_excluded(), (row) => formatNumber(row.excluded)],
		[m.renewal_column_clicked(), (row) => formatNumber(row.clicked)],
		[
			m.renewal_column_click_rate(),
			(row) => formatBasisPoints(row.clickRateBps),
		],
		[
			m.renewal_column_repurchase(),
			(row) =>
				`${formatNumber(row.repurchased14d)} (${formatBasisPoints(row.repurchase14dRateBps)})`,
		],
		[
			m.renewal_column_returned(),
			(row) =>
				row.stage === "recall"
					? `${formatNumber(row.returned)} (${formatBasisPoints(row.returnRateBps)})`
					: "—",
		],
	];
	return (
		<div className="flex w-full flex-col gap-4">
			<PageHeader
				description={m.renewal_admin_description()}
				title={m.renewal_admin_title()}
			/>
			<section className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2">
				<SettingSwitch
					checked={data?.settings.remindersEnabled ?? true}
					description={m.renewal_reminders_enabled_description()}
					disabled={!data || save.isPending}
					label={m.renewal_reminders_enabled()}
					onChange={(value) =>
						save.mutate({ data: { remindersEnabled: value } })
					}
				/>
				<SettingSwitch
					checked={data?.settings.recallEnabled ?? false}
					description={m.renewal_recall_enabled_description()}
					disabled={!data || save.isPending}
					label={m.renewal_recall_enabled()}
					onChange={(value) => save.mutate({ data: { recallEnabled: value } })}
				/>
			</section>
			<div className="overflow-x-auto rounded-lg border">
				<table className="w-full min-w-[720px] text-sm">
					<thead className="bg-muted/50 text-muted-foreground">
						<tr>
							<th className="px-3 py-2 text-start font-medium" scope="col">
								{m.renewal_column_stage()}
							</th>
							{columns.map(([label]) => (
								<th
									className="px-3 py-2 text-end font-medium"
									key={label}
									scope="col"
								>
									{label}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{(data?.stages ?? []).map((row) => (
							<tr className="border-t" key={row.stage}>
								<th className="px-3 py-2 text-start font-medium" scope="row">
									{stageLabel(row.stage)}
								</th>
								{columns.map(([label, value]) => (
									<td className="px-3 py-2 text-end tabular-nums" key={label}>
										{value(row)}
									</td>
								))}
							</tr>
						))}
						{stats.isPending ? (
							<tr>
								<td
									className="px-3 py-6 text-center"
									colSpan={columns.length + 1}
								>
									…
								</td>
							</tr>
						) : null}
					</tbody>
				</table>
			</div>
			{data ? (
				<div className="flex flex-col gap-1 text-muted-foreground text-sm">
					<p>
						{m.renewal_records_summary({
							awaiting: formatNumber(data.reminders.awaiting_redeem ?? 0),
							scheduled: formatNumber(data.reminders.scheduled ?? 0),
							cancelled: formatNumber(data.reminders.cancelled ?? 0),
							abandoned: formatNumber(data.reminders.abandoned ?? 0),
						})}
					</p>
					<p>
						{m.renewal_baseline({
							customers: formatNumber(data.baseline.customers),
							repeat: formatNumber(data.baseline.repeatCustomers),
							rate: formatBasisPoints(data.baseline.repeatRateBps),
						})}
					</p>
				</div>
			) : null}
			<section className="flex flex-col gap-3 rounded-lg border p-4">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<h2 className="font-medium">{m.renewal_preview_title()}</h2>
					<Button
						disabled={preview.isFetching}
						onClick={() =>
							previewRequested ? preview.refetch() : setPreviewRequested(true)
						}
						size="sm"
						variant="outline"
					>
						<Eye />
						{m.renewal_preview_action()}
					</Button>
				</div>
				{preview.data ? (
					<>
						<p className="text-sm">
							{m.renewal_preview_summary({
								rows: formatNumber(preview.data.recallDueRows),
								recipients: formatNumber(preview.data.recallDueRecipients),
							})}
						</p>
						<div className="grid gap-3 lg:grid-cols-3">
							{preview.data.examples.map((example) => (
								<article
									className="min-w-0 rounded-md border p-3"
									key={example.stage}
								>
									<p className="text-muted-foreground text-xs">
										{stageLabel(example.stage)} · {example.to}
									</p>
									<p className="mt-1 break-words font-medium text-sm">
										{example.subject}
									</p>
									<pre className="mt-2 whitespace-pre-wrap break-words font-sans text-muted-foreground text-xs">
										{example.text}
									</pre>
								</article>
							))}
						</div>
					</>
				) : null}
			</section>
		</div>
	);
}

function SettingSwitch(props: {
	checked: boolean;
	disabled: boolean;
	label: string;
	description: string;
	onChange: (value: boolean) => void;
}) {
	const id = useId();
	return (
		<div className="flex items-start justify-between gap-3">
			<div className="flex flex-col gap-1">
				<label className="font-medium text-sm" htmlFor={id}>
					{props.label}
				</label>
				<p className="text-muted-foreground text-xs">{props.description}</p>
			</div>
			<Switch
				checked={props.checked}
				disabled={props.disabled}
				id={id}
				onCheckedChange={props.onChange}
			/>
		</div>
	);
}
