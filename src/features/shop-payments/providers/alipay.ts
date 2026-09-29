import { z } from "zod";
import {
	alipayCredentialSchema,
	type PaymentProviderAdapter,
} from "#/features/shop-payments/provider";
import { sha256Hex } from "#/features/shop-payments/signature";
import { DomainError } from "#/lib/domain-error";
import { minorToDecimal } from "#/lib/units";
import { rsaSha256Sign, rsaSha256Verify } from "./rsa";
import { shanghaiDateTimeParts } from "./shanghai-time";
import { readPaymentWebhookText } from "./webhook-body";

const gateway = "https://openapi.alipay.com/gateway.do";

const tradeResponseSchema = z.object({
	code: z.string(),
	msg: z.string().optional(),
	sub_code: z.string().optional(),
	trade_no: z.string().optional(),
	out_trade_no: z.string().optional(),
	trade_status: z
		.enum(["WAIT_BUYER_PAY", "TRADE_SUCCESS", "TRADE_FINISHED", "TRADE_CLOSED"])
		.optional(),
	total_amount: z.string().optional(),
});

const refundResponseSchema = z.object({
	code: z.string(),
	sub_code: z.string().optional(),
	trade_no: z.string().optional(),
	out_trade_no: z.string().optional(),
	refund_fee: z.string().optional(),
	refund_status: z.string().optional(),
});

const callbackSchema = z.object({
	notify_id: z.string().min(1),
	app_id: z.string().min(1),
	seller_id: z.string().min(1),
	trade_no: z.string().min(1),
	out_trade_no: z.string().min(1),
	trade_status: z.enum([
		"WAIT_BUYER_PAY",
		"TRADE_SUCCESS",
		"TRADE_FINISHED",
		"TRADE_CLOSED",
	]),
	total_amount: z.string().regex(/^\d+(?:\.\d{1,2})?$/),
	sign: z.string().min(1),
	sign_type: z.literal("RSA2"),
});

export function createAlipayProvider(
	productCode: "FAST_INSTANT_TRADE_PAY" | "QUICK_WAP_WAY",
): PaymentProviderAdapter {
	const method =
		productCode === "FAST_INSTANT_TRADE_PAY"
			? "alipay.trade.page.pay"
			: "alipay.trade.wap.pay";
	return {
		checkoutPresentation: "redirect",
		refundMode: "automatic",
		async createPayment(input, rawCredential) {
			assertCny(input.currency, input.currencyDecimals);
			const credential = alipayCredentialSchema.parse(rawCredential);
			const outTradeNo = compactId(input.attemptId);
			const params = await signedAlipayParameters(
				credential,
				method,
				{
					out_trade_no: outTradeNo,
					total_amount: minorToDecimal(input.amountMinor, 2),
					subject: input.description.slice(0, 256),
					product_code: productCode,
					quit_url:
						productCode === "QUICK_WAP_WAY" ? input.cancelUrl : undefined,
					time_expire: alipayExpiry(input.expiresAt ?? null),
				},
				{
					notify_url: input.webhookUrl,
					return_url: input.successUrl,
				},
			);
			return {
				providerPaymentId: outTradeNo,
				checkoutUrl: `${gateway}?${new URLSearchParams(params)}`,
				expiresAt: null,
			};
		},
		async queryPayment(providerPaymentId, rawCredential, fetcher = fetch) {
			const credential = alipayCredentialSchema.parse(rawCredential);
			const response = await callAlipay(
				credential,
				"alipay.trade.query",
				{ out_trade_no: providerPaymentId },
				"alipay_trade_query_response",
				tradeResponseSchema,
				fetcher,
			);
			if (response.code !== "10000")
				return {
					status:
						response.sub_code === "ACQ.TRADE_NOT_EXIST" ? "pending" : "failed",
					amountMinor: null,
					currency: "CNY",
				};
			return {
				status:
					response.trade_status === "TRADE_SUCCESS" ||
					response.trade_status === "TRADE_FINISHED"
						? "succeeded"
						: response.trade_status === "TRADE_CLOSED"
							? "expired"
							: "pending",
				amountMinor: response.total_amount
					? decimalToCnyMinor(response.total_amount)
					: null,
				currency: "CNY",
			};
		},
		async parseWebhook(request, rawCredential) {
			if (request.method !== "POST")
				throw new DomainError(
					"invalid_payment_callback",
					405,
					"Invalid payment callback method",
				);
			const credential = alipayCredentialSchema.parse(rawCredential);
			const body = await readPaymentWebhookText(request);
			const params = Object.fromEntries(new URLSearchParams(body));
			const event = callbackSchema.parse(params);
			const valid = await rsaSha256Verify(
				credential.alipayPublicKeyPem,
				alipayCanonical(params, new Set(["sign", "sign_type"])),
				event.sign,
			);
			if (
				!valid ||
				event.app_id !== credential.appId ||
				event.seller_id !== credential.sellerId
			)
				throw new DomainError(
					"invalid_payment_signature",
					401,
					"Invalid Alipay callback",
				);
			return {
				providerEventId: `alipay:${event.notify_id}`,
				providerPaymentId: event.out_trade_no,
				type:
					event.trade_status === "TRADE_SUCCESS" ||
					event.trade_status === "TRADE_FINISHED"
						? "payment_succeeded"
						: event.trade_status === "TRADE_CLOSED"
							? "payment_expired"
							: // WAIT_BUYER_PAY: the buyer opened the cashier but has not paid yet.
								"payment_pending",
				amountMinor: decimalToCnyMinor(event.total_amount),
				currency: "CNY",
				merchantOrderId: event.out_trade_no,
				payloadDigest: await sha256Hex(body),
			};
		},
		async refundPayment(input, rawCredential, fetcher = fetch) {
			const credential = alipayCredentialSchema.parse(rawCredential);
			const outRequestNo = compactId(input.refundId);
			const response = await callAlipay(
				credential,
				"alipay.trade.refund",
				{
					out_trade_no: input.providerPaymentId,
					refund_amount: minorToDecimal(input.amountMinor, 2),
					refund_reason: input.reason.slice(0, 256),
					out_request_no: outRequestNo,
				},
				"alipay_trade_refund_response",
				refundResponseSchema,
				fetcher,
			);
			return {
				providerRefundId: `${input.providerPaymentId}:${outRequestNo}`,
				status: response.code === "10000" ? "succeeded" : "failed",
				failureCode:
					response.code === "10000"
						? null
						: (response.sub_code ?? response.code),
			};
		},
		async queryRefund(providerRefundId, rawCredential, fetcher = fetch) {
			const credential = alipayCredentialSchema.parse(rawCredential);
			const [outTradeNo, outRequestNo] = providerRefundId.split(":", 2);
			if (!outTradeNo || !outRequestNo)
				throw new DomainError(
					"payment_refund_unavailable",
					409,
					"Alipay refund reference is invalid",
				);
			const response = await callAlipay(
				credential,
				"alipay.trade.fastpay.refund.query",
				{
					out_request_no: outRequestNo,
					out_trade_no: outTradeNo,
				},
				"alipay_trade_fastpay_refund_query_response",
				refundResponseSchema,
				fetcher,
			);
			return {
				providerRefundId,
				status:
					response.code === "10000" && response.refund_status !== "REFUND_FAIL"
						? "succeeded"
						: response.code === "10000"
							? "failed"
							: "pending",
				failureCode: response.sub_code ?? null,
			};
		},
		async checkHealth(rawCredential, fetcher = fetch) {
			const credential = alipayCredentialSchema.parse(rawCredential);
			await callAlipay(
				credential,
				"alipay.trade.query",
				{ out_trade_no: `health${Date.now()}` },
				"alipay_trade_query_response",
				tradeResponseSchema,
				fetcher,
			);
		},
	};
}

export function createAutomaticAlipayProvider(): PaymentProviderAdapter {
	const desktop = createAlipayProvider("FAST_INSTANT_TRADE_PAY");
	const mobile = createAlipayProvider("QUICK_WAP_WAY");
	return {
		...desktop,
		createPayment(input, credential, fetcher) {
			return (input.payerMobile ? mobile : desktop).createPayment(
				input,
				credential,
				fetcher,
			);
		},
	};
}

async function callAlipay<T>(
	credential: z.output<typeof alipayCredentialSchema>,
	method: string,
	bizContent: Record<string, unknown>,
	responseKey: string,
	schema: z.ZodType<T>,
	fetcher: typeof fetch,
) {
	const parameters = await signedAlipayParameters(
		credential,
		method,
		bizContent,
	);
	const response = await fetcher(gateway, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(parameters),
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok)
		throw new DomainError(
			"payment_provider_unavailable",
			502,
			"Alipay is unavailable",
		);
	const responseText = await response.text();
	let raw: unknown;
	try {
		raw = JSON.parse(responseText);
	} catch {
		throw new DomainError(
			"payment_provider_invalid_response",
			502,
			"Alipay returned an invalid response",
		);
	}
	const envelope = z
		.object({ sign: z.string().min(1) })
		.catchall(z.unknown())
		.parse(raw);
	const payload = envelope[responseKey];
	if (!payload)
		throw new DomainError(
			"payment_provider_invalid_response",
			502,
			"Alipay returned an invalid response",
		);
	const signedPayload = extractRootJsonValue(responseText, responseKey);
	if (
		signedPayload == null ||
		!(await rsaSha256Verify(
			credential.alipayPublicKeyPem,
			signedPayload,
			envelope.sign,
		))
	)
		throw new DomainError(
			"invalid_payment_signature",
			502,
			"Alipay response signature is invalid",
		);
	return schema.parse(payload);
}

function extractRootJsonValue(json: string, property: string) {
	let index = skipWhitespace(json, 0);
	if (json[index] !== "{") return null;
	index += 1;
	while (index < json.length) {
		index = skipWhitespace(json, index);
		if (json[index] === "}") return null;
		const keyEnd = scanJsonString(json, index);
		if (keyEnd == null) return null;
		let key: string;
		try {
			key = JSON.parse(json.slice(index, keyEnd)) as string;
		} catch {
			return null;
		}
		index = skipWhitespace(json, keyEnd);
		if (json[index] !== ":") return null;
		const valueStart = skipWhitespace(json, index + 1);
		const valueEnd = scanJsonValue(json, valueStart);
		if (valueEnd == null) return null;
		if (key === property) return json.slice(valueStart, valueEnd);
		index = skipWhitespace(json, valueEnd);
		if (json[index] === "}") return null;
		if (json[index] !== ",") return null;
		index += 1;
	}
	return null;
}

function scanJsonValue(json: string, start: number) {
	const first = json[start];
	if (first === '"') return scanJsonString(json, start);
	if (first === "{" || first === "[") {
		const opening = first;
		const closing = opening === "{" ? "}" : "]";
		let depth = 0;
		let index = start;
		while (index < json.length) {
			if (json[index] === '"') {
				const stringEnd = scanJsonString(json, index);
				if (stringEnd == null) return null;
				index = stringEnd;
				continue;
			}
			if (json[index] === opening) depth += 1;
			if (json[index] === closing) {
				depth -= 1;
				if (depth === 0) return index + 1;
			}
			index += 1;
		}
		return null;
	}
	let index = start;
	while (index < json.length && json[index] !== "," && json[index] !== "}")
		index += 1;
	return index;
}

function scanJsonString(json: string, start: number) {
	if (json[start] !== '"') return null;
	let escaped = false;
	for (let index = start + 1; index < json.length; index += 1) {
		const character = json[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === "\\") {
			escaped = true;
			continue;
		}
		if (character === '"') return index + 1;
	}
	return null;
}

function skipWhitespace(value: string, start: number) {
	let index = start;
	while (
		index < value.length &&
		(value[index] === " " ||
			value[index] === "\n" ||
			value[index] === "\r" ||
			value[index] === "\t")
	)
		index += 1;
	return index;
}

async function signedAlipayParameters(
	credential: z.output<typeof alipayCredentialSchema>,
	method: string,
	bizContent: Record<string, unknown>,
	extra: Record<string, string> = {},
) {
	const params: Record<string, string> = {
		app_id: credential.appId,
		method,
		format: "JSON",
		charset: "utf-8",
		sign_type: "RSA2",
		timestamp: alipayTimestamp(),
		version: "1.0",
		biz_content: JSON.stringify(bizContent),
		...extra,
	};
	params.sign = await rsaSha256Sign(
		credential.privateKeyPem,
		alipayCanonical(params, new Set(["sign"])),
	);
	return params;
}

export function alipayCanonical(
	params: Record<string, string>,
	excluded: ReadonlySet<string>,
) {
	return Object.entries(params)
		.filter(([key, value]) => value !== "" && !excluded.has(key))
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, value]) => `${key}=${value}`)
		.join("&");
}

// Alipay requires the absolute expiry to be at least one minute ahead.
function alipayExpiry(expiresAt: number | null, now = Date.now()) {
	if (expiresAt === null) return undefined;
	return alipayTimestamp(new Date(Math.max(expiresAt, now + 60_000)));
}

function alipayTimestamp(date = new Date()) {
	const value = shanghaiDateTimeParts(date);
	return `${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}:${value.second}`;
}

function decimalToCnyMinor(value: string) {
	const [whole, fraction = ""] = value.split(".");
	return (
		BigInt(whole ?? "0") * 100n +
		BigInt(fraction.padEnd(2, "0"))
	).toString();
}

function compactId(value: string) {
	return value.replaceAll("-", "").slice(0, 64);
}

function assertCny(currency: string, decimals: number) {
	if (currency !== "CNY" || decimals !== 2)
		throw new DomainError(
			"payment_currency_unsupported",
			400,
			"Alipay requires CNY with two decimal places",
		);
}
