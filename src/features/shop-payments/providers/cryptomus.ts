import { md5 } from "@noble/hashes/legacy.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { z } from "zod";
import type {
	PaymentProviderAdapter,
	PaymentQuery,
	PaymentWebhookEvent,
} from "#/features/shop-payments/provider";
import { cryptomusCredentialSchema } from "#/features/shop-payments/provider";
import {
	constantTimeEqual,
	sha256Hex,
} from "#/features/shop-payments/signature";
import { DomainError } from "#/lib/domain-error";
import { minorToDecimal } from "#/lib/units";
import { manualRefundMethods } from "./epusdt";
import { bytesToBase64 } from "./rsa";
import { readPaymentWebhookText } from "./webhook-body";

const apiBaseUrl = "https://api.cryptomus.com/v1";
const encoder = new TextEncoder();

const invoiceSchema = z.object({
	uuid: z.uuid(),
	order_id: z.string().min(1).max(128),
	amount: z.string().regex(/^\d+(?:\.\d+)?$/),
	currency: z.string().min(1).max(16),
	payment_status: z.string().optional(),
	status: z.string().optional(),
	url: z.url().optional(),
	expired_at: z.number().int().positive().nullable().optional(),
});

const invoiceResponseSchema = z.object({
	state: z.literal(0),
	result: invoiceSchema,
});

const healthResponseSchema = z.object({
	state: z.literal(0),
	result: z.unknown(),
});

const webhookSchema = z.looseObject({
	type: z.literal("payment"),
	uuid: z.uuid(),
	order_id: z.string().min(1).max(128),
	amount: z.string().regex(/^\d+(?:\.\d+)?$/),
	currency: z.string().min(1).max(16),
	status: z.string().min(1).max(64),
	sign: z.string().regex(/^[a-f\d]{32}$/i),
});

type CryptomusCredential = z.output<typeof cryptomusCredentialSchema>;

export const cryptomusPaymentProvider: PaymentProviderAdapter = {
	checkoutPresentation: "redirect",
	refundMode: "manual",
	async createPayment(input, rawCredential, fetcher = fetch) {
		const credential = cryptomusCredentialSchema.parse(rawCredential);
		const payload: Record<string, unknown> = {
			amount: minorToDecimal(input.amountMinor, input.currencyDecimals),
			currency: input.currency.toUpperCase(),
			order_id: input.attemptId,
			url_callback: input.webhookUrl,
			url_return: input.cancelUrl,
			url_success: input.successUrl,
		};
		if (input.defaultToken && input.defaultNetwork) {
			payload.to_currency = input.defaultToken.toUpperCase();
			payload.network = input.defaultNetwork.toLowerCase();
		}
		const lifetime = cryptomusLifetimeSeconds(input.expiresAt ?? null);
		if (lifetime !== null) payload.lifetime = lifetime;
		const invoice = parseInvoiceResponse(
			await cryptomusRequest("/payment", payload, credential, fetcher),
		);
		if (!invoice.url || invoice.order_id !== input.attemptId)
			throw invalidProviderResponse();
		return {
			providerPaymentId: invoice.uuid,
			checkoutUrl: invoice.url,
			expiresAt: invoice.expired_at ? invoice.expired_at * 1000 : null,
		};
	},
	async queryPayment(providerPaymentId, rawCredential, fetcher = fetch) {
		const credential = cryptomusCredentialSchema.parse(rawCredential);
		const invoice = parseInvoiceResponse(
			await cryptomusRequest(
				"/payment/info",
				{ uuid: providerPaymentId },
				credential,
				fetcher,
			),
		);
		if (invoice.uuid !== providerPaymentId) throw invalidProviderResponse();
		return presentPaymentQuery(invoice);
	},
	async parseWebhook(request, rawCredential) {
		if (request.method !== "POST")
			throw new DomainError(
				"invalid_payment_callback",
				405,
				"Invalid payment callback method",
			);
		if (
			!request.headers
				.get("content-type")
				?.toLowerCase()
				.startsWith("application/json")
		)
			throw invalidCallback();
		const body = await readPaymentWebhookText(request);
		const raw = parseJsonObject(body);
		const { sign, ...unsigned } = raw;
		const credential = cryptomusCredentialSchema.parse(rawCredential);
		const provided = typeof sign === "string" ? sign.toLowerCase() : "";
		const valid = cryptomusCanonicalBodies(unsigned).some((canonical) =>
			constantTimeEqual(
				provided,
				cryptomusSign(canonical, credential.paymentApiKey),
			),
		);
		if (!valid)
			throw new DomainError(
				"invalid_payment_signature",
				401,
				"Invalid signature",
			);
		const parsedEvent = webhookSchema.safeParse(raw);
		if (!parsedEvent.success) throw invalidCallback();
		const event = parsedEvent.data;
		const payloadDigest = await sha256Hex(body);
		return {
			providerEventId: `cryptomus:${event.uuid}:${event.status}:${payloadDigest}`,
			providerPaymentId: event.uuid,
			type: paymentEventType(event.status),
			amountMinor: null,
			amountDecimal: event.amount,
			currency: event.currency.toUpperCase(),
			merchantOrderId: event.order_id,
			payloadDigest,
		};
	},
	...manualRefundMethods,
	async checkHealth(rawCredential, fetcher = fetch) {
		const credential = cryptomusCredentialSchema.parse(rawCredential);
		const response = await cryptomusRequest(
			"/payment/services",
			{},
			credential,
			fetcher,
		);
		if (!healthResponseSchema.safeParse(response).success)
			throw invalidProviderResponse();
	},
};

// Cryptomus invoices live between 5 minutes and 12 hours.
const CRYPTOMUS_MIN_LIFETIME_S = 300;
const CRYPTOMUS_MAX_LIFETIME_S = 43_200;

function cryptomusLifetimeSeconds(expiresAt: number | null, now = Date.now()) {
	if (expiresAt === null) return null;
	return Math.min(
		CRYPTOMUS_MAX_LIFETIME_S,
		Math.max(CRYPTOMUS_MIN_LIFETIME_S, Math.ceil((expiresAt - now) / 1000)),
	);
}

/**
 * Cryptomus signs `md5(base64(json_encode($data, JSON_UNESCAPED_UNICODE)) . key)`.
 * PHP's json_encode escapes "/" as "\/", so the PHP-compatible form is the
 * primary candidate; the plain JSON.stringify form is accepted as well for
 * payloads re-encoded without escaped slashes.
 */
export function cryptomusCanonicalBodies(payload: Record<string, unknown>) {
	const plain = JSON.stringify(payload);
	const phpStyle = plain.replaceAll("/", "\\/");
	return phpStyle === plain ? [plain] : [phpStyle, plain];
}

export function cryptomusSign(body: string, paymentApiKey: string) {
	const encodedBody = bytesToBase64(encoder.encode(body));
	return bytesToHex(md5(encoder.encode(`${encodedBody}${paymentApiKey}`)));
}

async function cryptomusRequest(
	path: string,
	payload: Record<string, unknown>,
	credential: CryptomusCredential,
	fetcher: typeof fetch,
) {
	const body = JSON.stringify(payload);
	const response = await fetcher(`${apiBaseUrl}${path}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			merchant: credential.merchantId,
			sign: cryptomusSign(body, credential.paymentApiKey),
		},
		body,
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok)
		throw new DomainError(
			"payment_provider_unavailable",
			502,
			"Payment provider unavailable",
		);
	try {
		return await response.json();
	} catch {
		throw invalidProviderResponse();
	}
}

function presentPaymentQuery(
	invoice: z.output<typeof invoiceSchema>,
): PaymentQuery {
	return {
		status: paymentQueryStatus(invoice.payment_status ?? invoice.status ?? ""),
		amountMinor: null,
		currency: invoice.currency.toUpperCase(),
	};
}

function parseInvoiceResponse(value: unknown) {
	const parsed = invoiceResponseSchema.safeParse(value);
	if (!parsed.success) throw invalidProviderResponse();
	return parsed.data.result;
}

function paymentQueryStatus(status: string): PaymentQuery["status"] {
	if (status === "paid" || status === "paid_over") return "succeeded";
	if (status === "cancel") return "expired";
	if (["wrong_amount", "fail", "system_fail"].includes(status)) return "failed";
	return "pending";
}

function paymentEventType(status: string): PaymentWebhookEvent["type"] {
	const queryStatus = paymentQueryStatus(status);
	if (queryStatus === "succeeded") return "payment_succeeded";
	if (queryStatus === "expired") return "payment_expired";
	if (queryStatus === "failed") return "payment_failed";
	return "payment_pending";
}

function parseJsonObject(body: string): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(body);
		if (value && typeof value === "object" && !Array.isArray(value))
			return value as Record<string, unknown>;
	} catch {
		// Normalized below.
	}
	throw invalidCallback();
}

function invalidCallback() {
	return new DomainError(
		"invalid_payment_callback",
		400,
		"Invalid payment callback",
	);
}

function invalidProviderResponse() {
	return new DomainError(
		"payment_provider_invalid_response",
		502,
		"Payment provider returned an invalid response",
	);
}
