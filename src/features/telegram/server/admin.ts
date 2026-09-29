import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { Api } from "grammy";
import type { z } from "zod";
import { requireAdmin } from "#/features/access/server/require-admin";
import { systemPermission } from "#/features/access/system-rbac";
import { DomainError } from "#/lib/domain-error";
import { clientIp } from "#/server/client-ip";
import { getCloudflareEnv } from "#/server/db.server";
import {
	loadTelegramSettings,
	telegramSettingKeys,
	telegramSettingsInputSchema,
	upsertTelegramSetting,
} from "../settings";
import { synchronizeSupportAdministrators } from "./support-admins";
import {
	logTelegramFailure,
	supportChatErrorCode,
	synchronizeTelegramBot,
	telegramRuntime,
} from "./sync";

export const getTelegramSettingsFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const { db } = await telegramAdminContext("read");
		const { runtime, settings, provider } = await telegramRuntime(db);
		const webhookUrl = safeWebhookUrl(runtime.betterAuthUrl);
		const [counts, webhookHealth] = await Promise.all([
			db
				.prepare(
					`SELECT
					 (SELECT count(*) FROM telegram_support_conversations WHERE status = 'active') +
					 (SELECT count(*) FROM telegram_web_support_conversations WHERE status = 'active') AS active_count,
				 (SELECT count(*) FROM telegram_support_administrators WHERE support_chat_id = ?) AS administrator_count,
				 (SELECT max(updated_at) FROM replay_receipts
				  WHERE namespace = 'telegram_update' AND scope_id = ?) AS last_update_at`,
				)
				.bind(settings.supportChatId, settings.syncedBotUserId)
				.first<{
					active_count: number;
					administrator_count: number;
					last_update_at: number | null;
				}>(),
			inspectWebhook(provider?.telegramBotToken, webhookUrl),
		]);
		return {
			...settings,
			botName: settings.syncedBotName ?? provider?.displayName ?? null,
			botUsername: provider?.telegramBotUsername ?? null,
			dependencyAvailable: Boolean(
				provider?.telegramBotToken && provider.telegramMiniAppEnabled,
			),
			webhookUrl,
			webhookHealth,
			lastWebhookUpdateAt: counts?.last_update_at ?? null,
			activeConversationCount: Number(counts?.active_count ?? 0),
			administratorCount: Number(counts?.administrator_count ?? 0),
		};
	},
);

export const saveTelegramSettingsFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof telegramSettingsInputSchema>) =>
		telegramSettingsInputSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await telegramAdminContext("update");
		const { db } = context;
		const current = await loadTelegramSettings(db);
		if (data.supportChatId !== current.supportChatId) {
			const active = await db
				.prepare(
					`SELECT
					 (SELECT count(*) FROM telegram_support_conversations WHERE status = 'active') +
					 (SELECT count(*) FROM telegram_web_support_conversations WHERE status = 'active') AS count`,
				)
				.first<{ count: number }>();
			if (Number(active?.count ?? 0) > 0)
				throw new DomainError(
					"telegram_active_conversations",
					409,
					"Close active support conversations before changing the chat",
				);
		}
		const now = Date.now();
		const enablingSupport =
			(data.supportEnabled && !current.supportEnabled) ||
			(data.webSupportEnabled && !current.webSupportEnabled);
		const changingActiveSupportChat =
			(data.supportEnabled || data.webSupportEnabled) &&
			data.supportChatId !== current.supportChatId;
		if (enablingSupport || changingActiveSupportChat) {
			try {
				const validation = await synchronizeSupportAdministrators(
					db,
					now,
					data.supportChatId,
				);
				if (!validation.available)
					throw new Error("telegram_support_dependency_unavailable");
			} catch (error) {
				const code = supportChatErrorCode(error);
				logTelegramFailure(
					"telegram_support_chat_validation_failed",
					code,
					error,
				);
				throw new DomainError(
					code,
					409,
					"Telegram support chat validation failed",
				);
			}
		}
		await db.batch([
			upsertTelegramSetting(
				db,
				telegramSettingKeys.autoSync,
				data.autoSyncEnabled,
				now,
			),
			upsertTelegramSetting(
				db,
				telegramSettingKeys.autoSyncIntervalMs,
				data.autoSyncIntervalMs,
				now,
			),
			upsertTelegramSetting(
				db,
				telegramSettingKeys.supportEnabled,
				data.supportEnabled,
				now,
			),
			upsertTelegramSetting(
				db,
				telegramSettingKeys.webSupportEnabled,
				data.webSupportEnabled,
				now,
			),
			upsertTelegramSetting(
				db,
				telegramSettingKeys.supportChatId,
				data.supportChatId,
				now,
			),
			upsertTelegramSetting(
				db,
				telegramSettingKeys.idleTimeoutMs,
				data.idleTimeoutMs,
				now,
			),
			...(data.autoSyncEnabled && !current.autoSyncEnabled
				? [
						upsertTelegramSetting(
							db,
							telegramSettingKeys.status,
							"pending_sync",
							now,
						),
					]
				: []),
			...(data.supportChatId !== current.supportChatId && current.supportChatId
				? [
						db
							.prepare(
								"DELETE FROM telegram_support_administrators WHERE support_chat_id = ?",
							)
							.bind(current.supportChatId),
					]
				: []),
			auditStatement(context, "telegram.settings.updated", now, {
				autoSyncEnabled: data.autoSyncEnabled,
				autoSyncIntervalMs: data.autoSyncIntervalMs,
				supportEnabled: data.supportEnabled,
				webSupportEnabled: data.webSupportEnabled,
				supportChatConfigured: Boolean(data.supportChatId),
				idleTimeoutMs: data.idleTimeoutMs,
			}),
		]);
		return { saved: true };
	});

export const syncTelegramBotFn = createServerFn({ method: "POST" }).handler(
	async () => {
		const context = await telegramAdminContext("update");
		const { db } = context;
		const result = await synchronizeTelegramBot(db, { manual: true });
		if (!result.synchronized)
			throw new DomainError(
				result.code ?? "telegram_sync_failed",
				409,
				"Telegram bot synchronization failed",
			);
		await auditStatement(context, "telegram.bot.synchronized", Date.now(), {
			botName: result.botName,
			username: result.username,
		}).run();
		return result;
	},
);

async function telegramAdminContext(action: "read" | "update") {
	const request = getRequest();
	const user = await requireAdmin(
		request,
		systemPermission("settings", action),
	);
	const db = getCloudflareEnv(request).DB;
	if (!db) throw new Error("D1 binding DB is unavailable");
	return { db, request, user };
}

function auditStatement(
	context: Awaited<ReturnType<typeof telegramAdminContext>>,
	action: string,
	now: number,
	after: unknown,
) {
	return context.db
		.prepare(
			`INSERT INTO audit_logs
			 (id, actor_user_id, action, target_type, target_id, request_id,
			  ip_address, after, created_at)
			 VALUES (?, ?, ?, 'telegram', NULL, ?, ?, ?, ?)`,
		)
		.bind(
			crypto.randomUUID(),
			context.user.id,
			action,
			context.request.headers.get("x-request-id"),
			clientIp(context.request),
			JSON.stringify(after),
			now,
		);
}

function safeWebhookUrl(value: string) {
	try {
		return `${new URL(value).origin}/api/telegram/webhook`;
	} catch {
		return null;
	}
}

async function inspectWebhook(
	token: string | null | undefined,
	expectedUrl: string | null,
) {
	if (!token) return { status: "unavailable" as const, pendingUpdates: 0 };
	try {
		const info = await new Api(token).getWebhookInfo();
		return {
			status: !info.url
				? ("unconfigured" as const)
				: expectedUrl !== info.url
					? ("url_mismatch" as const)
					: info.last_error_date
						? ("delivery_failed" as const)
						: ("ready" as const),
			pendingUpdates: info.pending_update_count,
			lastErrorAt: info.last_error_date ? info.last_error_date * 1_000 : null,
			errorCode: webhookDeliveryErrorCode(info.last_error_message),
		};
	} catch {
		return { status: "unavailable" as const, pendingUpdates: 0 };
	}
}

function webhookDeliveryErrorCode(message: string | undefined) {
	if (!message) return null;
	if (/timed out/i.test(message)) return "timeout" as const;
	if (/ssl|tls|certificate/i.test(message)) return "tls" as const;
	if (/resolve|dns|host/i.test(message)) return "dns" as const;
	if (/connect|connection/i.test(message)) return "connection" as const;
	if (/response|status|\b[45]\d\d\b/i.test(message)) return "http" as const;
	return "unknown" as const;
}
