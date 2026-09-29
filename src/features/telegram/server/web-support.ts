import { Api, GrammyError } from "grammy";
import { z } from "zod";
import { isInternalIdentityEmail } from "#/features/auth/identity-email";
import { getStoreSessionUser } from "#/features/storefront/server/account";
import { encryptSecret } from "#/lib/secrets";
import { m } from "#/paraglide/messages";
import { clientIp } from "#/server/client-ip";
import { claimFixedWindowRateLimit } from "#/server/rate-limit";
import { loadTelegramSettings } from "../settings";
import {
	describeDevice,
	parseDevice,
	type webSupportConversationSchema,
	type webSupportMessageSchema,
} from "../web-support-contract";
import { telegramDataKeyId } from "./secret";
import { telegramRuntime } from "./sync";

const encoder = new TextEncoder();
/**
 * Retention for web-support runtime rows: encrypted replies awaiting pickup,
 * send receipts, and the keyed device-fingerprint hash of a conversation.
 */
export const webSupportRetentionMs = 86_400_000;
export const webSupportCookieName = "gmshop_web_support";

export class WebSupportError extends Error {
	constructor(
		readonly code: string,
		readonly status: number,
	) {
		super(code);
	}
}

type WebConversation = {
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
	if (existingSession)
		return reopenExisting(db, provider.telegramBotToken, existingSession);

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
			  next_reply_sequence, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'creating', ?, 1, ?, ?)`,
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
			JSON.stringify(input.publicKeyJwk),
			topicName,
			now + 30_000,
			now,
			now,
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
			formatDiagnostics(request, email, input, { repeated, fingerprint }),
			{ message_thread_id: topic.message_thread_id },
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
	const replies = await db
		.prepare(
			`SELECT id, sequence, algorithm, wrapped_key, iv, ciphertext, created_at
			 FROM telegram_web_support_replies WHERE conversation_id = ? AND sequence > ?
			 AND expires_at > ? ORDER BY sequence LIMIT 100`,
		)
		.bind(conversation.id, after, Date.now())
		.all();
	return { status: conversation.status, replies: replies.results };
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
		});
		await touchWebConversation(db, conversation.id);
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

export async function acknowledgeWebSupportReplies(
	db: D1Database,
	request: Request,
	ids: string[],
) {
	const conversation = await requireConversation(db, request);
	const placeholders = ids.map(() => "?").join(",");
	await db
		.prepare(
			`DELETE FROM telegram_web_support_replies WHERE conversation_id = ? AND id IN (${placeholders})`,
		)
		.bind(conversation.id, ...ids)
		.run();
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
		 fingerprint_hash = NULL, closed_at = ?, updated_at = ? WHERE id = ?`,
		)
		.bind(now, now, conversation.id)
		.run();
	return { status: "closed" as const };
}

export async function storeWebAdministratorReply(
	db: D1Database,
	conversation: WebConversation,
	message: string,
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
	const envelope = await encryptForBrowser(
		JSON.parse(conversation.public_key_jwk) as JsonWebKey,
		conversation.id,
		sequence,
		message,
	);
	const now = Date.now();
	await db.batch([
		db
			.prepare(
				`INSERT INTO telegram_web_support_replies
			 (id, conversation_id, sequence, algorithm, wrapped_key, iv, ciphertext, expires_at, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				crypto.randomUUID(),
				conversation.id,
				sequence,
				envelope.algorithm,
				envelope.wrappedKey,
				envelope.iv,
				envelope.ciphertext,
				now + webSupportRetentionMs,
				now,
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
		 fingerprint_hash = NULL, closed_at = ?, updated_at = ? WHERE support_chat_id = ? AND message_thread_id = ? AND status = 'active'`,
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

async function requireConversation(db: D1Database, request: Request) {
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

/**
 * Administrator-facing summary posted into the new support topic. The visitor
 * reference is a prefix of the stored keyed fingerprint hash (or of the client
 * conversation UUID); the raw FingerprintJS identifier never leaves the server.
 */
function formatDiagnostics(
	request: Request,
	email: string,
	input: z.infer<typeof webSupportConversationSchema>,
	visitor: { repeated: boolean; fingerprint: string | null },
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
	const ip = trustedClientIp(request);
	return m.telegram_web_support_diagnostics(
		{
			email,
			visitor: (visitor.fingerprint ?? input.visitorId).slice(0, 12),
			repeated: visitor.repeated
				? m.telegram_web_support_yes({}, options)
				: m.telegram_web_support_no({}, options),
			browser: device.browser ?? unknown,
			system: device.system ?? unknown,
			device: describeDevice(device, locale),
			timeZone: input.diagnostics.timeZone,
			ip: ip === "unknown" ? unknown : ip,
			location: [line(cf.country), line(cf.region), line(cf.city)].join(" · "),
			network: `AS${typeof cf.asn === "number" ? cf.asn : "?"} ${line(cf.asOrganization)}`,
		},
		options,
	);
}

function trustedClientIp(request: Request) {
	return clientIp(request) ?? "unknown";
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
