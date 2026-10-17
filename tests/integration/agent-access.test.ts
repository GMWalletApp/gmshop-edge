import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	agentAccessProducts,
	agentAccessRefundPolicy,
} from "#/features/agent-access/products";
import { prepareAgentCheckout } from "#/features/agent-access/server/checkout";
import {
	assertAgentRefundAmount,
	processAgentDelivery,
	reconcileAgentAccess,
} from "#/features/agent-access/server/fulfillment";
import { prepareAgentProducts } from "#/features/agent-access/server/products";
import { reserveOrderBalance } from "#/features/promotions/server/balance";
import { openAfterSaleCase } from "#/features/shop-orders/server/after-sales";
import { requestShopRefund } from "#/features/shop-payments/server/refunds";
import {
	completeFreeStoreOrder,
	completeWalletStoreOrder,
} from "#/features/shop-payments/server/service";
import { createMultiStoreOrder } from "#/features/storefront/server/multi-order";
import { applyMigrations } from "./migrations";

const { remote } = vi.hoisted(() => ({ remote: vi.fn() }));
vi.mock("#/features/agent-access/server/client", async (original) => ({
	...(await original<typeof import("#/features/agent-access/server/client")>()),
	callAgent: remote,
}));
const userId = "a1111111-1111-4111-8111-111111111111";
const items = [{ sellableItemId: agentAccessProducts.api.itemId, quantity: 1 }];
describe("paid agent access", { timeout: 30000 }, () => {
	let mf: Miniflare;
	let db: D1Database;
	beforeEach(async () => {
		mf = new Miniflare({
			modules: true,
			script: "export default {fetch(){return new Response('ok')}}",
			d1Databases: { DB: crypto.randomUUID() },
		});
		db = await mf.getD1Database("DB");
		await applyMigrations(db);
		await db
			.prepare(
				"INSERT INTO users(id,name,email,email_verified,enabled,balance_minor,balance_version) VALUES (?,'Buyer','buyer@example.test',1,1,'50000',1)",
			)
			.bind(userId)
			.run();
		await db
			.prepare(
				`INSERT INTO system_settings(key,value) VALUES ('agent_access.enabled','true'),('commerce.default_currency','"CNY"'),('runtime.data_encryption_secret','"test-access-data-secret-32-characters"')`,
			)
			.run();
		await prepareAgentProducts(db);
		await db.prepare("UPDATE products SET status='active'").run();
		remote.mockReset();
		remote.mockImplementation(async (input: { operation: string }) =>
			input.operation === "check"
				? { state: "eligible" }
				: input.operation === "revoke"
					? { state: "revoked" }
					: { state: "active", userId: 71 },
		);
	}, 30000);
	afterEach(async () => {
		await mf.dispose();
	});
	const make = async (db: D1Database, key: string = crypto.randomUUID()) =>
		createMultiStoreOrder(
			db,
			{
				items,
				email: "buyer@example.test",
				idempotencyKey: key,
				agentAccessTermsAccepted: true,
			},
			{ userId },
		);
	async function paid() {
		const order = await make(db);
		await completeWalletStoreOrder(db, { orderId: order.id, userId });
		const d = await db
			.prepare(
				"SELECT d.id,d.order_item_id FROM delivery_records d JOIN shop_order_items oi ON oi.id=d.order_item_id WHERE oi.order_id=?",
			)
			.bind(order.id)
			.first<{ id: string; order_item_id: string }>();
		if (!d) throw new Error("no delivery");
		return { order, ...d };
	}
	it("persists encrypted initial credentials before remote provision and reuses them after a lost response", async () => {
		const d = await paid();
		let firstPassword = "";
		remote.mockImplementation(
			async (input: { operation: string; initialPassword?: string }) => {
				firstPassword = input.initialPassword ?? "";
				throw new Error("lost response");
			},
		);
		await expect(processAgentDelivery(db, d.id)).rejects.toThrow();
		expect(firstPassword).toMatch(/^Aa1![a-f0-9]{48}$/);
		const encrypted = await db
			.prepare(
				"SELECT initial_password_encrypted FROM agent_access_orders WHERE order_item_id=?",
			)
			.bind(d.order_item_id)
			.first<string>("initial_password_encrypted");
		expect(encrypted).toBeTruthy();
		expect(encrypted).not.toContain(firstPassword);
		await db
			.prepare(
				"UPDATE agent_access_orders SET next_attempt_at=0 WHERE order_item_id=?",
			)
			.bind(d.order_item_id)
			.run();
		remote.mockImplementation(async (input: { initialPassword?: string }) => {
			expect(input.initialPassword).toBe(firstPassword);
			return { state: "active", userId: 71, initialPasswordValid: true };
		});
		await processAgentDelivery(db, d.id);
		expect(
			await db
				.prepare(
					"SELECT initial_password_encrypted FROM agent_access_orders WHERE order_item_id=?",
				)
				.bind(d.order_item_id)
				.first("initial_password_encrypted"),
		).toBe(encrypted);
		expect(
			await db
				.prepare("SELECT status FROM shop_orders WHERE id=?")
				.bind(d.order.id)
				.first("status"),
		).toBe("completed");
	});
	it("discards unused initial credentials when provisioning an existing account", async () => {
		const d = await paid();
		await processAgentDelivery(db, d.id);
		expect(
			await db
				.prepare(
					"SELECT initial_password_encrypted FROM agent_access_orders WHERE order_item_id=?",
				)
				.bind(d.order_item_id)
				.first("initial_password_encrypted"),
		).toBeNull();
	});

	it("creates only drafts, idempotently; never alters existing product price", async () => {
		await db
			.prepare(
				"UPDATE product_sellable_items SET price_minor='1234' WHERE id=?",
			)
			.bind(agentAccessProducts.api.itemId)
			.run();
		await prepareAgentProducts(db);
		expect(
			await db
				.prepare("SELECT price_minor FROM product_sellable_items WHERE id=?")
				.bind(agentAccessProducts.api.itemId)
				.first("price_minor"),
		).toBe("1234");
		expect(
			await db.prepare("SELECT COUNT(*) AS n FROM products").first("n"),
		).toBe(2);
	});
	it("rejects guests, unverified email, coupons, mixed carts, duplicates and disabled sales", async () => {
		await expect(prepareAgentCheckout(db, { items })).rejects.toMatchObject({
			code: "authentication_required",
		});
		await db
			.prepare("UPDATE users SET email_verified=0 WHERE id=?")
			.bind(userId)
			.run();
		await expect(make(db)).rejects.toMatchObject({
			code: "agent_access_email_verification",
		});
		await db
			.prepare("UPDATE users SET email_verified=1 WHERE id=?")
			.bind(userId)
			.run();
		await expect(
			prepareAgentCheckout(db, { items, couponCode: "TEST" }, userId),
		).rejects.toMatchObject({ code: "agent_access_checkout_invalid" });
		await expect(
			prepareAgentCheckout(
				db,
				{
					items: [
						...items,
						{ sellableItemId: agentAccessProducts.subsite.itemId, quantity: 1 },
					],
				},
				userId,
			),
		).rejects.toMatchObject({ code: "agent_access_checkout_invalid" });
		const o = await make(db, "same-order-key");
		expect((await make(db, "same-order-key")).id).toBe(o.id);
		await expect(make(db)).rejects.toMatchObject({
			code: "agent_access_existing_order",
		});
		await db
			.prepare(
				"UPDATE system_settings SET value='false' WHERE key='agent_access.enabled'",
			)
			.run();
		await expect(
			prepareAgentCheckout(db, { items }, userId),
		).rejects.toMatchObject({ code: "agent_access_disabled" });
	});
	it("blocks binding-required and already-active accounts before charging", async () => {
		remote.mockResolvedValue({ state: "binding_required" });
		await expect(make(db)).rejects.toMatchObject({
			code: "agent_access_binding_required",
		});
		remote.mockResolvedValue({ state: "already_active" });
		await expect(make(db)).rejects.toMatchObject({
			code: "agent_access_already_active",
		});
		expect(
			await db.prepare("SELECT COUNT(*) AS n FROM shop_orders").first("n"),
		).toBe(0);
	});
	it("claims the single qualification atomically under concurrent checkout", async () => {
		const settled = await Promise.allSettled([make(db), make(db)]);
		expect(settled.filter((x) => x.status === "fulfilled")).toHaveLength(1);
		expect(
			await db.prepare("SELECT COUNT(*) AS n FROM shop_orders").first("n"),
		).toBe(1);
	});
	it("payment queues activation; readback completes once, without another wallet charge", async () => {
		const { order, id, order_item_id } = await paid();
		expect(
			await db
				.prepare(
					"SELECT status FROM customer_entitlements WHERE order_item_id=?",
				)
				.bind(order_item_id)
				.first("status"),
		).toBe("pending");
		const before = await db
			.prepare("SELECT balance_minor FROM users WHERE id=?")
			.bind(userId)
			.first("balance_minor");
		expect(await processAgentDelivery(db, id)).toMatchObject({
			status: "delivered",
		});
		expect(await processAgentDelivery(db, id)).toMatchObject({
			status: "delivered",
		});
		expect(
			remote.mock.calls.filter(([r]) => r.operation === "provision"),
		).toHaveLength(1);
		expect(
			await db
				.prepare("SELECT status FROM shop_orders WHERE id=?")
				.bind(order.id)
				.first("status"),
		).toBe("completed");
		expect(
			await db
				.prepare(
					"SELECT status FROM customer_entitlements WHERE order_item_id=?",
				)
				.bind(order_item_id)
				.first("status"),
		).toBe("active");
		expect(
			await db
				.prepare("SELECT balance_minor FROM users WHERE id=?")
				.bind(userId)
				.first("balance_minor"),
		).toBe(before);
	});
	it("unpaid order never triggers a remote grant", async () => {
		const order = await make(db);
		await db
			.prepare(
				"INSERT INTO delivery_records(id,order_item_id,delivery_type,request_key,status) SELECT 'unpaid',id,'automation','unpaid','pending' FROM shop_order_items WHERE order_id=?",
			)
			.bind(order.id)
			.run();
		expect(await processAgentDelivery(db, "unpaid")).toMatchObject({
			status: "waiting",
		});
		expect(
			remote.mock.calls.filter(([r]) => r.operation === "provision"),
		).toHaveLength(0);
	});
	it("lost response retries the same order item and can recover from the scheduler", async () => {
		const { id, order_item_id } = await paid();
		remote.mockRejectedValueOnce(new Error("lost response"));
		await expect(processAgentDelivery(db, id)).rejects.toMatchObject({
			code: "agent_access_pending",
		});
		await db.prepare("UPDATE agent_access_orders SET next_attempt_at=0").run();
		await reconcileAgentAccess(db);
		const calls = remote.mock.calls.filter(
			([r]) => r.operation === "provision",
		);
		expect(calls).toHaveLength(2);
		expect(calls.every(([r]) => r.orderItemId === order_item_id)).toBe(true);
	});
	it("refund racing remote grant cannot publish delivery; reconciliation revokes exactly that grant", async () => {
		const { id, order_item_id, order } = await paid();
		remote.mockImplementationOnce(async () => {
			await db
				.prepare("UPDATE shop_orders SET status='refunded' WHERE id=?")
				.bind(order.id)
				.run();
			return { state: "active", userId: 71 };
		});
		expect(await processAgentDelivery(db, id)).toMatchObject({
			status: "processing",
		});
		expect(
			await db
				.prepare("SELECT status FROM delivery_records WHERE id=?")
				.bind(id)
				.first("status"),
		).toBe("pending");
		await reconcileAgentAccess(db);
		expect(
			remote.mock.calls.some(
				([r]) => r.operation === "revoke" && r.orderItemId === order_item_id,
			),
		).toBe(true);
		expect(
			await db
				.prepare("SELECT state FROM agent_access_orders WHERE order_item_id=?")
				.bind(order_item_id)
				.first("state"),
		).toBe("revoked");
	});

	it("reward-funded qualification keeps exact price, earns no reward and refunds each source", async () => {
		await db
			.prepare("UPDATE users SET reward_balance_minor='500' WHERE id=?")
			.bind(userId)
			.run();
		const order = await make(db);
		const cashBefore = await db
			.prepare("SELECT balance_minor FROM users WHERE id=?")
			.bind(userId)
			.first<string>("balance_minor");
		expect(await reserveOrderBalance(db, order.id, userId)).toMatchObject({
			reward_minor: "500",
			cash_minor: (
				BigInt(agentAccessProducts.api.priceMinor) - 500n
			).toString(),
			external_minor: "0",
		});
		await completeFreeStoreOrder(db, order.id, userId);
		const delivery = await db
			.prepare(
				"SELECT d.id FROM delivery_records d JOIN shop_order_items oi ON oi.id=d.order_item_id WHERE oi.order_id=?",
			)
			.bind(order.id)
			.first<{ id: string }>();
		if (!delivery) throw new Error("qualification delivery missing");
		await processAgentDelivery(db, delivery.id);
		expect(
			await db
				.prepare("SELECT referral_reward_minor FROM shop_orders WHERE id=?")
				.bind(order.id)
				.first("referral_reward_minor"),
		).toBe("0");
		await requestShopRefund(
			db,
			{
				orderId: order.id,
				amountMinor: agentAccessProducts.api.priceMinor,
				reason: "Verified activation failure",
				idempotencyKey: "combined-reward-agent-refund",
			},
			{
				actorUserId: userId,
				request: new Request("https://shop.example/admin"),
			},
		);
		await reconcileAgentAccess(db);
		expect(
			await db
				.prepare(
					"SELECT balance_minor,reward_balance_minor FROM users WHERE id=?",
				)
				.bind(userId)
				.first(),
		).toMatchObject({ balance_minor: cashBefore, reward_balance_minor: "500" });
		expect(
			await db
				.prepare("SELECT state FROM agent_access_orders WHERE user_id=?")
				.bind(userId)
				.first("state"),
		).toBe("revoked");
	});
	it("wallet refund uses existing payment ledger then revokes remotely", async () => {
		const { id, order } = await paid();
		await processAgentDelivery(db, id);
		await expect(
			assertAgentRefundAmount(db, order.id, "1"),
		).rejects.toMatchObject({ code: "agent_access_full_refund_required" });
		await requestShopRefund(
			db,
			{
				orderId: order.id,
				amountMinor: agentAccessProducts.api.priceMinor,
				reason: "test fixture",
				idempotencyKey: "refund-access-test",
			},
			{
				actorUserId: userId,
				request: new Request("https://shop.example/admin"),
			},
		);
		await reconcileAgentAccess(db);
		expect(
			await db.prepare("SELECT state FROM agent_access_orders").first("state"),
		).toBe("revoked");
	});
	it("ordinary products do not invoke onboarding", async () => {
		expect(
			await prepareAgentCheckout(db, {
				items: [{ sellableItemId: crypto.randomUUID(), quantity: 1 }],
			}),
		).toBeNull();
		expect(remote).not.toHaveBeenCalled();
		expect(await processAgentDelivery(db, "not-access")).toBeNull();
	});
	it("requires explicit qualification consent and snapshots the exact bilingual policy", async () => {
		await expect(
			createMultiStoreOrder(
				db,
				{
					items,
					email: "buyer@example.test",
					idempotencyKey: "no-consent-order",
				},
				{ userId },
			),
		).rejects.toMatchObject({ code: "agent_access_terms_required" });
		expect(remote).not.toHaveBeenCalled();
		const order = await make(db, "consented-order");
		const snapshot = await db
			.prepare("SELECT policy_snapshot FROM agent_access_orders")
			.first<string>("policy_snapshot");
		expect(JSON.parse(snapshot ?? "null")).toMatchObject({
			...agentAccessRefundPolicy,
			acceptedAt: expect.any(Number),
		});
		await make(db, "consented-order");
		expect(
			await db
				.prepare("SELECT policy_snapshot FROM agent_access_orders")
				.first("policy_snapshot"),
		).toBe(snapshot);
		expect(
			await db
				.prepare("SELECT COUNT(*) AS n FROM shop_orders WHERE id=?")
				.bind(order.id)
				.first("n"),
		).toBe(1);
	});
	it("does not offer voluntary customer refunds but preserves exception cases and admin remedies", async () => {
		const { order, id } = await paid();
		await processAgentDelivery(db, id);
		const context = {
			userId,
			actorUserId: userId,
			request: new Request("https://shop.example/account"),
		};
		await expect(
			openAfterSaleCase(
				db,
				{
					orderId: order.id,
					orderItemId: null,
					type: "refund",
					reason: "Changed my mind",
				},
				context,
			),
		).rejects.toMatchObject({ code: "agent_access_exception_support" });
		await expect(
			openAfterSaleCase(
				db,
				{
					orderId: order.id,
					orderItemId: null,
					type: "dispute",
					reason: "Duplicate charge needs review",
				},
				context,
			),
		).resolves.toMatchObject({ status: "open" });
		await expect(
			openAfterSaleCase(
				db,
				{
					orderId: order.id,
					orderItemId: null,
					type: "refund",
					reason: "Verified duplicate charge",
				},
				{ ...context, userId: null },
			),
		).resolves.toMatchObject({ status: "open" });
	});
	it("does not retroactively restrict a historical order without the new policy snapshot", async () => {
		const { order } = await paid();
		await db
			.prepare("UPDATE agent_access_orders SET policy_snapshot=NULL")
			.run();
		await expect(
			openAfterSaleCase(
				db,
				{
					orderId: order.id,
					orderItemId: null,
					type: "refund",
					reason: "Historical customer request",
				},
				{
					userId,
					actorUserId: userId,
					request: new Request("https://shop.example/account"),
				},
			),
		).resolves.toMatchObject({ status: "open" });
	});
});
