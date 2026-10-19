import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	cancelUnstartedBalancePayment,
	reserveOrderBalance,
	settlePromotionRewards,
} from "#/features/promotions/server/balance";
import {
	issueRecallCoupon,
	issueRecallEmailCoupon,
	openReferralCoupon,
} from "#/features/promotions/server/coupons";
import { expireStoreOrders } from "#/features/shop-orders/server/expiration";
import { transitionShopOrder } from "#/features/shop-orders/server/transition";
import { epayPaymentProvider } from "#/features/shop-payments/providers/epay";
import { gmpayPaymentProvider } from "#/features/shop-payments/providers/gmpay";
import {
	completeManualShopRefund,
	requestShopRefund,
} from "#/features/shop-payments/server/refunds";
import {
	completeFreeStoreOrder,
	createShopPayment,
	processShopPaymentEvent,
} from "#/features/shop-payments/server/service";
import {
	createMultiStoreOrder,
	previewStoreCoupon,
	quoteStoreCouponForVisitor,
} from "#/features/storefront/server/multi-order";
import { getWallet } from "#/features/wallet/server/ledger";
import { applyMigrations } from "./migrations";

const buyer = "11111111-1111-4111-8111-111111111111",
	promoter = "22222222-2222-4222-8222-222222222222";
const sku = "33333333-3333-4333-8333-333333333333",
	product = "44444444-4444-4444-8444-444444444444";
const channel = "55555555-5555-4555-8555-555555555555";
const admin = {
	actorUserId: buyer,
	request: new Request("https://shop.example.com/admin/orders"),
};
describe("invitation and personal recall checkout", { timeout: 30000 }, () => {
	let mf: Miniflare, db: D1Database;
	beforeEach(async () => {
		mf = new Miniflare({
			modules: true,
			script: "export default {fetch(){return new Response('ok')}}",
			d1Databases: { DB: crypto.randomUUID() },
		});
		db = await mf.getD1Database("DB");
		await applyMigrations(db);
		await db.batch([
			...[
				[buyer, "buyer@example.com"],
				[promoter, "promoter@example.com"],
			].map(([id, email]) =>
				db
					.prepare(
						`INSERT INTO users(id,name,email,email_verified,enabled,balance_minor,marketing_consent,created_at,updated_at) VALUES (?,'Test',?,1,1,'0',1,1,1)`,
					)
					.bind(id, email),
			),
			db
				.prepare(
					`INSERT INTO products(id,name,product_type,status,created_at,updated_at) VALUES (?,'Test','stock','active',1,1)`,
				)
				.bind(product),
			db
				.prepare(
					`INSERT INTO product_sellable_items(id,product_id,name,price_minor,currency,currency_decimals,fulfillment_source,maximum_quantity,promotion_budget_minor,created_at,updated_at) VALUES (?,?,'Test','108000','CNY',2,'manual',10,'800',1,1)`,
				)
				.bind(sku, product),
			db
				.prepare(
					`INSERT INTO payment_channels(id,provider,name,currency,enabled,created_at,updated_at) VALUES (?,'epay','Test','CNY',1,1,1)`,
				)
				.bind(channel),
			db.prepare(
				`INSERT INTO system_settings(key,value,is_secret,created_at,updated_at) VALUES ('commerce.default_currency','"CNY"',0,1,1)`,
			),
		]);
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await mf.dispose();
	});
	const order = (couponCode = "", userId: string | null = buyer) =>
		createMultiStoreOrder(
			db,
			{
				email: "buyer@example.com",
				couponCode,
				idempotencyKey: crypto.randomUUID(),
				items: [{ sellableItemId: sku, quantity: 1 }],
			},
			userId
				? {
						userId,
						identityEmail:
							userId === promoter
								? "promoter@example.com"
								: "buyer@example.com",
					}
				: {},
		);
	async function emptyOrder(amount = "10000") {
		const id = crypto.randomUUID();
		await db
			.prepare(`INSERT INTO shop_orders(id,order_number,user_id,contact_email,status,currency,currency_decimals,subtotal_minor,discount_minor,total_minor,paid_minor,expires_at,created_at,updated_at)
   VALUES (?,?,?,'buyer@example.com','pending_payment','CNY',2,?,'0',?,'0',?,1,1)`)
			.bind(id, id, buyer, amount, amount, Date.now() + 60000)
			.run();
		return id;
	}
	async function prepareExternal(id: string, amount: string) {
		const attempt = crypto.randomUUID();
		await db
			.prepare(`INSERT INTO payment_attempts(id,order_id,channel_id,provider_payment_id,idempotency_key,status,amount_minor,currency,currency_decimals,exchange_rate,exchange_rate_direction,created_at,updated_at,order_amount_minor)
   VALUES (?,?,?,?,?,'pending',?,'CNY',2,'1','parity',1,1,?)`)
			.bind(attempt, id, channel, attempt, attempt, amount, amount)
			.run();
		const event = {
			providerEventId: crypto.randomUUID(),
			providerPaymentId: attempt,
			type: "payment_succeeded" as const,
			amountMinor: amount,
			currency: "CNY",
			payloadDigest: "test-digest",
		};
		return event;
	}
	async function payExternal(id: string, amount: string) {
		const event = await prepareExternal(id, amount);
		return { event, result: await processShopPaymentEvent(db, channel, event) };
	}
	it("reuses one persistent code and attributes a signed-in order without a customer relationship", async () => {
		const code = await openReferralCoupon(db, promoter);
		expect(await openReferralCoupon(db, promoter)).toEqual(code);
		const created = await order(code.code);
		expect(created.totalMinor).toBe("107600");
		expect(
			await db
				.prepare(
					"SELECT referrer_user_id,referral_reward_minor,promotion_purpose FROM shop_orders WHERE id=?",
				)
				.bind(created.id)
				.first(),
		).toEqual({
			referrer_user_id: promoter,
			referral_reward_minor: "400",
			promotion_purpose: "referral",
		});
	});
	it("rejects identified self-referrals", async () => {
		const code = await openReferralCoupon(db, promoter);
		await expect(order(code.code, promoter)).rejects.toThrow(/own invitation/);
	});
	it("refuses invitation codes for guests and unverified accounts", async () => {
		const code = await openReferralCoupon(db, promoter);
		await expect(order(code.code, null)).rejects.toMatchObject({
			code: "coupon_sign_in_required",
		});
		await db
			.prepare("UPDATE users SET email_verified=0 WHERE id=?")
			.bind(buyer)
			.run();
		await expect(order(code.code)).rejects.toMatchObject({
			code: "coupon_sign_in_required",
		});
	});
	it("issues a campaign once per verified customer, prevents guests claiming it and consumes it once under concurrency", async () => {
		const old = await emptyOrder();
		await db
			.prepare("UPDATE shop_orders SET status='completed',paid_at=1 WHERE id=?")
			.bind(old)
			.run();
		const coupon = await issueRecallCoupon(db, {
			userId: buyer,
			campaignKey: "recall-test",
			startsAt: Date.now() - 1000,
		});
		expect(coupon).not.toBeNull();
		expect(
			(
				await issueRecallCoupon(db, {
					userId: buyer,
					campaignKey: "recall-test",
					startsAt: Date.now(),
				})
			)?.code,
		).toBe(coupon?.code);
		await expect(order(coupon?.code, null)).rejects.toThrow(/Sign in/);
		const attempts = await Promise.allSettled([
			order(coupon?.code),
			order(coupon?.code),
		]);
		expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(1);
		const saved = await db
			.prepare(
				"SELECT total_minor,referral_reward_minor,promotion_purpose FROM shop_orders WHERE coupon_id=?",
			)
			.bind(coupon?.id)
			.first();
		expect(saved).toEqual({
			total_minor: "107200",
			referral_reward_minor: "0",
			promotion_purpose: "recall",
		});
	});
	it("binds a recall coupon to a past buyer email so a guest can redeem it once with that email only", async () => {
		const old = await emptyOrder();
		await db
			.prepare("UPDATE shop_orders SET status='completed',paid_at=1 WHERE id=?")
			.bind(old)
			.run();
		expect(
			await issueRecallEmailCoupon(db, {
				email: "stranger@example.com",
				campaignKey: "email-recall",
				startsAt: Date.now() - 1000,
			}),
		).toBeNull();
		const coupon = await issueRecallEmailCoupon(db, {
			email: " Buyer@Example.com ",
			campaignKey: "email-recall",
			startsAt: Date.now() - 1000,
		});
		expect(coupon?.code).toMatch(/^BACK-/);
		expect(
			(
				await issueRecallEmailCoupon(db, {
					email: "buyer@example.com",
					campaignKey: "email-recall",
					startsAt: Date.now(),
				})
			)?.code,
		).toBe(coupon?.code);
		const guest = (email: string) =>
			createMultiStoreOrder(db, {
				email,
				couponCode: coupon?.code ?? "",
				idempotencyKey: crypto.randomUUID(),
				items: [{ sellableItemId: sku, quantity: 1 }],
			});
		await expect(guest("other@example.com")).rejects.toThrow(
			/email address this coupon was sent to/,
		);
		await expect(
			db
				.prepare(
					`INSERT INTO coupon_redemptions (id, coupon_id, order_id, user_id, normalized_email, discount_minor, status, created_at, updated_at)
					 VALUES ('r1', ?, ?, NULL, 'other@example.com', '800', 'reserved', ?, ?)`,
				)
				.bind(coupon?.id, old, Date.now(), Date.now())
				.run(),
		).rejects.toThrow(/coupon_recipient_or_usage_invalid/);
		const attempts = await Promise.allSettled([
			guest("buyer@example.com"),
			guest("BUYER@example.com"),
		]);
		expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(1);
		const saved = await db
			.prepare(
				"SELECT user_id,total_minor,promotion_purpose FROM shop_orders WHERE coupon_id=?",
			)
			.bind(coupon?.id)
			.first();
		expect(saved).toEqual({
			user_id: null,
			total_minor: "107200",
			promotion_purpose: "recall",
		});
		await expect(guest("buyer@example.com")).rejects.toThrow(/unavailable/);
	});
	it("never adds an email-bound coupon to a recall campaign that already has an account coupon", async () => {
		const old = await emptyOrder();
		await db
			.prepare("UPDATE shop_orders SET status='completed',paid_at=1 WHERE id=?")
			.bind(old)
			.run();
		await issueRecallCoupon(db, {
			userId: buyer,
			campaignKey: "upgraded",
			startsAt: Date.now() - 1000,
		});
		expect(
			await issueRecallEmailCoupon(db, {
				email: "buyer@example.com",
				campaignKey: "upgraded",
				startsAt: Date.now(),
			}),
		).toBeNull();
	});
	it("releases an unpaid recall coupon but does not recycle a paid refunded coupon", async () => {
		const old = await emptyOrder();
		await db
			.prepare("UPDATE shop_orders SET status='completed',paid_at=1 WHERE id=?")
			.bind(old)
			.run();
		const coupon = await issueRecallCoupon(db, {
			userId: buyer,
			campaignKey: "expiry-test",
			startsAt: Date.now() - 1000,
		});
		const created = await order(coupon?.code);
		await db
			.prepare("UPDATE shop_orders SET expires_at=1 WHERE id=?")
			.bind(created.id)
			.run();
		await expireStoreOrders(db);
		const retry = await order(coupon?.code);
		expect(retry.totalMinor).toBe("107200");
		await payExternal(retry.id, "107200");
		const refund = await requestShopRefund(
			db,
			{
				orderId: retry.id,
				amountMinor: "107200",
				reason: "Test",
				idempotencyKey: "recall-refund-test",
			},
			admin,
		);
		await completeManualShopRefund(
			db,
			refund.id,
			"local-test-reference",
			true,
			admin,
		);
		await expect(order(coupon?.code)).rejects.toThrow(/unavailable/);
	});
	it("reserves rewards first, then cash, and releases both exactly once on expiry", async () => {
		await db
			.prepare(
				"UPDATE users SET balance_minor='2000',reward_balance_minor='800' WHERE id=?",
			)
			.bind(buyer)
			.run();
		const id = await emptyOrder();
		const hold = await reserveOrderBalance(db, id, buyer);
		expect(hold).toMatchObject({
			cash_minor: "2000",
			reward_minor: "800",
			external_minor: "7200",
		});
		await reserveOrderBalance(db, id, buyer);
		expect(await getWallet(db, buyer)).toMatchObject({
			balanceMinor: "0",
			rewardBalanceMinor: "0",
		});
		await db
			.prepare("UPDATE shop_orders SET expires_at=1 WHERE id=?")
			.bind(id)
			.run();
		await expireStoreOrders(db);
		await expireStoreOrders(db);
		expect(await getWallet(db, buyer)).toMatchObject({
			balanceMinor: "2000",
			rewardBalanceMinor: "800",
		});
	});
	it("does not overspend a wallet across concurrent orders", async () => {
		await db
			.prepare("UPDATE users SET balance_minor='10000' WHERE id=?")
			.bind(buyer)
			.run();
		const a = await emptyOrder(),
			b = await emptyOrder();
		await Promise.allSettled([
			reserveOrderBalance(db, a, buyer),
			reserveOrderBalance(db, b, buyer),
		]);
		const holds = await db
			.prepare(
				"SELECT SUM(CAST(cash_minor AS INTEGER)) AS cash FROM order_balance_holds",
			)
			.first<{ cash: number }>();
		expect(holds?.cash).toBe(10000);
		expect((await getWallet(db, buyer)).balanceMinor).toBe("0");
	});
	it("settles a mixed payment once and returns partial and final refunds to their original sources", async () => {
		await db
			.prepare(
				"UPDATE users SET balance_minor='2000',reward_balance_minor='800' WHERE id=?",
			)
			.bind(buyer)
			.run();
		const id = await emptyOrder();
		await reserveOrderBalance(db, id, buyer);
		const { event } = await payExternal(id, "7200");
		await processShopPaymentEvent(db, channel, event);
		const first = await requestShopRefund(
			db,
			{
				orderId: id,
				amountMinor: "5000",
				reason: "Test",
				idempotencyKey: "mixed-refund-first",
			},
			admin,
		);
		const row = await db
			.prepare(
				"SELECT payment_amount_minor,cash_return_minor,reward_return_minor FROM refunds WHERE id=?",
			)
			.bind(first.id)
			.first();
		expect(row).toEqual({
			payment_amount_minor: "3600",
			cash_return_minor: "1000",
			reward_return_minor: "400",
		});
		await completeManualShopRefund(
			db,
			first.id,
			"local-test-first",
			true,
			admin,
		);
		expect(await getWallet(db, buyer)).toMatchObject({
			balanceMinor: "1000",
			rewardBalanceMinor: "400",
		});
		const last = await requestShopRefund(
			db,
			{
				orderId: id,
				amountMinor: "5000",
				reason: "Test",
				idempotencyKey: "mixed-refund-last",
			},
			admin,
		);
		await completeManualShopRefund(db, last.id, "local-test-last", true, admin);
		expect(await getWallet(db, buyer)).toMatchObject({
			balanceMinor: "2000",
			rewardBalanceMinor: "800",
		});
	});
	it("pays entirely from rewards and refunds without turning them into cash", async () => {
		await db
			.prepare("UPDATE users SET reward_balance_minor='10000' WHERE id=?")
			.bind(buyer)
			.run();
		const id = await emptyOrder();
		await reserveOrderBalance(db, id, buyer);
		await completeFreeStoreOrder(db, id, buyer);
		await completeFreeStoreOrder(db, id, buyer);
		await requestShopRefund(
			db,
			{
				orderId: id,
				amountMinor: "10000",
				reason: "Test",
				idempotencyKey: "all-reward-refund",
			},
			admin,
		);
		expect(await getWallet(db, buyer)).toMatchObject({
			balanceMinor: "0",
			rewardBalanceMinor: "10000",
		});
	});
	it("records late external success after release for reconciliation without fulfilling", async () => {
		await db
			.prepare("UPDATE users SET reward_balance_minor='800' WHERE id=?")
			.bind(buyer)
			.run();
		const id = await emptyOrder();
		await reserveOrderBalance(db, id, buyer);
		const event = await prepareExternal(id, "9200");
		await db
			.prepare("UPDATE shop_orders SET expires_at=1 WHERE id=?")
			.bind(id)
			.run();
		await expireStoreOrders(db);
		const result = await processShopPaymentEvent(db, channel, event);
		expect(result.status).toBe("reconciliation_required");
		expect(
			(
				await db
					.prepare("SELECT status FROM shop_orders WHERE id=?")
					.bind(id)
					.first<{ status: string }>()
			)?.status,
		).toBe("expired");
		expect((await getWallet(db, buyer)).rewardBalanceMinor).toBe("800");
	});
	it("matures at the next Beijing midnight after fulfillment and reverses spent rewards without touching cash", async () => {
		const id = await emptyOrder();
		await db
			.prepare(
				"UPDATE shop_orders SET promotion_purpose='referral',referrer_user_id=?,referral_reward_minor='400' WHERE id=?",
			)
			.bind(promoter, id)
			.run();
		await payExternal(id, "10000");
		expect(
			await settlePromotionRewards(db, Date.now() + 20 * 86400000),
		).toEqual({ settled: 0 });
		const completed = Date.parse("2026-10-08T15:59:59.999Z");
		const available = Date.parse("2026-10-08T16:00:00.000Z");
		await db
			.prepare(
				"UPDATE shop_orders SET status='completed',updated_at=? WHERE id=?",
			)
			.bind(completed, id)
			.run();
		expect(await settlePromotionRewards(db, available - 1)).toEqual({
			settled: 0,
		});
		expect(await settlePromotionRewards(db, available)).toEqual({
			settled: 1,
		});
		expect(await settlePromotionRewards(db, available + 86400000)).toEqual({
			settled: 0,
		});
		await db
			.prepare(
				"UPDATE users SET reward_balance_minor='0',balance_minor='9000' WHERE id=?",
			)
			.bind(promoter)
			.run();
		const refund = await requestShopRefund(
			db,
			{
				orderId: id,
				amountMinor: "10000",
				reason: "Test",
				idempotencyKey: "reward-reversal-test",
			},
			admin,
		);
		await completeManualShopRefund(
			db,
			refund.id,
			"local-test-reversal",
			true,
			admin,
		);
		expect(await getWallet(db, promoter)).toMatchObject({
			balanceMinor: "9000",
			rewardBalanceMinor: "-400",
		});
	});
	it.each([
		["epay", "CNY", "7200"],
		["gmpay", "USD", "1008"],
	])("creates only the remaining external charge for %s", async (provider, currency, expected) => {
		await db
			.prepare(
				"UPDATE users SET balance_minor='2000',reward_balance_minor='800' WHERE id=?",
			)
			.bind(buyer)
			.run();
		await db
			.prepare("UPDATE payment_channels SET provider=? WHERE id=?")
			.bind(provider, channel)
			.run();
		await db
			.prepare(`INSERT INTO exchange_rates(id,base_currency,quote_currency,raw_rate,rate,source,enabled,adjustment_bps,sort_order,observed_at,created_at,updated_at)
   VALUES('test-cny-usd','CNY','USD','0.14','0.14','manual',1,0,1,1,1,1)`)
			.run();
		const id = await emptyOrder();
		await reserveOrderBalance(db, id, buyer);
		const adapter =
			provider === "epay" ? epayPaymentProvider : gmpayPaymentProvider;
		const external = vi
			.spyOn(adapter, "createPayment")
			.mockImplementation(async (input) => {
				expect(input.amountMinor).toBe(expected);
				expect(input.currency).toBe(currency);
				return {
					providerPaymentId: "local-fixture",
					checkoutUrl: "https://example.invalid/local-only",
					expiresAt: Date.now() + 60000,
				};
			});
		const input = {
			orderId: id,
			channelId: channel,
			paymentCurrency: currency,
			idempotencyKey: "mixed-create-fixture",
			successUrl: "https://shop.example.com/success",
			cancelUrl: "https://shop.example.com/cancel",
		};
		await createShopPayment(db, input);
		await createShopPayment(db, input);
		expect(external).toHaveBeenCalledTimes(1);
	});
	it("preserves every cent across repeated tiny split-tender refunds", async () => {
		await db
			.prepare(
				"UPDATE users SET balance_minor='2',reward_balance_minor='4' WHERE id=?",
			)
			.bind(buyer)
			.run();
		const id = await emptyOrder("7");
		await reserveOrderBalance(db, id, buyer);
		await payExternal(id, "1");
		for (let index = 0; index < 7; index++) {
			const refund = await requestShopRefund(
				db,
				{
					orderId: id,
					amountMinor: "1",
					reason: "Test",
					idempotencyKey: `tiny-refund-${index}`,
				},
				admin,
			);
			if (refund.status === "processing")
				await completeManualShopRefund(
					db,
					refund.id,
					`local-tiny-${index}`,
					true,
					admin,
				);
		}
		expect(await getWallet(db, buyer)).toMatchObject({
			balanceMinor: "2",
			rewardBalanceMinor: "4",
		});
	});
	it("quotes both ordinary and invitation coupons through the same pricing rules as order creation", async () => {
		await db
			.prepare(`INSERT INTO coupons(id,code,name,type,currency,currency_decimals,value_minor,enabled,created_at,updated_at)
   VALUES('ordinary','ORDINARY','Test','fixed','CNY',2,'350',1,1,1)`)
			.run();
		const quote = await previewStoreCoupon(
			db,
			"ORDINARY",
			[{ id: sku, quantity: 1 }],
			{ userId: buyer, normalizedEmail: "buyer@example.com" },
		);
		expect(quote.discountMinor).toBe("350");
		expect((await order("ORDINARY")).totalMinor).toBe("107650");
		const code = await openReferralCoupon(db, promoter);
		expect(
			(
				await previewStoreCoupon(db, code.code, [{ id: sku, quantity: 1 }], {
					userId: buyer,
					normalizedEmail: "buyer@example.com",
				})
			).discountMinor,
		).toBe("400");
	});
	it("budgets public coupon quotes per IP and hides why a code was rejected", async () => {
		const code = await openReferralCoupon(db, promoter);
		const items = [{ id: sku, quantity: 1 }];
		const guest = { normalizedEmail: "guest@example.com" };
		for (const attempt of [code.code, "NO-SUCH-CODE"])
			await expect(
				quoteStoreCouponForVisitor(db, "198.51.100.40", attempt, items, guest),
			).rejects.toMatchObject({ code: "coupon_unavailable", status: 409 });
		await db
			.prepare(
				`INSERT INTO rate_limit_counters(id,bucket_key,window_start,count,expires_at,created_at,updated_at)
				 VALUES ('quote-full','checkout:coupon-quote:ip:198.51.100.41',?,120,?,1,1)`,
			)
			.bind(Math.floor(Date.now() / 600_000) * 600_000, Date.now() + 1_200_000)
			.run();
		await expect(
			quoteStoreCouponForVisitor(db, "198.51.100.41", "ANY", items, guest),
		).rejects.toMatchObject({ code: "coupon_quote_rate_limited", status: 429 });
	});
	it("releases personal coupons on explicit cancellation, without consuming their one successful use", async () => {
		const old = await emptyOrder();
		await db
			.prepare("UPDATE shop_orders SET status='completed',paid_at=1 WHERE id=?")
			.bind(old)
			.run();
		const coupon = await issueRecallCoupon(db, {
			userId: buyer,
			campaignKey: "cancel-test",
			startsAt: Date.now() - 1000,
		});
		const created = await order(coupon?.code);
		await transitionShopOrder(db, {
			id: created.id,
			version: 1,
			toStatus: "cancelled",
			note: null,
			actorType: "customer",
			actorUserId: buyer,
		});
		expect((await order(coupon?.code)).totalMinor).toBe("107200");
	});
	it("releases split tender after a definitive provider failure", async () => {
		await db
			.prepare("UPDATE users SET reward_balance_minor='800' WHERE id=?")
			.bind(buyer)
			.run();
		const id = await emptyOrder();
		await reserveOrderBalance(db, id, buyer);
		const event = await prepareExternal(id, "9200");
		await processShopPaymentEvent(db, channel, {
			...event,
			type: "payment_failed",
		});
		expect((await getWallet(db, buyer)).rewardBalanceMinor).toBe("800");
		expect(
			(
				await db
					.prepare("SELECT status FROM shop_orders WHERE id=?")
					.bind(id)
					.first<{ status: string }>()
			)?.status,
		).toBe("cancelled");
	});
	it("returns held funds if payment cannot start, but refuses to release an ambiguous active attempt", async () => {
		await db
			.prepare("UPDATE users SET reward_balance_minor='800' WHERE id=?")
			.bind(buyer)
			.run();
		const first = await emptyOrder();
		await reserveOrderBalance(db, first, buyer);
		expect(await cancelUnstartedBalancePayment(db, first)).toBe(true);
		expect(await cancelUnstartedBalancePayment(db, first)).toBe(false);
		expect((await getWallet(db, buyer)).rewardBalanceMinor).toBe("800");
		const second = await emptyOrder();
		await reserveOrderBalance(db, second, buyer);
		await prepareExternal(second, "9200");
		expect(await cancelUnstartedBalancePayment(db, second)).toBe(false);
		expect((await getWallet(db, buyer)).rewardBalanceMinor).toBe("0");
	});
});
