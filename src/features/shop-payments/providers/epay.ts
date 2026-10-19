import { z } from "zod";
import {
	PaymentCreationError,
	redactPaymentProviderText,
} from "#/features/shop-payments/creation-error";
import type {
	PaymentProviderAdapter,
	RefundPaymentInput,
} from "#/features/shop-payments/provider";
import { epayCredentialSchema } from "#/features/shop-payments/provider";
import { sha256Hex } from "#/features/shop-payments/signature";
import { DomainError } from "#/lib/domain-error";
import { decimalToMinor, minorToDecimal } from "#/lib/units";
import {
	epusdtMerchantOrderId,
	epusdtUrl,
	manualRefundMethods,
	signEpusdt,
	verifyEpusdtSignature,
} from "./epusdt";
import { readPaymentWebhookText } from "./webhook-body";

const successCodeSchema = z.union([z.literal(1), z.literal("1")]);
const createResponseSchema = z.object({
	code: successCodeSchema,
	msg: z.string().default(""),
	O_id: z.union([z.string(), z.number()]).optional(),
	trade_no: z.union([z.string(), z.number()]).optional(),
	payurl: z.string().default(""),
	payurl2: z.string().default(""),
	qrcode: z.string().default(""),
});
const queryResponseSchema = z.object({
	code: successCodeSchema,
	status: z.union([z.string(), z.number()]),
});
const healthResponseSchema = z.object({ code: successCodeSchema });
const zpayOrderResponseSchema = z.object({
	code: successCodeSchema,
	status: z.union([z.string(), z.number()]),
	trade_no: z.union([z.string(), z.number()]),
	out_trade_no: z.union([z.string(), z.number()]),
	type: z.string(),
	money: z.union([z.string(), z.number()]),
});
const zpayRefundResponseSchema = z.object({
	code: z.union([z.string(), z.number()]),
	msg: z.string().default(""),
});
const zpayRequestTimeoutMs = 15_000;
const zpayRefundTimeoutMs = 60_000;
const callbackSchema = z.object({
	pid: z.string().min(1),
	trade_no: z.string().min(1),
	out_trade_no: z.string().min(1),
	money: z.string().regex(/^\d+(?:\.\d+)?$/),
	trade_status: z.literal("TRADE_SUCCESS"),
	sign: z.string().min(1),
	sign_type: z.string().toUpperCase().pipe(z.literal("MD5")),
});

const paymentSubject = "老实人AI 额度";

export const epayPaymentProvider: PaymentProviderAdapter = {
	checkoutPresentation: "qr",
	refundMode: "manual",
	refundModeForCredential(rawCredential) {
		const credential = epayCredentialSchema.safeParse(rawCredential);
		return credential.success && isZpayOrigin(credential.data.baseUrl)
			? "automatic"
			: "manual";
	},
	async createPayment(input, rawCredential, fetcher = fetch) {
		const credential = epayCredentialSchema.parse(rawCredential);
		// The gateway reads `money` as yuan. Any other currency would charge the converted number in CNY.
		if (input.currency !== "CNY" || input.currencyDecimals !== 2)
			throw new DomainError(
				"payment_currency_unsupported",
				400,
				"Epay requires CNY with two decimal places",
			);
		if (!input.payerIp)
			throw new DomainError(
				"payment_payer_ip_required",
				400,
				"Payment provider requires the customer IP address",
			);
		const merchantOrderId = epusdtMerchantOrderId(input.attemptId);
		const params: Record<string, string> = {
			pid: credential.pid,
			type: credential.paymentMethod,
			out_trade_no: merchantOrderId,
			notify_url: input.webhookUrl,
			return_url: input.successUrl,
			name: paymentSubject,
			money: minorToDecimal(input.amountMinor, input.currencyDecimals),
			clientip: input.payerIp,
		};
		params.sign = signEpusdt(
			params,
			credential.secretKey,
			new Set(["sign", "sign_type"]),
		);
		params.sign_type = "MD5";
		const form = new FormData();
		for (const [key, value] of Object.entries(params)) form.set(key, value);
		const sensitive = [
			credential.secretKey,
			credential.pid,
			params.sign ?? "",
			input.customerEmail,
			input.payerIp,
			input.successUrl,
			input.cancelUrl,
			input.webhookUrl,
			merchantOrderId,
		];
		let response: Response;
		try {
			response = await fetcher(epusdtUrl(credential.baseUrl, "/mapi.php"), {
				method: "POST",
				body: form,
				signal: AbortSignal.timeout(15_000),
			});
		} catch (error) {
			throw new PaymentCreationError(
				error instanceof Error &&
					["TimeoutError", "AbortError"].includes(error.name)
					? "payment_provider_timeout"
					: "payment_provider_network_error",
				{},
			);
		}
		const diagnostics = { httpStatus: response.status };
		if (!response.ok)
			throw new PaymentCreationError(
				"payment_provider_http_error",
				diagnostics,
			);
		let raw: unknown;
		try {
			raw = await response.json();
		} catch {
			throw new PaymentCreationError(
				"payment_provider_invalid_json",
				diagnostics,
			);
		}
		const envelope = z
			.object({
				code: z.union([z.string(), z.number()]),
				msg: z.unknown().optional(),
			})
			.safeParse(raw);
		if (
			envelope.success &&
			!successCodeSchema.safeParse(envelope.data.code).success
		) {
			throw new PaymentCreationError("payment_provider_rejected", {
				...diagnostics,
				providerCode: redactPaymentProviderText(envelope.data.code, sensitive),
				providerMessage: redactPaymentProviderText(
					envelope.data.msg,
					sensitive,
				),
			});
		}
		const result = createResponseSchema.safeParse(raw);
		if (!result.success)
			throw new PaymentCreationError(
				"payment_provider_invalid_response",
				diagnostics,
			);
		const tradeNo = String(result.data.trade_no ?? result.data.O_id ?? "");
		const paymentUrl =
			result.data.payurl || result.data.payurl2 || result.data.qrcode;
		if (!tradeNo || !paymentUrl)
			throw new PaymentCreationError(
				"payment_provider_missing_checkout",
				diagnostics,
			);
		let checkoutUrl: string;
		try {
			checkoutUrl = z
				.url()
				.parse(new URL(paymentUrl, credential.baseUrl).toString());
		} catch {
			throw new PaymentCreationError(
				"payment_provider_invalid_checkout",
				diagnostics,
			);
		}
		return {
			providerPaymentId: `${tradeNo}:${merchantOrderId}`,
			checkoutUrl,
			expiresAt: null,
		};
	},
	async queryPayment(providerPaymentId, rawCredential, fetcher = fetch) {
		const credential = epayCredentialSchema.parse(rawCredential);
		const merchantOrderId = providerPaymentId.split(":").at(-1);
		if (!merchantOrderId)
			throw new DomainError(
				"payment_provider_invalid_response",
				502,
				"Payment provider identifier is invalid",
			);
		const url = new URL(epusdtUrl(credential.baseUrl, "/api.php"));
		url.search = new URLSearchParams({
			act: "order",
			pid: credential.pid,
			key: credential.secretKey,
			out_trade_no: merchantOrderId,
		}).toString();
		const response = await fetcher(url, {
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok)
			throw new DomainError(
				"payment_provider_unavailable",
				502,
				"Payment provider unavailable",
			);
		const result = queryResponseSchema.parse(await response.json());
		return {
			status: Number(result.status) === 1 ? "succeeded" : "pending",
			amountMinor: null,
			currency: null,
		};
	},
	async parseWebhook(request, rawCredential) {
		const credential = epayCredentialSchema.parse(rawCredential);
		if (request.method !== "GET" && request.method !== "POST")
			throw new DomainError(
				"invalid_payment_callback",
				405,
				"Invalid payment callback method",
			);
		const params =
			request.method === "GET"
				? Object.fromEntries(new URL(request.url).searchParams)
				: Object.fromEntries(
						new URLSearchParams(await readPaymentWebhookText(request)),
					);
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
			providerPaymentId: `${event.trade_no}:${event.out_trade_no}`,
			type: "payment_succeeded",
			amountMinor: null,
			amountDecimal: event.money,
			// Epay only settles in CNY, so a callback must match a CNY attempt.
			currency: "CNY",
			merchantOrderId: event.out_trade_no,
			payloadDigest: await sha256Hex(new URLSearchParams(params).toString()),
		};
	},
	async refundPayment(input, rawCredential, fetcher = fetch) {
		const credential = epayCredentialSchema.parse(rawCredential);
		if (!isZpayOrigin(credential.baseUrl))
			return manualRefundMethods.refundPayment(input, credential, fetcher);
		return refundZpayPayment(input, credential, fetcher);
	},
	async queryRefund(providerRefundId, rawCredential, fetcher = fetch) {
		const credential = epayCredentialSchema.parse(rawCredential);
		if (!isZpayOrigin(credential.baseUrl))
			return manualRefundMethods.queryRefund(
				providerRefundId,
				credential,
				fetcher,
			);
		throw new DomainError(
			"payment_refund_reconciliation_required",
			409,
			"ZPAY does not expose a refund query endpoint",
		);
	},
	async checkHealth(rawCredential, fetcher = fetch) {
		const credential = epayCredentialSchema.parse(rawCredential);
		const url = new URL(epusdtUrl(credential.baseUrl, "/api.php"));
		url.search = new URLSearchParams({
			act: "query",
			pid: credential.pid,
			key: credential.secretKey,
		}).toString();
		const response = await fetcher(url, {
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok)
			throw new DomainError(
				"payment_provider_unavailable",
				502,
				"Payment provider unavailable",
			);
		healthResponseSchema.parse(await response.json());
	},
};

function isZpayOrigin(baseUrl: string) {
	try {
		return new URL(baseUrl).origin === "https://zpayz.cn";
	} catch {
		return false;
	}
}

async function refundZpayPayment(
	input: RefundPaymentInput,
	credential: z.output<typeof epayCredentialSchema>,
	fetcher: typeof fetch,
) {
	const merchantOrderId = input.providerPaymentId.split(":").at(-1);
	if (!merchantOrderId)
		return {
			providerRefundId: `zpay:invalid:${input.refundId}`,
			status: "failed" as const,
			failureCode: "zpay_payment_reference_invalid",
		};
	const orderUrl = new URL(epusdtUrl(credential.baseUrl, "/api.php"));
	orderUrl.search = new URLSearchParams({
		act: "order",
		pid: credential.pid,
		key: credential.secretKey,
		out_trade_no: merchantOrderId,
	}).toString();
	const order = await zpayJson(
		zpayOrderResponseSchema,
		orderUrl,
		undefined,
		fetcher,
	);
	const providerTradeNo = String(order.trade_no).trim();
	if (
		Number(order.status) !== 1 ||
		!providerTradeNo ||
		String(order.out_trade_no) !== merchantOrderId ||
		order.type !== credential.paymentMethod ||
		decimalToMinor(String(order.money), 2).toString() !== input.amountMinor
	)
		return {
			providerRefundId: `zpay:${providerTradeNo || `invalid:${input.refundId}`}`,
			status: "failed" as const,
			failureCode: "zpay_full_refund_preflight_failed",
		};
	const body = new URLSearchParams({
		pid: credential.pid,
		key: credential.secretKey,
		trade_no: providerTradeNo,
		money: minorToDecimal(input.amountMinor, 2),
	});
	const result = await zpayJson(
		zpayRefundResponseSchema,
		epusdtUrl(credential.baseUrl, "/api.php?act=refund"),
		{
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body,
		},
		fetcher,
		zpayRefundTimeoutMs,
	);
	return {
		providerRefundId: `zpay:${providerTradeNo}`,
		status:
			Number(result.code) === 1 ? ("succeeded" as const) : ("failed" as const),
		failureCode: Number(result.code) === 1 ? null : "zpay_refund_rejected",
	};
}

async function zpayJson<T>(
	schema: z.ZodType<T>,
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	fetcher: typeof fetch,
	timeoutMs = zpayRequestTimeoutMs,
): Promise<T> {
	try {
		const response = await fetcher(input, {
			...init,
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) throw new Error("ZPAY HTTP failure");
		return schema.parse(await response.json());
	} catch {
		throw new DomainError(
			"payment_refund_reconciliation_required",
			409,
			"ZPAY refund result is ambiguous and requires manual reconciliation",
		);
	}
}
