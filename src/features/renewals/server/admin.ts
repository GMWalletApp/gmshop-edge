import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { systemPermission } from "#/features/access/system-rbac";
import { saveSystemSettings } from "#/features/settings/server/system-settings";
import { getAdminRuntimeServerContext } from "#/server/context";
import { loadRenewalStats, previewRenewalEmails } from "./stats";

export const getRenewalStatsFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const { db } = await getAdminRuntimeServerContext(
			systemPermission("notifications", "read"),
		);
		return loadRenewalStats(db);
	},
);

/** Read-only recall preview; never enqueues or sends email. */
export const previewRenewalEmailsFn = createServerFn({
	method: "GET",
}).handler(async () => {
	const { db } = await getAdminRuntimeServerContext(
		systemPermission("notifications", "read"),
	);
	return previewRenewalEmails(db);
});

const settingsInput = z
	.object({
		remindersEnabled: z.boolean().optional(),
		recallEnabled: z.boolean().optional(),
	})
	.refine((value) => Object.keys(value).length > 0);

export const updateRenewalSettingsFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof settingsInput>) =>
		settingsInput.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await getAdminRuntimeServerContext(
			systemPermission("notifications", "update"),
		);
		return saveSystemSettings(
			[
				...(data.remindersEnabled === undefined
					? []
					: [
							{
								key: "notifications.renewal_reminders_enabled",
								value: data.remindersEnabled,
							},
						]),
				...(data.recallEnabled === undefined
					? []
					: [
							{
								key: "notifications.renewal_recall_enabled",
								value: data.recallEnabled,
							},
						]),
			],
			{
				db: context.db,
				cache: context.env.CACHE,
				userId: context.currentUser.id,
				requestId: context.request.headers.get("x-request-id"),
				ipAddress: context.request.headers.get("cf-connecting-ip"),
			},
		);
	});
