import { settingsErrorMessage } from "#/features/settings/error-message";
import { m } from "#/paraglide/messages";

const labels: Record<string, () => string> = {
	dependency_unavailable: m.telegram_error_dependency_unavailable,
	sync_failed: m.telegram_status_failed,
	telegram_sync_failed: m.telegram_status_failed,
	telegram_bot_identity_changed: m.telegram_error_identity_changed,
	telegram_bot_token_invalid: m.telegram_error_token_invalid,
	telegram_request_rejected: m.telegram_error_request_rejected,
	telegram_active_conversations: m.telegram_chat_locked_by_active_conversations,
	telegram_support_chat_not_found: m.telegram_error_support_chat_not_found,
	telegram_support_not_forum: m.telegram_error_support_not_forum,
	telegram_bot_cannot_manage_topics: m.telegram_error_bot_cannot_manage_topics,
	telegram_bot_not_in_chat: m.telegram_error_bot_not_in_chat,
	telegram_support_dependency_unavailable:
		m.telegram_error_support_dependency_unavailable,
	telegram_support_invalid: m.telegram_error_support_invalid,
};

/** Label for a stored Telegram error code, such as the last synchronization error. */
export function telegramErrorLabel(code: string | null | undefined) {
	if (!code) return undefined;
	return labels[code]?.() ?? m.telegram_status_failed();
}

/** Message for a failed Telegram administration request. */
export function telegramErrorMessage(error: unknown) {
	const code =
		error && typeof error === "object" && "code" in error
			? error.code
			: undefined;
	return (
		(typeof code === "string" ? labels[code]?.() : undefined) ??
		settingsErrorMessage(error)
	);
}
