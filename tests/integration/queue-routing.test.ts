import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "#/lib/domain-error";
import { handleQueue, isPermanentFailure } from "#/server/queue/routing";
import type { CommerceQueueMessage } from "#/server/queue/types";
import { applyMigrations } from "./migrations";

describe("commerce queue failure policy", { timeout: 30_000 }, () => {
	let miniflare: Miniflare;
	let database: D1Database;

	beforeEach(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: crypto.randomUUID() },
		});
		database = await miniflare.getD1Database("DB");
		await applyMigrations(database);
	});

	afterEach(async () => miniflare.dispose());

	it("lets the throw site decide whether a failure is worth retrying", () => {
		expect(
			isPermanentFailure(new DomainError("delivery_not_found", 404, "")),
		).toBe(true);
		expect(
			isPermanentFailure(new DomainError("refund_not_retryable", 409, "")),
		).toBe(true);
		expect(
			isPermanentFailure(
				new DomainError("delivery_order_conflict", 409, "", {
					retryable: true,
				}),
			),
		).toBe(false);
		expect(
			isPermanentFailure(
				new DomainError("delivery_secret_unavailable", 503, ""),
			),
		).toBe(false);
		expect(
			isPermanentFailure(
				new DomainError("provider_bug", 502, "", { retryable: false }),
			),
		).toBe(true);
		expect(isPermanentFailure(new Error("network"))).toBe(false);
	});

	it("acknowledges and audits a message whose subject no longer exists instead of retrying", async () => {
		const outcomes: string[] = [];
		const message = fakeMessage(
			{
				kind: "commerce.delivery",
				version: 1,
				deliveryId: "missing-delivery",
			},
			outcomes,
		);
		await handleQueue(
			{
				queue: "gmshop-edge-commerce",
				messages: [message],
				ackAll() {},
				retryAll() {},
			} as unknown as MessageBatch<CommerceQueueMessage>,
			{ DB: database } as unknown as Env,
		);
		expect(outcomes).toEqual(["ack"]);
		const audit = await database
			.prepare(
				"SELECT action, target_id, after FROM audit_logs WHERE action = 'queue.message_failed'",
			)
			.first<{ action: string; target_id: string; after: string }>();
		expect(audit?.target_id).toBe("missing-delivery");
		expect(JSON.parse(audit?.after ?? "{}")).toMatchObject({
			kind: "commerce.delivery",
			code: "delivery_not_found",
		});
	});

	it("still retries invalid-shape messages as rejected and transient failures as retried", async () => {
		const outcomes: string[] = [];
		await handleQueue(
			{
				queue: "gmshop-edge-commerce",
				messages: [fakeMessage({ kind: "commerce.bogus" } as never, outcomes)],
				ackAll() {},
				retryAll() {},
			} as unknown as MessageBatch<CommerceQueueMessage>,
			{ DB: database } as unknown as Env,
		);
		expect(outcomes).toEqual(["ack"]);
		expect(
			(
				await database
					.prepare(
						"SELECT COUNT(*) AS total FROM audit_logs WHERE action = 'queue.message_rejected'",
					)
					.first<{ total: number }>()
			)?.total,
		).toBe(1);
	});
});

function fakeMessage(body: CommerceQueueMessage, outcomes: string[]) {
	return {
		id: crypto.randomUUID(),
		timestamp: new Date(),
		attempts: 1,
		body,
		ack: () => outcomes.push("ack"),
		retry: () => outcomes.push("retry"),
	};
}
