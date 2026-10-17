import { Miniflare } from "miniflare";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	encryptFeishuAppSecret,
	feishuAlertSettingKeys,
	upsertFeishuAlertSetting,
} from "#/features/telegram/server/feishu-alerts";
import {
	deliverOwnerAlert,
	encryptTelegramOwnerAlertBotToken,
	loadTelegramOwnerAlertSettings,
	OwnerAlertError,
	resolveTelegramOwnerAlertCredentials,
	sendOwnerAlert,
	splitTelegramText,
	telegramMessageLimit,
	telegramOwnerAlertSettingKeys,
	telegramOwnerAlertSettingsInputSchema,
	verifyTelegramOwnerAlertChat,
} from "#/features/telegram/server/owner-alerts";
import { createInitialRuntimeConfig } from "#/server/runtime-config";
import { applyMigrations } from "./migrations";

const botToken = "1234567890:AAtest-only-owner-alert-token_abcdefgh";
const chatId = "-5101401750";

type Call = { url: string; body: Record<string, unknown> };

function fakeFetch(
	telegramResponse: () => Response | Promise<Response> = () =>
		Response.json({ ok: true, result: { message_id: 1 } }),
) {
	const calls: Call[] = [];
	const fetcher = vi.fn(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
			if (url.startsWith("https://api.telegram.org/"))
				return telegramResponse();
			if (url.includes("tenant_access_token"))
				return Response.json({
					code: 0,
					tenant_access_token: "tenant-token",
					expire: 7200,
				});
			return Response.json({ code: 0, data: {} });
		},
	) as unknown as typeof fetch;
	return { calls, fetcher };
}

describe("owner alert routing", () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmshop-edge-owner-alerts" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await db
			.prepare(
				`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
				 VALUES ('runtime.data_encryption_secret', ?, 1, 1, 1)`,
			)
			.bind(JSON.stringify(createInitialRuntimeConfig().dataEncryptionSecret))
			.run();
	});

	afterAll(async () => miniflare.dispose());

	beforeEach(async () => {
		await db
			.prepare(
				"DELETE FROM system_settings WHERE key LIKE 'telegram.owner_alerts.%' OR key LIKE 'telegram.support.feishu_%'",
			)
			.run();
	});

	async function configureFeishu() {
		await db.batch([
			upsertFeishuAlertSetting(
				db,
				feishuAlertSettingKeys.appId,
				"cli_1234567890abcdef",
				1,
			),
			upsertFeishuAlertSetting(
				db,
				feishuAlertSettingKeys.chatId,
				"oc_1234567890abcdef",
				1,
			),
			upsertFeishuAlertSetting(
				db,
				feishuAlertSettingKeys.appSecret,
				await encryptFeishuAppSecret(db, "test-only-feishu-secret"),
				1,
				true,
			),
		]);
	}

	async function configureTelegram(enabled: boolean, withToken = true) {
		await db.batch([
			upsertFeishuAlertSetting(
				db,
				telegramOwnerAlertSettingKeys.enabled,
				enabled,
				1,
			),
			upsertFeishuAlertSetting(
				db,
				telegramOwnerAlertSettingKeys.chatId,
				chatId,
				1,
			),
			...(withToken
				? [
						upsertFeishuAlertSetting(
							db,
							telegramOwnerAlertSettingKeys.botToken,
							await encryptTelegramOwnerAlertBotToken(db, botToken),
							1,
							true,
						),
					]
				: []),
		]);
	}

	it("falls back to Feishu while Telegram owner alerts are disabled", async () => {
		await configureFeishu();
		await configureTelegram(false);
		const { calls, fetcher } = fakeFetch();
		await expect(
			sendOwnerAlert(db, "新订单", { fetcher, uuid: "event-1" }),
		).resolves.toEqual({ channel: "feishu" });
		expect(calls.some((call) => call.url.includes("api.telegram.org"))).toBe(
			false,
		);
		const message = calls.find((call) => call.url.includes("im/v1/messages"));
		expect(message?.body).toMatchObject({ uuid: "event-1", msg_type: "text" });
	});

	it("sends only to Telegram as plain text when enabled, never to Feishu", async () => {
		await configureFeishu();
		await configureTelegram(true);
		const { calls, fetcher } = fakeFetch();
		const text = "收入 *¥100* <b>_x_</b> [link](http://x)";
		await expect(sendOwnerAlert(db, text, { fetcher })).resolves.toEqual({
			channel: "telegram",
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(
			`https://api.telegram.org/bot${botToken}/sendMessage`,
		);
		expect(calls[0]?.body).toEqual({
			chat_id: chatId,
			text,
			link_preview_options: { is_disabled: true },
		});
		expect(calls[0]?.body).not.toHaveProperty("parse_mode");
		const settings = await loadTelegramOwnerAlertSettings(db);
		expect(settings).toMatchObject({
			enabled: true,
			chatId,
			hasBotToken: true,
			lastErrorCode: null,
		});
		expect(settings.lastSentAt).toEqual(expect.any(Number));
	});

	it("fails instead of falling back to Feishu when enabled Telegram is incomplete", async () => {
		await configureFeishu();
		await configureTelegram(true, false);
		const { calls, fetcher } = fakeFetch();
		await expect(sendOwnerAlert(db, "x", { fetcher })).rejects.toMatchObject({
			code: "telegram_alert_configuration_missing",
		});
		expect(calls).toHaveLength(0);
		expect((await loadTelegramOwnerAlertSettings(db)).lastErrorCode).toBe(
			"telegram_alert_configuration_missing",
		);
	});

	it("does not fall back to Feishu after a Telegram API failure and never exposes the token", async () => {
		await configureFeishu();
		await configureTelegram(true);
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { calls, fetcher } = fakeFetch(() =>
			Response.json(
				{
					ok: false,
					error_code: 403,
					description: `Forbidden: bot ${botToken} was kicked`,
				},
				{ status: 403 },
			),
		);
		const error = await sendOwnerAlert(db, "x", { fetcher }).catch(
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(OwnerAlertError);
		expect((error as OwnerAlertError).code).toBe("telegram_alert_api_403");
		expect(String((error as Error).message)).not.toContain(botToken);
		expect(JSON.stringify(error)).not.toContain(botToken);
		expect(calls.every((call) => call.url.includes("api.telegram.org"))).toBe(
			true,
		);
		const row = await db
			.prepare("SELECT value FROM system_settings WHERE key = ?")
			.bind(telegramOwnerAlertSettingKeys.lastErrorCode)
			.first<{ value: string }>();
		expect(row?.value).toBe(JSON.stringify("telegram_alert_api_403"));
		const stored = await db
			.prepare(
				"SELECT group_concat(value, '|') AS values_text FROM system_settings",
			)
			.first<{ values_text: string }>();
		expect(stored?.values_text).not.toContain(botToken);
		for (const spy of [log, warn])
			expect(JSON.stringify(spy.mock.calls)).not.toContain(botToken);
		log.mockRestore();
		warn.mockRestore();
	});

	it("maps network errors that carry the request URL to a token-free code", async () => {
		await configureTelegram(true);
		const fetcher = vi.fn(async (input: RequestInfo | URL) => {
			throw new TypeError(`fetch failed: ${String(input)}`);
		}) as unknown as typeof fetch;
		const error = (await sendOwnerAlert(db, "x", { fetcher }).catch(
			(caught: unknown) => caught,
		)) as OwnerAlertError;
		expect(error.code).toBe("telegram_alert_delivery_failed");
		expect(error.message).not.toContain(botToken);
		expect(error.stack ?? "").not.toContain(botToken);
	});

	it("reports an unconfigured channel when neither Telegram nor Feishu is set", async () => {
		const { calls, fetcher } = fakeFetch();
		await expect(sendOwnerAlert(db, "x", { fetcher })).resolves.toBeNull();
		await expect(deliverOwnerAlert(db, "x", { fetcher })).rejects.toMatchObject(
			{ code: "owner_alert_configuration_unavailable" },
		);
		expect(calls).toHaveLength(0);
	});

	it("splits long alerts into ordered Telegram messages", async () => {
		await configureTelegram(true);
		const { calls, fetcher } = fakeFetch();
		const line = `${"订单".repeat(30)}\n`;
		const text = line.repeat(200);
		await sendOwnerAlert(db, text, { fetcher });
		expect(calls.length).toBeGreaterThan(1);
		for (const call of calls)
			expect(String(call.body.text).length).toBeLessThanOrEqual(
				telegramMessageLimit,
			);
		expect(calls.map((call) => call.body.text).join("\n")).toBe(text);
	});

	it("stores the bot token encrypted and verifies the chat with getChat", async () => {
		await configureTelegram(true);
		const row = await db
			.prepare("SELECT value, is_secret FROM system_settings WHERE key = ?")
			.bind(telegramOwnerAlertSettingKeys.botToken)
			.first<{ value: string; is_secret: number }>();
		expect(row?.is_secret).toBe(1);
		expect(row?.value).not.toContain(botToken);
		const credentials = await resolveTelegramOwnerAlertCredentials(db);
		expect(credentials).toEqual({ botToken, chatId });
		const { calls, fetcher } = fakeFetch(() =>
			Response.json({
				ok: true,
				result: { id: -5101401750, type: "group", title: "老板群" },
			}),
		);
		await expect(
			verifyTelegramOwnerAlertChat(
				credentials as NonNullable<typeof credentials>,
				fetcher,
			),
		).resolves.toEqual({ verified: true, type: "group", title: "老板群" });
		expect(calls[0]?.url).toBe(
			`https://api.telegram.org/bot${botToken}/getChat`,
		);
		expect(calls[0]?.body).toEqual({ chat_id: chatId });
	});
});

describe("Telegram owner alert helpers", () => {
	it("keeps every part within the limit and prefers line breaks", () => {
		const text = `${"a".repeat(3000)}\n${"b".repeat(3000)}\n${"c".repeat(5000)}`;
		const parts = splitTelegramText(text);
		expect(parts.map((part) => part.length)).toEqual([3000, 3000, 4096, 904]);
		expect(parts.join("")).toBe(text.replaceAll("\n", ""));
		expect(splitTelegramText("短消息")).toEqual(["短消息"]);
		expect(splitTelegramText("   \n ")).toEqual([]);
	});

	it("never splits a surrogate pair", () => {
		const text = `${"a".repeat(4095)}😀tail`;
		const parts = splitTelegramText(text);
		expect(parts[0]).toBe("a".repeat(4095));
		expect(parts[1]).toBe("😀tail");
	});

	it("validates bot tokens and negative group chat ids", () => {
		expect(
			telegramOwnerAlertSettingsInputSchema.safeParse({
				enabled: true,
				botToken,
				chatId,
			}).success,
		).toBe(true);
		for (const bad of [
			{ enabled: true, botToken: "not-a-token", chatId },
			{ enabled: true, chatId: "oc_feishu" },
			{ enabled: true, chatId: "-0" },
		])
			expect(telegramOwnerAlertSettingsInputSchema.safeParse(bad).success).toBe(
				false,
			);
	});
});
