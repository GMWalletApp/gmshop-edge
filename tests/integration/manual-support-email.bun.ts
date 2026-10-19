import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as grammy from "grammy";
import { Api } from "grammy";
import { decryptNotificationMessage } from "../../src/features/notifications/secrets";
import { encryptSecret } from "../../src/lib/secrets";
import { openNodeDatabase } from "../../src/server/runtime/node/database";
import { applyNodeMigrations } from "../../src/server/runtime/node/migrations";
import * as runtimeConfig from "../../src/server/runtime-config";

let revision = 0;
let botMessages: Array<Record<string, unknown>> = [];
class TestBot extends grammy.Bot {
	constructor(token: string) {
		super(token);
		this.api.config.use((async (_previous, method, payload) => {
			if (method === "getMe")
				return {
					ok: true,
					result: {
						id: 777,
						is_bot: true,
						first_name: "Test",
						username: "test_bot",
					},
				};
			if (method === "getChatMember")
				return {
					ok: true,
					result: {
						status: admin ? "creator" : "member",
						user: { id: 42, is_bot: false, first_name: "Test" },
						is_anonymous: false,
					},
				};
			if (method === "answerCallbackQuery") return { ok: true, result: true };
			if (method === "sendMessage") {
				botMessages.push(payload as Record<string, unknown>);
				return {
					ok: true,
					result: {
						message_id: 1,
						date: 1,
						chat: { id: 123, type: "supergroup" },
					},
				};
			}
			throw Error(`Unexpected Telegram method: ${method}`);
		}) as Parameters<Api["config"]["use"]>[0]);
	}
}
mock.module("grammy", () => ({ ...grammy, Bot: TestBot }));
const secret = "test-only-manual-support-email-secret";
mock.module("../../src/features/telegram/server/sync", () => ({
	miniAppUrl: () => "https://laoshirenvip.com",
	telegramRuntime: async () => ({
		settings: {
			supportChatId: "123",
			lastAdminSyncAt: null,
			status: "active",
			syncedRevision: revision,
		},
		provider: {
			telegramBotToken: "synthetic-token",
			telegramBotUserId: "777",
			revision,
			allowSignup: false,
		},
		runtime: {
			dataEncryptionSecret: secret,
			betterAuthUrl: "https://laoshirenvip.com",
		},
	}),
}));
mock.module("../../src/server/runtime-config", () => ({
	...runtimeConfig,
	loadRuntimeConfig: async () => ({ commerceSecret: secret }),
}));
const {
	requestManualSupportEmail,
	authorizeSupportEmailTopic,
	supportEmailKeyboard,
} = await import("../../src/features/telegram/server/manual-support-email");
const { supportReplyEmailSender, processNotificationDelivery } = await import(
	"../../src/features/notifications/server/delivery"
);
const { handleTelegramUpdate } = await import(
	"../../src/features/telegram/server/bot"
);
let database: ReturnType<typeof openNodeDatabase>;
let db: D1Database;
let admin = true;
const cid = "00000000-0000-4000-8000-000000000001";
const input = {
	chatId: "123",
	threadId: 99,
	userId: "42",
	conversationId: cid,
};
const api = new Api("synthetic-token");
api.config.use((async (_previous, method) => {
	if (method !== "getChatMember") throw Error("Unexpected network call");
	return {
		ok: true,
		result: {
			status: admin ? "creator" : "member",
			user: { id: 42, is_bot: false, first_name: "Test" },
			is_anonymous: false,
		},
	};
}) as Parameters<Api["config"]["use"]>[0]);
async function reply(sequence = 1, expires = Date.now() + 86400000) {
	await db
		.prepare(
			"INSERT INTO telegram_web_support_replies (id,conversation_id,sequence,algorithm,wrapped_key,iv,ciphertext,expires_at,created_at) VALUES (?,?,?,'server-v1','','','private transcript',?,?)",
		)
		.bind(crypto.randomUUID(), cid, sequence, expires, Date.now())
		.run();
}
async function count(table: string) {
	return (
		await db
			.prepare(`SELECT COUNT(*) AS n FROM ${table}`)
			.first<{ n: number }>()
	)?.n;
}
beforeEach(async () => {
	database = openNodeDatabase(":memory:");
	db = database as unknown as D1Database;
	await applyNodeMigrations(database);
	admin = true;
	revision++;
	botMessages = [];
	await db
		.prepare(
			"INSERT INTO telegram_web_support_conversations (id,support_chat_id,visitor_id,email_encrypted,email_hash,session_token_hash,public_key_jwk,message_thread_id,status,next_reply_sequence,created_at,updated_at) VALUES (?,'123','test',?,'test','test','{}',99,'active',1,?,?)",
		)
		.bind(
			cid,
			await encryptSecret(
				"synthetic-customer@proton.me",
				secret,
				"telegram-web-support-email",
			),
			Date.now(),
			Date.now(),
		)
		.run();
	await db
		.prepare(
			"INSERT INTO notification_channel_configs (id,channel,name,provider,from_address,enabled) VALUES ('official','email','Official','cloudflare_email',?,1)",
		)
		.bind(supportReplyEmailSender)
		.run();
});
afterEach(() => database.sqlite.close());
test("normal reply and showing manual controls do not enqueue email", async () => {
	await reply();
	await authorizeSupportEmailTopic(db, api, input);
	expect(supportEmailKeyboard(cid).inline_keyboard[0]?.[0]?.callback_data).toBe(
		`webmail:${cid}`,
	);
	expect(await count("notification_deliveries")).toBe(0);
});
test("manual request pins official channel, encrypts generic body and deduplicates", async () => {
	await reply();
	const result = await requestManualSupportEmail(db, api, input);
	expect(result.status).toBe("pending");
	const row = await db
		.prepare("SELECT * FROM notification_deliveries WHERE id=?")
		.bind(result.id)
		.first<{
			message_encrypted: string;
			channel_config_id: string;
			event: string;
		}>();
	expect(row?.channel_config_id).toBe("official");
	expect(row?.event).toBe("support_reply_manual");
	const message = JSON.parse(
		await decryptNotificationMessage(row?.message_encrypted ?? "", secret),
	);
	expect(message.from).toBe(supportReplyEmailSender);
	expect(message.to).toBe("synthetic-customer@proton.me");
	expect(message.text).toContain("https://laoshirenvip.com/#support");
	expect(message.text).not.toContain("private transcript");
	expect(message.text).not.toContain(cid);
	expect((await requestManualSupportEmail(db, api, input)).duplicate).toBe(
		true,
	);
	expect(await count("notification_deliveries")).toBe(1);
	expect(await count("outbox_events")).toBe(1);
	expect(await count("audit_logs")).toBe(1);
	await reply(2);
	expect((await requestManualSupportEmail(db, api, input)).duplicate).toBe(
		false,
	);
	expect(await count("notification_deliveries")).toBe(2);
});
test("reject non-admin, wrong group, topic or callback identity", async () => {
	await reply();
	admin = false;
	await expect(requestManualSupportEmail(db, api, input)).rejects.toMatchObject(
		{ code: "forbidden" },
	);
	admin = true;
	for (const patch of [
		{ chatId: "456" },
		{ threadId: 100 },
		{ conversationId: crypto.randomUUID() },
	])
		await expect(
			requestManualSupportEmail(db, api, { ...input, ...patch }),
		).rejects.toBeDefined();
	expect(await count("notification_deliveries")).toBe(0);
});
test("no current reply means no notification", async () => {
	await expect(requestManualSupportEmail(db, api, input)).rejects.toMatchObject(
		{ code: "support_reply_required" },
	);
	await reply(1, Date.now() - 1);
	await expect(requestManualSupportEmail(db, api, input)).rejects.toMatchObject(
		{ code: "support_reply_required" },
	);
	expect(await count("notification_deliveries")).toBe(0);
});
test("wrong sender, provider or disabled channel fails closed", async () => {
	await reply();
	for (const change of [
		"from_address='other@laoshirenvip.com'",
		"provider='smtp'",
		"enabled=0",
	]) {
		await db.prepare(`UPDATE notification_channel_configs SET ${change}`).run();
		await expect(
			requestManualSupportEmail(db, api, input),
		).rejects.toMatchObject({ code: "support_email_sender_unavailable" });
		await db
			.prepare(
				"UPDATE notification_channel_configs SET from_address=?,provider='cloudflare_email',enabled=1",
			)
			.bind(supportReplyEmailSender)
			.run();
	}
	expect(await count("notification_deliveries")).toBe(0);
});
test("reserved recipient is suppressed without outbox", async () => {
	await reply();
	await db
		.prepare("UPDATE telegram_web_support_conversations SET email_encrypted=?")
		.bind(
			await encryptSecret(
				"attachment-qa@example.com",
				secret,
				"telegram-web-support-email",
			),
		)
		.run();
	expect((await requestManualSupportEmail(db, api, input)).status).toBe(
		"suppressed",
	);
	expect(await count("outbox_events")).toBe(0);
});
test("send-time configuration drift blocks actual transport", async () => {
	await reply();
	const result = await requestManualSupportEmail(db, api, input);
	await db.prepare("UPDATE notification_channel_configs SET enabled=0").run();
	await expect(
		processNotificationDelivery(db, result.id),
	).rejects.toMatchObject({ code: "support_email_sender_unavailable" });
	expect(
		(
			await db
				.prepare("SELECT attempt_count FROM notification_deliveries WHERE id=?")
				.bind(result.id)
				.first<{ attempt_count: number }>()
		)?.attempt_count,
	).toBe(0);
});
test("only explicit Telegram callback wires sending; mobile copy and header contract", () => {
	const bot = readFileSync("src/features/telegram/server/bot.ts", "utf8");
	expect(bot.match(/await requestManualSupportEmail\(/g)?.length).toBe(1);
	expect(bot.indexOf("bot.callbackQuery(/^webmail:")).toBeLessThan(
		bot.indexOf("await requestManualSupportEmail("),
	);
	const cn = JSON.parse(readFileSync("messages/zh-CN.json", "utf8"));
	expect(cn.store_support_description).not.toContain("微信");
	expect(cn.web_support_reply_notice).toContain(
		"客服回复了会通过邮件提醒你返回网页继续沟通。",
	);
	const header = readFileSync("src/layouts/public/header.tsx", "utf8");
	// Phones get support from the menu (web chat, group, bot); desktops keep the header button.
	const mobileMenu = header.slice(
		header.indexOf("function MobileMenu("),
		header.indexOf("export function DeliveryTicker("),
	);
	expect(mobileMenu).toContain(
		"window.dispatchEvent(new Event(webSupportOpenEvent))",
	);
	expect(mobileMenu).toContain("href={telegramGroupUrl}");
	expect(mobileMenu).toContain("href={telegramSupportUrl}");
	expect(header).toContain("<MobileMenu navigation={navigation} />");
	expect(header).toContain("<CustomerSupport />");
});

test("approved binding accepts exactly one manually requested message with no fallback", async () => {
	await reply();
	const result = await requestManualSupportEmail(db, api, input);
	let sent = 0;
	const binding = {
		send: async () => {
			sent++;
			return { messageId: "mock-provider-id" };
		},
	} as unknown as SendEmail;
	expect(
		await processNotificationDelivery(db, result.id, {
			cloudflareEmail: binding,
		}),
	).toMatchObject({ status: "accepted" });
	await processNotificationDelivery(db, result.id, {
		cloudflareEmail: binding,
	});
	expect(sent).toBe(1);
});

test("real bot reply does not email; notify only shows button; callback enqueues once", async () => {
	await db
		.prepare("INSERT INTO system_settings (key,value) VALUES (?,?)")
		.bind("telegram.support.chat_id", JSON.stringify("123"))
		.run();
	const from = {
		id: 42,
		is_bot: false,
		first_name: "Test",
		language_code: "zh",
	};
	const message = {
		message_id: 10,
		date: Math.floor(Date.now() / 1000),
		chat: { id: 123, type: "supergroup", is_forum: true, title: "Test" },
		message_thread_id: 99,
		is_topic_message: true,
		from,
		text: "/notify",
		entities: [{ offset: 0, length: 7, type: "bot_command" }],
	};
	await handleTelegramUpdate(db, {
		update_id: 0,
		message: { ...message, text: "ordinary administrator reply", entities: [] },
	});
	expect(await count("telegram_web_support_replies")).toBe(1);
	expect(await count("notification_deliveries")).toBe(0);
	await handleTelegramUpdate(db, { update_id: 1, message });
	expect(await count("notification_deliveries")).toBe(0);
	expect(botMessages[0]).toMatchObject({
		message_thread_id: 99,
		reply_markup: { inline_keyboard: [[{ callback_data: `webmail:${cid}` }]] },
	});
	await handleTelegramUpdate(db, {
		update_id: 2,
		callback_query: {
			id: "callback-1",
			from,
			chat_instance: "test",
			message: {
				...message,
				from: { id: 777, is_bot: true, first_name: "Test" },
			},
			data: `webmail:${cid}`,
		},
	});
	expect(await count("notification_deliveries")).toBe(1);
	expect(botMessages.at(-1)?.text).toContain("已加入邮件发送队列");
});

test("customer website language overrides account default and staff language", async () => {
	await db
		.prepare(
			"INSERT INTO users (id,name,email,preferred_locale) VALUES ('locale-user','Test','locale-test@example.com','en-US')",
		)
		.run();
	await db
		.prepare(
			"UPDATE telegram_web_support_conversations SET user_id='locale-user' WHERE id=?",
		)
		.bind(cid)
		.run();
	const { updateWebSupportLocale } = await import(
		"../../src/features/telegram/server/web-support"
	);
	for (const [index, locale] of (["zh-CN", "en-US"] as const).entries()) {
		await updateWebSupportLocale(db, cid, locale);
		await reply(index + 1);
		const result = await requestManualSupportEmail(db, api, input);
		const row = await db
			.prepare(
				"SELECT locale,message_encrypted FROM notification_deliveries WHERE id=?",
			)
			.bind(result.id)
			.first<{ locale: string; message_encrypted: string }>();
		expect(row?.locale).toBe(locale);
		const message = JSON.parse(
			await decryptNotificationMessage(row?.message_encrypted ?? "", secret),
		);
		expect(message.subject).toBe(
			locale === "zh-CN"
				? "老实人AI VIP：客服已回复你的咨询"
				: "LaoshirenAI VIP: support has replied",
		);
		expect(message.text).toContain(
			locale === "zh-CN" ? "请返回网页继续沟通" : "Return to the website",
		);
	}
	await updateWebSupportLocale(db, cid, undefined);
	expect(
		(
			await db
				.prepare(
					"SELECT locale FROM telegram_web_support_conversations WHERE id=?",
				)
				.bind(cid)
				.first<{ locale: string }>()
		)?.locale,
	).toBe("en-US");
});
