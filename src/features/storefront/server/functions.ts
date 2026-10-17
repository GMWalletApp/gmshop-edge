import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireStorefrontPermission } from "#/features/access/storefront-access";
import { isInternalIdentityEmail } from "#/features/auth/identity-email";
import { publishPendingDeliveries } from "#/features/fulfillment/server/outbox";
import {
	cancelUnstartedBalancePayment,
	reserveOrderBalance,
} from "#/features/promotions/server/balance";
import {
	completeFreeStoreOrder,
	completeWalletStoreOrder,
	createShopPayment,
	reconcileShopOrderPayment,
} from "#/features/shop-payments/server/service";
import { storePaymentReturnUrl } from "#/features/storefront/payment-url";
import {
	checkoutStoreOrderSchema,
	commerceEventSchema,
	createStoreOrderSchema,
	storeOrderLookupSchema,
} from "#/features/storefront/schema";
import { publishPendingSupplierOrders } from "#/features/suppliers/server/outbox";
import { DomainError } from "#/lib/domain-error";
import { configurationLogoUrl } from "#/server/configuration-logo";
import { getCloudflareEnv, getDb } from "#/server/db.server";
import { resolveStoreAccount } from "./account";
import { removeUserCartItems } from "./cart";
import { createStoreOrder } from "./order";
import { withOrderGrowth } from "./order-growth";
import { getStoreOrder } from "./order-query";
import {
	paymentChannelIsVisible,
	requestIsFromMainlandChina,
} from "./payment-region";

export const createStoreOrderFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof createStoreOrderSchema>) =>
		createStoreOrderSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const request = getRequest();
		const db = getDb(request).$client;
		const account = await resolveStoreAccount(db, request);
		requireStorefrontPermission(
			account ? "customer" : "guest",
			"checkout.create",
		);
		const input = account
			? {
					...data,
					email: isInternalIdentityEmail(account.user.email)
						? null
						: account.user.email,
					locale: account.user.preferredLocale,
				}
			: data;
		return createStoreOrder(db, input, {
			userId: account?.user.id,
			identityEmail: account?.user.email,
		});
	});

export const trackCommerceEventFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof commerceEventSchema>) =>
		commerceEventSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const request = getRequest();
		const origin = request.headers.get("origin");
		requireStorefrontPermission("guest", "catalog.read");
		if (!origin || origin !== new URL(request.url).origin)
			throw new DomainError("origin_invalid", 403, "Origin is not allowed");
		await getDb(request)
			.$client.prepare(
				`INSERT INTO commerce_events
				 (id, event_type, session_id, product_id, sellable_item_id, created_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				crypto.randomUUID(),
				data.eventType,
				data.sessionId,
				data.productId,
				data.sellableItemId,
				Date.now(),
			)
			.run();
		return { accepted: true };
	});

const checkoutPaymentChannelsSchema = z.object({
	sellableItemIds: z.array(z.uuid()).min(1).max(100),
});

export const listCheckoutPaymentChannelsFn = createServerFn({
	method: "GET",
}).handler(async () => {
	const request = getRequest();
	requireStorefrontPermission("guest", "catalog.read");
	const rows = await getDb(request)
		.$client.prepare(
			`SELECT id, name, provider, fee_bps, fixed_fee_minor,
			        logo_object_key, logo_updated_at
			 FROM payment_channels
			 WHERE enabled = 1 ORDER BY sort_order, name, id`,
		)
		.all<{
			id: string;
			name: string;
			provider: string;
			fee_bps: number;
			fixed_fee_minor: string;
			logo_object_key: string | null;
			logo_updated_at: number | null;
		}>();
	return rows.results
		.filter((channel) => paymentChannelIsVisible(request, channel))
		.map((channel) => ({
			id: channel.id,
			name: channel.name,
			provider: channel.provider,
			feeBps: channel.fee_bps,
			fixedFeeMinor: channel.fixed_fee_minor,
			logoUrl:
				channel.logo_object_key && channel.logo_updated_at
					? configurationLogoUrl("payment", channel.id, channel.logo_updated_at)
					: null,
		}));
});

export const quoteCheckoutPaymentChannelsFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof checkoutPaymentChannelsSchema>) =>
		checkoutPaymentChannelsSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const request = getRequest();
		requireStorefrontPermission("guest", "catalog.read");
		const db = getDb(request).$client;
		const [channelsResult, pricesResult] = await db.batch([
			db.prepare(
				`SELECT id, name, provider, fee_bps, fixed_fee_minor,
			        logo_object_key, logo_updated_at
			 FROM payment_channels
				 WHERE enabled = 1 ORDER BY sort_order, name, id`,
			),
			db
				.prepare(
					`SELECT channel_id, sellable_item_id, price_minor
					 FROM sellable_item_channel_prices
					 WHERE enabled = 1 AND sellable_item_id IN (${data.sellableItemIds
							.map(() => "?")
							.join(", ")})`,
				)
				.bind(...data.sellableItemIds),
		]);
		if (!channelsResult || !pricesResult)
			throw new DomainError(
				"payment_channel_unavailable",
				503,
				"Payment channel unavailable",
			);
		const rows = channelsResult.results as Array<{
			id: string;
			name: string;
			provider: string;
			fee_bps: number;
			fixed_fee_minor: string;
			logo_object_key: string | null;
			logo_updated_at: number | null;
		}>;
		const prices = pricesResult.results as Array<{
			channel_id: string;
			sellable_item_id: string;
			price_minor: string;
		}>;
		return rows
			.filter((channel) => paymentChannelIsVisible(request, channel))
			.map((channel) => ({
				id: channel.id,
				name: channel.name,
				provider: channel.provider,
				feeBps: channel.fee_bps,
				fixedFeeMinor: channel.fixed_fee_minor,
				logoUrl:
					channel.logo_object_key && channel.logo_updated_at
						? configurationLogoUrl(
								"payment",
								channel.id,
								channel.logo_updated_at,
							)
						: null,
				itemPrices: Object.fromEntries(
					prices
						.filter((price) => price.channel_id === channel.id)
						.map((price) => [price.sellable_item_id, price.price_minor]),
				),
			}));
	});

export const checkoutStoreOrderFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof checkoutStoreOrderSchema>) =>
		checkoutStoreOrderSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const request = getRequest();
		const db = getDb(request).$client;
		const account = await resolveStoreAccount(db, request);
		requireStorefrontPermission(
			account ? "customer" : "guest",
			"checkout.create",
		);
		const input = account
			? {
					...data,
					email: isInternalIdentityEmail(account.user.email)
						? null
						: account.user.email,
				}
			: data;
		if (data.paymentChannelId && requestIsFromMainlandChina(request)) {
			const channel = await db
				.prepare(
					"SELECT provider FROM payment_channels WHERE id = ? AND enabled = 1 LIMIT 1",
				)
				.bind(data.paymentChannelId)
				.first<{ provider: string }>();
			if (!channel || !paymentChannelIsVisible(request, channel))
				throw new DomainError(
					"payment_channel_unavailable",
					404,
					"Payment channel unavailable",
				);
		}
		const order = await createStoreOrder(db, input, {
			userId: account?.user.id,
			identityEmail: account?.user.email,
			pricingChannelId:
				data.walletPayment || !data.paymentChannelId
					? undefined
					: data.paymentChannelId,
		});
		if (account && "items" in data && !order.duplicate) {
			const sellableItemIds = data.items.map((item) => item.sellableItemId);
			await removeUserCartItems(db, account.user.id, sellableItemIds);
		}
		const origin = new URL(request.url).origin;
		const orderPath = account
			? `/account/orders/${encodeURIComponent(order.orderNumber)}`
			: `/orders/${encodeURIComponent(order.orderNumber)}`;
		if (order.totalMinor === "0") {
			await completeFreeStoreOrder(db, order.id);
			const queue = getCloudflareEnv(request).COMMERCE_QUEUE;
			if (queue) {
				await publishPendingDeliveries(db, queue);
				await publishPendingSupplierOrders(db, queue);
			}
			return {
				order: { ...order, status: "paid" },
				payment: null,
				accountOrder: Boolean(account),
			};
		}
		if (data.useBalance) {
			if (!account)
				throw new DomainError(
					"authentication_required",
					401,
					"Sign in required",
				);
			const hold = await reserveOrderBalance(db, order.id, account.user.id);
			if (hold?.external_minor === "0") {
				try {
					await completeFreeStoreOrder(db, order.id, account.user.id);
				} catch (error) {
					await cancelUnstartedBalancePayment(db, order.id);
					throw error;
				}
				const queue = getCloudflareEnv(request).COMMERCE_QUEUE;
				if (queue) {
					await publishPendingDeliveries(db, queue);
					await publishPendingSupplierOrders(db, queue);
				}
				return {
					order: { ...order, status: "paid" },
					payment: null,
					accountOrder: true,
				};
			}
		}
		if (data.walletPayment) {
			if (!account)
				throw new DomainError(
					"authentication_required",
					401,
					"Sign in required",
				);
			await completeWalletStoreOrder(db, {
				orderId: order.id,
				userId: account.user.id,
			});
			const queue = getCloudflareEnv(request).COMMERCE_QUEUE;
			if (queue) {
				await publishPendingDeliveries(db, queue);
				await publishPendingSupplierOrders(db, queue);
			}
			return {
				order: { ...order, status: "paid" },
				payment: null,
				accountOrder: true,
			};
		}
		if (!data.paymentChannelId) {
			await cancelUnstartedBalancePayment(db, order.id);
			throw new DomainError(
				"payment_channel_required",
				400,
				"Select a payment channel",
			);
		}
		try {
			const payment = await createShopPayment(db, {
				orderId: order.id,
				channelId: data.paymentChannelId,
				paymentCurrency: data.paymentCurrency ?? order.currency,
				idempotencyKey: `checkout:${order.id}:${data.paymentChannelId}:${data.paymentCurrency ?? order.currency}`,
				successUrl: storePaymentReturnUrl(origin, orderPath),
				cancelUrl: `${origin}${orderPath}`,
				payerIp: request.headers.get("cf-connecting-ip"),
				payerMobile: isMobilePaymentRequest(request),
			});
			return { order, payment, accountOrder: Boolean(account) };
		} catch (error) {
			let failed = await db
				.prepare(
					`SELECT id, status FROM payment_attempts WHERE order_id = ?
					 ORDER BY created_at DESC, id DESC LIMIT 1`,
				)
				.bind(order.id)
				.first<{ id: string; status: string }>();
			if (!failed) {
				if (await cancelUnstartedBalancePayment(db, order.id))
					return {
						order: { ...order, status: "cancelled" },
						payment: null,
						accountOrder: Boolean(account),
					};
				const now = Date.now();
				const fallbackId = crypto.randomUUID();
				await db
					.prepare(
						`INSERT INTO payment_attempts
						 (id, order_id, channel_id, idempotency_key, status, amount_minor,
						  currency, currency_decimals, exchange_rate, exchange_rate_direction,
						  exchange_rate_source, exchange_rate_adjustment_bps,
						  exchange_rate_observed_at, failure_code, created_at, updated_at)
						 VALUES (?, ?, ?, ?, 'failed', ?, ?, ?, '1', 'parity', 'parity', 0,
						  ?, ?, ?, ?)
						 ON CONFLICT(idempotency_key) DO NOTHING`,
					)
					.bind(
						fallbackId,
						order.id,
						data.paymentChannelId,
						`checkout:${order.id}:${data.paymentChannelId}:${data.paymentCurrency ?? order.currency}`,
						order.totalMinor,
						order.currency,
						order.currencyDecimals,
						now,
						error instanceof DomainError ? error.code : "payment_create_failed",
						now,
						now,
					)
					.run();
				failed = await db
					.prepare(
						`SELECT id, status FROM payment_attempts WHERE order_id = ?
						 ORDER BY created_at DESC, id DESC LIMIT 1`,
					)
					.bind(order.id)
					.first<{ id: string; status: string }>();
			}
			if (failed?.status !== "failed") throw error;
			return {
				order,
				payment: {
					id: failed.id,
					status: "failed",
					providerPaymentId: null,
					checkoutUrl: null,
					expiresAt: null,
				},
				accountOrder: Boolean(account),
			};
		}
	});

export const getStoreOrderFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof storeOrderLookupSchema>) =>
		storeOrderLookupSchema.parse(input),
	)
	.handler(async ({ data }) => {
		requireStorefrontPermission("guest", "order.lookup");
		const db = getDb().$client;
		return withOrderGrowth(db, await getStoreOrder(db, data), {
			signedIn: false,
		});
	});

const retryStorePaymentSchema = storeOrderLookupSchema.extend({
	email: storeOrderLookupSchema.shape.email.optional(),
});

export const refreshStoreOrderFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof retryStorePaymentSchema>) =>
		retryStorePaymentSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const request = getRequest();
		const db = getDb(request).$client;
		const account = await resolveStoreAccount(db, request);
		requireStorefrontPermission(account ? "customer" : "guest", "order.lookup");
		const growthAccess = { signedIn: Boolean(account) };
		let order = await getStoreOrder(db, data, { userId: account?.user.id });
		if (order.status !== "pending_payment")
			return withOrderGrowth(db, order, growthAccess);
		const reconciliation = await reconcileShopOrderPayment(db, order.id);
		if (!reconciliation.checked)
			return withOrderGrowth(db, order, growthAccess);
		const queue = getCloudflareEnv(request).COMMERCE_QUEUE;
		if (queue) {
			await publishPendingDeliveries(db, queue);
			await publishPendingSupplierOrders(db, queue);
		}
		order = await getStoreOrder(db, data, { userId: account?.user.id });
		return withOrderGrowth(db, order, growthAccess);
	});

export const retryStorePaymentFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof retryStorePaymentSchema>) =>
		retryStorePaymentSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const request = getRequest();
		const db = getDb(request).$client;
		const account = await resolveStoreAccount(db, request);
		requireStorefrontPermission(
			account ? "customer" : "guest",
			"payment.retry",
		);
		const order = await getStoreOrder(db, data, {
			userId: account?.user.id,
		});
		if (order.status !== "pending_payment" || order.expiresAt <= Date.now())
			throw new DomainError("order_not_payable", 409, "Order cannot be paid");
		const attempt = await db
			.prepare(
				`SELECT channel_id, status, currency FROM payment_attempts WHERE order_id = ?
				 ORDER BY created_at DESC, id DESC LIMIT 1`,
			)
			.bind(order.id)
			.first<{ channel_id: string; status: string; currency: string }>();
		if (!attempt)
			throw new DomainError(
				"payment_channel_unavailable",
				404,
				"Payment channel unavailable",
			);
		if (!["failed", "cancelled", "expired"].includes(attempt.status))
			throw new DomainError(
				"payment_retry_invalid",
				409,
				"Payment attempt cannot be retried",
			);
		const origin = new URL(request.url).origin;
		const orderPath = account
			? `/account/orders/${encodeURIComponent(order.orderNumber)}`
			: `/orders/${encodeURIComponent(order.orderNumber)}`;
		return createShopPayment(db, {
			orderId: order.id,
			channelId: attempt.channel_id,
			paymentCurrency: attempt.currency,
			idempotencyKey: `checkout-retry:${order.id}:${crypto.randomUUID()}`,
			successUrl: storePaymentReturnUrl(origin, orderPath),
			cancelUrl: `${origin}${orderPath}`,
			payerIp: request.headers.get("cf-connecting-ip"),
			payerMobile: isMobilePaymentRequest(request),
		});
	});

function isMobilePaymentRequest(request: Request) {
	if (request.headers.get("sec-ch-ua-mobile") === "?1") return true;
	return /Android|iPhone|iPad|iPod|Mobile/i.test(
		request.headers.get("user-agent") ?? "",
	);
}
