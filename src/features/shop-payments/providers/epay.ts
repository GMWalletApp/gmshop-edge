import { z } from "zod";
import type { PaymentProviderAdapter } from "#/features/shop-payments/provider";
import { epayCredentialSchema } from "#/features/shop-payments/provider";
import { sha256Hex } from "#/features/shop-payments/signature";
import { DomainError } from "#/lib/domain-error";
import { minorToDecimal } from "#/lib/units";
import {
	checkEpusdtHealth,
	epusdtFetch,
	epusdtMerchantOrderId,
	epusdtUrl,
	manualRefundMethods,
	queryEpusdtPayment,
	signEpusdt,
	verifyEpusdtSignature,
} from "./epusdt";

const callbackSchema = z.object({
	pid: z.string().min(1),
	trade_no: z.string().min(1),
	out_trade_no: z.string().min(1),
	money: z.string().regex(/^\d+(?:\.\d+)?$/),
	trade_status: z.literal("TRADE_SUCCESS"),
	sign: z.string().min(1),
	sign_type: z.string().toUpperCase().pipe(z.literal("MD5")),
});

export const epayPaymentProvider: PaymentProviderAdapter = {
	checkoutPresentation: "redirect",
	refundMode: "manual",
	async createPayment(input, rawCredential, fetcher = fetch) {
		const credential = epayCredentialSchema.parse(rawCredential);
		const params: Record<string, string> = {
			pid: credential.pid,
			money: minorToDecimal(input.amountMinor, input.currencyDecimals),
			out_trade_no: epusdtMerchantOrderId(input.attemptId),
			notify_url: input.webhookUrl,
			return_url: input.successUrl,
			name: input.description,
			type: credential.paymentMethod,
			currency: input.currency.toLowerCase(),
			sign_type: "MD5",
		};
		if (input.defaultToken && input.defaultNetwork) {
			params.token = input.defaultToken;
			params.network = input.defaultNetwork;
		}
		params.sign = signEpusdt(
			params,
			credential.secretKey,
			new Set(["sign", "sign_type"]),
		);
		const response = await epusdtFetch(
			epusdtUrl(credential.baseUrl, "/submit.php"),
			{
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams(params),
			},
			fetcher,
			{ expectRedirect: true },
		);
		const location = response.headers.get("location");
		if (response.status < 300 || response.status >= 400 || !location)
			throw new DomainError(
				"payment_provider_unavailable",
				502,
				"Payment provider unavailable",
			);
		const checkoutUrl = new URL(location, credential.baseUrl).toString();
		const providerPaymentId = new URL(checkoutUrl).pathname
			.split("/")
			.filter(Boolean)
			.at(-1);
		if (!providerPaymentId)
			throw new DomainError(
				"payment_provider_invalid_response",
				502,
				"Payment provider returned an invalid response",
			);
		return { providerPaymentId, checkoutUrl, expiresAt: null };
	},
	async queryPayment(providerPaymentId, rawCredential, fetcher = fetch) {
		const credential = epayCredentialSchema.parse(rawCredential);
		return queryEpusdtPayment(providerPaymentId, credential, fetcher);
	},
	async parseWebhook(request, rawCredential) {
		const credential = epayCredentialSchema.parse(rawCredential);
		if (request.method !== "GET")
			throw new DomainError(
				"invalid_payment_callback",
				405,
				"Invalid payment callback method",
			);
		const url = new URL(request.url);
		const params = Object.fromEntries(url.searchParams);
		verifyEpusdtSignature(params, credential.secretKey, "sign");
		const event = callbackSchema.parse(params);
		if (event.pid !== credential.pid)
			throw new DomainError(
				"invalid_payment_signature",
				401,
				"Invalid payment credential",
			);
		return {
			providerEventId: `epay:${event.trade_no}:${event.trade_status}`,
			providerPaymentId: event.trade_no,
			type: "payment_succeeded",
			amountMinor: null,
			amountDecimal: event.money,
			currency: null,
			merchantOrderId: event.out_trade_no,
			payloadDigest: await sha256Hex(url.searchParams.toString()),
		};
	},
	...manualRefundMethods,
	async checkHealth(rawCredential, fetcher = fetch) {
		const credential = epayCredentialSchema.parse(rawCredential);
		await checkEpusdtHealth(credential, fetcher);
	},
};
