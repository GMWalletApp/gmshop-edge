import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupWebSupport } from "#/features/telegram/server/maintenance";
import {
	closeWebConversationFromTopic,
	webSupportRetentionMs,
} from "#/features/telegram/server/web-support";
import { applyMigrations } from "./migrations";

const supportChatId = "-1001234567890";
const now = 10 * webSupportRetentionMs;

describe("web support fingerprint retention", () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmshop-edge-telegram-web-support-retention" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await db.batch([
			conversation(
				db,
				"stale-active",
				"active",
				now - webSupportRetentionMs,
				11,
			),
			conversation(
				db,
				"fresh-active",
				"active",
				now - webSupportRetentionMs + 1,
				12,
			),
			conversation(db, "stale-creating", "creating", null, null),
			conversation(db, "admin-closed", "active", now, 13),
			db
				.prepare(
					`INSERT INTO telegram_web_support_sends
					 (id, conversation_id, client_message_id, created_at)
					 VALUES ('old-send', 'fresh-active', 'c1', ?), ('new-send', 'fresh-active', 'c2', ?)`,
				)
				.bind(now - webSupportRetentionMs, now),
		]);
	});

	afterAll(async () => miniflare.dispose());

	it("clears the fingerprint hash when an administrator closes the topic", async () => {
		const closed = await closeWebConversationFromTopic(db, supportChatId, 13);
		expect(Number(closed.meta.changes)).toBe(1);
		await expect(fingerprintHashes(db)).resolves.toMatchObject({
			"admin-closed": null,
			"fresh-active": "fp-fresh-active",
		});
	});

	it("purges fingerprint hashes beyond retention while keeping fresh ones", async () => {
		await expect(cleanupWebSupport(db, now)).resolves.toEqual({
			replies: 0,
			sends: 1,
			fingerprints: 2,
		});
		await expect(fingerprintHashes(db)).resolves.toEqual({
			"admin-closed": null,
			"fresh-active": "fp-fresh-active",
			"stale-active": null,
			"stale-creating": null,
		});
		const sends = await db
			.prepare("SELECT id FROM telegram_web_support_sends ORDER BY id")
			.all<{ id: string }>();
		expect(sends.results).toEqual([{ id: "new-send" }]);
		await expect(cleanupWebSupport(db, now)).resolves.toEqual({
			replies: 0,
			sends: 0,
			fingerprints: 0,
		});
	});
});

function conversation(
	db: D1Database,
	id: string,
	status: string,
	lastActivityAt: number | null,
	threadId: number | null,
) {
	return db
		.prepare(
			`INSERT INTO telegram_web_support_conversations
			 (id, support_chat_id, visitor_id, email_encrypted, email_hash, session_token_hash,
			  fingerprint_hash, public_key_jwk, message_thread_id, status, last_activity_at,
			  created_at, updated_at)
			 VALUES (?, ?, ?, 'ciphertext', 'email-hash', ?, ?, '{}', ?, ?, ?, 1, 1)`,
		)
		.bind(
			id,
			supportChatId,
			id,
			`session-${id}`,
			`fp-${id}`,
			threadId,
			status,
			lastActivityAt,
		);
}

async function fingerprintHashes(db: D1Database) {
	const rows = await db
		.prepare(
			"SELECT id, fingerprint_hash FROM telegram_web_support_conversations ORDER BY id",
		)
		.all<{ id: string; fingerprint_hash: string | null }>();
	return Object.fromEntries(
		rows.results.map((row) => [row.id, row.fingerprint_hash]),
	);
}
