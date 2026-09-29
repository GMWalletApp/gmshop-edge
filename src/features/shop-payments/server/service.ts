import { z } from "zod";
import {
	activateEntitlementGrantStatements,
	createEntitlementGrantStatements,
	type EntitlementOrderItem,
} from "#/features/entitlements/server/ledger";
import { quotePaymentCurrency } from "#/features/exchange-rates/server/quote";
import {
	orderStateGuard,
	paidOrderGuard,
	type StatementGuard,
} from "#/features/shop-orders/server/order-guard";
import type { PaymentWebhookEvent } from "#/features/shop-payments/provider";
import { getPaymentProvider } from "#/features/shop-payments/providers";
import { epusdtMerchantOrderId } from "#/features/shop-payments/providers/epusdt";
import { walletMutationStatements } from "#/features/wallet/server/ledger";
import { DomainError } from "#/lib/domain-error";
import { decryptSecret } from "#/lib/secrets";
import { decimalToMinor } from "#/lib/units";
import { m } from "#/paraglide/messages";
import { loadRuntimeConfig } from "#/server/runtime-config";

type PaymentContext = {
	attempt_id: string;
	attempt_status: string;
	provider_payment_id: string | null;
	order_id: string | null;
	wallet_topup_id: string | null;
	order_number: string | null;
	order_status: string | null;
	order_version: number | null;
	topup_status: string | null;
	topup_user_id: string | null;
	topup_amount_minor: string | null;
	topup_currency: string | null;
	topup_balance_minor: string | null;
	topup_balance_version: number | null;
	topup_credit_id: string | null;
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
	order_expires_at: number;
	amount_minor: string;
	currency: string;
	currency_decimals: number;
	contact_email: string;
	channel_id: string;
	provider: string;
	credential_encrypted: string | null;
	default_token: string;
	default_network: string;
};

type OrderItem = EntitlementOrderItem & {
	fulfillment_source: "local" | "supplier";
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
	payerIp: z.ipv4().nullable().default(null),
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
			 o.total_minor AS amount_minor, o.currency, o.currency_decimals,
			 o.expires_at AS order_expires_at,
			 o.contact_email,
			 pc.id AS channel_id, pc.provider, pc.credential_encrypted,
			 pc.default_token, pc.default_network
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
	const quote = await quotePaymentCurrency(db, {
		amountMinor: context.amount_minor,
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
			  created_at, updated_at)
			 VALUES (?, ?, ?, ?, 'created', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
				description: m.payment_description_order({
					orderNumber: context.order_number,
				}),
				expiresAt: context.order_expires_at,
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
		await db
			.prepare(
				"UPDATE payment_attempts SET status = 'failed', failure_code = 'provider_create_failed', updated_at = ? WHERE id = ?",
			)
			.bind(Date.now(), attemptId)
			.run();
		throw error;
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
			 pc.default_token, pc.default_network,
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
			currency: string;
			currency_decimals: number;
		}>();
	if (!context)
		throw new DomainError(
			"payment_channel_unavailable",
			404,
			"Payment channel unavailable",
		);
	const quote = await quotePaymentCurrency(db, {
		amountMinor: input.amountMinor,
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
				description: m.payment_description_wallet_topup(),
				expiresAt: null,
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
			db
				.prepare(
					"UPDATE payment_attempts SET status = 'failed', failure_code = 'provider_create_failed', updated_at = ? WHERE id = ?",
				)
				.bind(Date.now(), attemptId),
			db
				.prepare(
					"UPDATE wallet_topups SET status = 'failed', updated_at = ? WHERE id = ?",
				)
				.bind(Date.now(), topupId),
		]);
		throw error;
	}
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

const payableOrderStatuses = new Set(["pending_payment", "expired"]);
const payableTopupStatuses = new Set(["pending", "expired", "failed"]);

export async function processShopPaymentEvent(
	db: D1Database,
	channelId: string,
	event: PaymentWebhookEvent,
) {
	if (event.type === "payment_ignored")
		return { duplicate: false as const, status: "ignored" as const };
	const duplicate = await findPaymentReplayReceipt(
		db,
		channelId,
		event.providerEventId,
	);
	if (duplicate) return presentPaymentReplayReceipt(duplicate, event);
	const context = await loadPaymentContext(db, channelId, event);
	validateEventMoney(context, event);
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
	if (context.wallet_topup_id)
		return settleWalletTopup(db, channelId, context, event);
	if (
		!context.order_id ||
		context.order_version === null ||
		!context.order_status
	)
		throw new DomainError(
			"payment_subject_invalid",
			409,
			"Payment subject is invalid",
		);
	if (!payableOrderStatuses.has(context.order_status))
		return recordUnmatchedPayment(
			db,
			channelId,
			context,
			event,
			"order_not_payable",
		);

	const orderId = context.order_id;
	const items = await db
		.prepare(`${orderItemsForFulfillmentSql} WHERE oi.order_id = ?`)
		.bind(orderId)
		.all<OrderItem>();
	const now = Date.now();
	// A verified payment that arrives after the order expired revives the order:
	// the money is real, the provider checkout stayed open longer than the order,
	// and the customer expects the goods. Coupon accounting is restored as well.
	const paid = paidOrderStatements(db, {
		orderId,
		fromStatus: context.order_status,
		fromVersion: context.order_version,
		items: items.results,
		now,
		event: { type: "payment_succeeded", actorType: "provider" },
	});
	let result: Awaited<ReturnType<typeof runPaymentEventBatch>>;
	try {
		result = await runPaymentEventBatch(db, channelId, event, [
			paid.orderUpdate,
			db
				.prepare(
					`UPDATE payment_attempts SET status = 'succeeded', succeeded_at = ?,
				 updated_at = ?, failure_code = NULL, provider_payment_id = ?
				 WHERE id = ? AND status IN ('created', 'pending', 'expired', 'failed')
				 AND ${paid.guard.sql}`,
				)
				.bind(
					now,
					now,
					event.providerPaymentId,
					context.attempt_id,
					...paid.guard.bindings,
				),
			paymentEventStatement(
				db,
				channelId,
				context.attempt_id,
				event,
				"processed",
				now,
				paid.guard,
			),
			...paid.statements,
		]);
	} catch (error) {
		// Two success events read from the same order snapshot target the same
		// paid version, so the loser only fails on the fulfillment unique indexes
		// (event version, delivery request key, entitlement). The order state
		// decides: already paid elsewhere → record this money as unmatched;
		// otherwise the error is real.
		const current = await loadOrderStatus(db, orderId);
		if (current && !payableOrderStatuses.has(current))
			return recordUnmatchedPayment(
				db,
				channelId,
				{ ...context, order_status: current },
				event,
				"order_not_payable",
			);
		throw error;
	}
	if (result.duplicate)
		return presentPaymentReplayReceipt(result.duplicate, event);
	if (Number(result.results[0]?.meta.changes ?? 0) !== 1) {
		const current = await loadOrderStatus(db, orderId);
		if (current && payableOrderStatuses.has(current))
			throw new DomainError(
				"order_version_conflict",
				409,
				"Order changed; retry event",
				{ retryable: true },
			);
		return recordUnmatchedPayment(
			db,
			channelId,
			{ ...context, order_status: current ?? context.order_status },
			event,
			"order_not_payable",
		);
	}
	return { duplicate: false, status: "succeeded" };
}

async function loadOrderStatus(db: D1Database, orderId: string) {
	const row = await db
		.prepare("SELECT status FROM shop_orders WHERE id = ? LIMIT 1")
		.bind(orderId)
		.first<{ status: string }>();
	return row?.status ?? null;
}

async function settleWalletTopup(
	db: D1Database,
	channelId: string,
	context: PaymentContext,
	event: PaymentWebhookEvent,
) {
	if (
		!context.wallet_topup_id ||
		!context.topup_user_id ||
		!context.topup_amount_minor ||
		!context.topup_currency ||
		!context.topup_status
	)
		throw new DomainError(
			"payment_subject_invalid",
			409,
			"Payment subject is invalid",
		);
	if (!payableTopupStatuses.has(context.topup_status))
		return recordUnmatchedPayment(
			db,
			channelId,
			context,
			event,
			"topup_not_payable",
		);
	const now = Date.now();
	const walletKey = `wallet-topup:${context.wallet_topup_id}`;
	const walletGuard = {
		sql: "EXISTS (SELECT 1 FROM wallet_entries WHERE idempotency_key = ?)",
		bindings: [walletKey],
	};
	// The balance credit, the attempt, the top-up row and the replay receipt are
	// committed in one batch; a credit that already exists (idempotency key,
	// joined into the context row) is never repeated.
	let wallet: ReturnType<typeof walletMutationStatements> | null = null;
	if (!context.topup_credit_id) {
		if (
			context.topup_balance_minor === null ||
			context.topup_balance_version === null
		)
			throw new DomainError(
				"wallet_user_not_found",
				404,
				"Wallet user not found",
			);
		wallet = walletMutationStatements(
			db,
			{
				userId: context.topup_user_id,
				direction: "credit",
				amountMinor: context.topup_amount_minor,
				currency: context.topup_currency,
				sourceType: "topup",
				sourceId: context.wallet_topup_id,
				idempotencyKey: walletKey,
			},
			{
				balanceMinor: context.topup_balance_minor,
				balanceVersion: context.topup_balance_version,
			},
			// Money the provider already collected is booked even when the account
			// was disabled in the meantime; the balance stays unusable until the
			// account is enabled again.
			{ now, requireEnabled: false },
		);
	}
	let result: Awaited<ReturnType<typeof runPaymentEventBatch>>;
	try {
		result = await runPaymentEventBatch(db, channelId, event, [
			...(wallet ? [wallet.insert, wallet.update] : []),
			db
				.prepare(
					`UPDATE payment_attempts SET status = 'succeeded', succeeded_at = ?, updated_at = ?,
				 failure_code = NULL, provider_payment_id = ?
				 WHERE id = ? AND status IN ('created', 'pending', 'expired', 'failed')
				 AND ${walletGuard.sql}`,
				)
				.bind(
					now,
					now,
					event.providerPaymentId,
					context.attempt_id,
					...walletGuard.bindings,
				),
			db
				.prepare(
					`UPDATE wallet_topups SET status = 'paid', paid_at = ?, updated_at = ?
				 WHERE id = ? AND status IN ('pending', 'expired', 'failed') AND ${walletGuard.sql}`,
				)
				.bind(now, now, context.wallet_topup_id, ...walletGuard.bindings),
			paymentEventStatement(
				db,
				channelId,
				context.attempt_id,
				event,
				"processed",
				now,
				walletGuard,
			),
		]);
	} catch (error) {
		// A concurrent success for the same top-up already booked the credit
		// (wallet idempotency index): this second payment is unmatched.
		const current = await db
			.prepare("SELECT status FROM wallet_topups WHERE id = ? LIMIT 1")
			.bind(context.wallet_topup_id)
			.first<{ status: string }>();
		if (current && !payableTopupStatuses.has(current.status))
			return recordUnmatchedPayment(
				db,
				channelId,
				{ ...context, topup_status: current.status },
				event,
				"topup_not_payable",
			);
		throw error;
	}
	if (result.duplicate)
		return presentPaymentReplayReceipt(result.duplicate, event);
	if (wallet && Number(result.results[1]?.meta.changes ?? 0) !== 1)
		throw new DomainError(
			"wallet_conflict",
			409,
			"Wallet changed; retry event",
			{ retryable: true },
		);
	return { duplicate: false, status: "succeeded" };
}

/**
 * A verified, money-matching success event for a subject that can no longer
 * accept payment (already paid through another attempt, cancelled, refunded…)
 * is durably recorded as a rejected receipt plus an audit entry so operators
 * can refund or credit the customer, and the provider receives an
 * acknowledgement instead of endless retries.
 */
async function recordUnmatchedPayment(
	db: D1Database,
	channelId: string,
	context: PaymentContext,
	event: PaymentWebhookEvent,
	reason: "order_not_payable" | "topup_not_payable",
) {
	const now = Date.now();
	const result = await runPaymentEventBatch(db, channelId, event, [
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
				`UPDATE payment_attempts SET failure_code = 'unmatched_payment', updated_at = ?
				 WHERE id = ? AND status IN ('expired', 'failed', 'cancelled')`,
			)
			.bind(now, context.attempt_id),
		db
			.prepare(
				`INSERT INTO audit_logs
				 (id, action, target_type, target_id, after, created_at)
				 VALUES (?, 'payment.unmatched', 'payment_attempt', ?, ?, ?)`,
			)
			.bind(
				crypto.randomUUID(),
				context.attempt_id,
				JSON.stringify({
					reason,
					channelId,
					provider: context.provider,
					providerEventId: event.providerEventId,
					providerPaymentId: event.providerPaymentId,
					orderId: context.order_id,
					orderNumber: context.order_number,
					orderStatus: context.order_status,
					walletTopupId: context.wallet_topup_id,
					topupStatus: context.topup_status,
					amountMinor: event.amountMinor ?? context.amount_minor,
					amountDecimal: event.amountDecimal ?? null,
					currency: event.currency ?? context.currency,
				}),
				now,
			),
	]);
	if (result.duplicate)
		return presentPaymentReplayReceipt(result.duplicate, event);
	return { duplicate: false as const, status: "rejected" as const, reason };
}

function couponConsumptionStatements(
	db: D1Database,
	orderId: string,
	now: number,
	guard: StatementGuard,
	restoreReleasedUsage: boolean,
) {
	const statements = [
		db
			.prepare(
				`UPDATE coupon_redemptions SET status = 'consumed', updated_at = ?
				 WHERE order_id = ? AND status IN ('reserved', 'released') AND ${guard.sql}`,
			)
			.bind(now, orderId, ...guard.bindings),
	];
	if (restoreReleasedUsage)
		statements.push(
			db
				.prepare(
					`UPDATE coupons SET used_count = used_count + 1, updated_at = ?
					 WHERE id = (SELECT coupon_id FROM coupon_redemptions
					  WHERE order_id = ? AND status = 'consumed' AND released_at IS NOT NULL LIMIT 1)
					 AND ${guard.sql}`,
				)
				.bind(now, orderId, ...guard.bindings),
		);
	return statements;
}

type PaidOrderTransition = {
	orderId: string;
	/** `pending_payment`, or `expired` when a late payment revives the order. */
	fromStatus: string;
	fromVersion: number;
	items: OrderItem[];
	now: number;
	event: {
		type: string;
		actorType: "provider" | "system" | "customer" | "admin";
		actorUserId?: string | null;
		note?: string | null;
	};
	/** Free orders record `'0'`; everything else records the order total. */
	paidMinorSql?: "total_minor" | "'0'";
	/** Extra predicate for the order transition (wallet debit landed, total is zero…). */
	orderGuardSql?: string;
	orderGuardBindings?: readonly (string | number)[];
};

/**
 * The one "order becomes paid" batch shared by provider webhooks, free
 * checkouts, wallet payments and administrator confirmation: order transition,
 * customer-visible event, stock/delivery/entitlement fulfillment, coupon
 * consumption, the `shop_order.paid` outbox row and the conversion event.
 * Every statement after the first is bound to the exact paid version the first
 * one produces. Callers splice their own statements (payment attempt, receipt,
 * wallet ledger, audit) around `statements[0]` and check its `changes`.
 */
function paidOrderStatements(db: D1Database, input: PaidOrderTransition) {
	const nextVersion = input.fromVersion + 1;
	const guard = paidOrderGuard(input.orderId, nextVersion);
	const revived = input.fromStatus === "expired";
	const orderUpdate = db
		.prepare(
			`UPDATE shop_orders SET status = 'paid', paid_minor = ${input.paidMinorSql ?? "total_minor"},
				 paid_at = ?, cancelled_at = NULL, version = ?, updated_at = ?
				 WHERE id = ? AND status = ? AND version = ?${input.orderGuardSql ? ` AND ${input.orderGuardSql}` : ""}`,
		)
		.bind(
			input.now,
			nextVersion,
			input.now,
			input.orderId,
			input.fromStatus,
			input.fromVersion,
			...(input.orderGuardBindings ?? []),
		);
	const statements: D1PreparedStatement[] = [
		db
			.prepare(
				`INSERT INTO shop_order_events
				 (id, order_id, event_type, visibility, from_status, to_status, order_version,
				  note, actor_type, actor_user_id, created_at)
				 SELECT ?, id, ?, 'customer', ?, 'paid', ?, ?, ?, ?, ?
				 FROM shop_orders WHERE id = ? AND status = 'paid' AND version = ?`,
			)
			.bind(
				crypto.randomUUID(),
				input.event.type,
				input.fromStatus,
				nextVersion,
				input.event.note ?? null,
				input.event.actorType,
				input.event.actorUserId ?? null,
				input.now,
				input.orderId,
				nextVersion,
			),
	];
	for (const item of input.items)
		statements.push(
			...fulfillmentStatements(db, input.orderId, item, input.now, nextVersion),
		);
	statements.push(
		...couponConsumptionStatements(
			db,
			input.orderId,
			input.now,
			guard,
			revived,
		),
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
				`shop-order-paid:${input.orderId}:${nextVersion}`,
				JSON.stringify({ orderId: input.orderId, version: nextVersion }),
				input.now,
				input.now,
				input.orderId,
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
				 AND ${guard.sql}
				 ORDER BY event.created_at, event.id LIMIT 1`,
			)
			.bind(crypto.randomUUID(), input.now, input.orderId, ...guard.bindings),
	);
	return { orderUpdate, statements, nextVersion, guard };
}

async function loadOrderItemsForFulfillment(db: D1Database, orderId: string) {
	const items = await db
		.prepare(`${orderItemsForFulfillmentSql} WHERE oi.order_id = ?`)
		.bind(orderId)
		.all<OrderItem>();
	return items.results;
}

export async function completeFreeStoreOrder(db: D1Database, orderId: string) {
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
	if (order.total_minor !== "0")
		throw new DomainError("order_payment_required", 409, "Payment is required");
	if (order.status === "paid" || order.status === "completed")
		return { duplicate: true, status: order.status };
	if (order.status !== "pending_payment")
		throw new DomainError(
			"order_not_payable",
			409,
			"Order cannot be completed",
		);
	const paid = paidOrderStatements(db, {
		orderId: order.id,
		fromStatus: order.status,
		fromVersion: order.version,
		items: await loadOrderItemsForFulfillment(db, order.id),
		now: Date.now(),
		event: { type: "payment_not_required", actorType: "system" },
		paidMinorSql: "'0'",
		orderGuardSql: "total_minor = '0'",
	});
	const results = await db.batch([paid.orderUpdate, ...paid.statements]);
	if (Number(results[0]?.meta.changes ?? 0) !== 1)
		throw new DomainError(
			"order_version_conflict",
			409,
			"Order changed; retry completion",
		);
	return { duplicate: false, status: "paid" };
}

/**
 * Mark an order paid outside the provider webhook flow (administrator
 * confirmation of an offline payment). Runs the same fulfillment batch as a
 * provider success so stock, deliveries, entitlements and outbox rows exist.
 */
export async function completeManualStoreOrder(
	db: D1Database,
	input: {
		orderId: string;
		version: number;
		actorUserId: string | null;
		note: string | null;
		ipAddress: string | null;
		requestId: string | null;
	},
) {
	const order = await db
		.prepare("SELECT id, status, version FROM shop_orders WHERE id = ? LIMIT 1")
		.bind(input.orderId)
		.first<{ id: string; status: string; version: number }>();
	if (!order) throw new DomainError("order_not_found", 404, "Order not found");
	if (order.version !== input.version)
		throw new DomainError(
			"order_version_conflict",
			409,
			"Order changed; refresh and retry",
		);
	if (!payableOrderStatuses.has(order.status))
		throw new DomainError(
			"order_transition_invalid",
			409,
			`Cannot transition an order from ${order.status} to paid`,
		);
	const now = Date.now();
	const paid = paidOrderStatements(db, {
		orderId: order.id,
		fromStatus: order.status,
		fromVersion: order.version,
		items: await loadOrderItemsForFulfillment(db, order.id),
		now,
		event: {
			type: "status_changed",
			actorType: "admin",
			actorUserId: input.actorUserId,
			note: input.note,
		},
	});
	const results = await db.batch([
		paid.orderUpdate,
		// Open provider attempts end here; a late provider success for them is
		// recorded as an unmatched payment for the operator.
		db
			.prepare(
				`UPDATE payment_attempts SET status = 'expired', failure_code = 'manual_payment',
				 updated_at = ? WHERE order_id = ? AND status IN ('created', 'pending')
				 AND ${paid.guard.sql}`,
			)
			.bind(now, order.id, ...paid.guard.bindings),
		...paid.statements,
		db
			.prepare(
				`INSERT INTO audit_logs
				 (id, actor_user_id, action, target_type, target_id, request_id,
				  ip_address, before, after, created_at)
				 SELECT ?, ?, 'shop_order.status_changed', 'shop_order', id, ?, ?, ?, ?, ?
				 FROM shop_orders WHERE id = ? AND status = 'paid' AND version = ?`,
			)
			.bind(
				crypto.randomUUID(),
				input.actorUserId,
				input.requestId,
				input.ipAddress,
				JSON.stringify({ status: order.status, version: order.version }),
				JSON.stringify({
					status: "paid",
					version: paid.nextVersion,
					manual: true,
				}),
				now,
				order.id,
				paid.nextVersion,
			),
	]);
	if (Number(results[0]?.meta.changes ?? 0) !== 1)
		throw new DomainError(
			"order_version_conflict",
			409,
			"Order changed; refresh and retry",
		);
	return {
		id: order.id,
		fromStatus: order.status,
		toStatus: "paid" as const,
		version: paid.nextVersion,
	};
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
	const walletIdempotencyKey = `wallet-order:${order.id}`;
	const now = Date.now();
	const wallet = walletMutationStatements(
		db,
		{
			userId: input.userId,
			direction: "debit",
			amountMinor: order.total_minor,
			currency,
			sourceType: "shop_order",
			sourceId: order.id,
			idempotencyKey: walletIdempotencyKey,
		},
		{
			balanceMinor: order.balance_minor,
			balanceVersion: order.balance_version,
		},
		{
			now,
			guardSql: orderStateGuard(order.id, "pending_payment", order.version).sql,
			guardBindings: [order.id, "pending_payment", order.version],
		},
	);
	const paid = paidOrderStatements(db, {
		orderId: order.id,
		fromStatus: order.status,
		fromVersion: order.version,
		items: await loadOrderItemsForFulfillment(db, order.id),
		now,
		event: { type: "wallet_payment_succeeded", actorType: "customer" },
		// The order only becomes paid when the debit of this very batch landed.
		orderGuardSql:
			"EXISTS (SELECT 1 FROM wallet_entries WHERE idempotency_key = ?)",
		orderGuardBindings: [walletIdempotencyKey],
	});
	const results = await db.batch([
		wallet.insert,
		wallet.update,
		paid.orderUpdate,
		...paid.statements,
	]);
	if (Number(results[1]?.meta.changes ?? 0) !== 1) {
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

const paymentContextSql = `SELECT pa.id AS attempt_id, pa.status AS attempt_status, pa.amount_minor,
	 pa.provider_payment_id,
	 pa.currency, pa.currency_decimals, pa.channel_id, o.id AS order_id,
	 pa.wallet_topup_id, o.order_number,
	 o.status AS order_status, o.version AS order_version,
	 topup.status AS topup_status, topup.user_id AS topup_user_id,
	 topup.amount_minor AS topup_amount_minor,
	 topup.currency AS topup_currency,
	 topup_user.balance_minor AS topup_balance_minor,
	 topup_user.balance_version AS topup_balance_version,
	 topup_credit.id AS topup_credit_id,
	 COALESCE(o.contact_email, topup_user.email) AS contact_email,
	 pc.provider, pc.credential_encrypted
	 FROM payment_attempts pa LEFT JOIN shop_orders o ON o.id = pa.order_id
	 LEFT JOIN wallet_topups topup ON topup.id = pa.wallet_topup_id
	 LEFT JOIN users topup_user ON topup_user.id = topup.user_id
	 LEFT JOIN wallet_entries topup_credit
	  ON topup_credit.idempotency_key = 'wallet-topup:' || pa.wallet_topup_id
	 JOIN payment_channels pc ON pc.id = pa.channel_id`;

async function loadPaymentContext(
	db: D1Database,
	channelId: string,
	event: Pick<PaymentWebhookEvent, "providerPaymentId" | "merchantOrderId">,
) {
	const context = await db
		.prepare(
			`${paymentContextSql} WHERE pa.channel_id = ? AND pa.provider_payment_id = ? LIMIT 1`,
		)
		.bind(channelId, event.providerPaymentId)
		.first<PaymentContext>();
	if (context) return context;
	// Providers that only echo our merchant order id (or whose provider payment
	// id was derived from a redirect URL) are resolved through the attempt id we
	// sent them — compact 32-hex form or full UUID — or the order number, each
	// through its own index.
	const merchantOrderId = event.merchantOrderId?.trim();
	if (merchantOrderId) {
		const attemptIds = [
			merchantOrderId,
			...(/^[0-9a-f]{32}$/i.test(merchantOrderId)
				? [expandCompactUuid(merchantOrderId)]
				: []),
		];
		const byAttempt = await db
			.prepare(
				`${paymentContextSql} WHERE pa.channel_id = ? AND pa.id IN (?, ?) LIMIT 1`,
			)
			.bind(channelId, attemptIds[0], attemptIds[1] ?? attemptIds[0])
			.first<PaymentContext>();
		if (byAttempt) return byAttempt;
		const byOrderNumber = await db
			.prepare(
				`${paymentContextSql} WHERE pa.channel_id = ?
				 AND pa.order_id = (SELECT id FROM shop_orders WHERE order_number = ?)
				 ORDER BY pa.created_at DESC, pa.id DESC LIMIT 1`,
			)
			.bind(channelId, merchantOrderId)
			.first<PaymentContext>();
		if (byOrderNumber) return byOrderNumber;
	}
	throw new DomainError(
		"payment_attempt_not_found",
		404,
		"Payment attempt not found",
	);
}

function expandCompactUuid(value: string) {
	return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`.toLowerCase();
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
	guard?: StatementGuard,
) {
	return db
		.prepare(
			`INSERT INTO replay_receipts
		 (id, namespace, scope_id, payment_attempt_id, external_id, event_type,
		  payload_digest, status, processed_at, created_at, updated_at)
		 SELECT ?, 'payment_webhook', ?, ?, ?, ?, ?, ?, ?, ?, ?${guard ? ` WHERE ${guard.sql}` : ""}`,
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
			...(guard?.bindings ?? []),
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
	orderVersion: number,
) {
	const deliveryId = crypto.randomUUID();
	const supplierOrderId = crypto.randomUUID();
	const statements: D1PreparedStatement[] = [];
	// Every statement below is bound to the exact paid order version produced by
	// the caller's transition statement, so nothing is reserved or created when
	// that transition did not apply (expired/cancelled/already paid order).
	const paidOrderSql = `FROM shop_orders WHERE id = ? AND status = 'paid' AND version = ?`;
	const supplierStock =
		item.delivery_component_type === "stock" &&
		item.fulfillment_source === "supplier";
	if (supplierStock && !supplierBindingReady(item))
		throw new DomainError(
			"supplier_binding_unavailable",
			409,
			"Supplier binding unavailable",
		);
	if (item.delivery_component_type === "stock" && !supplierStock) {
		statements.push(
			db
				.prepare(
					`UPDATE stock_entries SET status = 'reserved', order_item_id = ?, reserved_at = ?, updated_at = ?
					 WHERE id IN (SELECT id FROM stock_entries WHERE sellable_item_id = ? AND status = 'available'
					 ORDER BY created_at, id LIMIT ?)
					 AND (SELECT COUNT(*) FROM stock_entries WHERE sellable_item_id = ? AND status = 'available') >= ?
					 AND EXISTS (SELECT 1 ${paidOrderSql})`,
				)
				.bind(
					item.id,
					now,
					now,
					item.delivery_component_id,
					item.quantity,
					item.delivery_component_id,
					item.quantity,
					orderId,
					orderVersion,
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
				   ELSE 'failed' END,
				  0, ?,
				  CASE WHEN ? = 1 THEN NULL
				   WHEN (SELECT COUNT(*) FROM stock_entries WHERE order_item_id = ? AND status = 'reserved') = ? THEN NULL
				   ELSE 'inventory_unavailable' END,
				  ?, ? ${paidOrderSql}`,
				)
				.bind(
					deliveryId,
					item.id,
					`initial:${item.id}`,
					supplierStock,
					item.id,
					item.quantity,
					now,
					supplierStock,
					item.id,
					item.quantity,
					now,
					now,
					orderId,
					orderVersion,
				),
		);
		if (supplierStock) {
			const totalCostMinor = (
				BigInt(item.reference_cost_minor ?? "0") * BigInt(item.quantity)
			).toString();
			statements.push(
				db
					.prepare(
						`INSERT INTO supplier_orders
						 (id, order_id, order_item_id, delivery_record_id,
						  supplier_binding_id, quantity, quoted_unit_cost_minor,
						  total_cost_minor, currency, binding_snapshot_json,
						  state, attempt_count, selection_count, next_retry_at,
						  created_at, updated_at)
						 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, ?, ?, ?
						 ${paidOrderSql}`,
					)
					.bind(
						supplierOrderId,
						orderId,
						item.id,
						deliveryId,
						item.supplier_binding_id,
						item.quantity,
						item.reference_cost_minor,
						totalCostMinor,
						item.supplier_currency,
						JSON.stringify({
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
						orderVersion,
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
				 ${paidOrderSql}`,
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
					orderVersion,
				),
		);
	}
	const entitlement = createEntitlementGrantStatements(
		db,
		orderId,
		item,
		now,
		orderVersion,
	);
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
					 AND EXISTS (SELECT 1 ${paidOrderSql})`,
				)
				.bind(
					item.id,
					item.id,
					now,
					now,
					item.delivery_component_id,
					item.product_id,
					orderId,
					orderVersion,
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
	statements.push(
		db
			.prepare(
				`INSERT INTO outbox_events
			 (id, event_type, aggregate_type, aggregate_id, idempotency_key, payload,
			  status, attempt_count, created_at, updated_at)
			 SELECT ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?
			 ${paidOrderSql}`,
			)
			.bind(
				crypto.randomUUID(),
				supplierStock ? "supplier.requested" : "delivery.requested",
				supplierStock ? "supplier_order" : "delivery",
				supplierStock ? supplierOrderId : deliveryId,
				supplierStock
					? `supplier-requested:${supplierOrderId}`
					: `delivery-requested:${deliveryId}`,
				supplierStock
					? JSON.stringify({ supplierOrderId })
					: JSON.stringify({ deliveryId, orderItemId: item.id }),
				now,
				now,
				orderId,
				orderVersion,
			),
	);
	return statements;
}

const orderItemsForFulfillmentSql = `SELECT
 oi.id, oi.sellable_item_id, oi.product_id, oi.delivery_component_id,
 oi.delivery_component_type, oi.quantity, oi.duration_ms, oi.usage_limit,
 oi.access_limit, oi.renewed_from_entitlement_id, oi.renewal_mode,
 oi.definition_version_id, psi.fulfillment_source, psi.supplier_status,
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
