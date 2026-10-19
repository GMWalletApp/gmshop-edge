import { z } from "zod";
import {
	activateEntitlementGrantStatements,
	createEntitlementGrantStatements,
	type EntitlementOrderItem,
} from "#/features/entitlements/server/ledger";
import { quotePaymentCurrency } from "#/features/exchange-rates/server/quote";
import { unallocatedPaymentStatement } from "#/features/redeem-warehouse/server/sale-capacity";
import { PaymentCreationError } from "#/features/shop-payments/creation-error";
import { grossUpPaymentAmount } from "#/features/shop-payments/fees";
import type { PaymentWebhookEvent } from "#/features/shop-payments/provider";
import { getPaymentProvider } from "#/features/shop-payments/providers";
import { epusdtMerchantOrderId } from "#/features/shop-payments/providers/epusdt";
import { supplierFallbackEnabledExpression } from "#/features/storefront/server/stock-availability";
import { resolveSupplierUsageUrl } from "#/features/suppliers/customer-usage";
import { mutateWallet } from "#/features/wallet/server/ledger";
import { DomainError } from "#/lib/domain-error";
import { decryptSecret } from "#/lib/secrets";
import { decimalToMinor } from "#/lib/units";
import { loadRuntimeConfig } from "#/server/runtime-config";

type PaymentContext = {
	attempt_id: string;
	attempt_status: string;
	order_id: string | null;
	wallet_topup_id: string | null;
	order_number: string | null;
	order_status: string | null;
	order_version: number | null;
	topup_status: string | null;
	topup_user_id: string | null;
	topup_amount_minor: string | null;
	topup_currency: string | null;
	amount_minor: string;
	currency: string;
	currency_decimals: number;
	contact_email: string;
	channel_id: string;
	provider: string;
	credential_encrypted: string | null;
};

type PaymentCreationContext = {
	order_id: string;
	order_number: string;
	order_status: string;
	amount_minor: string;
	currency: string;
	currency_decimals: number;
	pricing_channel_id: string | null;
	contact_email: string;
	channel_id: string;
	provider: string;
	credential_encrypted: string | null;
	default_token: string;
	default_network: string;
	fee_bps: number;
	fixed_fee_minor: string;
	fixed_channel_pricing: number;
};

type OrderItem = EntitlementOrderItem & {
	policy_json: string | null;
	supplier_fallback_enabled: number;
	fulfillment_source: "local" | "manual" | "supplier";
	supplier_status: string | null;
	supplier_binding_id: string | null;
	supplier_provider: string | null;
	supplier_origin: string | null;
	supplier_protocol: string | null;
	upstream_product_id: string | null;
	upstream_sku_id: string | null;
	upstream_product_name: string | null;
	upstream_sku_name: string | null;
	reference_cost_minor: string | null;
	max_cost_minor: string | null;
	supplier_currency: string | null;
};

const createPaymentSchema = z.object({
	orderId: z.uuid(),
	channelId: z.uuid(),
	idempotencyKey: z.string().trim().min(8).max(200),
	paymentCurrency: z
		.string()
		.trim()
		.toUpperCase()
		.regex(/^[A-Z]{3}$/)
		.optional(),
	successUrl: z.url(),
	cancelUrl: z.url(),
	payerIp: z.union([z.ipv4(), z.ipv6()]).nullable().default(null),
	payerMobile: z.boolean().default(false),
});

export async function createShopPayment(
	db: D1Database,
	rawInput: z.input<typeof createPaymentSchema>,
	fetcher: typeof fetch = fetch,
) {
	const input = createPaymentSchema.parse(rawInput);
	const existing = await loadPaymentAttemptByIdempotency(
		db,
		input.idempotencyKey,
	);
	if (existing) {
		assertPaymentIdempotencyScope(existing, input);
		return presentAttempt(existing);
	}

	const context = await db
		.prepare(
			`SELECT o.id AS order_id, o.order_number, o.status AS order_status,
			 COALESCE((SELECT external_minor FROM order_balance_holds WHERE order_id=o.id AND state='held'),o.total_minor) AS amount_minor, o.currency, o.currency_decimals,
			 o.contact_email, o.pricing_channel_id,
			 pc.id AS channel_id, pc.provider, pc.credential_encrypted,
			 pc.default_token, pc.default_network, pc.fee_bps, pc.fixed_fee_minor,
			 NOT EXISTS (
			  SELECT 1 FROM shop_order_items order_item
			  WHERE order_item.order_id = o.id AND NOT EXISTS (
			   SELECT 1 FROM sellable_item_channel_prices channel_price
			   WHERE channel_price.sellable_item_id = order_item.sellable_item_id
			    AND channel_price.channel_id = pc.id AND channel_price.enabled = 1
			  )
			 ) AS fixed_channel_pricing
			 FROM shop_orders o JOIN payment_channels pc ON pc.id = ?
			 WHERE o.id = ? AND pc.enabled = 1 LIMIT 1`,
		)
		.bind(input.channelId, input.orderId)
		.first<PaymentCreationContext>();
	if (!context)
		throw new DomainError(
			"payment_channel_unavailable",
			404,
			"Payment channel unavailable",
		);
	if (context.order_status !== "pending_payment")
		throw new DomainError("order_not_payable", 409, "Order cannot be paid");
	// The total was quoted with this channel's prices; another channel would pay that price without its own fee.
	if (
		context.pricing_channel_id != null &&
		context.pricing_channel_id !== context.channel_id
	)
		throw new DomainError(
			"payment_channel_mismatch",
			409,
			"This order was priced for another payment channel",
		);
	const balanceHold = await db
		.prepare("SELECT state FROM order_balance_holds WHERE order_id=?")
		.bind(input.orderId)
		.first<{ state: string }>();
	if (balanceHold && balanceHold.state !== "held")
		throw new DomainError(
			"payment_reconciliation_required",
			409,
			"Order balance reservation is unavailable",
		);
	const paymentAmountMinor = grossUpPaymentAmount(
		context.amount_minor,
		context.fixed_channel_pricing ? 0 : context.fee_bps,
		context.fixed_channel_pricing ? "0" : context.fixed_fee_minor,
	);
	const quote = await quotePaymentCurrency(db, {
		amountMinor: paymentAmountMinor,
		currency: context.currency,
		currencyDecimals: context.currency_decimals,
		paymentCurrency: input.paymentCurrency ?? context.currency,
	});
	const credential = await loadCredential(db, context.credential_encrypted);
	const attemptId = crypto.randomUUID();
	const now = Date.now();
	const claimed = await db
		.prepare(
			`INSERT INTO payment_attempts
			 (id, order_id, channel_id, idempotency_key, status, amount_minor, currency,
			  currency_decimals, exchange_rate_id, exchange_rate, exchange_rate_direction,
			  exchange_rate_source, exchange_rate_adjustment_bps, exchange_rate_observed_at,
			  created_at, updated_at, order_amount_minor)
			 VALUES (?, ?, ?, ?, 'created', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(idempotency_key) DO NOTHING`,
		)
		.bind(
			attemptId,
			input.orderId,
			input.channelId,
			input.idempotencyKey,
			quote.amountMinor,
			quote.currency,
			quote.currencyDecimals,
			quote.rateId,
			quote.rate,
			quote.rateDirection,
			quote.rateSource,
			quote.rateAdjustmentBps,
			quote.rateObservedAt,
			now,
			now,
			context.amount_minor,
		)
		.run();
	if (Number(claimed.meta.changes ?? 0) !== 1) {
		const replay = await loadPaymentAttemptByIdempotency(
			db,
			input.idempotencyKey,
		);
		if (!replay)
			throw new DomainError(
				"payment_idempotency_conflict",
				409,
				"Payment creation conflicted; retry",
			);
		assertPaymentIdempotencyScope(replay, input);
		return presentAttempt(replay);
	}
	try {
		const payment = await getPaymentProvider(context.provider).createPayment(
			{
				attemptId,
				orderId: context.order_id,
				orderNumber: context.order_number,
				amountMinor: quote.amountMinor,
				currency: quote.currency,
				currencyDecimals: quote.currencyDecimals,
				customerEmail: context.contact_email,
				description: `Order ${context.order_number}`,
				successUrl: input.successUrl,
				cancelUrl: input.cancelUrl,
				webhookUrl: new URL(
					`/api/shop/payments/${encodeURIComponent(input.channelId)}/webhook`,
					input.successUrl,
				).toString(),
				defaultToken: context.default_token,
				defaultNetwork: context.default_network,
				payerIp: input.payerIp,
				payerMobile: input.payerMobile,
			},
			credential,
			fetcher,
		);
		await db
			.prepare(
				`UPDATE payment_attempts SET provider_payment_id = ?, checkout_url = ?,
				 provider_expires_at = ?, status = 'pending', updated_at = ?
				 WHERE id = ? AND status = 'created'`,
			)
			.bind(
				payment.providerPaymentId,
				payment.checkoutUrl,
				payment.expiresAt,
				Date.now(),
				attemptId,
			)
			.run();
		return { id: attemptId, status: "pending", ...payment };
	} catch (error) {
		await db.batch(
			paymentCreationFailureStatements(
				db,
				attemptId,
				context.provider,
				input.payerIp,
				now,
				error,
			),
		);
		throw error instanceof PaymentCreationError
			? new DomainError(error.code, error.status, error.message)
			: error;
	}
}

export async function createWalletTopupPayment(
	db: D1Database,
	input: {
		userId: string;
		amountMinor: string;
		channelId: string;
		idempotencyKey: string;
		paymentCurrency?: string;
		successUrl: string;
		cancelUrl: string;
		payerIp?: string | null;
		payerMobile?: boolean;
	},
	fetcher: typeof fetch = fetch,
) {
	const existing = await db
		.prepare(
			`SELECT pa.id, pa.wallet_topup_id, pa.channel_id, pa.provider_payment_id,
			 pa.checkout_url, pa.provider_expires_at, pa.status,
			 topup.amount_minor AS topup_amount_minor
			 FROM payment_attempts pa LEFT JOIN wallet_topups topup
			  ON topup.id = pa.wallet_topup_id
			 WHERE pa.idempotency_key = ? LIMIT 1`,
		)
		.bind(input.idempotencyKey)
		.first<{
			id: string;
			wallet_topup_id: string | null;
			channel_id: string;
			provider_payment_id: string | null;
			checkout_url: string | null;
			provider_expires_at: number | null;
			status: string;
			topup_amount_minor: string | null;
		}>();
	if (existing) {
		if (
			existing.channel_id !== input.channelId ||
			!existing.wallet_topup_id ||
			existing.topup_amount_minor !== input.amountMinor
		)
			throw new DomainError(
				"payment_idempotency_conflict",
				409,
				"Payment idempotency conflict",
			);
		return { topupId: existing.wallet_topup_id, ...presentAttempt(existing) };
	}
	const context = await db
		.prepare(
			`SELECT u.email, pc.id AS channel_id, pc.provider, pc.credential_encrypted,
			 pc.default_token, pc.default_network, pc.fee_bps, pc.fixed_fee_minor,
			 COALESCE((SELECT json_extract(value, '$') FROM system_settings
			  WHERE key = 'commerce.default_currency'), 'USD') AS currency,
			 COALESCE((SELECT CAST(json_extract(value, '$') AS INTEGER) FROM system_settings
			  WHERE key = 'commerce.currency_decimals'), 2) AS currency_decimals
			 FROM users u JOIN payment_channels pc ON pc.id = ?
			 WHERE u.id = ? AND u.enabled = 1 AND pc.enabled = 1 LIMIT 1`,
		)
		.bind(input.channelId, input.userId)
		.first<{
			email: string;
			channel_id: string;
			provider: string;
			credential_encrypted: string | null;
			default_token: string;
			default_network: string;
			fee_bps: number;
			fixed_fee_minor: string;
			currency: string;
			currency_decimals: number;
		}>();
	if (!context)
		throw new DomainError(
			"payment_channel_unavailable",
			404,
			"Payment channel unavailable",
		);
	const paymentAmountMinor = grossUpPaymentAmount(
		input.amountMinor,
		context.fee_bps,
		context.fixed_fee_minor,
	);
	const quote = await quotePaymentCurrency(db, {
		amountMinor: paymentAmountMinor,
		currency: context.currency,
		currencyDecimals: context.currency_decimals,
		paymentCurrency: input.paymentCurrency ?? context.currency,
	});
	const topupId = crypto.randomUUID();
	const attemptId = crypto.randomUUID();
	const now = Date.now();
	await db.batch([
		db
			.prepare(
				`INSERT INTO wallet_topups (id, user_id, amount_minor, currency, currency_decimals, status, idempotency_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
			)
			.bind(
				topupId,
				input.userId,
				input.amountMinor,
				context.currency,
				context.currency_decimals,
				input.idempotencyKey,
				now,
				now,
			),
		db
			.prepare(
				`INSERT INTO payment_attempts (id, order_id, wallet_topup_id, channel_id, idempotency_key, status, amount_minor, currency, currency_decimals, exchange_rate_id, exchange_rate, exchange_rate_direction, exchange_rate_source, exchange_rate_adjustment_bps, exchange_rate_observed_at, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, 'created', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				attemptId,
				topupId,
				input.channelId,
				input.idempotencyKey,
				quote.amountMinor,
				quote.currency,
				quote.currencyDecimals,
				quote.rateId,
				quote.rate,
				quote.rateDirection,
				quote.rateSource,
				quote.rateAdjustmentBps,
				quote.rateObservedAt,
				now,
				now,
			),
	]);
	try {
		const credential = await loadCredential(db, context.credential_encrypted);
		const payment = await getPaymentProvider(context.provider).createPayment(
			{
				attemptId,
				orderId: topupId,
				orderNumber: `TOPUP-${topupId}`,
				amountMinor: quote.amountMinor,
				currency: quote.currency,
				currencyDecimals: quote.currencyDecimals,
				customerEmail: context.email,
				description: "Wallet top-up",
				successUrl: input.successUrl,
				cancelUrl: input.cancelUrl,
				webhookUrl: new URL(
					`/api/shop/payments/${encodeURIComponent(input.channelId)}/webhook`,
					input.successUrl,
				).toString(),
				defaultToken: context.default_token,
				defaultNetwork: context.default_network,
				payerIp: input.payerIp ?? null,
				payerMobile: input.payerMobile ?? false,
			},
			credential,
			fetcher,
		);
		await db
			.prepare(
				"UPDATE payment_attempts SET provider_payment_id = ?, checkout_url = ?, provider_expires_at = ?, status = 'pending', updated_at = ? WHERE id = ? AND status = 'created'",
			)
			.bind(
				payment.providerPaymentId,
				payment.checkoutUrl,
				payment.expiresAt,
				Date.now(),
				attemptId,
			)
			.run();
		return { topupId, id: attemptId, status: "pending", ...payment };
	} catch (error) {
		await db.batch([
			...paymentCreationFailureStatements(
				db,
				attemptId,
				context.provider,
				input.payerIp ?? null,
				now,
				error,
			),
			db
				.prepare(
					"UPDATE wallet_topups SET status = 'failed', updated_at = ? WHERE id = ?",
				)
				.bind(Date.now(), topupId),
		]);
		throw error instanceof PaymentCreationError
			? new DomainError(error.code, error.status, error.message)
			: error;
	}
}

function paymentCreationFailureStatements(
	db: D1Database,
	attemptId: string,
	provider: string,
	payerIp: string | null,
	startedAt: number,
	error: unknown,
) {
	const now = Date.now();
	const errorCode =
		error instanceof DomainError ? error.code : "provider_create_failed";
	const details = {
		provider,
		errorCode,
		elapsedMs: Math.max(0, now - startedAt),
		payerIpVersion:
			payerIp === null ? "missing" : payerIp.includes(":") ? "ipv6" : "ipv4",
		...(error instanceof PaymentCreationError ? error.diagnostics : {}),
	};
	return [
		db
			.prepare(
				"UPDATE payment_attempts SET status = 'failed', failure_code = ?, updated_at = ? WHERE id = ? AND status = 'created'",
			)
			.bind(errorCode, now, attemptId),
		db
			.prepare(`INSERT INTO audit_logs (id,action,target_type,target_id,after,created_at)
		 VALUES (?, 'payment.creation_failed', 'payment_attempt', ?, ?, ?)`)
			.bind(crypto.randomUUID(), attemptId, JSON.stringify(details), now),
	];
}

export async function handleShopPaymentWebhook(
	request: Request,
	channelId: string,
	db: D1Database,
) {
	const channel = await db
		.prepare(
			"SELECT provider, credential_encrypted FROM payment_channels WHERE id = ? AND enabled = 1 LIMIT 1",
		)
		.bind(channelId)
		.first<{ provider: string; credential_encrypted: string | null }>();
	if (!channel)
		throw new DomainError(
			"payment_channel_not_found",
			404,
			"Payment channel not found",
		);
	const credential = await loadCredential(db, channel.credential_encrypted);
	const event = await getPaymentProvider(channel.provider).parseWebhook(
		request,
		credential,
	);
	return {
		provider: channel.provider,
		...(await processShopPaymentEvent(db, channelId, event)),
	};
}

export async function reconcilePendingShopPayments(
	db: D1Database,
	fetcher: typeof fetch = fetch,
	now = Date.now(),
	limit = 20,
) {
	const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
	const attempts = await db
		.prepare(
			`SELECT pa.id,pa.channel_id,pa.provider_payment_id,pa.amount_minor,pa.currency,
			 pc.provider,pc.credential_encrypted
			 FROM payment_attempts pa JOIN payment_channels pc ON pc.id=pa.channel_id
			 JOIN shop_orders o ON o.id=pa.order_id
			 WHERE pa.status IN ('pending','expired')
			  AND o.status IN ('pending_payment','expired')
			  AND pa.provider_payment_id IS NOT NULL
			  AND pc.enabled=1 AND pc.provider IN ('epay','gmpay')
			  AND pa.created_at>=?
			 ORDER BY pa.created_at,pa.id LIMIT ?`,
		)
		.bind(now - 86_400_000, boundedLimit)
		.all<{
			id: string;
			channel_id: string;
			provider_payment_id: string;
			amount_minor: string;
			currency: string;
			provider: string;
			credential_encrypted: string | null;
		}>();
	let succeeded = 0;
	let pending = 0;
	let failed = 0;
	for (const attempt of attempts.results) {
		try {
			const result = await reconcilePaymentAttempt(db, attempt, fetcher, now);
			if (result !== "succeeded") {
				pending += 1;
				continue;
			}
			succeeded += 1;
		} catch (error) {
			failed += 1;
			logPaymentReconciliationFailure(attempt, error);
		}
	}
	return { scanned: attempts.results.length, succeeded, pending, failed };
}

export async function reconcileShopOrderPayment(
	db: D1Database,
	orderId: string,
	fetcher: typeof fetch = fetch,
	now = Date.now(),
) {
	const attempt = await db
		.prepare(
			`SELECT pa.id,pa.channel_id,pa.provider_payment_id,pa.amount_minor,pa.currency,
			 pc.provider,pc.credential_encrypted
			 FROM payment_attempts pa JOIN payment_channels pc ON pc.id=pa.channel_id
			 JOIN shop_orders o ON o.id=pa.order_id
			 WHERE pa.order_id=? AND pa.status IN ('pending','expired')
			  AND o.status IN ('pending_payment','expired')
			  AND pa.provider_payment_id IS NOT NULL
			  AND pc.enabled=1 AND pc.provider IN ('epay','gmpay')
			  AND pa.updated_at<=?
			 ORDER BY pa.created_at DESC,pa.id DESC LIMIT 1`,
		)
		.bind(orderId, now - 3_000)
		.first<ReconcilePaymentAttempt>();
	if (!attempt) return { checked: false, status: "pending" as const };
	try {
		return {
			checked: true,
			status: await reconcilePaymentAttempt(db, attempt, fetcher, now),
		};
	} catch (error) {
		logPaymentReconciliationFailure(attempt, error);
		return { checked: true, status: "failed" as const };
	}
}

function logPaymentReconciliationFailure(
	attempt: Pick<ReconcilePaymentAttempt, "id" | "channel_id" | "provider">,
	error: unknown,
) {
	console.error(
		JSON.stringify({
			event: "payment_reconciliation_failed",
			attemptId: attempt.id,
			channelId: attempt.channel_id,
			provider: attempt.provider,
			errorCode:
				error instanceof z.ZodError
					? "invalid_provider_response"
					: error instanceof DomainError
						? error.code
						: "provider_query_failed",
		}),
	);
}

type ReconcilePaymentAttempt = {
	id: string;
	channel_id: string;
	provider_payment_id: string;
	amount_minor: string;
	currency: string;
	provider: string;
	credential_encrypted: string | null;
};

async function reconcilePaymentAttempt(
	db: D1Database,
	attempt: ReconcilePaymentAttempt,
	fetcher: typeof fetch,
	now: number,
) {
	const credential = await loadCredential(db, attempt.credential_encrypted);
	const query = await getPaymentProvider(attempt.provider).queryPayment(
		attempt.provider_payment_id,
		credential,
		fetcher,
	);
	if (query.status !== "succeeded") {
		await db
			.prepare(
				"UPDATE payment_attempts SET updated_at=? WHERE id=? AND status IN ('pending','expired')",
			)
			.bind(now, attempt.id)
			.run();
		return "pending" as const;
	}
	await processShopPaymentEvent(db, attempt.channel_id, {
		providerEventId: `payment-reconcile:${attempt.channel_id}:${attempt.id}`,
		providerPaymentId: attempt.provider_payment_id,
		type: "payment_succeeded",
		amountMinor: query.amountMinor ?? attempt.amount_minor,
		currency: query.currency ?? attempt.currency,
		merchantOrderId: null,
		payloadDigest: `payment-reconcile:${attempt.id}`,
	});
	return "succeeded" as const;
}

export async function processShopPaymentEvent(
	db: D1Database,
	channelId: string,
	event: PaymentWebhookEvent,
) {
	const duplicate = await findPaymentReplayReceipt(
		db,
		channelId,
		event.providerEventId,
	);
	if (duplicate) return presentPaymentReplayReceipt(duplicate, event);
	const context = await loadPaymentContext(
		db,
		channelId,
		event.providerPaymentId,
		event.merchantOrderId ?? null,
	);
	validateEventMoney(context, event);
	if (event.type === "payment_succeeded" && context.order_id) {
		const released = await db
			.prepare(`SELECT order_id FROM order_balance_holds WHERE order_id=? AND state='released'
   UNION ALL SELECT cr.order_id FROM coupon_redemptions cr JOIN coupons c ON c.id=cr.coupon_id
   WHERE cr.order_id=? AND cr.status='released' AND c.purpose='recall' LIMIT 1`)
			.bind(context.order_id, context.order_id)
			.first();
		if (released) {
			const now = Date.now();
			await runPaymentEventBatch(db, channelId, event, [
				paymentEventStatement(
					db,
					channelId,
					context.attempt_id,
					event,
					"rejected",
					now,
				),
				db
					.prepare(
						"UPDATE payment_attempts SET failure_code='payment_reconciliation_required',updated_at=? WHERE id=?",
					)
					.bind(now, context.attempt_id),
			]);
			return { duplicate: false, status: "reconciliation_required" };
		}
	}
	if (context.attempt_status === "succeeded") {
		const result = await runPaymentEventBatch(db, channelId, event, [
			paymentEventStatement(
				db,
				channelId,
				context.attempt_id,
				event,
				"processed",
				Date.now(),
			),
		]);
		if (result.duplicate)
			return presentPaymentReplayReceipt(result.duplicate, event);
		return { duplicate: true, status: "processed" };
	}
	if (event.type === "payment_pending") {
		const result = await runPaymentEventBatch(db, channelId, event, [
			paymentEventStatement(
				db,
				channelId,
				context.attempt_id,
				event,
				"processed",
				Date.now(),
			),
		]);
		if (result.duplicate)
			return presentPaymentReplayReceipt(result.duplicate, event);
		return { duplicate: false, status: "pending" };
	}
	if (event.type !== "payment_succeeded") {
		const status = event.type === "payment_expired" ? "expired" : "failed";
		const now = Date.now();
		const result = await runPaymentEventBatch(db, channelId, event, [
			paymentEventStatement(
				db,
				channelId,
				context.attempt_id,
				event,
				"processed",
				now,
			),
			db
				.prepare(
					"UPDATE payment_attempts SET status = ?, failure_code = ?, updated_at = ? WHERE id = ? AND status IN ('created', 'pending')",
				)
				.bind(status, event.type, now, context.attempt_id),
			...(context.wallet_topup_id
				? [
						db
							.prepare(
								"UPDATE wallet_topups SET status = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
							)
							.bind(status, now, context.wallet_topup_id),
					]
				: []),
		]);
		if (result.duplicate)
			return presentPaymentReplayReceipt(result.duplicate, event);
		return { duplicate: false, status };
	}
	if (
		context.wallet_topup_id &&
		context.topup_user_id &&
		context.topup_amount_minor &&
		context.topup_currency
	) {
		if (context.topup_status !== "pending")
			throw new DomainError(
				"topup_not_payable",
				409,
				"Top-up cannot accept payment",
			);
		await mutateWallet(db, {
			userId: context.topup_user_id,
			direction: "credit",
			amountMinor: context.topup_amount_minor,
			currency: context.topup_currency,
			sourceType: "topup",
			sourceId: context.wallet_topup_id,
			idempotencyKey: `wallet-topup:${context.wallet_topup_id}`,
		});
		const now = Date.now();
		const result = await runPaymentEventBatch(db, channelId, event, [
			paymentEventStatement(
				db,
				channelId,
				context.attempt_id,
				event,
				"processed",
				now,
			),
			db
				.prepare(
					"UPDATE payment_attempts SET status = 'succeeded', succeeded_at = ?, updated_at = ?, failure_code = NULL WHERE id = ? AND status IN ('created', 'pending')",
				)
				.bind(now, now, context.attempt_id),
			db
				.prepare(
					"UPDATE wallet_topups SET status = 'paid', paid_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
				)
				.bind(now, now, context.wallet_topup_id),
		]);
		if (result.duplicate)
			return presentPaymentReplayReceipt(result.duplicate, event);
		return { duplicate: false, status: "succeeded" };
	}
	if (!context.order_id || context.order_version === null)
		throw new DomainError(
			"payment_subject_invalid",
			409,
			"Payment subject is invalid",
		);
	if (
		!context.order_status ||
		!["pending_payment", "expired"].includes(context.order_status)
	)
		throw new DomainError(
			"order_not_payable",
			409,
			"Order cannot accept payment",
		);

	const items = await db
		.prepare(`${orderItemsForFulfillmentSql} WHERE oi.order_id = ?`)
		.bind(context.order_id)
		.all<OrderItem>();
	const now = Date.now();
	const nextVersion = context.order_version + 1;
	const previousOrderStatus = context.order_status as
		| "pending_payment"
		| "expired";
	const statements: D1PreparedStatement[] = [
		paymentEventStatement(
			db,
			channelId,
			context.attempt_id,
			event,
			"processed",
			now,
		),
		db
			.prepare(
				`UPDATE payment_attempts SET status = 'succeeded', succeeded_at = ?,
				 updated_at = ?, failure_code = NULL WHERE id = ?
				 AND status IN ('created', 'pending', 'expired')`,
			)
			.bind(now, now, context.attempt_id),
		db
			.prepare(
				`UPDATE shop_orders SET status = 'paid', paid_minor = total_minor,
				 paid_at = ?, cancelled_at = NULL, version = ?, updated_at = ?
				 WHERE id = ? AND status = ? AND version = ?`,
			)
			.bind(
				now,
				nextVersion,
				now,
				context.order_id,
				previousOrderStatus,
				context.order_version,
			),
		db
			.prepare(
				`INSERT INTO shop_order_events
			 (id, order_id, event_type, visibility, from_status, to_status, order_version,
			  note, actor_type, created_at)
				 SELECT ?, (SELECT id FROM shop_orders WHERE id = ? AND status = 'paid' AND version = ?), 'payment_succeeded', 'customer', ?, 'paid', ?, NULL, 'provider', ?`,
			)
			.bind(
				crypto.randomUUID(),
				context.order_id,
				nextVersion,
				previousOrderStatus,
				nextVersion,
				now,
			),
	];
	for (const item of items.results)
		statements.push(...fulfillmentStatements(db, context.order_id, item, now));
	statements.push(
		db
			.prepare(
				`UPDATE coupon_redemptions SET status = 'consumed', released_at = NULL,
				 updated_at = ? WHERE order_id = ? AND status IN ('reserved', 'released')`,
			)
			.bind(now, context.order_id),
		db
			.prepare(
				`INSERT INTO outbox_events
			 (id, event_type, aggregate_type, aggregate_id, idempotency_key, payload,
			  status, attempt_count, created_at, updated_at)
			 SELECT ?, 'shop_order.paid', 'shop_order', id, ?, ?, 'pending', 0, ?, ?
			 FROM shop_orders WHERE id = ? AND status = 'paid' AND version = ?`,
			)
			.bind(
				crypto.randomUUID(),
				`shop-order-paid:${context.order_id}:${nextVersion}`,
				JSON.stringify({ orderId: context.order_id, version: nextVersion }),
				now,
				now,
				context.order_id,
				nextVersion,
			),
		db
			.prepare(
				`INSERT INTO commerce_events
				 (id, event_type, session_id, order_id, currency, amount_minor, created_at)
				 SELECT ?, 'payment_succeeded', event.session_id, orders.id,
				  orders.currency, orders.total_minor, ?
				 FROM commerce_events event
				 JOIN shop_orders orders ON orders.id = event.order_id
				 WHERE event.order_id = ? AND event.event_type = 'order_created'
				 ORDER BY event.created_at, event.id LIMIT 1`,
			)
			.bind(crypto.randomUUID(), now, context.order_id),
	);
	if (context.order_id)
		statements.push(unallocatedPaymentStatement(db, context.order_id));
	const result = await runPaymentEventBatch(db, channelId, event, statements);
	if (result.duplicate)
		return presentPaymentReplayReceipt(result.duplicate, event);
	if (Number(result.results[2]?.meta.changes ?? 0) < 1)
		throw new DomainError(
			"order_version_conflict",
			409,
			"Order changed; retry event",
		);
	return { duplicate: false, status: "succeeded" };
}

export async function completeFreeStoreOrder(
	db: D1Database,
	orderId: string,
	balanceUserId?: string,
) {
	const order = await db
		.prepare(
			`SELECT id, status, version, total_minor FROM shop_orders
			 WHERE id = ? LIMIT 1`,
		)
		.bind(orderId)
		.first<{
			id: string;
			status: string;
			version: number;
			total_minor: string;
		}>();
	if (!order) throw new DomainError("order_not_found", 404, "Order not found");
	const fullHold =
		balanceUserId &&
		(await db
			.prepare(
				"SELECT order_id FROM order_balance_holds WHERE order_id=? AND user_id=? AND external_minor='0' AND state IN ('held','consumed')",
			)
			.bind(orderId, balanceUserId)
			.first());
	if (order.total_minor !== "0" && !fullHold)
		throw new DomainError("order_payment_required", 409, "Payment is required");
	if (order.status === "paid" || order.status === "completed")
		return { duplicate: true, status: order.status };
	if (order.status !== "pending_payment")
		throw new DomainError(
			"order_not_payable",
			409,
			"Order cannot be completed",
		);
	const items = await db
		.prepare(`${orderItemsForFulfillmentSql} WHERE oi.order_id = ?`)
		.bind(order.id)
		.all<OrderItem>();
	const now = Date.now();
	const version = order.version + 1;
	const statements: D1PreparedStatement[] = [
		db
			.prepare(
				`UPDATE shop_orders SET status = 'paid', paid_minor = total_minor, paid_at = ?,
				 version = ?, updated_at = ? WHERE id = ? AND status = 'pending_payment'
				 AND version = ? AND (total_minor = '0' OR EXISTS (SELECT 1 FROM order_balance_holds WHERE order_id=shop_orders.id AND external_minor='0' AND state='held'))`,
			)
			.bind(now, version, now, order.id, order.version),
		db
			.prepare(
				`INSERT INTO shop_order_events
				 (id, order_id, event_type, visibility, from_status, to_status,
				  order_version, actor_type, created_at)
				 SELECT ?, id, 'payment_not_required', 'customer', 'pending_payment',
				 'paid', ?, 'system', ? FROM shop_orders
				 WHERE id = ? AND status = 'paid' AND version = ?`,
			)
			.bind(crypto.randomUUID(), version, now, order.id, version),
	];
	for (const item of items.results)
		statements.push(...fulfillmentStatements(db, order.id, item, now));
	statements.push(
		db
			.prepare(
				`UPDATE coupon_redemptions SET status = 'consumed', updated_at = ?
				 WHERE order_id = ? AND status = 'reserved'`,
			)
			.bind(now, order.id),
		db
			.prepare(
				`INSERT INTO outbox_events
				 (id, event_type, aggregate_type, aggregate_id, idempotency_key, payload,
				  status, attempt_count, created_at, updated_at)
				 SELECT ?, 'shop_order.paid', 'shop_order', id, ?, ?, 'pending', 0, ?, ?
				 FROM shop_orders WHERE id = ? AND status = 'paid' AND version = ?`,
			)
			.bind(
				crypto.randomUUID(),
				`shop-order-paid:${order.id}:${version}`,
				JSON.stringify({ orderId: order.id, version }),
				now,
				now,
				order.id,
				version,
			),
		db
			.prepare(
				`INSERT INTO commerce_events
				 (id, event_type, session_id, order_id, currency, amount_minor, created_at)
				 SELECT ?, 'payment_succeeded', event.session_id, orders.id,
				  orders.currency, orders.total_minor, ?
				 FROM commerce_events event
				 JOIN shop_orders orders ON orders.id = event.order_id
				 WHERE event.order_id = ? AND event.event_type = 'order_created'
				 ORDER BY event.created_at, event.id LIMIT 1`,
			)
			.bind(crypto.randomUUID(), now, order.id),
	);
	statements.push(unallocatedPaymentStatement(db, orderId));
	const results = await db.batch(statements);
	if (Number(results[0]?.meta.changes ?? 0) < 1)
		throw new DomainError(
			"order_version_conflict",
			409,
			"Order changed; retry completion",
		);
	return { duplicate: false, status: "paid" };
}

export async function completeWalletStoreOrder(
	db: D1Database,
	input: { orderId: string; userId: string },
) {
	const order = await db
		.prepare(
			`SELECT orders.id, orders.status, orders.version, orders.total_minor,
			 orders.currency, orders.user_id, users.balance_minor, users.balance_version
			 FROM shop_orders orders LEFT JOIN users ON users.id = orders.user_id
			 WHERE orders.id = ? LIMIT 1`,
		)
		.bind(input.orderId)
		.first<{
			id: string;
			status: string;
			version: number;
			total_minor: string;
			currency: string;
			user_id: string | null;
			balance_minor: string | null;
			balance_version: number | null;
		}>();
	if (!order || order.user_id !== input.userId)
		throw new DomainError("order_not_found", 404, "Order not found");
	if (order.status !== "pending_payment") {
		if (["paid", "fulfilling", "completed"].includes(order.status))
			return { duplicate: true, status: order.status };
		throw new DomainError("order_not_payable", 409, "Order cannot be paid");
	}
	const held = await db
		.prepare("SELECT order_id FROM order_balance_holds WHERE order_id=?")
		.bind(order.id)
		.first();
	if (held)
		throw new DomainError(
			"wallet_hold_conflict",
			409,
			"Continue the existing split payment or start a new order",
		);
	const settings = await db
		.prepare(
			"SELECT value FROM system_settings WHERE key = 'commerce.default_currency' LIMIT 1",
		)
		.first<{ value: string }>();
	const currency = settings ? String(JSON.parse(settings.value)) : "USD";
	if (order.currency !== currency)
		throw new DomainError(
			"wallet_currency_mismatch",
			409,
			"Wallet currency mismatch",
		);
	if (order.balance_minor === null || order.balance_version === null)
		throw new DomainError(
			"wallet_user_not_found",
			404,
			"Wallet user not found",
		);
	const balanceBefore = BigInt(order.balance_minor);
	const amount = BigInt(order.total_minor);
	if (balanceBefore < amount)
		throw new DomainError(
			"wallet_insufficient_balance",
			409,
			"Insufficient balance",
		);
	const balanceAfter = (balanceBefore - amount).toString();
	const balanceVersion = order.balance_version + 1;
	const walletIdempotencyKey = `wallet-order:${order.id}`;
	const items = await db
		.prepare(`${orderItemsForFulfillmentSql} WHERE oi.order_id = ?`)
		.bind(order.id)
		.all<OrderItem>();
	const now = Date.now();
	const version = order.version + 1;
	const statements: D1PreparedStatement[] = [
		db
			.prepare(`UPDATE users SET balance_minor = ?, balance_version = ?, updated_at = ?
		 WHERE id = ? AND enabled = 1 AND balance_version = ?
		 AND EXISTS (SELECT 1 FROM shop_orders WHERE id = ? AND status = 'pending_payment' AND version = ?)`)
			.bind(
				balanceAfter,
				balanceVersion,
				now,
				input.userId,
				order.balance_version,
				order.id,
				order.version,
			),
		db
			.prepare(`INSERT INTO wallet_entries
		 (id, user_id, direction, amount_minor, balance_before_minor, balance_after_minor,
		  currency, source_type, source_id, idempotency_key, created_at)
		 SELECT ?, id, 'debit', ?, ?, balance_minor, ?, 'shop_order', ?, ?, ?
		 FROM users WHERE id = ? AND balance_version = ? AND balance_minor = ? AND changes() = 1`)
			.bind(
				crypto.randomUUID(),
				order.total_minor,
				order.balance_minor,
				currency,
				order.id,
				walletIdempotencyKey,
				now,
				input.userId,
				balanceVersion,
				balanceAfter,
			),
		db
			.prepare(
				`UPDATE shop_orders SET status = 'paid', paid_minor = total_minor, paid_at = ?, version = ?, updated_at = ? WHERE id = ? AND status = 'pending_payment' AND version = ? AND EXISTS (SELECT 1 FROM wallet_entries WHERE idempotency_key = ?)`,
			)
			.bind(now, version, now, order.id, order.version, walletIdempotencyKey),
		db
			.prepare(
				`INSERT INTO shop_order_events (id, order_id, event_type, visibility, from_status, to_status, order_version, actor_type, created_at) SELECT ?, id, 'wallet_payment_succeeded', 'customer', 'pending_payment', 'paid', ?, 'customer', ? FROM shop_orders WHERE id = ? AND status = 'paid' AND version = ?`,
			)
			.bind(crypto.randomUUID(), version, now, order.id, version),
	];
	for (const item of items.results)
		statements.push(...fulfillmentStatements(db, order.id, item, now));
	statements.push(
		db
			.prepare(
				"UPDATE coupon_redemptions SET status = 'consumed', updated_at = ? WHERE order_id = ? AND status = 'reserved'",
			)
			.bind(now, order.id),
		db
			.prepare(
				`INSERT INTO outbox_events (id, event_type, aggregate_type, aggregate_id, idempotency_key, payload, status, attempt_count, created_at, updated_at) SELECT ?, 'shop_order.paid', 'shop_order', id, ?, ?, 'pending', 0, ?, ? FROM shop_orders WHERE id = ? AND status = 'paid' AND version = ?`,
			)
			.bind(
				crypto.randomUUID(),
				`shop-order-paid:${order.id}:${version}`,
				JSON.stringify({ orderId: order.id, version }),
				now,
				now,
				order.id,
				version,
			),
	);
	statements.push(unallocatedPaymentStatement(db, input.orderId));
	const results = await db.batch(statements);
	if (Number(results[0]?.meta.changes ?? 0) < 1) {
		const current = await db
			.prepare("SELECT status FROM shop_orders WHERE id = ?")
			.bind(order.id)
			.first<{ status: string }>();
		if (current && ["paid", "fulfilling", "completed"].includes(current.status))
			return { duplicate: true, status: current.status };
		throw new DomainError(
			"order_version_conflict",
			409,
			"Order or wallet changed; retry payment",
		);
	}
	return { duplicate: false, status: "paid" };
}

async function loadCredential(db: D1Database, encrypted: string | null) {
	if (!encrypted) return {};
	const runtime = await loadRuntimeConfig(db);
	if (!runtime.commerceSecret)
		throw new DomainError(
			"payment_secret_unavailable",
			503,
			"Payment configuration unavailable",
		);
	return JSON.parse(
		await decryptSecret(
			encrypted,
			runtime.commerceSecret,
			"payment-credential",
		),
	) as unknown;
}

async function loadPaymentContext(
	db: D1Database,
	channelId: string,
	providerPaymentId: string,
	merchantOrderId: string | null,
) {
	const context = await db
		.prepare(
			`SELECT pa.id AS attempt_id, pa.status AS attempt_status, pa.amount_minor,
			 pa.currency, pa.currency_decimals, pa.channel_id, o.id AS order_id,
			 pa.wallet_topup_id, o.order_number,
			 o.status AS order_status, o.version AS order_version,
			 topup.status AS topup_status, topup.user_id AS topup_user_id,
			 topup.amount_minor AS topup_amount_minor,
			 topup.currency AS topup_currency,
			 COALESCE(o.contact_email, topup_user.email) AS contact_email,
			 pc.provider, pc.credential_encrypted
			 FROM payment_attempts pa LEFT JOIN shop_orders o ON o.id = pa.order_id
			 LEFT JOIN wallet_topups topup ON topup.id = pa.wallet_topup_id
			 LEFT JOIN users topup_user ON topup_user.id = topup.user_id
			 JOIN payment_channels pc ON pc.id = pa.channel_id
			 WHERE pa.channel_id = ? AND (
			  pa.provider_payment_id = ? OR
			  (? IS NOT NULL AND pa.provider_payment_id LIKE '%:' || ?)
			 ) LIMIT 1`,
		)
		.bind(channelId, providerPaymentId, merchantOrderId, merchantOrderId)
		.first<PaymentContext>();
	if (!context)
		throw new DomainError(
			"payment_attempt_not_found",
			404,
			"Payment attempt not found",
		);
	return context;
}

function validateEventMoney(
	context: PaymentContext,
	event: PaymentWebhookEvent,
) {
	if (event.type !== "payment_succeeded") return;
	let decimalMinor: string | null = null;
	try {
		decimalMinor =
			event.amountDecimal == null
				? null
				: decimalToMinor(
						event.amountDecimal,
						context.currency_decimals,
					).toString();
	} catch {
		throw new DomainError(
			"payment_amount_mismatch",
			400,
			"Payment amount mismatch",
		);
	}
	const expectedMerchantOrderIds = new Set([
		context.attempt_id,
		context.order_number,
		epusdtMerchantOrderId(context.attempt_id),
	]);
	if (
		(event.amountMinor == null && decimalMinor == null) ||
		(event.amountMinor != null && event.amountMinor !== context.amount_minor) ||
		(decimalMinor != null && decimalMinor !== context.amount_minor) ||
		(event.currency != null &&
			event.currency.toUpperCase() !== context.currency.toUpperCase()) ||
		(event.merchantOrderId != null &&
			!expectedMerchantOrderIds.has(event.merchantOrderId))
	)
		throw new DomainError(
			"payment_amount_mismatch",
			400,
			"Payment amount mismatch",
		);
}

function paymentEventStatement(
	db: D1Database,
	channelId: string,
	attemptId: string,
	event: PaymentWebhookEvent,
	status: "processed" | "rejected",
	now: number,
) {
	return db
		.prepare(
			`INSERT INTO replay_receipts
		 (id, namespace, scope_id, payment_attempt_id, external_id, event_type,
		  payload_digest, status, processed_at, created_at, updated_at)
		 VALUES (?, 'payment_webhook', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			crypto.randomUUID(),
			channelId,
			attemptId,
			event.providerEventId,
			event.type,
			event.payloadDigest,
			status,
			now,
			now,
			now,
		);
}

type PaymentReplayReceipt = {
	status: string;
	event_type: string;
	payload_digest: string;
};

async function findPaymentReplayReceipt(
	db: D1Database,
	channelId: string,
	providerEventId: string,
) {
	return db
		.prepare(
			`SELECT status, event_type, payload_digest FROM replay_receipts
			 WHERE namespace = 'payment_webhook' AND scope_id = ?
			  AND external_id = ? LIMIT 1`,
		)
		.bind(channelId, providerEventId)
		.first<PaymentReplayReceipt>();
}

function presentPaymentReplayReceipt(
	receipt: PaymentReplayReceipt,
	event: PaymentWebhookEvent,
) {
	if (
		receipt.event_type !== event.type ||
		receipt.payload_digest !== event.payloadDigest
	)
		throw new DomainError(
			"payment_replay_conflict",
			409,
			"Payment event identifier was reused with different content",
		);
	return { duplicate: true as const, status: receipt.status };
}

async function runPaymentEventBatch(
	db: D1Database,
	channelId: string,
	event: PaymentWebhookEvent,
	statements: D1PreparedStatement[],
) {
	try {
		return {
			duplicate: null,
			results: await db.batch(statements),
		};
	} catch (error) {
		const duplicate = await findPaymentReplayReceipt(
			db,
			channelId,
			event.providerEventId,
		);
		if (duplicate) return { duplicate, results: null };
		throw error;
	}
}

function fulfillmentStatements(
	db: D1Database,
	orderId: string,
	item: OrderItem,
	now: number,
) {
	const deliveryId = crypto.randomUUID();
	const supplierOrderId = crypto.randomUUID();
	const statements: D1PreparedStatement[] = [];
	const supplierStock =
		item.delivery_component_type === "stock" &&
		item.fulfillment_source === "supplier";
	const supplierFallback =
		item.delivery_component_type === "stock" &&
		item.fulfillment_source === "local" &&
		item.supplier_fallback_enabled === 1 &&
		supplierBindingReady(item);
	const useSupplier = supplierStock || supplierFallback;
	const manualStock =
		item.delivery_component_type === "stock" &&
		item.fulfillment_source === "manual";
	if (supplierStock && !supplierBindingReady(item))
		throw new DomainError(
			"supplier_binding_unavailable",
			409,
			"Supplier binding unavailable",
		);
	if (
		item.delivery_component_type === "stock" &&
		item.fulfillment_source === "local"
	) {
		statements.push(
			db
				.prepare(
					`UPDATE stock_entries SET status = 'reserved', order_item_id = ?, reserved_at = ?, updated_at = ?
					 WHERE id IN (SELECT id FROM stock_entries WHERE sellable_item_id = ? AND status = 'available'
					 ORDER BY created_at, id LIMIT MAX(0,?-(SELECT COUNT(*) FROM stock_entries WHERE order_item_id=? AND status='reserved')))
					 AND (? = 1 OR (SELECT COUNT(*) FROM stock_entries WHERE sellable_item_id = ? AND status = 'available') + (SELECT COUNT(*) FROM stock_entries WHERE order_item_id=? AND status='reserved') >= ?)`,
				)
				.bind(
					item.id,
					now,
					now,
					item.delivery_component_id,
					item.quantity,
					item.id,
					supplierFallback,
					item.delivery_component_id,
					item.id,
					item.quantity,
				),
		);
	}
	if (item.delivery_component_type === "stock") {
		statements.push(
			db
				.prepare(
					`INSERT INTO delivery_records
					 (id, order_item_id, delivery_type, request_key, status, attempt_count, next_attempt_at,
					  error_code, created_at, updated_at)
					 SELECT ?, ?, 'stock', ?,
				  CASE WHEN ? = 1 THEN 'awaiting_supply'
				   WHEN (SELECT COUNT(*) FROM stock_entries WHERE order_item_id = ? AND status = 'reserved') = ? THEN 'pending'
				   WHEN ? = 1 THEN 'awaiting_supply'
				   ELSE 'failed' END,
				  0, ?,
				  CASE WHEN ? = 1 THEN NULL
				   WHEN (SELECT COUNT(*) FROM stock_entries WHERE order_item_id = ? AND status = 'reserved') = ? THEN NULL
				   WHEN ? = 1 THEN NULL
				   ELSE 'inventory_unavailable' END,
				  ?, ? FROM shop_orders WHERE id = ? AND status = 'paid'`,
				)
				.bind(
					deliveryId,
					item.id,
					`initial:${item.id}`,
					manualStock,
					item.id,
					item.quantity,
					useSupplier,
					now,
					manualStock,
					item.id,
					item.quantity,
					useSupplier,
					now,
					now,
					orderId,
				),
		);
		if (useSupplier) {
			const totalCostMinor = (
				BigInt(item.reference_cost_minor ?? "0") * BigInt(item.quantity)
			).toString();
			// D1 calculates the deficit inside the reservation transaction. Keep its
			// integer multiplication exact rather than allowing SQLite REAL overflow.
			if (BigInt(totalCostMinor) > 9223372036854775807n)
				throw new DomainError(
					"supplier_cost_out_of_range",
					409,
					"Supplier cost exceeds the supported range",
				);
			const remaining = `(SELECT ${item.quantity} - COUNT(*) FROM stock_entries WHERE order_item_id = ? AND status = 'reserved')`;
			statements.push(
				db
					.prepare(
						`INSERT INTO supplier_orders
						 (id, order_id, order_item_id, delivery_record_id,
						  supplier_binding_id, quantity, quoted_unit_cost_minor,
						  total_cost_minor, currency, binding_snapshot_json,
						  state, attempt_count, selection_count, next_retry_at,
						  created_at, updated_at)
						 SELECT ?, ?, ?, ?, ?, ${remaining}, ?, CAST(CAST(? AS INTEGER) * ${remaining} AS TEXT), ?, ?, 'pending', 0, 0, ?, ?, ?
						 FROM shop_orders WHERE id = ? AND status = 'paid'
						  AND ((SELECT COUNT(*) FROM stock_entries
						   WHERE order_item_id = ? AND status = 'reserved') < ?)`,
					)
					.bind(
						supplierOrderId,
						orderId,
						item.id,
						deliveryId,
						item.supplier_binding_id,
						item.id,
						item.reference_cost_minor,
						item.reference_cost_minor,
						item.id,
						item.supplier_currency,
						JSON.stringify({
							customerUsageUrl: resolveSupplierUsageUrl(item.policy_json, {
								provider: item.supplier_provider,
								normalizedApiOrigin: item.supplier_origin,
								upstreamSkuId: item.upstream_sku_id,
							}),
							provider: item.supplier_provider,
							normalizedApiOrigin: item.supplier_origin,
							protocolVersion: item.supplier_protocol,
							upstreamProductId: item.upstream_product_id,
							upstreamSkuId: item.upstream_sku_id,
							upstreamProductName: item.upstream_product_name,
							upstreamSkuName: item.upstream_sku_name,
							referenceCostMinor: item.reference_cost_minor,
							maxCostMinor: item.max_cost_minor,
						}),
						now,
						now,
						now,
						orderId,
						item.id,
						item.quantity,
					),
			);
		}
	} else {
		statements.push(
			db
				.prepare(
					`INSERT INTO delivery_records
					 (id, order_item_id, delivery_type, request_key, status, attempt_count, next_attempt_at,
					  created_at, updated_at)
					 SELECT ?, ?, ?, ?, 'pending', 0, ?, ?, ?
				 FROM shop_orders WHERE id = ? AND status = 'paid'`,
				)
				.bind(
					deliveryId,
					item.id,
					item.delivery_component_type,
					`initial:${item.id}`,
					now,
					now,
					now,
					orderId,
				),
		);
	}
	const entitlement = createEntitlementGrantStatements(db, orderId, item, now);
	statements.push(...entitlement.statements);
	if (item.delivery_component_type === "download")
		statements.push(
			db
				.prepare(
					`INSERT OR IGNORE INTO order_item_download_assets
					 (id, order_item_id, download_asset_id, asset_version, object_key, file_name, content_type,
					  size_bytes, checksum_sha256, created_at, updated_at)
					 SELECT ? || ':' || asset.id, ?, asset.id, asset.version, asset.object_key, asset.file_name,
					  asset.content_type, asset.size_bytes, asset.checksum_sha256, ?, ?
					 FROM download_assets asset JOIN download_asset_sellable_items binding
					  ON binding.download_asset_id = asset.id
					   AND binding.sellable_item_id = ?
					 WHERE asset.product_id = ? AND asset.download_enabled = 1
					 AND EXISTS (SELECT 1 FROM shop_orders WHERE id = ? AND status = 'paid')`,
				)
				.bind(
					item.id,
					item.id,
					now,
					now,
					item.delivery_component_id,
					item.product_id,
					orderId,
				),
			db
				.prepare(
					`UPDATE delivery_records SET status = 'failed', error_code = 'download_unavailable',
					 next_attempt_at = NULL, updated_at = ? WHERE order_item_id = ?
					 AND status = 'pending' AND NOT EXISTS (
					  SELECT 1 FROM order_item_download_assets snapshot
					  WHERE snapshot.order_item_id = ?
					 )`,
				)
				.bind(now, item.id, item.id),
		);
	if (
		item.delivery_component_type === "download" ||
		item.delivery_component_type === "automation"
	)
		statements.push(
			...activateEntitlementGrantStatements(db, item.id, now, {
				requireDownloadAsset: item.delivery_component_type === "download",
			}),
		);
	if (useSupplier)
		statements.push(
			db
				.prepare(
					`INSERT INTO outbox_events
				 (id, event_type, aggregate_type, aggregate_id, idempotency_key, payload,
				  status, attempt_count, created_at, updated_at)
				 SELECT ?, 'delivery.requested', 'delivery', ?, ?, ?, 'pending', 0, ?, ?
				 FROM delivery_records delivery WHERE delivery.id = ?
				  AND NOT EXISTS (SELECT 1 FROM supplier_orders supplier
				   WHERE supplier.delivery_record_id = delivery.id)`,
				)
				.bind(
					crypto.randomUUID(),
					deliveryId,
					`delivery-requested:${deliveryId}`,
					JSON.stringify({ deliveryId, orderItemId: item.id }),
					now,
					now,
					deliveryId,
				),
			db
				.prepare(
					`INSERT INTO outbox_events
				 (id, event_type, aggregate_type, aggregate_id, idempotency_key, payload,
				  status, attempt_count, created_at, updated_at)
				 SELECT ?, 'supplier.requested', 'supplier_order', ?, ?, ?, 'pending', 0, ?, ?
				 FROM supplier_orders supplier WHERE supplier.id = ?`,
				)
				.bind(
					crypto.randomUUID(),
					supplierOrderId,
					`supplier-requested:${supplierOrderId}`,
					JSON.stringify({ supplierOrderId }),
					now,
					now,
					supplierOrderId,
				),
		);
	else if (!manualStock)
		statements.push(
			db
				.prepare(
					`INSERT INTO outbox_events
			 (id, event_type, aggregate_type, aggregate_id, idempotency_key, payload,
			  status, attempt_count, created_at, updated_at)
			 SELECT ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?
			 FROM shop_orders WHERE id = ? AND status = 'paid'`,
				)
				.bind(
					crypto.randomUUID(),
					"delivery.requested",
					"delivery",
					deliveryId,
					`delivery-requested:${deliveryId}`,
					JSON.stringify({ deliveryId, orderItemId: item.id }),
					now,
					now,
					orderId,
				),
		);
	statements.push(
		db
			.prepare(
				`INSERT INTO outbox_events
				 (id, event_type, aggregate_type, aggregate_id, idempotency_key,
				  payload, status, attempt_count, created_at, updated_at)
				 SELECT ?, 'owner.sale_alert', 'shop_order', ?, ?, ?, 'pending', 0, ?, ?
				 FROM shop_orders WHERE id = ? AND status = 'paid'
				  AND EXISTS (SELECT 1 FROM system_settings
				   WHERE key = 'commerce.sales.feishu_alerts_enabled'
				    AND value = 'true')
				 ON CONFLICT(idempotency_key) DO NOTHING`,
			)
			.bind(
				crypto.randomUUID(),
				orderId,
				`owner-sale-order:${orderId}`,
				JSON.stringify({ orderId }),
				now,
				now,
				orderId,
			),
	);
	return statements;
}

const orderItemsForFulfillmentSql = `SELECT
 oi.id, oi.sellable_item_id, oi.product_id, oi.delivery_component_id,
 oi.delivery_component_type, oi.quantity, oi.duration_ms, oi.usage_limit,
 oi.access_limit, oi.renewed_from_entitlement_id, oi.renewal_mode,
 oi.definition_version_id, psi.fulfillment_source, psi.supplier_status, psi.policy_json,
 ${supplierFallbackEnabledExpression("psi")} AS supplier_fallback_enabled,
 sb.id AS supplier_binding_id, sb.provider AS supplier_provider,
 sb.normalized_api_origin AS supplier_origin,
 sb.protocol_version AS supplier_protocol,
 sb.upstream_product_id, sb.upstream_sku_id, sb.upstream_product_name,
 sb.upstream_sku_name, sb.reference_cost_minor, sb.max_cost_minor,
 (SELECT sa.currency FROM supplier_accounts sa
  WHERE sa.provider = sb.provider
   AND sa.normalized_api_origin = sb.normalized_api_origin
   AND sa.protocol_version = sb.protocol_version
  ORDER BY sa.enabled DESC, sa.id LIMIT 1) AS supplier_currency
 FROM shop_order_items oi
 JOIN product_sellable_items psi ON psi.id = oi.sellable_item_id
 LEFT JOIN supplier_bindings sb ON sb.sellable_item_id = oi.sellable_item_id
  AND sb.enabled = 1`;

function supplierBindingReady(item: OrderItem) {
	return Boolean(
		item.supplier_binding_id &&
			item.supplier_provider &&
			item.supplier_origin &&
			item.supplier_protocol &&
			item.upstream_product_id &&
			item.upstream_sku_id &&
			item.reference_cost_minor &&
			item.max_cost_minor &&
			item.supplier_currency,
	);
}

function presentAttempt(row: {
	id: string;
	provider_payment_id: string | null;
	checkout_url: string | null;
	provider_expires_at: number | null;
	status: string;
}) {
	return {
		id: row.id,
		providerPaymentId: row.provider_payment_id,
		checkoutUrl: row.checkout_url,
		expiresAt: row.provider_expires_at,
		status: row.status,
	};
}

type PaymentAttemptReplay = {
	id: string;
	order_id: string;
	channel_id: string;
	provider_payment_id: string | null;
	checkout_url: string | null;
	provider_expires_at: number | null;
	status: string;
};

async function loadPaymentAttemptByIdempotency(
	db: D1Database,
	idempotencyKey: string,
) {
	return db
		.prepare(
			`SELECT id, order_id, channel_id, provider_payment_id, checkout_url,
			 provider_expires_at, status FROM payment_attempts
			 WHERE idempotency_key = ? LIMIT 1`,
		)
		.bind(idempotencyKey)
		.first<PaymentAttemptReplay>();
}

function assertPaymentIdempotencyScope(
	attempt: PaymentAttemptReplay,
	input: { orderId: string; channelId: string },
) {
	if (
		attempt.order_id !== input.orderId ||
		attempt.channel_id !== input.channelId
	)
		throw new DomainError(
			"payment_idempotency_conflict",
			409,
			"Payment idempotency key belongs to another request",
		);
}
