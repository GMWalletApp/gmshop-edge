import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { Api } from "grammy";
import type { z } from "zod";
import { requireAdmin } from "#/features/access/server/require-admin";
import { systemPermission } from "#/features/access/system-rbac";
import { DomainError } from "#/lib/domain-error";
import { getCloudflareEnv } from "#/server/db.server";
import {
	loadTelegramSettings,
	telegramSettingKeys,
	telegramSettingsInputSchema,
	upsertTelegramSetting,
} from "../settings";
import {
	encryptFeishuAppSecret,
	FeishuAlertError,
	feishuAlertSettingKeys,
	feishuAlertSettingsInputSchema,
	loadFeishuAlertSettings,
	recordFeishuAlertResult,
	resolveFeishuAlertCredentials,
	sendFeishuText,
	upsertFeishuAlertSetting,
	verifyFeishuAppBot,
} from "./feishu-alerts";
import {
	encryptTelegramOwnerAlertBotToken,
	loadTelegramOwnerAlertSettings,
	OwnerAlertError,
	ownerAlertErrorCode,
	recordTelegramOwnerAlertResult,
	resolveTelegramOwnerAlertCredentials,
	sendTelegramOwnerAlertText,
	type TelegramOwnerAlertCredentials,
	telegramOwnerAlertSettingKeys,
	telegramOwnerAlertSettingsInputSchema,
	verifyTelegramOwnerAlertChat,
} from "./owner-alerts";
import { synchronizeSupportAdministrators } from "./support-admins";
import { synchronizeTelegramBot, telegramRuntime } from "./sync";

export const getTelegramSettingsFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const { db } = await telegramAdminContext("read");
		const { runtime, settings, provider } = await telegramRuntime(db);
		const webhookUrl = safeWebhookUrl(runtime.betterAuthUrl);
		const [counts, webhookHealth, feishuAlerts, ownerTelegramAlerts] =
			await Promise.all([
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
				loadFeishuAlertSettings(db),
				loadTelegramOwnerAlertSettings(db),
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
			feishuAlerts,
			ownerTelegramAlerts,
		};
	},
);

export const saveFeishuAlertSettingsFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof feishuAlertSettingsInputSchema>) =>
		feishuAlertSettingsInputSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await telegramAdminContext("update");
		const { db } = context;
		const stored = await resolveFeishuAlertCredentials(db, {
			requireEnabled: false,
		}).catch((error) => {
			if (error instanceof FeishuAlertError) return null;
			throw error;
		});
		const candidate =
			data.appId && data.chatId && (data.appSecret || stored?.appSecret)
				? {
						appId: data.appId,
						chatId: data.chatId,
						appSecret: data.appSecret ?? stored?.appSecret ?? "",
					}
				: null;
		if (data.enabled && !candidate)
			throw new DomainError(
				"feishu_configuration_required",
				400,
				"Feishu App ID, App Secret, and Chat ID are required",
			);
		if (data.enabled && candidate) {
			try {
				await verifyFeishuAppBot(candidate);
			} catch (error) {
				throw new DomainError(
					error instanceof FeishuAlertError
						? error.code
						: "feishu_validation_failed",
					409,
					"Feishu application bot validation failed",
				);
			}
		}
		const now = Date.now();
		await db.batch([
			upsertFeishuAlertSetting(
				db,
				feishuAlertSettingKeys.enabled,
				data.enabled,
				now,
			),
			upsertFeishuAlertSetting(
				db,
				feishuAlertSettingKeys.appId,
				data.appId,
				now,
			),
			upsertFeishuAlertSetting(
				db,
				feishuAlertSettingKeys.chatId,
				data.chatId,
				now,
			),
			...(data.appSecret
				? [
						upsertFeishuAlertSetting(
							db,
							feishuAlertSettingKeys.appSecret,
							await encryptFeishuAppSecret(db, data.appSecret),
							now,
							true,
						),
					]
				: []),
			auditStatement(context, "telegram.feishu_alerts.updated", now, {
				enabled: data.enabled,
				appIdConfigured: Boolean(data.appId),
				appSecretConfigured: Boolean(data.appSecret || stored?.appSecret),
				chatIdConfigured: Boolean(data.chatId),
			}),
		]);
		return { saved: true };
	});

export const testFeishuAlertFn = createServerFn({ method: "POST" })
	.validator(() => undefined)
	.handler(async () => {
		const context = await telegramAdminContext("update");
		const credentials = await resolveFeishuAlertCredentials(context.db, {
			requireEnabled: false,
		});
		if (!credentials)
			throw new DomainError(
				"feishu_configuration_required",
				400,
				"Feishu application bot configuration is required",
			);
		try {
			await sendFeishuText(
				credentials,
				`✅ 网页客服飞书提醒测试\n时间：${new Intl.DateTimeFormat("zh-CN", {
					timeZone: "Asia/Shanghai",
					dateStyle: "medium",
					timeStyle: "short",
				}).format(Date.now())}（北京时间）\n结果：飞书通道已连通。`,
			);
			await recordFeishuAlertResult(context.db, { sent: true });
			await auditStatement(
				context,
				"telegram.feishu_alerts.tested",
				Date.now(),
				{ sent: true },
			).run();
			return { sent: true };
		} catch (error) {
			const code =
				error instanceof FeishuAlertError
					? error.code
					: "feishu_delivery_failed";
			await recordFeishuAlertResult(context.db, {
				sent: false,
				errorCode: code,
			});
			throw new DomainError(code, 409, "Feishu test delivery failed");
		}
	});

async function storedTelegramOwnerAlertCredentials(db: D1Database) {
	return resolveTelegramOwnerAlertCredentials(db, {
		requireEnabled: false,
	}).catch((error) => {
		if (error instanceof OwnerAlertError) return null;
		throw error;
	});
}

async function verifiedTelegramOwnerAlertChat(
	credentials: TelegramOwnerAlertCredentials,
) {
	try {
		return await verifyTelegramOwnerAlertChat(credentials);
	} catch (error) {
		throw new DomainError(
			ownerAlertErrorCode(error),
			409,
			"Telegram owner alert chat verification failed",
		);
	}
}

export const saveTelegramOwnerAlertSettingsFn = createServerFn({
	method: "POST",
})
	.validator((input: z.input<typeof telegramOwnerAlertSettingsInputSchema>) =>
		telegramOwnerAlertSettingsInputSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await telegramAdminContext("update");
		const { db } = context;
		const stored = await storedTelegramOwnerAlertCredentials(db);
		const botToken = data.botToken ?? stored?.botToken;
		const candidate =
			data.chatId && botToken ? { chatId: data.chatId, botToken } : null;
		if (data.enabled && !candidate)
			throw new DomainError(
				"telegram_alert_configuration_required",
				400,
				"Telegram bot token and chat ID are required",
			);
		if (data.enabled && candidate)
			await verifiedTelegramOwnerAlertChat(candidate);
		const now = Date.now();
		await db.batch([
			upsertFeishuAlertSetting(
				db,
				telegramOwnerAlertSettingKeys.enabled,
				data.enabled,
				now,
			),
			upsertFeishuAlertSetting(
				db,
				telegramOwnerAlertSettingKeys.chatId,
				data.chatId,
				now,
			),
			...(data.botToken
				? [
						upsertFeishuAlertSetting(
							db,
							telegramOwnerAlertSettingKeys.botToken,
							await encryptTelegramOwnerAlertBotToken(db, data.botToken),
							now,
							true,
						),
					]
				: []),
			auditStatement(context, "telegram.owner_alerts.updated", now, {
				enabled: data.enabled,
				botTokenConfigured: Boolean(botToken),
				botTokenChanged: Boolean(data.botToken),
				chatIdConfigured: Boolean(data.chatId),
			}),
		]);
		return { saved: true };
	});

async function requireStoredTelegramOwnerAlertCredentials(db: D1Database) {
	const credentials = await storedTelegramOwnerAlertCredentials(db);
	if (!credentials)
		throw new DomainError(
			"telegram_alert_configuration_required",
			400,
			"Telegram bot token and chat ID are required",
		);
	return credentials;
}

export const verifyTelegramOwnerAlertFn = createServerFn({ method: "POST" })
	.validator(() => undefined)
	.handler(async () => {
		const context = await telegramAdminContext("update");
		const credentials = await requireStoredTelegramOwnerAlertCredentials(
			context.db,
		);
		const chat = await verifiedTelegramOwnerAlertChat(credentials);
		await auditStatement(
			context,
			"telegram.owner_alerts.verified",
			Date.now(),
			{ type: chat.type },
		).run();
		return chat;
	});

export const testTelegramOwnerAlertFn = createServerFn({ method: "POST" })
	.validator(() => undefined)
	.handler(async () => {
		const context = await telegramAdminContext("update");
		const credentials = await requireStoredTelegramOwnerAlertCredentials(
			context.db,
		);
		try {
			await sendTelegramOwnerAlertText(
				credentials,
				`✅ 老板提醒测试\n时间：${new Intl.DateTimeFormat("zh-CN", {
					timeZone: "Asia/Shanghai",
					dateStyle: "medium",
					timeStyle: "short",
				}).format(Date.now())}（北京时间）\n结果：Telegram 私密群已连通。`,
			);
		} catch (error) {
			const code = ownerAlertErrorCode(error);
			await recordTelegramOwnerAlertResult(context.db, {
				sent: false,
				errorCode: code,
			});
			throw new DomainError(code, 409, "Telegram test delivery failed");
		}
		await recordTelegramOwnerAlertResult(context.db, { sent: true });
		await auditStatement(context, "telegram.owner_alerts.tested", Date.now(), {
			sent: true,
		}).run();
		return { sent: true };
	});

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
				throw new DomainError(
					error instanceof Error ? error.message : "telegram_support_invalid",
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
			context.request.headers.get("cf-connecting-ip"),
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
