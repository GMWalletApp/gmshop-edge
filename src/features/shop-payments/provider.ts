import { z } from "zod";
import { isSafeWebhookUrl } from "#/lib/webhook-url";

export const paymentProviderValues = [
	"stripe",
	"cryptomus",
	"gmpay",
	"epay",
	"alipay_page",
	"alipay_wap",
	"wechat_native",
	"wechat_h5",
] as const;
export type PaymentProvider = (typeof paymentProviderValues)[number];
export type PaymentProviderFamily =
	| "stripe"
	| "cryptomus"
	| "gmpay"
	| "epay"
	| "alipay"
	| "wechat";

export function paymentProviderFamily(
	provider: PaymentProvider,
): PaymentProviderFamily {
	if (provider === "alipay_page" || provider === "alipay_wap") return "alipay";
	if (provider === "wechat_native" || provider === "wechat_h5") return "wechat";
	return provider;
}

export function paymentProviderDefaultCurrency(
	provider: PaymentProvider,
	storeCurrency: string,
) {
	const family = paymentProviderFamily(provider);
	return family === "alipay" || family === "wechat" ? "CNY" : storeCurrency;
}

export type CreatePaymentInput = {
	attemptId: string;
	orderId: string;
	orderNumber: string;
	amountMinor: string;
	currency: string;
	currencyDecimals: number;
	customerEmail: string;
	description: string;
	successUrl: string;
	cancelUrl: string;
	webhookUrl: string;
	defaultToken: string;
	defaultNetwork: string;
	payerIp: string | null;
	payerMobile?: boolean;
	/**
	 * When the shop stops accepting this payment (order expiry, ms since epoch).
	 * Providers clamp it to their own limits; `null` means the provider default.
	 */
	expiresAt?: number | null;
};

export type CreatedPayment = {
	providerPaymentId: string;
	checkoutUrl: string;
	expiresAt: number | null;
};

export type PaymentQuery = {
	status: "pending" | "succeeded" | "failed" | "expired";
	amountMinor: string | null;
	currency: string | null;
};

export type RefundPaymentInput = {
	refundId: string;
	providerPaymentId: string;
	amountMinor: string;
	reason: string;
};

export type PaymentRefund = {
	providerRefundId: string;
	status: "pending" | "succeeded" | "failed" | "cancelled";
	failureCode: string | null;
};

export type PaymentWebhookEvent = {
	providerEventId: string;
	providerPaymentId: string;
	type:
		| "payment_pending"
		| "payment_succeeded"
		| "payment_failed"
		| "payment_expired"
		/** Authenticated notification the shop does not act on (e.g. refund or unrelated event types). */
		| "payment_ignored";
	amountMinor: string | null;
	amountDecimal?: string | null;
	currency: string | null;
	merchantOrderId?: string | null;
	payloadDigest: string;
};

export type PaymentProviderAdapter = {
	checkoutPresentation: "qr" | "redirect";
	refundMode: "automatic" | "manual";
	createPayment(
		input: CreatePaymentInput,
		credential: unknown,
		fetcher?: typeof fetch,
	): Promise<CreatedPayment>;
	queryPayment(
		providerPaymentId: string,
		credential: unknown,
		fetcher?: typeof fetch,
	): Promise<PaymentQuery>;
	parseWebhook(
		request: Request,
		credential: unknown,
		now?: number,
	): Promise<PaymentWebhookEvent>;
	refundPayment(
		input: RefundPaymentInput,
		credential: unknown,
		fetcher?: typeof fetch,
	): Promise<PaymentRefund>;
	queryRefund(
		providerRefundId: string,
		credential: unknown,
		fetcher?: typeof fetch,
	): Promise<PaymentRefund>;
	checkHealth(credential: unknown, fetcher?: typeof fetch): Promise<void>;
};

export const stripeCredentialSchema = z.object({
	secretKey: z.string().startsWith("sk_").max(512),
	webhookSecret: z.string().startsWith("whsec_").max(512),
});

export const cryptomusCredentialSchema = z.object({
	merchantId: z.uuid(),
	paymentApiKey: z.string().trim().min(8).max(512),
});

const epusdtCredentialFields = {
	baseUrl: z
		.url()
		.max(2_048)
		.refine(isSafeWebhookUrl, "Enter a public HTTPS Epusdt URL")
		.transform((value) => value.replace(/\/+$/, "")),
	pid: z.string().trim().min(1).max(80),
	secretKey: z.string().min(8).max(512),
};

function epusdtCredentialSchema() {
	return z.object(epusdtCredentialFields);
}

const paymentMethodSchema = z
	.string()
	.trim()
	.toLowerCase()
	.regex(/^[a-z][a-z0-9_-]{0,39}$/)
	.default("alipay");

export const gmpayCredentialSchema = epusdtCredentialSchema();
export const epayCredentialSchema = epusdtCredentialSchema()
	.extend({ paymentMethod: paymentMethodSchema })
	.superRefine((value, context) => {
		if (/^\d+$/.test(value.pid)) return;
		context.addIssue({
			code: "custom",
			path: ["pid"],
			message: "EPay requires a numeric PID",
		});
	});

export const alipayCredentialSchema = z.object({
	appId: z
		.string()
		.trim()
		.regex(/^\d{16}$/),
	sellerId: z
		.string()
		.trim()
		.regex(/^\d{16}$/),
	privateKeyPem: z.string().includes("PRIVATE KEY").max(8_192),
	alipayPublicKeyPem: z.string().includes("PUBLIC KEY").max(8_192),
});

export const wechatCredentialSchema = z.object({
	appId: z.string().trim().min(1).max(32),
	mchId: z
		.string()
		.trim()
		.regex(/^\d{8,32}$/),
	merchantSerialNumber: z
		.string()
		.trim()
		.regex(/^[0-9A-F]+$/i),
	merchantPrivateKeyPem: z.string().includes("PRIVATE KEY").max(8_192),
	apiV3Key: z.string().length(32),
	platformSerialNumber: z
		.string()
		.trim()
		.regex(/^[0-9A-F]+$/i),
	platformPublicKeyPem: z.string().includes("PUBLIC KEY").max(8_192),
});
