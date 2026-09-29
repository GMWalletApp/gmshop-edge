import { Api } from "grammy";
import type { SupportedLocale } from "#/lib/locales";
import { m } from "#/paraglide/messages";
import { telegramSettingKeys, upsertTelegramSetting } from "../settings";
import { telegramWebhookSigningKeyId } from "./secret";
import { synchronizeSupportAdministrators } from "./support-admins";
import {
	logTelegramFailure,
	supportChatErrorCode,
	synchronizeTelegramBot,
	telegramCommandVersion,
	telegramRuntime,
} from "./sync";
import { webSupportRetentionMs } from "./web-support";

export async function runTelegramMaintenance(db: D1Database, now = Date.now()) {
	const sync = await reconcileBot(db, now);
	const { settings, provider } = await telegramRuntime(db);
	let administratorSync: unknown = { skipped: true };
	if (
		settings.supportChatId &&
		(settings.supportEnabled ||
			settings.webSupportEnabled ||
			(await activeConversationCount(db)) > 0)
	) {
		try {
			administratorSync = await synchronizeSupportAdministrators(db, now);
		} catch (error) {
			const code = supportChatErrorCode(error);
			logTelegramFailure("telegram_administrator_sync_failed", code, error);
			administratorSync = { failed: true, code };
		}
	}
	let idleClosed = 0;
	let webIdleClosed = 0;
	if (provider?.telegramBotToken && settings.supportChatId) {
		idleClosed = await closeIdleConversations(
			db,
			new Api(provider.telegramBotToken),
			settings.idleTimeoutMs,
			now,
		);
		webIdleClosed = await closeIdleWebConversations(
			db,
			new Api(provider.telegramBotToken),
			settings.idleTimeoutMs,
			now,
		);
	}
	const webCleanup = await cleanupWebSupport(db, now);
	return { sync, administratorSync, idleClosed, webIdleClosed, webCleanup };
}

async function reconcileBot(db: D1Database, now: number) {
	const { runtime, settings, provider } = await telegramRuntime(db);
	if (!settings.autoSyncEnabled) return { skipped: true };
	if (
		settings.status === "active" &&
		settings.lastAutoSyncCheckAt &&
		settings.lastAutoSyncCheckAt > now - settings.autoSyncIntervalMs
	)
		return { skipped: true };
	const dataKeyId = runtime.automationCallbackSecret
		? await telegramWebhookSigningKeyId(runtime.automationCallbackSecret)
		: null;
	const origin = safeOrigin(runtime.betterAuthUrl);
	const pending =
		settings.status !== "active" ||
		settings.syncedRevision !== provider?.revision ||
		settings.syncedBotUserId !== provider?.telegramBotUserId ||
		settings.syncedDataKeyId !== dataKeyId ||
		settings.syncedOrigin !== origin ||
		settings.syncedCommandVersion !== telegramCommandVersion;
	if (!pending) {
		await upsertTelegramSetting(
			db,
			telegramSettingKeys.lastAutoSyncCheckAt,
			now,
			now,
		).run();
		return { skipped: true };
	}
	if (settings.status === "active")
		await upsertTelegramSetting(
			db,
			telegramSettingKeys.status,
			"pending_sync",
			now,
		).run();
	return synchronizeTelegramBot(db, { now });
}

async function closeIdleConversations(
	db: D1Database,
	api: Api,
	idleTimeoutMs: number,
	now: number,
) {
	const cutoff = now - idleTimeoutMs;
	const rows = await db
		.prepare(
			`SELECT c.id, c.support_chat_id, c.customer_chat_id, c.message_thread_id,
			 u.preferred_locale
			 FROM telegram_support_conversations c
			 JOIN users u ON u.id = c.user_id
			 WHERE c.status = 'active' AND c.last_activity_at <= ?
			 ORDER BY c.last_activity_at, c.id LIMIT 50`,
		)
		.bind(cutoff)
		.all<{
			id: string;
			support_chat_id: string;
			customer_chat_id: string;
			message_thread_id: number | null;
			preferred_locale: SupportedLocale;
		}>();
	let closed = 0;
	for (const conversation of rows.results) {
		if (!conversation.message_thread_id) continue;
		const claimed = await db
			.prepare(
				`UPDATE telegram_support_conversations SET status = 'closing', updated_at = ?
				 WHERE id = ? AND status = 'active' AND last_activity_at <= ?`,
			)
			.bind(now, conversation.id, cutoff)
			.run();
		if (Number(claimed.meta.changes ?? 0) !== 1) continue;
		const locale = normalizeLocale(conversation.preferred_locale);
		try {
			await api.sendMessage(
				conversation.support_chat_id,
				m.telegram_support_topic_closed({}, { locale }),
				{ message_thread_id: conversation.message_thread_id },
			);
			await api.closeForumTopic(
				conversation.support_chat_id,
				conversation.message_thread_id,
			);
			const completed = await db
				.prepare(
					`UPDATE telegram_support_conversations SET status = 'closed',
					 closed_at = ?, closed_reason = 'idle_timeout', updated_at = ?
					 WHERE id = ? AND status = 'closing'`,
				)
				.bind(now, now, conversation.id)
				.run();
			if (Number(completed.meta.changes ?? 0) === 1) {
				await api.sendMessage(
					conversation.customer_chat_id,
					m.telegram_support_idle_closed({}, { locale }),
				);
				closed += 1;
			} else {
				await api
					.reopenForumTopic(
						conversation.support_chat_id,
						conversation.message_thread_id,
					)
					.catch(() => undefined);
			}
		} catch {
			await db
				.prepare(
					`UPDATE telegram_support_conversations SET status = 'active', updated_at = ?
					 WHERE id = ? AND status = 'closing'`,
				)
				.bind(now, conversation.id)
				.run();
		}
	}
	return closed;
}

async function activeConversationCount(db: D1Database) {
	const row = await db
		.prepare(
			`SELECT
			 (SELECT count(*) FROM telegram_support_conversations WHERE status = 'active') +
			 (SELECT count(*) FROM telegram_web_support_conversations WHERE status = 'active') AS count`,
		)
		.first<{ count: number }>();
	return Number(row?.count ?? 0);
}

async function closeIdleWebConversations(
	db: D1Database,
	api: Api,
	idleTimeoutMs: number,
	now: number,
) {
	const cutoff = now - idleTimeoutMs;
	const rows = await db
		.prepare(
			`SELECT id, support_chat_id, message_thread_id FROM telegram_web_support_conversations
		 WHERE status = 'active' AND last_activity_at <= ?
		 ORDER BY last_activity_at, id LIMIT 50`,
		)
		.bind(cutoff)
		.all<{
			id: string;
			support_chat_id: string;
			message_thread_id: number | null;
		}>();
	let closed = 0;
	for (const conversation of rows.results) {
		if (!conversation.message_thread_id) continue;
		const claim = await db
			.prepare(
				`UPDATE telegram_web_support_conversations SET status = 'closing', updated_at = ?
			 WHERE id = ? AND status = 'active' AND last_activity_at <= ?`,
			)
			.bind(now, conversation.id, cutoff)
			.run();
		if (Number(claim.meta.changes ?? 0) !== 1) continue;
		try {
			await api.sendMessage(
				conversation.support_chat_id,
				"Web support conversation closed after inactivity.",
				{
					message_thread_id: conversation.message_thread_id,
				},
			);
			await api.closeForumTopic(
				conversation.support_chat_id,
				conversation.message_thread_id,
			);
			await db
				.prepare(
					`UPDATE telegram_web_support_conversations SET status = 'closed', closed_reason = 'idle_timeout',
				 fingerprint_hash = NULL, closed_at = ?, updated_at = ? WHERE id = ? AND status = 'closing'`,
				)
				.bind(now, now, conversation.id)
				.run();
			closed += 1;
		} catch {
			await db
				.prepare(
					`UPDATE telegram_web_support_conversations SET status = 'active', updated_at = ?
				 WHERE id = ? AND status = 'closing'`,
				)
				.bind(now, conversation.id)
				.run();
		}
	}
	return closed;
}

/**
 * Bounded retention sweep for web-support runtime rows. Device-fingerprint
 * hashes are cleared when a conversation closes; this sweep also clears them
 * for conversations idle beyond the retention window regardless of status.
 */
export async function cleanupWebSupport(db: D1Database, now: number) {
	const cutoff = now - webSupportRetentionMs;
	const [replies, sends, fingerprints] = await db.batch([
		db
			.prepare(
				`DELETE FROM telegram_web_support_replies WHERE id IN (
			 SELECT id FROM telegram_web_support_replies WHERE expires_at <= ?
			 ORDER BY expires_at, id LIMIT 500)`,
			)
			.bind(now),
		db
			.prepare(
				`DELETE FROM telegram_web_support_sends WHERE id IN (
			 SELECT id FROM telegram_web_support_sends WHERE created_at <= ?
			 ORDER BY created_at, id LIMIT 500)`,
			)
			.bind(cutoff),
		db
			.prepare(
				`UPDATE telegram_web_support_conversations SET fingerprint_hash = NULL, updated_at = ?
			 WHERE id IN (
			 SELECT id FROM telegram_web_support_conversations
			 WHERE status IN ('creating', 'active', 'closing')
			 AND fingerprint_hash IS NOT NULL AND coalesce(last_activity_at, created_at) <= ?
			 ORDER BY id LIMIT 500)`,
			)
			.bind(now, cutoff),
	]);
	return {
		replies: Number(replies?.meta.changes ?? 0),
		sends: Number(sends?.meta.changes ?? 0),
		fingerprints: Number(fingerprints?.meta.changes ?? 0),
	};
}

function safeOrigin(value: string) {
	try {
		return new URL(value).origin;
	} catch {
		return null;
	}
}

function normalizeLocale(value: string): SupportedLocale {
	return value === "zh-CN" ? "zh-CN" : "en-US";
}
