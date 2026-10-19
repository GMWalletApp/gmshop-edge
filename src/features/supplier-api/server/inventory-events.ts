import { z } from "zod";
import { signGmshopEdgeRequest } from "#/features/suppliers/providers/signatures";
import { decryptSecret } from "#/lib/secrets";
import { isSafeWebhookUrl } from "#/lib/webhook-url";
import type { InventoryEventQueueMessage } from "#/server/queue/types";
import { loadRuntimeConfig } from "#/server/runtime-config";

const callbackPath = "/api/v1/upstream/callback";
const payloadSchema = z.object({
	sellableItemId: z.uuid(),
	changedAt: z.number().int().nonnegative(),
});
const callbackResponseSchema = z.object({ ok: z.literal(true) });

export async function publishPendingInventoryEvents(
	db: D1Database,
	queue: Queue<InventoryEventQueueMessage>,
	limit = 25,
) {
	const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
	const rows = await db
		.prepare(
			`SELECT id FROM outbox_events
			 WHERE event_type = 'inventory.changed' AND status = 'pending'
			 AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
			 ORDER BY created_at, id LIMIT ?`,
		)
		.bind(Date.now(), boundedLimit)
		.all<{ id: string }>();
	if (rows.results.length === 0) return { published: 0 };
	await queue.sendBatch(
		rows.results.map((row) => ({
			body: {
				kind: "commerce.inventory-event",
				version: 1,
				outboxId: row.id,
			} satisfies InventoryEventQueueMessage,
		})),
	);
	const now = Date.now();
	await db.batch(
		rows.results.map((row) =>
			db
				.prepare(
					`UPDATE outbox_events SET status = 'published', published_at = ?,
					 updated_at = ? WHERE id = ? AND status = 'pending'`,
				)
				.bind(now, now, row.id),
		),
	);
	return { published: rows.results.length };
}

export async function deliverInventoryEvent(
	db: D1Database,
	outboxId: string,
	dependencies: {
		fetcher?: typeof fetch;
		now?: () => number;
	} = {},
) {
	const event = await db
		.prepare(
			`SELECT id, payload FROM outbox_events
			 WHERE id = ? AND event_type = 'inventory.changed' LIMIT 1`,
		)
		.bind(outboxId)
		.first<{ id: string; payload: string }>();
	if (!event) throw new Error("inventory_event_not_found");
	const payload = payloadSchema.parse(JSON.parse(event.payload));
	const runtime = await loadRuntimeConfig(db);
	if (!runtime.commerceSecret)
		throw new Error("inventory_event_secret_unavailable");
	const subscribers = await db
		.prepare(
			`SELECT key_id, secret_encrypted, allowed_callback_origin
			 FROM supplier_api_keys
			 WHERE revoked_at IS NULL AND allowed_callback_origin IS NOT NULL
			 ORDER BY id`,
		)
		.all<{
			key_id: string;
			secret_encrypted: string;
			allowed_callback_origin: string;
		}>();
	const fetcher = dependencies.fetcher ?? fetch;
	const now = dependencies.now?.() ?? Date.now();
	const rawBody = JSON.stringify({
		event: "inventory.changed",
		event_id: event.id,
		timestamp: payload.changedAt,
	});
	let delivered = 0;
	let failed = 0;
	// Each subscriber is isolated: one slow, broken or redirecting partner must
	// not starve the others. The event is a re-sync hint, so a failed delivery
	// is not retried for everyone; the next inventory change notifies again.
	for (const subscriber of subscribers.results) {
		try {
			await notifySubscriber(subscriber);
			delivered++;
		} catch (error) {
			failed++;
			console.warn(
				JSON.stringify({
					event: "inventory_event_callback_failed",
					outboxId: event.id,
					keyId: subscriber.key_id,
					reason: error instanceof Error ? error.message : "unknown",
				}),
			);
		}
	}
	return { delivered, failed };

	async function notifySubscriber(subscriber: {
		key_id: string;
		secret_encrypted: string;
		allowed_callback_origin: string;
	}) {
		const target = new URL(callbackPath, subscriber.allowed_callback_origin);
		if (!isSafeWebhookUrl(target.toString()))
			throw new Error("inventory_event_callback_unsafe");
		const timestamp = Math.floor(now / 1000).toString();
		const nonce = crypto.randomUUID();
		const apiSecret = await decryptSecret(
			subscriber.secret_encrypted,
			runtime.commerceSecret,
			"supplier-api-key",
		);
		const response = await fetcher(target, {
			method: "POST",
			// A redirect could bounce the signed request to an unchecked host.
			redirect: "manual",
			headers: {
				"Content-Type": "application/json",
				"GMShop-Edge-Api-Key": subscriber.key_id,
				"GMShop-Edge-Timestamp": timestamp,
				"GMShop-Edge-Nonce": nonce,
				"GMShop-Edge-Signature": signGmshopEdgeRequest({
					method: "POST",
					pathWithQuery: callbackPath,
					timestamp,
					nonce,
					rawBody,
					apiSecret,
				}),
			},
			body: rawBody,
			signal: AbortSignal.timeout(10_000),
		});
		const text = await response.text();
		if (!response.ok || text.length > 16_000)
			throw new Error("inventory_event_callback_failed");
		let result: unknown;
		try {
			result = JSON.parse(text);
		} catch {
			throw new Error("inventory_event_callback_invalid");
		}
		callbackResponseSchema.parse(result);
	}
}
