import { Api, GrammyError } from "grammy";
import { z } from "zod";
import { isInternalIdentityEmail } from "#/features/auth/identity-email";
import { getStoreSessionUser } from "#/features/storefront/server/account";
import { decryptSecret, encryptSecret } from "#/lib/secrets";
import { m } from "#/paraglide/messages";
import { getRuntimeEnv } from "#/server/db.server";
import { claimFixedWindowRateLimit } from "#/server/rate-limit";
import { loadTelegramSettings } from "../settings";
import { supportFileRetentionMs } from "../web-support-attachments";
import {
	parseDevice,
	type webSupportConversationSchema,
	type webSupportMessageSchema,
} from "../web-support-contract";
import { formatFeishuWebSupportAlert } from "./feishu-alerts";
import { supportEmailKeyboard } from "./manual-support-email";
import { sendOwnerAlert } from "./owner-alerts";
import { telegramDataKeyId } from "./secret";
import {
	completeSupportAwayReply,
	reserveSupportAwayReply,
} from "./support-away";
import { telegramRuntime } from "./sync";

const encoder = new TextEncoder();
export const webSupportCookieName = "gmshop_web_support";

export class WebSupportError extends Error {
	constructor(
		readonly code: string,
		readonly status: number,
	) {
		super(code);
	}
}

export type WebConversation = {
	id: string;
	support_chat_id: string;
	message_thread_id: number | null;
	status: "creating" | "active" | "closing" | "closed";
	public_key_jwk: string;
	next_reply_sequence: number;
	topic_name?: string | null;
};

export async function webSupportStatus(db: D1Database, request: Request) {
	const settings = await loadTelegramSettings(db);
	const conversation = await authenticatedConversation(db, request);
	return {
		enabled: settings.webSupportEnabled,
		hasConversation: Boolean(conversation),
		conversationId: conversation?.id ?? null,
		status: conversation?.status ?? null,
	};
}

export async function createWebSupportConversation(
	db: D1Database,
	request: Request,
	input: z.infer<typeof webSupportConversationSchema>,
) {
	const { runtime, settings, provider } = await telegramRuntime(db);
	if (
		!settings.webSupportEnabled ||
		!settings.supportChatId ||
		settings.status !== "active" ||
		!provider?.telegramBotToken ||
		!runtime.dataEncryptionSecret
	)
		throw new WebSupportError("support_unavailable", 409);

	const existingSession = await authenticatedConversation(db, request);
	if (existingSession) {
		await updateWebSupportLocale(
			db,
			existingSession.id,
			input.diagnostics.locale,
		);
		return reopenExisting(db, provider.telegramBotToken, existingSession);
	}

	const sessionUser = await getStoreSessionUser(request).catch(() => null);
	const accountEmail =
		sessionUser?.emailVerified && !isInternalIdentityEmail(sessionUser.email)
			? sessionUser.email
			: null;
	const email = (accountEmail ?? input.email)?.trim().toLowerCase();
	if (!email || !z.email().safeParse(email).success)
		throw new WebSupportError("email_required", 400);

	const ip = trustedClientIp(request);
	await enforceCreateLimits(db, ip, email, runtime.dataEncryptionSecret, input);
	const duplicateVisitor = await db
		.prepare(
			"SELECT 1 AS found FROM telegram_web_support_conversations WHERE support_chat_id = ? AND visitor_id = ? LIMIT 1",
		)
		.bind(settings.supportChatId, input.visitorId)
		.first();
	if (duplicateVisitor) throw new WebSupportError("visitor_conflict", 409);

	const now = Date.now();
	const id = crypto.randomUUID();
	const sessionToken = randomToken();
	const fingerprint = input.fingerprint
		? await purposeHash(
				runtime.dataEncryptionSecret,
				`fingerprint:v1:${input.fingerprint.version}:${input.fingerprint.visitorId}`,
			)
		: null;
	const emailHash = await purposeHash(
		runtime.dataEncryptionSecret,
		`email:v1:${email}`,
	);
	const repeated = fingerprint
		? Boolean(
				await db
					.prepare(
						"SELECT 1 FROM telegram_web_support_conversations WHERE fingerprint_hash = ? LIMIT 1",
					)
					.bind(fingerprint)
					.first(),
			)
		: false;
	const topicName =
		`Web · ${maskEmail(email)} · ${input.visitorId.slice(0, 8)}`.slice(0, 128);
	await db
		.prepare(
			`INSERT INTO telegram_web_support_conversations
			 (id, support_chat_id, visitor_id, user_id, email_encrypted, email_hash,
			  session_token_hash, fingerprint_hash, fingerprint_version, fingerprint_key_id,
			  public_key_jwk, topic_name, status, creation_lease_expires_at,
			  next_reply_sequence, created_at, updated_at, locale)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'creating', ?, 1, ?, ?, ?)`,
		)
		.bind(
			id,
			settings.supportChatId,
			input.visitorId,
			sessionUser?.id ?? null,
			await encryptSecret(
				email,
				runtime.dataEncryptionSecret,
				"telegram-web-support-email",
			),
			emailHash,
			await sessionHash(sessionToken),
			fingerprint,
			input.fingerprint?.version ?? null,
			await telegramDataKeyId(runtime.dataEncryptionSecret),
			JSON.stringify(input.publicKeyJwk ?? {}),
			topicName,
			now + 30_000,
			now,
			now,
			input.diagnostics.locale,
		)
		.run();
	const api = new Api(provider.telegramBotToken);
	try {
		const topic = await api.createForumTopic(settings.supportChatId, topicName);
		await db
			.prepare(
				`UPDATE telegram_web_support_conversations SET message_thread_id = ?, status = 'active',
				 creation_lease_expires_at = NULL, opened_at = ?, last_activity_at = ?, updated_at = ?
				 WHERE id = ?`,
			)
			.bind(topic.message_thread_id, now, now, now, id)
			.run();
		await api.sendMessage(
			settings.supportChatId,
			formatDiagnostics(request, email, input, repeated),
			{
				message_thread_id: topic.message_thread_id,
				reply_markup: supportEmailKeyboard(id, input.diagnostics.locale),
			},
		);
		return { id, status: "active" as const, sessionToken };
	} catch (error) {
		await db
			.prepare("DELETE FROM telegram_web_support_conversations WHERE id = ?")
			.bind(id)
			.run();
		throw error;
	}
}

export async function currentWebSupportConversation(
	db: D1Database,
	request: Request,
	after: number,
) {
	const conversation = await requireConversation(db, request);
	const rows = await db
		.prepare(`SELECT id,sequence,algorithm,wrapped_key,iv,ciphertext,created_at
 FROM telegram_web_support_replies WHERE conversation_id=? AND sequence>? AND expires_at>? AND created_at>? ORDER BY sequence LIMIT 100`)
		.bind(
			conversation.id,
			after,
			Date.now(),
			Date.now() - supportFileRetentionMs,
		)
		.all<{
			id: string;
			sequence: number;
			algorithm: string;
			wrapped_key: string;
			iv: string;
			ciphertext: string;
			created_at: number;
		}>();
	const v2 = new URL(request.url).searchParams.get("version") === "2";
	const replies = [];
	const runtime = rows.results.some((row) => row.algorithm === "server-v1")
		? (await telegramRuntime(db)).runtime
		: null;
	for (const row of rows.results) {
		if (row.algorithm !== "server-v1") {
			replies.push(row);
			continue;
		}
		const text = await decryptSecret(
			row.ciphertext,
			runtime?.dataEncryptionSecret ?? "",
			`web-support:${conversation.id}:${row.sequence}`,
		);
		if (v2) {
			replies.push({
				id: row.id,
				sequence: row.sequence,
				text,
				created_at: row.created_at,
			});
			continue;
		}
		// Keep already-open legacy clients working until they reload.
		const envelope = await encryptForBrowser(
			JSON.parse(conversation.public_key_jwk) as JsonWebKey,
			conversation.id,
			row.sequence,
			text,
		);
		replies.push({
			...row,
			algorithm: envelope.algorithm,
			wrapped_key: envelope.wrappedKey,
			iv: envelope.iv,
			ciphertext: envelope.ciphertext,
		});
	}
	return {
		conversationId: conversation.id,
		status: conversation.status,
		replies,
	};
}

export async function sendWebSupportMessage(
	db: D1Database,
	request: Request,
	input: z.infer<typeof webSupportMessageSchema>,
) {
	const conversation = await requireConversation(db, request);
	if (
		!conversation.message_thread_id ||
		!["active", "closing"].includes(conversation.status)
	)
		throw new WebSupportError("conversation_closed", 409);
	const limit = await claimFixedWindowRateLimit(db, {
		bucketKey: `telegram:web:session:${conversation.id}`,
		limit: 30,
		windowMs: 60_000,
	});
	if (!limit.allowed) throw new WebSupportError("rate_limited", 429);
	await updateWebSupportLocale(db, conversation.id, input.locale);
	const receipt = await db
		.prepare(
			`INSERT INTO telegram_web_support_sends (id, conversation_id, client_message_id, created_at)
			 VALUES (?, ?, ?, ?) ON CONFLICT(conversation_id, client_message_id) DO NOTHING`,
		)
		.bind(
			crypto.randomUUID(),
			conversation.id,
			input.clientMessageId,
			Date.now(),
		)
		.run();
	if (Number(receipt.meta.changes ?? 0) === 0)
		return { sent: true, duplicate: true };
	const { provider } = await telegramRuntime(db);
	if (!provider?.telegramBotToken)
		throw new WebSupportError("support_unavailable", 503);
	const api = new Api(provider.telegramBotToken);
	try {
		await api.sendMessage(conversation.support_chat_id, `💬 ${input.text}`, {
			message_thread_id: conversation.message_thread_id,
			reply_markup: supportEmailKeyboard(conversation.id),
		});
		await touchWebConversation(db, conversation.id);
		scheduleFeishuWebSupportAlert(
			db,
			conversation.id,
			conversation.topic_name,
			input.text,
		);
		await maybeReplyWebSupportAway(db, api, conversation);
		return { sent: true };
	} catch (error) {
		if (isMissingTopicError(error)) {
			const topic = await api.createForumTopic(
				conversation.support_chat_id,
				conversation.topic_name ?? `Web · ${conversation.id.slice(0, 8)}`,
			);
			await db
				.prepare(
					`UPDATE telegram_web_support_conversations SET message_thread_id = ?, status = 'active', updated_at = ?
				 WHERE id = ? AND status != 'closed'`,
				)
				.bind(topic.message_thread_id, Date.now(), conversation.id)
				.run();
			await api.sendMessage(conversation.support_chat_id, `💬 ${input.text}`, {
				message_thread_id: topic.message_thread_id,
			});
			await touchWebConversation(db, conversation.id);
			scheduleFeishuWebSupportAlert(
				db,
				conversation.id,
				conversation.topic_name,
				input.text,
			);
			await maybeReplyWebSupportAway(db, api, conversation);
			return { sent: true };
		}
		await db
			.prepare(
				"DELETE FROM telegram_web_support_sends WHERE conversation_id = ? AND client_message_id = ?",
			)
			.bind(conversation.id, input.clientMessageId)
			.run();
		throw error;
	}
}

export async function maybeReplyWebSupportAway(
	db: D1Database,
	api: Pick<Api, "sendMessage">,
	conversation: WebConversation,
) {
	let reply: Awaited<ReturnType<typeof reserveSupportAwayReply>> = null;
	try {
		reply = await reserveSupportAwayReply(db, {
			chatId: conversation.support_chat_id,
			conversationId: conversation.id,
			kind: "web",
			locale: "zh-CN",
		});
		if (!reply) return;
		await storeWebAdministratorReply(
			db,
			conversation,
			reply.message,
			undefined,
			true,
		);
		await api.sendMessage(conversation.support_chat_id, reply.message, {
			message_thread_id: reply.threadId,
		});
		await completeSupportAwayReply(db, reply.receiptId, true);
	} catch {
		if (reply)
			await completeSupportAwayReply(db, reply.receiptId, false).catch(
				() => undefined,
			);
		console.error(
			JSON.stringify({
				event: "support_away_delivery_failed",
				conversationId: conversation.id,
			}),
		);
	}
}

// One owner ping per conversation per 5 minutes; the full thread is in Telegram.
const WEB_SUPPORT_FEISHU_QUIET_MS = 5 * 60_000;

function scheduleFeishuWebSupportAlert(
	db: D1Database,
	conversationId: string,
	topicName: string | null | undefined,
	message: string,
) {
	const task = (async () => {
		try {
			const now = Date.now();
			const claimed = await db
				.prepare(
					`UPDATE telegram_web_support_conversations SET feishu_alerted_at = ?
					 WHERE id = ? AND (feishu_alerted_at IS NULL OR feishu_alerted_at <= ?)`,
				)
				.bind(now, conversationId, now - WEB_SUPPORT_FEISHU_QUIET_MS)
				.run();
			if (Number(claimed.meta.changes ?? 0) !== 1) return;
			// Telegram owner alerts when enabled; otherwise Feishu only behind
			// its web-support switch. sendOwnerAlert records the outcome.
			await sendOwnerAlert(
				db,
				formatFeishuWebSupportAlert(topicName, message),
				{ requireFeishuEnabled: true },
			);
		} catch {
			// Owner pings never block the customer's message reaching Telegram.
		}
	})();
	const waitUntil = getRuntimeEnv().waitUntil;
	if (waitUntil) waitUntil(task);
	else void task;
}

export async function acknowledgeWebSupportReplies(
	db: D1Database,
	request: Request,
	ids: string[],
) {
	await requireConversation(db, request);
	// Replies expire on the server after 48 hours, not on the first tab's read.
	return { acknowledged: ids.length };
}

export async function closeWebSupportConversation(
	db: D1Database,
	request: Request,
) {
	const conversation = await requireConversation(db, request);
	if (conversation.status === "closed") return { status: "closed" as const };
	const { provider } = await telegramRuntime(db);
	if (provider?.telegramBotToken && conversation.message_thread_id) {
		const api = new Api(provider.telegramBotToken);
		await api
			.sendMessage(
				conversation.support_chat_id,
				"Web support conversation closed.",
				{
					message_thread_id: conversation.message_thread_id,
				},
			)
			.catch(() => undefined);
		await api
			.closeForumTopic(
				conversation.support_chat_id,
				conversation.message_thread_id,
			)
			.catch(() => undefined);
	}
	const now = Date.now();
	await db
		.prepare(
			`UPDATE telegram_web_support_conversations SET status = 'closed', closed_reason = 'customer',
		 closed_at = ?, updated_at = ? WHERE id = ?`,
		)
		.bind(now, now, conversation.id)
		.run();
	return { status: "closed" as const };
}

export async function storeWebAdministratorReply(
	db: D1Database,
	conversation: WebConversation,
	message: string,
	attachmentId?: string,
	isAwayReply = false,
) {
	const reserved = await db
		.prepare(
			`UPDATE telegram_web_support_conversations SET next_reply_sequence = next_reply_sequence + 1
		 WHERE id = ? AND status IN ('active', 'closing') RETURNING next_reply_sequence`,
		)
		.bind(conversation.id)
		.first<{ next_reply_sequence: number }>();
	if (!reserved) throw new WebSupportError("conversation_closed", 409);
	const sequence = reserved.next_reply_sequence - 1;
	const { runtime } = await telegramRuntime(db);
	const ciphertext = await encryptSecret(
		message,
		runtime.dataEncryptionSecret,
		`web-support:${conversation.id}:${sequence}`,
	);
	const now = Date.now();
	await db.batch([
		...(attachmentId
			? [
					db
						.prepare(
							"UPDATE telegram_web_support_attachments SET status='sent' WHERE id=? AND conversation_id=?",
						)
						.bind(attachmentId, conversation.id),
				]
			: []),
		db
			.prepare(
				`INSERT INTO telegram_web_support_replies
			 (id, conversation_id, sequence, algorithm, wrapped_key, iv, ciphertext, expires_at, created_at, is_away_reply)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				crypto.randomUUID(),
				conversation.id,
				sequence,
				"server-v1",
				"",
				"",
				ciphertext,
				now + supportFileRetentionMs,
				now,
				isAwayReply ? 1 : 0,
			),
		db
			.prepare(
				`UPDATE telegram_web_support_conversations SET status = 'active',
			 last_activity_at = ?, updated_at = ? WHERE id = ?`,
			)
			.bind(now, now, conversation.id),
	]);
}

export async function findWebConversationByTopic(
	db: D1Database,
	supportChatId: string,
	threadId: number,
) {
	return db
		.prepare(
			`SELECT id, support_chat_id, message_thread_id, status, public_key_jwk, next_reply_sequence, topic_name
		 FROM telegram_web_support_conversations WHERE support_chat_id = ? AND message_thread_id = ?
		 AND status IN ('active', 'closing') LIMIT 1`,
		)
		.bind(supportChatId, threadId)
		.first<WebConversation>();
}

export async function closeWebConversationFromTopic(
	db: D1Database,
	supportChatId: string,
	threadId: number,
) {
	const now = Date.now();
	return db
		.prepare(
			`UPDATE telegram_web_support_conversations SET status = 'closed', closed_reason = 'administrator',
		 closed_at = ?, updated_at = ? WHERE support_chat_id = ? AND message_thread_id = ? AND status = 'active'`,
		)
		.bind(now, now, supportChatId, threadId)
		.run();
}

async function authenticatedConversation(db: D1Database, request: Request) {
	const token = cookieValue(request, webSupportCookieName);
	if (!token) return null;
	return db
		.prepare(
			`SELECT id, support_chat_id, message_thread_id, status, public_key_jwk, next_reply_sequence, topic_name
		 FROM telegram_web_support_conversations WHERE session_token_hash = ? LIMIT 1`,
		)
		.bind(await sessionHash(token))
		.first<WebConversation>();
}

export async function requireConversation(db: D1Database, request: Request) {
	const conversation = await authenticatedConversation(db, request);
	if (!conversation) throw new WebSupportError("conversation_not_found", 401);
	return conversation;
}

async function reopenExisting(
	db: D1Database,
	token: string,
	conversation: WebConversation,
) {
	if (conversation.status === "closed" && conversation.message_thread_id) {
		const api = new Api(token);
		try {
			await api.reopenForumTopic(
				conversation.support_chat_id,
				conversation.message_thread_id,
			);
		} catch (error) {
			if (
				!(
					error instanceof GrammyError &&
					/topic_not_modified/i.test(error.description)
				)
			)
				throw error;
		}
	}
	await touchWebConversation(db, conversation.id);
	return { id: conversation.id, status: "active" as const, sessionToken: null };
}

function touchWebConversation(db: D1Database, id: string) {
	const now = Date.now();
	return db
		.prepare(
			`UPDATE telegram_web_support_conversations SET status = 'active', closed_at = NULL,
		 closed_reason = NULL, last_activity_at = ?, updated_at = ? WHERE id = ?`,
		)
		.bind(now, now, id)
		.run();
}

async function enforceCreateLimits(
	db: D1Database,
	ip: string,
	email: string,
	secret: string,
	input: z.infer<typeof webSupportConversationSchema>,
) {
	const keys = [
		`telegram:web:create:ip:${ip}`,
		`telegram:web:create:email:${await purposeHash(secret, `email:v1:${email}`)}`,
	];
	if (input.fingerprint)
		keys.push(
			`telegram:web:create:fingerprint:${await purposeHash(secret, `fingerprint:v1:${input.fingerprint.version}:${input.fingerprint.visitorId}`)}`,
		);
	for (const bucketKey of keys) {
		const result = await claimFixedWindowRateLimit(db, {
			bucketKey,
			limit: 10,
			windowMs: 60_000,
		});
		if (!result.allowed) throw new WebSupportError("rate_limited", 429);
	}
}

async function encryptForBrowser(
	jwk: JsonWebKey,
	conversationId: string,
	sequence: number,
	value: string,
) {
	const publicKey = await crypto.subtle.importKey(
		"jwk",
		jwk,
		{ name: "RSA-OAEP", hash: "SHA-256" },
		false,
		["encrypt"],
	);
	const contentKey = await crypto.subtle.generateKey(
		{ name: "AES-GCM", length: 256 },
		true,
		["encrypt"],
	);
	const rawKey = await crypto.subtle.exportKey("raw", contentKey);
	const wrappedKey = await crypto.subtle.encrypt(
		{ name: "RSA-OAEP" },
		publicKey,
		rawKey,
	);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const additionalData = encoder.encode(`${conversationId}:${sequence}`);
	const ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv, additionalData },
		contentKey,
		encoder.encode(value),
	);
	return {
		algorithm: "RSA-OAEP-256+A256GCM",
		wrappedKey: base64Url(new Uint8Array(wrappedKey)),
		iv: base64Url(iv),
		ciphertext: base64Url(new Uint8Array(ciphertext)),
	};
}

async function purposeHash(secret: string, value: string) {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return base64Url(
		new Uint8Array(
			await crypto.subtle.sign(
				"HMAC",
				key,
				encoder.encode(`telegram-web-support:${value}`),
			),
		),
	);
}

async function sessionHash(value: string) {
	return base64Url(
		new Uint8Array(
			await crypto.subtle.digest("SHA-256", encoder.encode(value)),
		),
	);
}

function formatDiagnostics(
	request: Request,
	email: string,
	input: z.infer<typeof webSupportConversationSchema>,
	repeated: boolean,
) {
	const device = parseDevice(request.headers.get("user-agent"));
	const cf = (request as Request & { cf?: Record<string, unknown> }).cf ?? {};
	const locale = input.diagnostics.locale;
	const options = { locale } as const;
	const unknown = m.telegram_web_support_unknown({}, options);
	const line = (value: unknown) =>
		typeof value === "string" && value.trim()
			? value.trim().slice(0, 100)
			: unknown;
	const deviceType =
		device.deviceType === "desktop"
			? m.telegram_web_support_device_desktop({}, options)
			: device.deviceType === "phone"
				? m.telegram_web_support_device_phone({}, options)
				: device.deviceType === "tablet"
					? m.telegram_web_support_device_tablet({}, options)
					: m.telegram_web_support_device_unknown({}, options);
	const localizedDevice = device.deviceDetails
		? `${deviceType} · ${device.deviceDetails}`
		: deviceType;
	const ip = trustedClientIp(request);
	return m.telegram_web_support_diagnostics(
		{
			email,
			visitor: input.fingerprint
				? input.fingerprint.visitorId.slice(0, 12)
				: input.visitorId.slice(0, 12),
			repeated: repeated
				? m.telegram_web_support_yes({}, options)
				: m.telegram_web_support_no({}, options),
			browser: device.browser === "Unknown" ? unknown : device.browser,
			system: device.system === "Unknown" ? unknown : device.system,
			device: localizedDevice,
			timeZone: input.diagnostics.timeZone,
			ip: ip === "unknown" ? unknown : ip,
			location: [line(cf.country), line(cf.region), line(cf.city)].join(" · "),
			network: `AS${typeof cf.asn === "number" ? cf.asn : "?"} ${line(cf.asOrganization)}`,
		},
		options,
	);
}

function trustedClientIp(request: Request) {
	if (!(request as Request & { cf?: unknown }).cf) return "unknown";
	return request.headers.get("cf-connecting-ip")?.slice(0, 45) || "unknown";
}

function isMissingTopicError(error: unknown) {
	return (
		error instanceof GrammyError &&
		/(message thread not found|topic_closed|topic deleted)/i.test(
			error.description,
		)
	);
}

function maskEmail(email: string) {
	const [local = "", domain = ""] = email.split("@");
	return `${local.slice(0, 2)}***@${domain}`;
}

function randomToken() {
	return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function base64Url(value: Uint8Array) {
	let binary = "";
	for (const byte of value) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

function cookieValue(request: Request, name: string) {
	const prefix = `${name}=`;
	return (
		request.headers
			.get("cookie")
			?.split(/;\s*/)
			.find((entry) => entry.startsWith(prefix))
			?.slice(prefix.length) ?? null
	);
}

export function webSupportCookie(token: string) {
	return `${webSupportCookieName}=${token}; Path=/api/support/web; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`;
}

/** Explicit website locale, never guessed from message contents or staff language. */
export async function updateWebSupportLocale(
	db: D1Database,
	conversationId: string,
	locale?: "zh-CN" | "en-US",
) {
	if (!locale) return;
	await db
		.prepare(
			"UPDATE telegram_web_support_conversations SET locale=? WHERE id=?",
		)
		.bind(locale, conversationId)
		.run();
}
