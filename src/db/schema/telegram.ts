import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { users } from "./auth";
import { timestamps } from "./common";

export const telegramSupportConversations = sqliteTable(
	"telegram_support_conversations",
	{
		id: text("id").primaryKey(),
		supportChatId: text("support_chat_id").notNull(),
		telegramUserId: text("telegram_user_id").notNull(),
		customerChatId: text("customer_chat_id").notNull(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		messageThreadId: integer("message_thread_id"),
		topicName: text("topic_name"),
		status: text("status", {
			enum: ["creating", "active", "closing", "closed"],
		}).notNull(),
		creationLeaseExpiresAt: integer("creation_lease_expires_at", {
			mode: "timestamp_ms",
		}),
		openedAt: integer("opened_at", { mode: "timestamp_ms" }),
		closedAt: integer("closed_at", { mode: "timestamp_ms" }),
		closedReason: text("closed_reason", {
			enum: ["customer", "administrator", "idle_timeout"],
		}),
		lastActivityAt: integer("last_activity_at", { mode: "timestamp_ms" }),
		...timestamps,
	},
	(table) => [
		uniqueIndex("telegram_support_conversations_user_uidx").on(
			table.supportChatId,
			table.telegramUserId,
		),
		uniqueIndex("telegram_support_conversations_topic_uidx").on(
			table.supportChatId,
			table.messageThreadId,
		),
		index("telegram_support_conversations_idle_idx").on(
			table.status,
			table.lastActivityAt,
			table.id,
		),
		check(
			"telegram_support_conversations_topic_check",
			sql`${table.messageThreadId} IS NULL OR ${table.messageThreadId} > 0`,
		),
		check(
			"telegram_support_conversations_status_check",
			sql`${table.status} IN ('creating', 'active', 'closing', 'closed')`,
		),
		check(
			"telegram_support_conversations_closed_reason_check",
			sql`${table.closedReason} IS NULL OR ${table.closedReason} IN ('customer', 'administrator', 'idle_timeout')`,
		),
	],
);

export const telegramSupportAdministrators = sqliteTable(
	"telegram_support_administrators",
	{
		supportChatId: text("support_chat_id").notNull(),
		telegramUserId: text("telegram_user_id").notNull(),
		status: text("status", { enum: ["creator", "administrator"] }).notNull(),
		...timestamps,
	},
	(table) => [
		uniqueIndex("telegram_support_administrators_identity_uidx").on(
			table.supportChatId,
			table.telegramUserId,
		),
		index("telegram_support_administrators_chat_idx").on(table.supportChatId),
	],
);

export const telegramWebSupportConversations = sqliteTable(
	"telegram_web_support_conversations",
	{
		id: text("id").primaryKey(),
		supportChatId: text("support_chat_id").notNull(),
		visitorId: text("visitor_id").notNull(),
		userId: text("user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		emailEncrypted: text("email_encrypted").notNull(),
		emailHash: text("email_hash").notNull(),
		sessionTokenHash: text("session_token_hash").notNull(),
		fingerprintHash: text("fingerprint_hash"),
		fingerprintVersion: text("fingerprint_version"),
		fingerprintKeyId: text("fingerprint_key_id"),
		publicKeyJwk: text("public_key_jwk").notNull(),
		locale: text("locale", { enum: ["zh-CN", "en-US"] }),
		messageThreadId: integer("message_thread_id"),
		topicName: text("topic_name"),
		status: text("status", {
			enum: ["creating", "active", "closing", "closed"],
		}).notNull(),
		creationLeaseExpiresAt: integer("creation_lease_expires_at", {
			mode: "timestamp_ms",
		}),
		nextReplySequence: integer("next_reply_sequence").notNull().default(1),
		openedAt: integer("opened_at", { mode: "timestamp_ms" }),
		closedAt: integer("closed_at", { mode: "timestamp_ms" }),
		closedReason: text("closed_reason", {
			enum: ["customer", "administrator", "idle_timeout"],
		}),
		lastActivityAt: integer("last_activity_at", { mode: "timestamp_ms" }),
		feishuAlertedAt: integer("feishu_alerted_at", { mode: "timestamp_ms" }),
		...timestamps,
	},
	(table) => [
		uniqueIndex("telegram_web_support_conversations_visitor_uidx").on(
			table.supportChatId,
			table.visitorId,
		),
		uniqueIndex("telegram_web_support_conversations_session_uidx").on(
			table.sessionTokenHash,
		),
		uniqueIndex("telegram_web_support_conversations_topic_uidx").on(
			table.supportChatId,
			table.messageThreadId,
		),
		index("telegram_web_support_conversations_fingerprint_idx").on(
			table.fingerprintHash,
		),
		index("telegram_web_support_conversations_idle_idx").on(
			table.status,
			table.lastActivityAt,
			table.id,
		),
		check(
			"telegram_web_support_conversations_topic_check",
			sql`${table.messageThreadId} IS NULL OR ${table.messageThreadId} > 0`,
		),
		check(
			"telegram_web_support_conversations_status_check",
			sql`${table.status} IN ('creating', 'active', 'closing', 'closed')`,
		),
	],
);

export const telegramWebSupportReplies = sqliteTable(
	"telegram_web_support_replies",
	{
		id: text("id").primaryKey(),
		conversationId: text("conversation_id")
			.notNull()
			.references(() => telegramWebSupportConversations.id, {
				onDelete: "cascade",
			}),
		sequence: integer("sequence").notNull(),
		isAwayReply: integer("is_away_reply", { mode: "boolean" })
			.notNull()
			.default(false),
		algorithm: text("algorithm").notNull(),
		wrappedKey: text("wrapped_key").notNull(),
		iv: text("iv").notNull(),
		ciphertext: text("ciphertext").notNull(),
		expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [
		uniqueIndex("telegram_web_support_replies_sequence_uidx").on(
			table.conversationId,
			table.sequence,
		),
		index("telegram_web_support_replies_expiry_idx").on(
			table.expiresAt,
			table.id,
		),
	],
);

export const telegramWebSupportSends = sqliteTable(
	"telegram_web_support_sends",
	{
		id: text("id").primaryKey(),
		conversationId: text("conversation_id")
			.notNull()
			.references(() => telegramWebSupportConversations.id, {
				onDelete: "cascade",
			}),
		clientMessageId: text("client_message_id").notNull(),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [
		uniqueIndex("telegram_web_support_sends_message_uidx").on(
			table.conversationId,
			table.clientMessageId,
		),
		index("telegram_web_support_sends_created_idx").on(
			table.createdAt,
			table.id,
		),
	],
);

export const telegramWebSupportAttachments = sqliteTable(
	"telegram_web_support_attachments",
	{
		id: text("id").primaryKey(),
		conversationId: text("conversation_id")
			.notNull()
			.references(() => telegramWebSupportConversations.id),
		sourceKey: text("source_key").notNull(),
		name: text("name").notNull(),
		mime: text("mime").notNull(),
		size: integer("size").notNull(),
		status: text("status", { enum: ["pending", "sent"] }).notNull(),
		createdAt: integer("created_at").notNull(),
		expiresAt: integer("expires_at").notNull(),
	},
	(table) => [
		uniqueIndex("telegram_web_support_attachments_source_uidx").on(
			table.conversationId,
			table.sourceKey,
		),
		index("telegram_web_support_attachments_expiry_idx").on(
			table.expiresAt,
			table.id,
		),
		check(
			"telegram_web_support_attachments_status_check",
			sql`${table.status} IN ('pending','sent')`,
		),
	],
);
