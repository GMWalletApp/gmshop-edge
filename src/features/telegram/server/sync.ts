import { Api, GrammyError } from "grammy";
import { loadRuntimeAuthProviders } from "#/features/auth/server/provider-runtime";
import type { SupportedLocale } from "#/lib/locales";
import { isSafeWebhookUrl } from "#/lib/webhook-url";
import { m } from "#/paraglide/messages";
import { loadRuntimeConfig } from "#/server/runtime-config";
import {
	loadTelegramSettings,
	telegramSettingKeys,
	upsertTelegramSetting,
} from "../settings";
import {
	deriveTelegramWebhookSecret,
	telegramWebhookSigningKeyId,
} from "./secret";

const retryDelays = [60_000, 300_000, 900_000, 3_600_000] as const;
export const telegramCommandVersion = "v1.1";

export async function synchronizeTelegramBot(
	db: D1Database,
	options: { manual?: boolean; now?: number } = {},
) {
	const now = options.now ?? Date.now();
	const runtime = await loadRuntimeConfig(db);
	const settings = await loadTelegramSettings(db);
	if (!options.manual && !settings.autoSyncEnabled) return { skipped: true };
	if (!options.manual && settings.nextRetryAt && settings.nextRetryAt > now)
		return { skipped: true };
	const provider = (
		await loadRuntimeAuthProviders(db, runtime.authProviderSecret)
	).find((entry) => entry.providerId === "telegram");
	if (
		!provider?.telegramBotToken ||
		!provider.telegramBotUserId ||
		!provider.telegramMiniAppEnabled ||
		!runtime.dataEncryptionSecret ||
		!runtime.automationCallbackSecret ||
		!isPublicHttpsOrigin(runtime.betterAuthUrl)
	) {
		await storeSyncFailure(
			db,
			"dependency_unavailable",
			settings.syncAttempts,
			now,
		);
		return { synchronized: false, code: "dependency_unavailable" };
	}
	await db.batch([
		upsertTelegramSetting(db, telegramSettingKeys.status, "syncing", now),
		upsertTelegramSetting(db, telegramSettingKeys.lastErrorCode, null, now),
	]);
	try {
		const api = new Api(provider.telegramBotToken);
		const bot = await api.getMe();
		if (String(bot.id) !== provider.telegramBotUserId)
			throw new Error("telegram_bot_identity_changed");
		const origin = new URL(runtime.betterAuthUrl).origin;
		const secret = await deriveTelegramWebhookSecret(
			runtime.automationCallbackSecret,
			provider.telegramBotUserId,
			provider.revision,
		);
		await setCommands(api);
		await api.setChatMenuButton({
			menu_button: { type: "commands" },
		});
		await api.setWebhook(`${origin}/api/telegram/webhook`, {
			secret_token: secret,
			allowed_updates: [
				"message",
				"callback_query",
				"chat_member",
				"my_chat_member",
			],
		});
		await db.batch([
			upsertTelegramSetting(db, telegramSettingKeys.status, "active", now),
			upsertTelegramSetting(
				db,
				telegramSettingKeys.syncedRevision,
				provider.revision,
				now,
			),
			upsertTelegramSetting(
				db,
				telegramSettingKeys.syncedBotUserId,
				provider.telegramBotUserId,
				now,
			),
			upsertTelegramSetting(
				db,
				telegramSettingKeys.syncedBotName,
				bot.first_name,
				now,
			),
			upsertTelegramSetting(
				db,
				telegramSettingKeys.syncedDataKeyId,
				await telegramWebhookSigningKeyId(runtime.automationCallbackSecret),
				now,
			),
			upsertTelegramSetting(db, telegramSettingKeys.syncedOrigin, origin, now),
			upsertTelegramSetting(
				db,
				telegramSettingKeys.syncedCommandVersion,
				telegramCommandVersion,
				now,
			),
			upsertTelegramSetting(db, telegramSettingKeys.lastSyncedAt, now, now),
			upsertTelegramSetting(
				db,
				telegramSettingKeys.lastAutoSyncCheckAt,
				now,
				now,
			),
			upsertTelegramSetting(db, telegramSettingKeys.syncAttempts, 0, now),
			upsertTelegramSetting(db, telegramSettingKeys.nextRetryAt, null, now),
		]);
		return {
			synchronized: true,
			botName: bot.first_name,
			username: bot.username,
		};
	} catch (error) {
		const code = syncErrorCode(error);
		await storeSyncFailure(db, code, settings.syncAttempts, now);
		return { synchronized: false, code };
	}
}

function syncErrorCode(error: unknown) {
	if (
		error instanceof Error &&
		error.message === "telegram_bot_identity_changed"
	)
		return "telegram_bot_identity_changed";
	if (error instanceof GrammyError) {
		if (error.error_code === 401) return "telegram_bot_token_invalid";
		if (error.error_code === 400) return "telegram_request_rejected";
	}
	return "sync_failed";
}

export async function telegramRuntime(db: D1Database) {
	const runtime = await loadRuntimeConfig(db);
	const settings = await loadTelegramSettings(db);
	const provider = (
		await loadRuntimeAuthProviders(db, runtime.authProviderSecret)
	).find((entry) => entry.providerId === "telegram");
	return { runtime, settings, provider };
}

export function miniAppUrl(
	origin: string,
	target: "shop" | "orders" | "account",
) {
	const path = {
		shop: "/",
		orders: "/account/orders",
		account: "/account/settings",
	}[target];
	return new URL(path, origin).toString();
}

const botCommandDescriptions = {
	start: m.telegram_bot_command_start,
	support: m.telegram_bot_command_support,
	close: m.telegram_bot_command_close,
	language: m.telegram_bot_command_language,
	help: m.telegram_bot_command_help,
} as const;

/** Telegram `language_code` values that receive a localized command list. */
const botCommandLanguages = [
	{ locale: "en-US", languageCode: "en" },
	{ locale: "zh-CN", languageCode: "zh" },
] as const satisfies ReadonlyArray<{
	locale: SupportedLocale;
	languageCode: string;
}>;

export function telegramBotCommands(locale: SupportedLocale) {
	return Object.entries(botCommandDescriptions).map(
		([command, description]) => ({
			command,
			description: description({}, { locale }),
		}),
	);
}

async function setCommands(api: Api) {
	const scope = { type: "all_private_chats" } as const;
	await api.setMyCommands(telegramBotCommands("en-US"), { scope });
	for (const { locale, languageCode } of botCommandLanguages)
		await api.setMyCommands(telegramBotCommands(locale), {
			scope,
			language_code: languageCode,
		});
}

/**
 * Maps a support-chat validation failure to a fixed, localizable code. The
 * upstream Telegram description is only ever emitted through
 * {@link logTelegramFailure}.
 */
export function supportChatErrorCode(error: unknown) {
	if (error instanceof GrammyError) {
		if (error.error_code === 401) return "telegram_bot_token_invalid";
		if (/chat not found/i.test(error.description))
			return "telegram_support_chat_not_found";
		if (
			error.error_code === 403 ||
			/not a member|was kicked|was blocked/i.test(error.description)
		)
			return "telegram_bot_not_in_chat";
		return "telegram_request_rejected";
	}
	const message = error instanceof Error ? error.message : "";
	if (message === "support_chat_not_forum") return "telegram_support_not_forum";
	if (message === "bot_cannot_manage_topics")
		return "telegram_bot_cannot_manage_topics";
	if (message === "telegram_support_dependency_unavailable") return message;
	return "telegram_support_invalid";
}

const botTokenPattern = /\d{5,}:[A-Za-z0-9_-]{20,}/g;

/** Structured server log for a failed Telegram request; never includes the bot token. */
export function logTelegramFailure(
	event: string,
	code: string,
	error: unknown,
) {
	const upstream =
		error instanceof GrammyError
			? {
					method: error.method,
					errorCode: error.error_code,
					description: error.description,
				}
			: error instanceof Error
				? {
						name: error.name,
						message: error.message.replaceAll(botTokenPattern, "[redacted]"),
					}
				: { name: typeof error };
	console.warn(JSON.stringify({ event, code, upstream }));
}

async function storeSyncFailure(
	db: D1Database,
	code: string,
	attempts: number,
	now: number,
) {
	const nextAttempts = Math.min(attempts + 1, retryDelays.length);
	const delay =
		retryDelays[Math.min(attempts, retryDelays.length - 1)] ?? 3_600_000;
	await db.batch([
		upsertTelegramSetting(
			db,
			telegramSettingKeys.status,
			code === "dependency_unavailable" ? code : "sync_failed",
			now,
		),
		upsertTelegramSetting(db, telegramSettingKeys.lastErrorCode, code, now),
		upsertTelegramSetting(
			db,
			telegramSettingKeys.syncAttempts,
			nextAttempts,
			now,
		),
		upsertTelegramSetting(
			db,
			telegramSettingKeys.nextRetryAt,
			now + delay,
			now,
		),
	]);
}

function isPublicHttpsOrigin(value: string) {
	try {
		const url = new URL(value);
		return (
			url.origin === value.replace(/\/$/, "") && isSafeWebhookUrl(url.origin)
		);
	} catch {
		return false;
	}
}
