import { z } from "zod";
import { decryptSecret, encryptSecret } from "#/lib/secrets";
import { loadRuntimeConfig } from "#/server/runtime-config";
import {
	FeishuAlertError,
	recordFeishuAlertResult,
	resolveFeishuAlertCredentials,
	sendFeishuText,
	upsertFeishuAlertSetting,
} from "./feishu-alerts";

/**
 * Owner/operations alert channel. Telegram (a private group) is the primary
 * destination; Feishu is used only while Telegram alerts are disabled, so one
 * alert never reaches both.
 */

export const telegramOwnerAlertBotTokenPurpose =
	"telegram-owner-alerts:bot-token" as const;

export const telegramOwnerAlertSettingKeys = {
	enabled: "telegram.owner_alerts.enabled",
	botToken: "telegram.owner_alerts.bot_token",
	chatId: "telegram.owner_alerts.chat_id",
	lastSentAt: "telegram.owner_alerts.last_sent_at",
	lastErrorCode: "telegram.owner_alerts.last_error_code",
} as const;

const botTokenPattern = /^\d{5,16}:[A-Za-z0-9_-]{30,80}$/;
const chatIdPattern = /^-?[1-9]\d{4,19}$/;

export const telegramOwnerAlertSettingsInputSchema = z.object({
	enabled: z.boolean(),
	botToken: z.string().trim().regex(botTokenPattern).optional(),
	chatId: z.string().trim().regex(chatIdPattern).nullable(),
});

export const telegramMessageLimit = 4_096;
const telegramApiBase = "https://api.telegram.org";
const requestTimeoutMs = 8_000;

const apiResponseSchema = z.object({
	ok: z.boolean(),
	error_code: z.number().int().optional(),
	result: z.unknown().optional(),
});

const chatSchema = z.object({
	id: z.number().int(),
	type: z.string(),
	title: z.string().optional(),
});

type Fetcher = typeof fetch;
export type TelegramOwnerAlertCredentials = {
	botToken: string;
	chatId: string;
};
export type OwnerAlertChannel = "telegram" | "feishu";

/** Structured, token-free error: the message is only the code. */
export class OwnerAlertError extends Error {
	constructor(readonly code: string) {
		super(code);
	}
}

export async function loadTelegramOwnerAlertSettings(db: D1Database) {
	const values = await loadSettingValues(db);
	return {
		enabled: values.get(telegramOwnerAlertSettingKeys.enabled) === true,
		chatId: nullableString(values.get(telegramOwnerAlertSettingKeys.chatId)),
		hasBotToken:
			typeof values.get(telegramOwnerAlertSettingKeys.botToken) === "string",
		lastSentAt: nullableInteger(
			values.get(telegramOwnerAlertSettingKeys.lastSentAt),
		),
		lastErrorCode: nullableString(
			values.get(telegramOwnerAlertSettingKeys.lastErrorCode),
		),
	};
}

/**
 * Returns `null` when Telegram alerts are disabled (or, with
 * `requireEnabled: false`, not fully configured). An enabled but incomplete
 * channel is an error, never a silent switch back to Feishu.
 */
export async function resolveTelegramOwnerAlertCredentials(
	db: D1Database,
	options: { requireEnabled?: boolean } = {},
): Promise<TelegramOwnerAlertCredentials | null> {
	const values = await loadSettingValues(db);
	const enabled = values.get(telegramOwnerAlertSettingKeys.enabled) === true;
	if (options.requireEnabled !== false && !enabled) return null;
	const chatId = nullableString(
		values.get(telegramOwnerAlertSettingKeys.chatId),
	);
	const encrypted = nullableString(
		values.get(telegramOwnerAlertSettingKeys.botToken),
	);
	if (!chatId || !encrypted) {
		if (enabled)
			throw new OwnerAlertError("telegram_alert_configuration_missing");
		return null;
	}
	const runtime = await loadRuntimeConfig(db);
	if (!runtime.integrationConfigSecret)
		throw new OwnerAlertError("telegram_alert_secret_unavailable");
	try {
		return {
			chatId,
			botToken: await decryptSecret(
				encrypted,
				runtime.integrationConfigSecret,
				telegramOwnerAlertBotTokenPurpose,
			),
		};
	} catch {
		throw new OwnerAlertError("telegram_alert_secret_invalid");
	}
}

export async function encryptTelegramOwnerAlertBotToken(
	db: D1Database,
	botToken: string,
) {
	const runtime = await loadRuntimeConfig(db);
	if (!runtime.integrationConfigSecret)
		throw new OwnerAlertError("telegram_alert_secret_unavailable");
	return encryptSecret(
		botToken,
		runtime.integrationConfigSecret,
		telegramOwnerAlertBotTokenPurpose,
	);
}

/** Splits text into Telegram-sized parts, preferring line boundaries. */
export function splitTelegramText(text: string, limit = telegramMessageLimit) {
	const parts: string[] = [];
	let rest = text;
	while (rest.length > limit) {
		let cut = rest.lastIndexOf("\n", limit);
		if (cut < limit / 2) {
			cut = limit;
			const code = rest.charCodeAt(cut - 1);
			if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
		}
		parts.push(rest.slice(0, cut));
		rest = rest.slice(rest[cut] === "\n" ? cut + 1 : cut);
	}
	if (rest.length > 0) parts.push(rest);
	return parts.filter((part) => part.trim().length > 0);
}

async function callTelegram(
	credentials: TelegramOwnerAlertCredentials,
	method: "sendMessage" | "getChat",
	body: Record<string, unknown>,
	request: Fetcher,
	failureCode: string,
) {
	// The URL embeds the bot token: it is never logged or put in an error.
	const response = await request(
		`${telegramApiBase}/bot${credentials.botToken}/${method}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json; charset=utf-8" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(requestTimeoutMs),
		},
	).catch(() => null);
	if (!response) throw new OwnerAlertError(failureCode);
	const payload = apiResponseSchema.safeParse(
		await response.json().catch(() => null),
	);
	if (!payload.success) throw new OwnerAlertError(failureCode);
	if (!payload.data.ok || !response.ok)
		throw new OwnerAlertError(
			payload.data.error_code
				? `telegram_alert_api_${payload.data.error_code}`
				: failureCode,
		);
	return payload.data.result;
}

export async function sendTelegramOwnerAlertText(
	credentials: TelegramOwnerAlertCredentials,
	text: string,
	request: Fetcher = fetch,
) {
	const parts = splitTelegramText(text);
	if (parts.length === 0)
		throw new OwnerAlertError("telegram_alert_empty_message");
	for (const part of parts)
		await callTelegram(
			credentials,
			"sendMessage",
			{
				chat_id: credentials.chatId,
				text: part,
				link_preview_options: { is_disabled: true },
			},
			request,
			"telegram_alert_delivery_failed",
		);
	return { sent: true as const, parts: parts.length };
}

export async function verifyTelegramOwnerAlertChat(
	credentials: TelegramOwnerAlertCredentials,
	request: Fetcher = fetch,
) {
	const result = chatSchema.safeParse(
		await callTelegram(
			credentials,
			"getChat",
			{ chat_id: credentials.chatId },
			request,
			"telegram_alert_chat_unavailable",
		),
	);
	if (!result.success)
		throw new OwnerAlertError("telegram_alert_chat_unavailable");
	return {
		verified: true as const,
		type: result.data.type,
		title: result.data.title?.slice(0, 128) ?? null,
	};
}

export async function recordTelegramOwnerAlertResult(
	db: D1Database,
	result: { sent: true } | { sent: false; errorCode: string },
) {
	const now = Date.now();
	await db.batch(
		result.sent
			? [
					upsertFeishuAlertSetting(
						db,
						telegramOwnerAlertSettingKeys.lastSentAt,
						now,
						now,
					),
					db
						.prepare("DELETE FROM system_settings WHERE key = ?")
						.bind(telegramOwnerAlertSettingKeys.lastErrorCode),
				]
			: [
					upsertFeishuAlertSetting(
						db,
						telegramOwnerAlertSettingKeys.lastErrorCode,
						result.errorCode.slice(0, 100),
						now,
					),
				],
	);
}

export function ownerAlertErrorCode(error: unknown) {
	if (error instanceof OwnerAlertError || error instanceof FeishuAlertError)
		return error.code;
	return "owner_alert_delivery_failed";
}

export type OwnerAlertOptions = {
	fetcher?: Fetcher;
	/** Feishu idempotency key; Telegram has no equivalent. */
	uuid?: string;
	/**
	 * Applies to the Feishu fallback only: `false` sends even when the Feishu
	 * web-support switch is off (each caller has its own event switch).
	 */
	requireFeishuEnabled?: boolean;
	/** Persist last sent / last error for the channel used. Default true. */
	record?: boolean;
};

/**
 * Sends one owner alert to exactly one channel. Telegram wins whenever it is
 * enabled; Feishu is used only while Telegram is disabled. Returns `null`
 * when no channel is configured (Feishu fallback without credentials).
 */
export async function sendOwnerAlert(
	db: D1Database,
	text: string,
	options: OwnerAlertOptions = {},
): Promise<{ channel: OwnerAlertChannel } | null> {
	const request = options.fetcher ?? fetch;
	const record = options.record !== false;
	// Resolution only returns null while Telegram is disabled; an enabled but
	// broken Telegram channel fails here instead of falling back to Feishu.
	let channel: OwnerAlertChannel = "telegram";
	try {
		const telegram = await resolveTelegramOwnerAlertCredentials(db);
		if (telegram) {
			await sendTelegramOwnerAlertText(telegram, text, request);
			if (record)
				await recordTelegramOwnerAlertResult(db, { sent: true }).catch(
					() => undefined,
				);
			return { channel };
		}
		channel = "feishu";
		const feishu = await resolveFeishuAlertCredentials(db, {
			requireEnabled: options.requireFeishuEnabled ?? false,
		});
		if (!feishu) return null;
		await sendFeishuText(feishu, text, request, options.uuid);
		if (record)
			await recordFeishuAlertResult(db, { sent: true }).catch(() => undefined);
		return { channel };
	} catch (error) {
		if (record) {
			const failure = {
				sent: false as const,
				errorCode: ownerAlertErrorCode(error),
			};
			await (channel === "telegram"
				? recordTelegramOwnerAlertResult(db, failure)
				: recordFeishuAlertResult(db, failure)
			).catch(() => undefined);
		}
		throw error;
	}
}

/** Like `sendOwnerAlert`, but a missing configuration is an error. */
export async function deliverOwnerAlert(
	db: D1Database,
	text: string,
	options: OwnerAlertOptions = {},
) {
	const result = await sendOwnerAlert(db, text, options);
	if (result) return result;
	const error = new OwnerAlertError("owner_alert_configuration_unavailable");
	if (options.record !== false)
		await recordFeishuAlertResult(db, {
			sent: false,
			errorCode: error.code,
		}).catch(() => undefined);
	throw error;
}

/** True when some owner alert destination could receive a message. */
export async function ownerAlertConfigured(db: D1Database) {
	if (await resolveTelegramOwnerAlertCredentials(db)) return true;
	return Boolean(
		await resolveFeishuAlertCredentials(db, { requireEnabled: false }),
	);
}

async function loadSettingValues(db: D1Database) {
	const keys = Object.values(telegramOwnerAlertSettingKeys);
	const rows = await db
		.prepare(
			`SELECT key, value FROM system_settings WHERE key IN (${keys.map(() => "?").join(", ")})`,
		)
		.bind(...keys)
		.all<{ key: string; value: string }>();
	return new Map(rows.results.map((row) => [row.key, parse(row.value)]));
}

function parse(value: string) {
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return undefined;
	}
}

function nullableString(value: unknown) {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function nullableInteger(value: unknown) {
	return typeof value === "number" && Number.isInteger(value) ? value : null;
}
