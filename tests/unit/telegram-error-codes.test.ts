import { GrammyError } from "grammy";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	telegramErrorLabel,
	telegramErrorMessage,
} from "#/features/telegram/error-message";
import { TelegramSupportConfigurationError } from "#/features/telegram/server/support-admins";
import {
	logTelegramFailure,
	supportChatErrorCode,
	telegramBotCommands,
} from "#/features/telegram/server/sync";
import { m } from "#/paraglide/messages";

function grammyError(
	errorCode: number,
	description: string,
	method = "getChat",
) {
	return new GrammyError(
		`Call to '${method}' failed! (${errorCode}: ${description})`,
		{ ok: false, error_code: errorCode, description },
		method,
		{ chat_id: "-1001234567890" },
	);
}

describe("Telegram support chat error codes", () => {
	afterEach(() => vi.restoreAllMocks());

	it("maps upstream Telegram failures to fixed codes", () => {
		expect(
			supportChatErrorCode(grammyError(400, "Bad Request: chat not found")),
		).toBe("telegram_support_chat_not_found");
		expect(
			supportChatErrorCode(
				grammyError(
					403,
					"Forbidden: bot is not a member of the supergroup chat",
				),
			),
		).toBe("telegram_bot_not_in_chat");
		expect(
			supportChatErrorCode(grammyError(401, "Unauthorized", "getMe")),
		).toBe("telegram_bot_token_invalid");
		expect(
			supportChatErrorCode(
				grammyError(400, "Bad Request: CHAT_ADMIN_REQUIRED"),
			),
		).toBe("telegram_request_rejected");
		expect(
			supportChatErrorCode(
				new TelegramSupportConfigurationError("support_chat_not_forum"),
			),
		).toBe("telegram_support_not_forum");
		expect(
			supportChatErrorCode(
				new TelegramSupportConfigurationError("bot_cannot_manage_topics"),
			),
		).toBe("telegram_bot_cannot_manage_topics");
		expect(
			supportChatErrorCode(
				new Error("telegram_support_dependency_unavailable"),
			),
		).toBe("telegram_support_dependency_unavailable");
		expect(supportChatErrorCode(new TypeError("fetch failed"))).toBe(
			"telegram_support_invalid",
		);
		expect(supportChatErrorCode("boom")).toBe("telegram_support_invalid");
	});

	it("never forwards the upstream description as a code", () => {
		const description = "Bad Request: chat not found";
		for (const code of [
			supportChatErrorCode(grammyError(400, description)),
			supportChatErrorCode(grammyError(420, "Flood control exceeded")),
		]) {
			expect(code).toMatch(/^telegram_[a-z_]+$/);
			expect(code).not.toContain(description);
		}
	});

	it("logs the upstream description as structured JSON without bot tokens", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		logTelegramFailure(
			"telegram_support_chat_validation_failed",
			"telegram_support_chat_not_found",
			grammyError(400, "Bad Request: chat not found"),
		);
		logTelegramFailure(
			"telegram_administrator_sync_failed",
			"telegram_support_invalid",
			new Error(
				"request to https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/getChat failed",
			),
		);
		expect(warn).toHaveBeenCalledTimes(2);
		const [first, second] = warn.mock.calls.map(
			([entry]) => JSON.parse(String(entry)) as Record<string, unknown>,
		);
		expect(first).toEqual({
			event: "telegram_support_chat_validation_failed",
			code: "telegram_support_chat_not_found",
			upstream: {
				method: "getChat",
				errorCode: 400,
				description: "Bad Request: chat not found",
			},
		});
		expect(JSON.stringify(second)).not.toContain(
			"AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw",
		);
		expect(JSON.stringify(second)).toContain("[redacted]");
	});

	it("localizes every fixed code on the client", () => {
		const codes = [
			"telegram_support_chat_not_found",
			"telegram_support_not_forum",
			"telegram_bot_cannot_manage_topics",
			"telegram_bot_not_in_chat",
			"telegram_bot_token_invalid",
			"telegram_request_rejected",
			"telegram_support_dependency_unavailable",
			"telegram_support_invalid",
			"telegram_active_conversations",
			"telegram_bot_identity_changed",
			"dependency_unavailable",
			"telegram_sync_failed",
		];
		for (const code of codes) {
			const message = telegramErrorMessage({ code, status: 409 });
			expect(message, code).not.toBe(m.settings_save_failed());
			expect(message, code).toBe(telegramErrorLabel(code));
		}
		expect(telegramErrorMessage(new Error("boom"))).toBe(
			m.settings_save_failed(),
		);
		expect(telegramErrorMessage({ code: "site_asset_too_large" })).toBe(
			m.settings_error_asset_too_large(),
		);
		expect(telegramErrorLabel(undefined)).toBeUndefined();
		expect(telegramErrorLabel("something_new")).toBe(
			m.telegram_status_failed(),
		);
	});
});

describe("Telegram bot commands", () => {
	it("renders per-language descriptions from Paraglide", () => {
		const english = telegramBotCommands("en-US");
		const chinese = telegramBotCommands("zh-CN");
		expect(english.map((entry) => entry.command)).toEqual([
			"start",
			"support",
			"close",
			"language",
			"help",
		]);
		expect(chinese.map((entry) => entry.command)).toEqual(
			english.map((entry) => entry.command),
		);
		expect(
			english.find((entry) => entry.command === "support")?.description,
		).toBe("Contact support");
		expect(
			chinese.find((entry) => entry.command === "support")?.description,
		).toBe("联系客服");
		for (const entry of [...english, ...chinese]) {
			expect(entry.description.length).toBeGreaterThanOrEqual(1);
			expect(entry.description.length).toBeLessThanOrEqual(256);
		}
	});
});
