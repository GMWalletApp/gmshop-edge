import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { isInternalIdentityEmail } from "#/features/auth/identity-email";
import { getAuth } from "#/features/auth/server/auth";
import {
	commerceNotificationEventSchema,
	commerceNotificationEvents,
} from "#/features/notifications/templates";
import { afterSaleOpenSchema } from "#/features/shop-orders/schema";
import { openAfterSaleCase } from "#/features/shop-orders/server/after-sales";
import { DomainError } from "#/lib/domain-error";
import { supportedLocales } from "#/lib/locales";
import { getDb } from "#/server/db.server";
import { getStoreSession, resolveStoreAccount } from "./account";
import { listVisibleStoreEntitlements } from "./account-entitlements";
import {
	listStoreNotificationPreferences,
	listStoreSessions,
	revokeStoreSession,
	updateStoreNotificationPreference,
	updateStoreProfile,
} from "./account-security";
import { setUserCartItem } from "./cart";
import { loadRenewableEntitlement } from "./entitlement-renewal";
import { withOrderGrowth } from "./order-growth";
import { getStoreOrder } from "./order-query";

const accountOrderSchema = z.object({
	orderNumber: z.string().trim().min(8).max(80),
});

const setAccountPasswordSchema = z.object({
	newPassword: z.string().min(12).max(200),
});

export const setAccountPasswordFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof setAccountPasswordSchema>) =>
		setAccountPasswordSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const request = getRequest();
		await getStoreSession(request);
		const response = await (await getAuth(request)).api.setPassword({
			headers: request.headers,
			body: data,
			asResponse: true,
		});
		if (!response.ok)
			throw new DomainError(
				"password_setup_failed",
				response.status,
				"Unable to set a local password",
			);
		return { success: true };
	});

export const getStoreAccountFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const request = getRequest();
		const db = getDb(request).$client;
		const account = await resolveStoreAccount(db, request, {
			required: true,
		});
		if (!account)
			throw new DomainError("authentication_required", 401, "Sign in required");
		const userId = account.user.id;
		const [orders, credential, notificationPreferences, coupons, entitlements] =
			await Promise.all([
				db
					.prepare(
						`SELECT o.order_number, o.status, o.currency, o.currency_decimals,
						 o.total_minor, o.created_at, o.updated_at,
						 (SELECT product_name FROM shop_order_items WHERE order_id = o.id
						  ORDER BY created_at, id LIMIT 1) AS product_name,
						 (SELECT COUNT(*) FROM shop_order_items WHERE order_id = o.id) AS item_count
						 FROM shop_orders o WHERE o.user_id = ?
						 ORDER BY o.created_at DESC, o.id DESC LIMIT 100`,
					)
					.bind(userId)
					.all<AccountOrderRow>(),
				db
					.prepare(
						`SELECT id FROM accounts WHERE user_id = ? AND provider_id = 'credential'
					 AND password IS NOT NULL LIMIT 1`,
					)
					.bind(userId)
					.first<{ id: string }>(),
				listStoreNotificationPreferences(db, userId),
				db
					.prepare(
						`SELECT c.code, cr.status, cr.discount_minor, o.currency,
							 o.currency_decimals, o.order_number, cr.created_at
							 FROM coupon_redemptions cr JOIN coupons c ON c.id = cr.coupon_id
							 JOIN shop_orders o ON o.id = cr.order_id WHERE cr.user_id = ?
							 ORDER BY cr.created_at DESC, cr.id DESC LIMIT 100`,
					)
					.bind(userId)
					.all<AccountCouponRow>(),
				listVisibleStoreEntitlements(db, userId),
			]);
		return {
			user: {
				name: account.user.name,
				preferredLocale: account.user.preferredLocale,
				email: !isInternalIdentityEmail(account.user.email)
					? account.user.email
					: null,
				emailVerified:
					!isInternalIdentityEmail(account.user.email) &&
					account.user.emailVerified,
			},
			customerLinked: true,
			hasPassword: Boolean(credential),
			notificationPreferences: commerceNotificationEvents.map((event) => ({
				event,
				enabled: notificationPreferences.get(event)?.enabled ?? true,
			})),
			coupons: coupons.results.map((coupon) => ({
				code: coupon.code,
				status: coupon.status,
				discountMinor: coupon.discount_minor,
				currency: coupon.currency,
				currencyDecimals: coupon.currency_decimals,
				orderNumber: coupon.order_number,
				createdAt: coupon.created_at,
			})),
			entitlements: entitlements.results.map((entitlement) => ({
				id: entitlement.id,
				type: entitlement.entitlement_type,
				status: entitlement.status,
				usageLimit: entitlement.usage_limit,
				usageCount: entitlement.usage_count,
				accessLimit: entitlement.access_limit,
				accessCount: entitlement.access_count,
				activatedAt: entitlement.activated_at,
				expiresAt: entitlement.expires_at,
				productName: entitlement.product_name,
				sellableItemName: entitlement.sellable_item_name,
				productId: entitlement.product_id,
				sellableItemId: entitlement.sellable_item_id,
				renewable:
					["active", "expired", "exhausted"].includes(entitlement.status) &&
					entitlement.renewal_mode === "stack" &&
					entitlement.sellable_item_enabled === 1 &&
					entitlement.product_status === "active",
				orderNumber: entitlement.order_number,
				createdAt: entitlement.created_at,
				deliveryCount: entitlement.delivery_count,
				downloadAssetCount: entitlement.download_asset_count,
				buildJobCount: entitlement.automation_job_count,
				buildArtifactCount: entitlement.automation_artifact_count,
			})),
			orders: orders.results.map((order) => ({
				orderNumber: order.order_number,
				status: order.status,
				currency: order.currency,
				currencyDecimals: order.currency_decimals,
				totalMinor: order.total_minor,
				productName: order.product_name,
				itemCount: order.item_count,
				createdAt: order.created_at,
				updatedAt: order.updated_at,
			})),
		};
	},
);

type AccountCouponRow = {
	code: string;
	status: string;
	discount_minor: string;
	currency: string;
	currency_decimals: number;
	order_number: string;
	created_at: number;
};

const renewalSchema = z.object({ entitlementId: z.uuid() });

export const prepareEntitlementRenewalFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof renewalSchema>) =>
		renewalSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const request = getRequest();
		const db = getDb(request).$client;
		const account = await resolveStoreAccount(db, request, {
			required: true,
		});
		if (!account)
			throw new DomainError(
				"customer_unavailable",
				403,
				"Customer is unavailable",
			);
		const entitlement = await loadRenewableEntitlement(
			db,
			account.user.id,
			data.entitlementId,
		);
		if (!entitlement)
			throw new DomainError(
				"renewal_unavailable",
				409,
				"Entitlement cannot be renewed",
			);
		await setUserCartItem(db, account.user.id, entitlement.sellable_item_id, 1);
		return {
			entitlementId: entitlement.id,
			sellableItemId: entitlement.sellable_item_id,
		};
	});

export const getAccountOrderFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof accountOrderSchema>) =>
		accountOrderSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const request = getRequest();
		const db = getDb(request).$client;
		const account = await resolveStoreAccount(db, request, { required: true });
		if (!account)
			throw new DomainError(
				"customer_account_unlinked",
				409,
				"The customer account is not linked yet",
			);
		return withOrderGrowth(
			db,
			await getStoreOrder(db, data, { userId: account.user.id }),
			{ signedIn: true },
		);
	});

const profileSchema = z.object({
	name: z.string().trim().min(1).max(120),
	preferredLocale: z.enum(supportedLocales),
});

export const updateStoreProfileFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof profileSchema>) =>
		profileSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const request = getRequest();
		const db = getDb(request).$client;
		const session = await getStoreSession(request);
		if (!session)
			throw new DomainError("authentication_required", 401, "Sign in required");
		return updateStoreProfile(db, data, {
			userId: session.user.id,
			currentName: session.user.name,
			currentPreferredLocale: session.user.preferredLocale,
			request,
		});
	});

export const listStoreSessionsFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const request = getRequest();
		const db = getDb(request).$client;
		const current = await getStoreSession(request);
		if (!current)
			throw new DomainError("authentication_required", 401, "Sign in required");
		return listStoreSessions(db, current.user.id, current.session.id);
	},
);

const revokeSessionSchema = z.object({ sessionId: z.string().min(1).max(200) });

export const revokeStoreSessionFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof revokeSessionSchema>) =>
		revokeSessionSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const request = getRequest();
		const db = getDb(request).$client;
		const current = await getStoreSession(request);
		if (!current)
			throw new DomainError("authentication_required", 401, "Sign in required");
		return revokeStoreSession(db, data.sessionId, {
			userId: current.user.id,
			currentSessionId: current.session.id,
			request,
		});
	});

const notificationPreferenceSchema = z.object({
	event: commerceNotificationEventSchema,
	enabled: z.boolean(),
});

export const updateStoreNotificationPreferenceFn = createServerFn({
	method: "POST",
})
	.validator((input: z.input<typeof notificationPreferenceSchema>) =>
		notificationPreferenceSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const request = getRequest();
		const db = getDb(request).$client;
		const account = await resolveStoreAccount(db, request, {
			required: true,
		});
		if (!account)
			throw new DomainError(
				"customer_account_unlinked",
				409,
				"The customer account is not linked yet",
			);
		return updateStoreNotificationPreference(db, data, {
			userId: account.user.id,
			email: account.user.email,
			emailVerified: account.user.emailVerified,
			preferredLocale: account.user.preferredLocale,
			request,
		});
	});

const accountAfterSaleSchema = afterSaleOpenSchema
	.omit({ orderId: true })
	.extend({
		orderNumber: z.string().trim().min(8).max(80),
	});

export const openAccountAfterSaleCaseFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof accountAfterSaleSchema>) =>
		accountAfterSaleSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const request = getRequest();
		const db = getDb(request).$client;
		const account = await resolveStoreAccount(db, request, {
			required: true,
		});
		if (!account)
			throw new DomainError(
				"customer_account_unlinked",
				409,
				"The customer account is not linked yet",
			);
		const order = await db
			.prepare(
				"SELECT id FROM shop_orders WHERE order_number = ? AND user_id = ? LIMIT 1",
			)
			.bind(data.orderNumber, account.user.id)
			.first<{ id: string }>();
		if (!order)
			throw new DomainError("order_not_found", 404, "Order not found");
		return openAfterSaleCase(
			db,
			{
				orderId: order.id,
				orderItemId: data.orderItemId,
				type: data.type,
				reason: data.reason,
			},
			{
				userId: account.user.id,
				actorUserId: account.user.id,
				request,
			},
		);
	});

type AccountOrderRow = {
	order_number: string;
	status: string;
	currency: string;
	currency_decimals: number;
	total_minor: string;
	product_name: string | null;
	item_count: number;
	created_at: number;
	updated_at: number;
};
