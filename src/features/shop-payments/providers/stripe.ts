import { z } from "zod";
import type {
	PaymentProviderAdapter,
	PaymentWebhookEvent,
} from "#/features/shop-payments/provider";
import { stripeCredentialSchema } from "#/features/shop-payments/provider";
import {
	constantTimeEqual,
	hmacSha256Hex,
	parseTimestampedSignature,
	sha256Hex,
} from "#/features/shop-payments/signature";
import { DomainError } from "#/lib/domain-error";
import { readPaymentWebhookText } from "./webhook-body";

const checkoutSessionSchema = z.object({
	id: z.string(),
	url: z.url(),
	expires_at: z.number().int().nullable().optional(),
});

const checkoutSessionQuerySchema = z.object({
	id: z.string(),
	status: z.enum(["open", "complete", "expired"]).nullable(),
	payment_status: z.enum(["paid", "unpaid", "no_payment_required"]),
	amount_total: z.number().int().nonnegative().nullable(),
	currency: z.string().nullable(),
	payment_intent: z.string().nullable(),
});

const stripeRefundSchema = z.object({
	id: z.string(),
	status: z.enum([
		"pending",
		"requires_action",
		"succeeded",
		"failed",
		"canceled",
	]),
	failure_reason: z.string().nullable().optional(),
});

// Stripe sends every event type the endpoint is subscribed to; unrelated types
// are acknowledged as ignored instead of failing with a schema error.
const webhookSchema = z.object({
	id: z.string(),
	type: z.string(),
	data: z.object({
		object: z.object({
			id: z.string().optional(),
			amount_total: z.number().int().nonnegative().nullable().optional(),
			currency: z.string().nullable().optional(),
			payment_status: z.string().optional(),
		}),
	}),
});

// Stripe accepts a Checkout Session expiry between 30 minutes and 24 hours.
const STRIPE_MIN_SESSION_LIFETIME_MS = 30 * 60_000 + 60_000;
const STRIPE_MAX_SESSION_LIFETIME_MS = 24 * 3_600_000 - 60_000;

function stripeSessionExpiresAt(expiresAt: number | null, now = Date.now()) {
	if (expiresAt === null) return null;
	const clamped = Math.min(
		Math.max(expiresAt, now + STRIPE_MIN_SESSION_LIFETIME_MS),
		now + STRIPE_MAX_SESSION_LIFETIME_MS,
	);
	return Math.ceil(clamped / 1000);
}

function stripeEventType(
	type: string,
	paymentStatus: string | undefined,
): PaymentWebhookEvent["type"] {
	switch (type) {
		case "checkout.session.completed":
			// Delayed-notification methods (bank debits, transfers) complete the
			// session before the money settles; only a paid session fulfils.
			return paymentStatus === "paid" || paymentStatus === "no_payment_required"
				? "payment_succeeded"
				: "payment_pending";
		case "checkout.session.async_payment_succeeded":
			return "payment_succeeded";
		case "checkout.session.async_payment_failed":
			return "payment_failed";
		case "checkout.session.expired":
			return "payment_expired";
		default:
			return "payment_ignored";
	}
}

export const stripePaymentProvider: PaymentProviderAdapter = {
	checkoutPresentation: "redirect",
	refundMode: "automatic",
	async createPayment(input, rawCredential, fetcher = fetch) {
		const { secretKey } = stripeCredentialSchema.parse(rawCredential);
		const body = new URLSearchParams({
			mode: "payment",
			success_url: input.successUrl,
			cancel_url: input.cancelUrl,
			client_reference_id: input.orderId,
			customer_email: input.customerEmail,
			"metadata[order_id]": input.orderId,
			"metadata[attempt_id]": input.attemptId,
			"line_items[0][quantity]": "1",
			"line_items[0][price_data][currency]": input.currency.toLowerCase(),
			"line_items[0][price_data][unit_amount]": input.amountMinor,
			"line_items[0][price_data][product_data][name]": input.description,
		});
		const expiresAt = stripeSessionExpiresAt(input.expiresAt ?? null);
		if (expiresAt !== null) body.set("expires_at", String(expiresAt));
		const response = await fetcher(
			"https://api.stripe.com/v1/checkout/sessions",
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${secretKey}`,
					"Content-Type": "application/x-www-form-urlencoded",
					"Idempotency-Key": input.attemptId,
				},
				body,
				signal: AbortSignal.timeout(10_000),
			},
		);
		if (!response.ok)
			throw new DomainError(
				"payment_provider_unavailable",
				502,
				"Payment provider unavailable",
			);
		const session = checkoutSessionSchema.parse(await response.json());
		return {
			providerPaymentId: session.id,
			checkoutUrl: session.url,
			expiresAt: session.expires_at ? session.expires_at * 1000 : null,
		};
	},
	async queryPayment(providerPaymentId, rawCredential, fetcher = fetch) {
		const { secretKey } = stripeCredentialSchema.parse(rawCredential);
		const session = await fetchStripeCheckoutSession(
			providerPaymentId,
			secretKey,
			fetcher,
		);
		return {
			status:
				session.payment_status === "paid" ||
				session.payment_status === "no_payment_required"
					? "succeeded"
					: session.status === "expired"
						? "expired"
						: "pending",
			amountMinor: session.amount_total?.toString() ?? null,
			currency: session.currency?.toUpperCase() ?? null,
		};
	},
	async parseWebhook(request, rawCredential, now = Date.now()) {
		const { webhookSecret } = stripeCredentialSchema.parse(rawCredential);
		const body = await readPaymentWebhookText(request);
		const signature = parseTimestampedSignature(
			request.headers.get("stripe-signature") ?? "",
		);
		if (!signature || Math.abs(now / 1000 - signature.timestamp) > 300)
			throw new DomainError(
				"invalid_payment_signature",
				401,
				"Invalid signature",
			);
		const expected = await hmacSha256Hex(
			webhookSecret,
			`${signature.timestamp}.${body}`,
		);
		if (
			!signature.signatures.some((value) => constantTimeEqual(value, expected))
		)
			throw new DomainError(
				"invalid_payment_signature",
				401,
				"Invalid signature",
			);
		const event = webhookSchema.parse(JSON.parse(body));
		const session = event.data.object;
		return {
			providerEventId: event.id,
			providerPaymentId: session.id ?? "",
			type: stripeEventType(event.type, session.payment_status),
			amountMinor: session.amount_total?.toString() ?? null,
			currency: session.currency?.toUpperCase() ?? null,
			payloadDigest: await sha256Hex(body),
		};
	},
	async refundPayment(input, rawCredential, fetcher = fetch) {
		const { secretKey } = stripeCredentialSchema.parse(rawCredential);
		const paymentIntent = input.providerPaymentId.startsWith("pi_")
			? input.providerPaymentId
			: (
					await fetchStripeCheckoutSession(
						input.providerPaymentId,
						secretKey,
						fetcher,
					)
				).payment_intent;
		if (!paymentIntent)
			throw new DomainError(
				"payment_refund_unavailable",
				409,
				"Payment cannot be refunded yet",
			);
		const response = await fetcher("https://api.stripe.com/v1/refunds", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${secretKey}`,
				"Content-Type": "application/x-www-form-urlencoded",
				"Idempotency-Key": input.refundId,
			},
			body: new URLSearchParams({
				payment_intent: paymentIntent,
				amount: input.amountMinor,
				reason: "requested_by_customer",
				"metadata[gmshop_refund_id]": input.refundId,
			}),
			signal: AbortSignal.timeout(10_000),
		});
		return presentStripeRefund(await parseStripeResponse(response));
	},
	async queryRefund(providerRefundId, rawCredential, fetcher = fetch) {
		const { secretKey } = stripeCredentialSchema.parse(rawCredential);
		const response = await fetcher(
			`https://api.stripe.com/v1/refunds/${encodeURIComponent(providerRefundId)}`,
			{
				headers: { Authorization: `Bearer ${secretKey}` },
				signal: AbortSignal.timeout(10_000),
			},
		);
		return presentStripeRefund(await parseStripeResponse(response));
	},
	async checkHealth(rawCredential, fetcher = fetch) {
		const { secretKey } = stripeCredentialSchema.parse(rawCredential);
		const response = await fetcher("https://api.stripe.com/v1/balance", {
			headers: { Authorization: `Bearer ${secretKey}` },
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok)
			throw new DomainError(
				"payment_provider_unavailable",
				502,
				"Payment provider unavailable",
			);
	},
};

async function fetchStripeCheckoutSession(
	providerPaymentId: string,
	secretKey: string,
	fetcher: typeof fetch,
) {
	const response = await fetcher(
		`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(providerPaymentId)}`,
		{
			headers: { Authorization: `Bearer ${secretKey}` },
			signal: AbortSignal.timeout(10_000),
		},
	);
	if (!response.ok)
		throw new DomainError(
			"payment_provider_unavailable",
			502,
			"Payment provider unavailable",
		);
	return checkoutSessionQuerySchema.parse(await response.json());
}

async function parseStripeResponse(response: Response) {
	if (!response.ok)
		throw new DomainError(
			"payment_provider_unavailable",
			502,
			"Payment provider unavailable",
		);
	return stripeRefundSchema.parse(await response.json());
}

function presentStripeRefund(refund: z.output<typeof stripeRefundSchema>) {
	return {
		providerRefundId: refund.id,
		status:
			refund.status === "succeeded"
				? ("succeeded" as const)
				: refund.status === "failed"
					? ("failed" as const)
					: refund.status === "canceled"
						? ("cancelled" as const)
						: ("pending" as const),
		failureCode: refund.failure_reason?.slice(0, 120) ?? null,
	};
}
