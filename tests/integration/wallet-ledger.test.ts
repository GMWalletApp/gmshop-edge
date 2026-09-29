import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requestShopRefund } from "#/features/shop-payments/server/refunds";
import {
	completeWalletStoreOrder,
	processShopPaymentEvent,
} from "#/features/shop-payments/server/service";
import {
	loadWalletSnapshot,
	mutateWallet,
	walletMutationStatements,
} from "#/features/wallet/server/ledger";
import { applyMigrations } from "./migrations";

describe("user wallet ledger", { timeout: 30_000 }, () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeEach(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: crypto.randomUUID() },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await db
			.prepare(
				`INSERT INTO users (id, name, email, email_verified, enabled, created_at, updated_at) VALUES ('00000000-0000-4000-8000-000000000001', 'Buyer', 'buyer@example.com', 1, 1, 1, 1)`,
			)
			.run();
	});

	afterEach(async () => miniflare.dispose());

	it("never records a ledger entry for a balance change that lost the race", async () => {
		const userId = "00000000-0000-4000-8000-000000000001";
		await mutateWallet(db, mutation("credit", "100", "credit-base"));
		// Two writers read the same snapshot; the first one wins.
		const stale = await loadWalletSnapshot(db, userId);
		await mutateWallet(db, mutation("credit", "100", "credit-winner"));
		const loser = walletMutationStatements(
			db,
			mutation("credit", "100", "credit-loser"),
			stale,
			{ now: Date.now() },
		);
		const results = await db.batch([loser.insert, loser.update]);
		expect(results.map((result) => Number(result.meta.changes ?? 0))).toEqual([
			0, 0,
		]);
		const state = await db
			.prepare(
				`SELECT (SELECT balance_minor FROM users WHERE id = ?) AS balance,
				 (SELECT COUNT(*) FROM wallet_entries) AS entries,
				 (SELECT COUNT(*) FROM wallet_entries WHERE idempotency_key = 'credit-loser') AS phantom`,
			)
			.bind(userId)
			.first<Record<string, unknown>>();
		expect(state).toEqual({ balance: "200", entries: 2, phantom: 0 });
		// The retrying writer re-reads and lands on top of the winner.
		await expect(
			mutateWallet(db, mutation("credit", "100", "credit-loser")),
		).resolves.toMatchObject({ balanceMinor: "300", duplicate: false });
	});

	it("keeps balance equal to the ledger under concurrent mutations", async () => {
		const userId = "00000000-0000-4000-8000-000000000001";
		await Promise.all(
			Array.from({ length: 6 }, (_, index) =>
				mutateWallet(db, mutation("credit", "10", `concurrent-${index}`)),
			),
		);
		const state = await db
			.prepare(
				`SELECT (SELECT balance_minor FROM users WHERE id = ?) AS balance,
				 (SELECT COUNT(*) FROM wallet_entries) AS entries,
				 (SELECT balance_after_minor FROM wallet_entries ORDER BY created_at DESC, id DESC LIMIT 1) AS last_after`,
			)
			.bind(userId)
			.first<Record<string, unknown>>();
		expect(state).toMatchObject({ balance: "60", entries: 6 });
		const chain = await db
			.prepare(
				"SELECT balance_before_minor, balance_after_minor FROM wallet_entries ORDER BY CAST(balance_after_minor AS INTEGER)",
			)
			.all<{ balance_before_minor: string; balance_after_minor: string }>();
		let expected = 0n;
		for (const entry of chain.results) {
			expect(entry.balance_before_minor).toBe(expected.toString());
			expected += 10n;
			expect(entry.balance_after_minor).toBe(expected.toString());
		}
	});

	it("refunds a wallet-paid order even after the customer account was disabled", async () => {
		const userId = "00000000-0000-4000-8000-000000000001";
		await mutateWallet(db, mutation("credit", "500", "credit-disabled"));
		await db
			.prepare(`INSERT INTO shop_orders
		 (id, order_number, idempotency_key, user_id, contact_email,
		  normalized_contact_email, locale, status, currency, currency_decimals,
		  subtotal_minor, discount_minor, total_minor, paid_minor, version,
		  expires_at, created_at, updated_at)
		 VALUES ('00000000-0000-4000-8000-000000000030', 'ORDER-0003', 'order-0003',
		  ?, 'buyer@example.com', 'buyer@example.com', 'en-US', 'pending_payment',
		  'USD', 2, '300', '0', '300', '0', 1, 9999999999999, 1, 1)`)
			.bind(userId)
			.run();
		await completeWalletStoreOrder(db, {
			orderId: "00000000-0000-4000-8000-000000000030",
			userId,
		});
		await db
			.prepare("UPDATE users SET enabled = 0 WHERE id = ?")
			.bind(userId)
			.run();
		await expect(
			requestShopRefund(
				db,
				{
					orderId: "00000000-0000-4000-8000-000000000030",
					amountMinor: "300",
					reason: "Refund owed to a suspended customer",
					idempotencyKey: "wallet-refund-disabled",
				},
				{
					actorUserId: userId,
					request: new Request("https://shop.example.com/admin/orders"),
				},
			),
		).resolves.toMatchObject({ status: "succeeded" });
		const state = await db
			.prepare(
				`SELECT (SELECT balance_minor FROM users WHERE id = ?) AS balance,
				 (SELECT status FROM shop_orders WHERE id = '00000000-0000-4000-8000-000000000030') AS status`,
			)
			.bind(userId)
			.first();
		expect(state).toEqual({ balance: "500", status: "refunded" });
	});

	it("keeps the user balance and immutable entries consistent", async () => {
		await mutateWallet(db, mutation("credit", "50", "credit-0001"));
		await mutateWallet(db, mutation("credit", "70", "credit-0002"));
		const replay = await mutateWallet(
			db,
			mutation("credit", "70", "credit-0002"),
		);
		expect(replay.duplicate).toBe(true);
		await expect(
			mutateWallet(db, mutation("debit", "121", "debit-0001")),
		).rejects.toThrow(/Insufficient balance/);
		const user = await db
			.prepare(
				"SELECT balance_minor FROM users WHERE id = '00000000-0000-4000-8000-000000000001'",
			)
			.first<{ balance_minor: string }>();
		const entries = await db
			.prepare(
				"SELECT direction, amount_minor, balance_before_minor, balance_after_minor FROM wallet_entries ORDER BY created_at, id",
			)
			.all();
		expect(user?.balance_minor).toBe("120");
		expect(entries.results).toHaveLength(2);
	});

	it("pays a storefront order from the same balance exactly once", async () => {
		await mutateWallet(db, mutation("credit", "500", "credit-order"));
		await db
			.prepare(`INSERT INTO shop_orders
		 (id, order_number, idempotency_key, user_id, contact_email,
		  normalized_contact_email, locale, status, currency, currency_decimals,
		  subtotal_minor, discount_minor, total_minor, paid_minor, version,
		  expires_at, created_at, updated_at)
		 VALUES ('00000000-0000-4000-8000-000000000010', 'ORDER-0001', 'order-0001',
		  '00000000-0000-4000-8000-000000000001', 'buyer@example.com',
		  'buyer@example.com', 'en-US', 'pending_payment', 'USD', 2,
		  '300', '0', '300', '0', 1, 9999999999999, 1, 1)`)
			.run();
		const first = await completeWalletStoreOrder(db, {
			orderId: "00000000-0000-4000-8000-000000000010",
			userId: "00000000-0000-4000-8000-000000000001",
		});
		const replay = await completeWalletStoreOrder(db, {
			orderId: "00000000-0000-4000-8000-000000000010",
			userId: "00000000-0000-4000-8000-000000000001",
		});
		expect(first.duplicate).toBe(false);
		expect(replay.duplicate).toBe(true);
		const state = await db
			.prepare(`SELECT
		 (SELECT balance_minor FROM users WHERE id = '00000000-0000-4000-8000-000000000001') AS balance,
		 (SELECT status FROM shop_orders WHERE id = '00000000-0000-4000-8000-000000000010') AS status,
		 (SELECT COUNT(*) FROM wallet_entries WHERE idempotency_key = 'wallet-order:00000000-0000-4000-8000-000000000010') AS debits`)
			.first();
		expect(state).toEqual({ balance: "200", status: "paid", debits: 1 });
		const refund = await requestShopRefund(
			db,
			{
				orderId: "00000000-0000-4000-8000-000000000010",
				amountMinor: "300",
				reason: "Test wallet refund",
				idempotencyKey: "wallet-refund-order-0001",
			},
			{
				actorUserId: "00000000-0000-4000-8000-000000000001",
				request: new Request("https://shop.example.com/admin/orders"),
			},
		);
		expect(refund.status).toBe("succeeded");
		const refunded = await db
			.prepare(`SELECT
		 (SELECT balance_minor FROM users WHERE id = '00000000-0000-4000-8000-000000000001') AS balance,
		 (SELECT status FROM shop_orders WHERE id = '00000000-0000-4000-8000-000000000010') AS status,
		 (SELECT COUNT(*) FROM wallet_entries WHERE source_type = 'refund') AS credits`)
			.first();
		expect(refunded).toEqual({
			balance: "500",
			status: "refunded",
			credits: 1,
		});
	});

	it("credits a paid top-up once when its webhook is replayed", async () => {
		await db.batch([
			db.prepare(`INSERT INTO payment_channels
			 (id, provider, name, currency, enabled, created_at, updated_at)
			 VALUES ('00000000-0000-4000-8000-000000000020', 'mock', 'Mock', 'USD', 1, 1, 1)`),
			db.prepare(`INSERT INTO wallet_topups
			 (id, user_id, amount_minor, currency, currency_decimals, status,
			  idempotency_key, created_at, updated_at)
			 VALUES ('00000000-0000-4000-8000-000000000021',
			  '00000000-0000-4000-8000-000000000001', '250', 'USD', 2,
			  'pending', 'topup-test-0001', 1, 1)`),
			db.prepare(`INSERT INTO payment_attempts
			 (id, wallet_topup_id, channel_id, provider_payment_id, idempotency_key,
			  status, amount_minor, currency, currency_decimals, created_at, updated_at)
			 VALUES ('00000000-0000-4000-8000-000000000022',
			  '00000000-0000-4000-8000-000000000021',
			  '00000000-0000-4000-8000-000000000020', 'provider-topup-1',
			  'topup-attempt-0001', 'pending', '250', 'USD', 2, 1, 1)`),
		]);
		const event = {
			providerEventId: "topup-event-1",
			providerPaymentId: "provider-topup-1",
			type: "payment_succeeded" as const,
			amountMinor: "250",
			currency: "USD",
			payloadDigest: "digest-topup-event-1",
		};
		await processShopPaymentEvent(
			db,
			"00000000-0000-4000-8000-000000000020",
			event,
		);
		const replay = await processShopPaymentEvent(
			db,
			"00000000-0000-4000-8000-000000000020",
			event,
		);
		expect(replay.duplicate).toBe(true);
		const state = await db
			.prepare(`SELECT
		 (SELECT balance_minor FROM users WHERE id = '00000000-0000-4000-8000-000000000001') AS balance,
		 (SELECT status FROM wallet_topups WHERE id = '00000000-0000-4000-8000-000000000021') AS topup_status,
		 (SELECT COUNT(*) FROM wallet_entries WHERE source_type = 'topup') AS credits`)
			.first();
		expect(state).toEqual({ balance: "250", topup_status: "paid", credits: 1 });
	});

	function mutation(
		direction: "credit" | "debit",
		amountMinor: string,
		idempotencyKey: string,
	) {
		return {
			userId: "00000000-0000-4000-8000-000000000001",
			direction,
			amountMinor,
			currency: "USD",
			sourceType: "adjustment" as const,
			sourceId: "test",
			idempotencyKey,
		};
	}
});
