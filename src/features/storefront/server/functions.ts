import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import type { z } from "zod";
import { requireStorefrontPermission } from "#/features/access/storefront-access";
import { isInternalIdentityEmail } from "#/features/auth/identity-email";
import { publishPendingDeliveries } from "#/features/fulfillment/server/outbox";
import {
	completeFreeStoreOrder,
	completeWalletStoreOrder,
	createShopPayment,
} from "#/features/shop-payments/server/service";
import {
	checkoutStoreOrderSchema,
	commerceEventSchema,
	createStoreOrderSchema,
	storeOrderLookupSchema,
} from "#/features/storefront/schema";
import { publishPendingSupplierOrders } from "#/features/suppliers/server/outbox";
import { DomainError } from "#/lib/domain-error";
import { clientIp } from "#/server/client-ip";
import { configurationLogoUrl } from "#/server/configuration-logo";
import { getCloudflareEnv, getDb } from "#/server/db.server";
import { claimFixedWindowRateLimit } from "#/server/rate-limit";
import { resolveStoreAccount } from "./account";
import { removeUserCartItems } from "./cart";
import { createStoreOrder } from "./order";
import { getStoreOrder } from "./order-query";

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
		if (!account && data.couponCode)
			await enforceGuestCouponRateLimit(db, request);
		return createStoreOrder(db, input, {
			userId: account?.user.id,
			identityEmail: account?.user.email,
		});
	});

// Coupon codes are matched exactly; guests are throttled per client so codes
// cannot be enumerated through repeated order creation.
async function enforceGuestCouponRateLimit(db: D1Database, request: Request) {
	const ip = clientIp(request);
	if (!ip) return;
	const claim = await claimFixedWindowRateLimit(db, {
		bucketKey: `coupon-attempt:ip:${ip}`,
		limit: 20,
		windowMs: 60_000,
	});
	if (!claim.allowed)
		throw new DomainError(
			"coupon_attempts_rate_limited",
			429,
			"Too many coupon attempts; try again later",
		);
}

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

export const listCheckoutPaymentChannelsFn = createServerFn({
	method: "GET",
}).handler(async () => {
	requireStorefrontPermission("guest", "catalog.read");
	const rows = await getDb()
		.$client.prepare(
			`SELECT id, name, provider, logo_object_key, logo_updated_at
			 FROM payment_channels
				 WHERE enabled = 1 ORDER BY sort_order, name, id`,
		)
		.all<{
			id: string;
			name: string;
			provider: string;
			logo_object_key: string | null;
			logo_updated_at: number | null;
		}>();
	return rows.results.map((channel) => ({
		id: channel.id,
		name: channel.name,
		provider: channel.provider,
		logoUrl:
			channel.logo_object_key && channel.logo_updated_at
				? configurationLogoUrl("payment", channel.id, channel.logo_updated_at)
				: null,
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
		if (!account && data.couponCode)
			await enforceGuestCouponRateLimit(db, request);
		const order = await createStoreOrder(db, input, {
			userId: account?.user.id,
			identityEmail: account?.user.email,
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
		if (!data.paymentChannelId)
			throw new DomainError(
				"payment_channel_required",
				400,
				"Select a payment channel",
			);
		try {
			const payment = await createShopPayment(db, {
				orderId: order.id,
				channelId: data.paymentChannelId,
				paymentCurrency: data.paymentCurrency ?? order.currency,
				idempotencyKey: `checkout:${order.id}:${data.paymentChannelId}:${data.paymentCurrency ?? order.currency}`,
				successUrl: `${origin}${orderPath}`,
				cancelUrl: `${origin}${orderPath}`,
				payerIp: clientIp(request),
				payerMobile: isMobilePaymentRequest(request),
			});
			return { order, payment, accountOrder: Boolean(account) };
		} catch (error) {
			const failed = await db
				.prepare(
					`SELECT id, status FROM payment_attempts WHERE order_id = ?
					 ORDER BY created_at DESC, id DESC LIMIT 1`,
				)
				.bind(order.id)
				.first<{ id: string; status: string }>();
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
		const request = getRequest();
		return getStoreOrder(getDb(request).$client, data, { request });
	});

const retryStorePaymentSchema = storeOrderLookupSchema.extend({
	email: storeOrderLookupSchema.shape.email.optional(),
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
			request,
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
			successUrl: `${origin}${orderPath}`,
			cancelUrl: `${origin}${orderPath}`,
			payerIp: clientIp(request),
			payerMobile: isMobilePaymentRequest(request),
		});
	});

function isMobilePaymentRequest(request: Request) {
	if (request.headers.get("sec-ch-ua-mobile") === "?1") return true;
	return /Android|iPhone|iPad|iPod|Mobile/i.test(
		request.headers.get("user-agent") ?? "",
	);
}
