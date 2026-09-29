import { z } from "zod";
import type { PaymentProviderAdapter } from "#/features/shop-payments/provider";
import { gmpayCredentialSchema } from "#/features/shop-payments/provider";
import { sha256Hex } from "#/features/shop-payments/signature";
import { DomainError } from "#/lib/domain-error";
import { minorToDecimal } from "#/lib/units";
import {
	checkEpusdtHealth,
	epusdtFetch,
	epusdtMerchantOrderId,
	epusdtUrl,
	manualRefundMethods,
	parseEpusdtJson,
	scalarRecord,
	signGmpay,
	verifyGmpaySignature,
} from "./epusdt";
import { readPaymentWebhookText } from "./webhook-body";

const createResponseSchema = z.object({
	status_code: z.literal(200),
	data: z.object({
		trade_id: z.string().min(1),
		payment_url: z.url(),
		expiration_time: z.number().int().positive(),
	}),
});

const callbackSchema = z.object({
	pid: z.string().min(1),
	trade_id: z.string().min(1),
	order_id: z.string().min(1),
	amount: z.string().regex(/^\d+(?:\.\d+)?$/),
	block_transaction_id: z.string().default(""),
	actual_amount: z
		.string()
		.regex(/^\d+(?:\.\d+)?$/)
		.default("0"),
	status: z.enum([
		"pending",
		"confirming",
		"paid",
		"partially_paid",
		"overpaid",
		"expired",
		"cancelled",
		"failed",
		"refunded",
	]),
	signature: z.string().min(1),
});

const queryResponseSchema = z.object({
	status_code: z.literal(200),
	data: z.object({
		trade_id: z.string().min(1),
		order_id: z.string().min(1),
		amount: z.string().regex(/^\d+(?:\.\d+)?$/),
		currency: z.string().length(3),
		status: callbackSchema.shape.status,
	}),
});

export const gmpayPaymentProvider: PaymentProviderAdapter = {
	checkoutPresentation: "redirect",
	refundMode: "manual",
	async createPayment(input, rawCredential, fetcher = fetch) {
		const credential = gmpayCredentialSchema.parse(rawCredential);
		const params: Record<string, string> = {
			pid: credential.pid,
			order_id: epusdtMerchantOrderId(input.attemptId),
			currency: input.currency.toUpperCase(),
			amount: minorToDecimal(input.amountMinor, input.currencyDecimals),
			notify_url: input.webhookUrl,
			redirect_url: input.successUrl,
			name: input.description,
		};
		if (input.defaultToken && input.defaultNetwork) {
			params.token = input.defaultToken;
			params.network = input.defaultNetwork;
		}
		params.signature = await signGmpay(params, credential.secretKey);
		const response = await epusdtFetch(
			epusdtUrl(
				credential.baseUrl,
				"/payments/gmpay/v1/order/create-transaction",
			),
			{
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams(params),
			},
			fetcher,
		);
		const result = createResponseSchema.parse(await parseEpusdtJson(response));
		return {
			providerPaymentId: result.data.trade_id,
			checkoutUrl: result.data.payment_url,
			expiresAt: result.data.expiration_time * 1000,
		};
	},
	async queryPayment(providerPaymentId, rawCredential, fetcher = fetch) {
		const credential = gmpayCredentialSchema.parse(rawCredential);
		const params = {
			pid: credential.pid,
			trade_id: providerPaymentId,
			signature: "",
		};
		params.signature = await signGmpay(params, credential.secretKey);
		const url = new URL(
			epusdtUrl(credential.baseUrl, "/payments/gmpay/v1/order/query"),
		);
		url.search = new URLSearchParams(params).toString();
		const result = queryResponseSchema.parse(
			await parseEpusdtJson(await epusdtFetch(url, {}, fetcher)),
		);
		return {
			status:
				result.data.status === "paid" || result.data.status === "overpaid"
					? ("succeeded" as const)
					: result.data.status === "expired" ||
							result.data.status === "cancelled"
						? ("expired" as const)
						: result.data.status === "failed"
							? ("failed" as const)
							: ("pending" as const),
			amountMinor: null,
			currency: result.data.currency.toUpperCase(),
		};
	},
	async parseWebhook(request, rawCredential) {
		const credential = gmpayCredentialSchema.parse(rawCredential);
		if (request.method !== "POST")
			throw new DomainError(
				"invalid_payment_callback",
				405,
				"Invalid payment callback method",
			);
		const body = await readPaymentWebhookText(request);
		let raw: unknown;
		try {
			raw = JSON.parse(body);
		} catch {
			throw new DomainError(
				"invalid_payment_callback",
				400,
				"Invalid payment callback",
			);
		}
		const params = scalarRecord(raw);
		await verifyGmpaySignature(params, credential.secretKey);
		const event = callbackSchema.parse(params);
		if (event.pid !== credential.pid)
			throw new DomainError(
				"invalid_payment_signature",
				401,
				"Invalid payment credential",
			);
		return {
			// A confirming and a paid notification for the same on-chain transaction
			// must not collide, so the status is always part of the identifier.
			providerEventId: `gmpay:${event.trade_id}:${event.status}:${event.block_transaction_id}`,
			providerPaymentId: event.trade_id,
			type:
				event.status === "paid" || event.status === "overpaid"
					? "payment_succeeded"
					: event.status === "pending" ||
							event.status === "confirming" ||
							event.status === "partially_paid"
						? "payment_pending"
						: event.status === "expired" || event.status === "cancelled"
							? "payment_expired"
							: "payment_failed",
			amountMinor: null,
			amountDecimal: event.amount,
			currency: null,
			merchantOrderId: event.order_id,
			payloadDigest: await sha256Hex(body),
		};
	},
	...manualRefundMethods,
	async checkHealth(rawCredential, fetcher = fetch) {
		const credential = gmpayCredentialSchema.parse(rawCredential);
		let healthy = false;
		try {
			healthy = (
				await epusdtFetch(
					epusdtUrl(credential.baseUrl, "/healthz"),
					{},
					fetcher,
				)
			).ok;
		} catch {
			healthy = false;
		}
		if (!healthy) await checkEpusdtHealth(credential, fetcher);
	},
};
