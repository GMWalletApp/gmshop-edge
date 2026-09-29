import { z } from "zod";
import {
	type PaymentProviderAdapter,
	type PaymentWebhookEvent,
	wechatCredentialSchema,
} from "#/features/shop-payments/provider";
import { sha256Hex } from "#/features/shop-payments/signature";
import { DomainError } from "#/lib/domain-error";
import { base64ToBytes, rsaSha256Sign, rsaSha256Verify } from "./rsa";
import { shanghaiDateTimeParts } from "./shanghai-time";
import { readPaymentWebhookText } from "./webhook-body";

const apiOrigin = "https://api.mch.weixin.qq.com";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const orderSchema = z.object({
	appid: z.string().optional(),
	mchid: z.string().optional(),
	out_trade_no: z.string(),
	transaction_id: z.string().optional(),
	trade_state: z.enum([
		"SUCCESS",
		"REFUND",
		"NOTPAY",
		"CLOSED",
		"REVOKED",
		"USERPAYING",
		"PAYERROR",
	]),
	amount: z.object({
		total: z.number().int().nonnegative(),
		currency: z.string().length(3),
	}),
});

const refundSchema = z.object({
	refund_id: z.string(),
	out_refund_no: z.string(),
	status: z.enum(["SUCCESS", "CLOSED", "PROCESSING", "ABNORMAL", "CHANGE"]),
});

const notificationSchema = z.object({
	id: z.string().min(1),
	event_type: z.string().min(1),
	resource: z.object({
		algorithm: z.literal("AEAD_AES_256_GCM"),
		ciphertext: z.string().min(1),
		associated_data: z.string().default(""),
		nonce: z.string().min(1),
	}),
});

export function createWechatPayProvider(
	mode: "native" | "h5",
): PaymentProviderAdapter {
	return {
		checkoutPresentation: mode === "native" ? "qr" : "redirect",
		refundMode: "automatic",
		async createPayment(input, rawCredential, fetcher = fetch) {
			assertCny(input.currency, input.currencyDecimals);
			const credential = wechatCredentialSchema.parse(rawCredential);
			if (mode === "h5" && !input.payerIp)
				throw new DomainError(
					"payment_client_ip_required",
					400,
					"WeChat H5 payment requires a client IP address",
				);
			const outTradeNo = compactId(input.attemptId);
			const expiresAt = wechatExpiry(input.expiresAt ?? null);
			const result = await wechatRequest(
				credential,
				"POST",
				`/v3/pay/transactions/${mode}`,
				{
					appid: credential.appId,
					mchid: credential.mchId,
					description: input.description.slice(0, 127),
					out_trade_no: outTradeNo,
					time_expire: wechatTimestamp(new Date(expiresAt)),
					notify_url: input.webhookUrl,
					amount: {
						total: Number(assertSafeMinor(input.amountMinor)),
						currency: "CNY",
					},
					...(mode === "h5"
						? {
								scene_info: {
									payer_client_ip: input.payerIp,
									h5_info: { type: "Wap" },
								},
							}
						: {}),
				},
				fetcher,
			);
			const parsed =
				mode === "native"
					? z
							.object({ code_url: z.string().startsWith("weixin://") })
							.parse(result)
					: z.object({ h5_url: z.url() }).parse(result);
			return {
				providerPaymentId: outTradeNo,
				checkoutUrl:
					mode === "native"
						? (parsed as { code_url: string }).code_url
						: (parsed as { h5_url: string }).h5_url,
				expiresAt,
			};
		},
		async queryPayment(providerPaymentId, rawCredential, fetcher = fetch) {
			const credential = wechatCredentialSchema.parse(rawCredential);
			const result = orderSchema.parse(
				await wechatRequest(
					credential,
					"GET",
					`/v3/pay/transactions/out-trade-no/${encodeURIComponent(providerPaymentId)}?mchid=${encodeURIComponent(credential.mchId)}`,
					null,
					fetcher,
				),
			);
			return {
				status:
					result.trade_state === "SUCCESS" || result.trade_state === "REFUND"
						? "succeeded"
						: result.trade_state === "CLOSED" ||
								result.trade_state === "REVOKED"
							? "expired"
							: result.trade_state === "PAYERROR"
								? "failed"
								: "pending",
				amountMinor: result.amount.total.toString(),
				currency: result.amount.currency.toUpperCase(),
			};
		},
		async parseWebhook(request, rawCredential) {
			if (request.method !== "POST")
				throw new DomainError(
					"invalid_payment_callback",
					405,
					"Invalid payment callback method",
				);
			const credential = wechatCredentialSchema.parse(rawCredential);
			const body = await readPaymentWebhookText(request);
			await verifyWechatSignature(request.headers, body, credential);
			const notification = notificationSchema.parse(JSON.parse(body));
			// Refund and other notification types are acknowledged without acting.
			if (notification.event_type !== "TRANSACTION.SUCCESS")
				return {
					providerEventId: notification.id,
					providerPaymentId: "",
					type: "payment_ignored",
					amountMinor: null,
					currency: null,
					payloadDigest: await sha256Hex(body),
				};
			const order = orderSchema.parse(
				JSON.parse(
					await decryptWechatResource(
						notification.resource,
						credential.apiV3Key,
					),
				),
			);
			if (order.appid !== credential.appId || order.mchid !== credential.mchId)
				throw new DomainError(
					"invalid_payment_signature",
					401,
					"WeChat payment identity does not match",
				);
			return {
				providerEventId: notification.id,
				providerPaymentId: order.out_trade_no,
				type: wechatEventType(order.trade_state),
				amountMinor: order.amount.total.toString(),
				currency: order.amount.currency.toUpperCase(),
				merchantOrderId: order.out_trade_no,
				payloadDigest: await sha256Hex(body),
			};
		},
		async refundPayment(input, rawCredential, fetcher = fetch) {
			const credential = wechatCredentialSchema.parse(rawCredential);
			const order = orderSchema.parse(
				await wechatRequest(
					credential,
					"GET",
					`/v3/pay/transactions/out-trade-no/${encodeURIComponent(input.providerPaymentId)}?mchid=${encodeURIComponent(credential.mchId)}`,
					null,
					fetcher,
				),
			);
			const outRefundNo = compactId(input.refundId);
			const refund = refundSchema.parse(
				await wechatRequest(
					credential,
					"POST",
					"/v3/refund/domestic/refunds",
					{
						out_trade_no: input.providerPaymentId,
						out_refund_no: outRefundNo,
						reason: input.reason.slice(0, 80),
						amount: {
							refund: Number(assertSafeMinor(input.amountMinor)),
							total: order.amount.total,
							currency: "CNY",
						},
					},
					fetcher,
				),
			);
			return presentRefund(refund);
		},
		async queryRefund(providerRefundId, rawCredential, fetcher = fetch) {
			const credential = wechatCredentialSchema.parse(rawCredential);
			return presentRefund(
				refundSchema.parse(
					await wechatRequest(
						credential,
						"GET",
						`/v3/refund/domestic/refunds/${encodeURIComponent(providerRefundId)}`,
						null,
						fetcher,
					),
				),
			);
		},
		async checkHealth(rawCredential, fetcher = fetch) {
			const credential = wechatCredentialSchema.parse(rawCredential);
			try {
				await wechatRequest(
					credential,
					"GET",
					`/v3/pay/transactions/out-trade-no/health${Date.now()}?mchid=${encodeURIComponent(credential.mchId)}`,
					null,
					fetcher,
				);
			} catch (error) {
				if (
					error instanceof DomainError &&
					error.code === "payment_order_not_found"
				)
					return;
				throw error;
			}
		},
	};
}

export function createAutomaticWechatPayProvider(): PaymentProviderAdapter {
	const desktop = createWechatPayProvider("native");
	const mobile = createWechatPayProvider("h5");
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

async function wechatRequest(
	credential: z.output<typeof wechatCredentialSchema>,
	method: "GET" | "POST",
	pathAndQuery: string,
	bodyValue: unknown,
	fetcher: typeof fetch,
) {
	const body = bodyValue === null ? "" : JSON.stringify(bodyValue);
	const timestamp = Math.floor(Date.now() / 1000).toString();
	const nonce = crypto.randomUUID().replaceAll("-", "");
	const signature = await rsaSha256Sign(
		credential.merchantPrivateKeyPem,
		`${method}\n${pathAndQuery}\n${timestamp}\n${nonce}\n${body}\n`,
	);
	const response = await fetcher(`${apiOrigin}${pathAndQuery}`, {
		method,
		headers: {
			Accept: "application/json",
			Authorization:
				`WECHATPAY2-SHA256-RSA2048 mchid="${credential.mchId}",` +
				`nonce_str="${nonce}",timestamp="${timestamp}",` +
				`serial_no="${credential.merchantSerialNumber}",signature="${signature}"`,
			...(body ? { "Content-Type": "application/json" } : {}),
		},
		...(body ? { body } : {}),
		signal: AbortSignal.timeout(10_000),
	});
	const responseBody = await response.text();
	await verifyWechatSignature(response.headers, responseBody, credential);
	if (!response.ok) {
		const error = z
			.object({ code: z.string(), message: z.string().optional() })
			.safeParse(safeJson(responseBody));
		if (error.success && error.data.code === "ORDER_NOT_EXIST")
			throw new DomainError(
				"payment_order_not_found",
				404,
				"WeChat payment order does not exist",
			);
		throw new DomainError(
			"payment_provider_unavailable",
			502,
			"WeChat Pay is unavailable",
		);
	}
	return safeJson(responseBody);
}

async function verifyWechatSignature(
	headers: Headers,
	body: string,
	credential: z.output<typeof wechatCredentialSchema>,
) {
	const timestamp = headers.get("wechatpay-timestamp") ?? "";
	const nonce = headers.get("wechatpay-nonce") ?? "";
	const signature = headers.get("wechatpay-signature") ?? "";
	const serial = headers.get("wechatpay-serial") ?? "";
	const now = Math.floor(Date.now() / 1000);
	if (
		serial.toUpperCase() !== credential.platformSerialNumber.toUpperCase() ||
		!/^\d{10}$/.test(timestamp) ||
		Math.abs(now - Number(timestamp)) > 300 ||
		!nonce ||
		!(await rsaSha256Verify(
			credential.platformPublicKeyPem,
			`${timestamp}\n${nonce}\n${body}\n`,
			signature,
		))
	)
		throw new DomainError(
			"invalid_payment_signature",
			401,
			"WeChat Pay signature is invalid",
		);
}

async function decryptWechatResource(
	resource: z.output<typeof notificationSchema>["resource"],
	apiV3Key: string,
) {
	const ciphertext = base64ToBytes(resource.ciphertext);
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(apiV3Key),
		"AES-GCM",
		false,
		["decrypt"],
	);
	try {
		const plaintext = await crypto.subtle.decrypt(
			{
				name: "AES-GCM",
				iv: encoder.encode(resource.nonce),
				additionalData: encoder.encode(resource.associated_data),
				tagLength: 128,
			},
			key,
			ciphertext,
		);
		return decoder.decode(plaintext);
	} catch {
		throw new DomainError(
			"invalid_payment_callback",
			400,
			"WeChat Pay callback cannot be decrypted",
		);
	}
}

function presentRefund(refund: z.output<typeof refundSchema>) {
	return {
		providerRefundId: refund.out_refund_no,
		status:
			refund.status === "SUCCESS"
				? ("succeeded" as const)
				: refund.status === "CLOSED"
					? ("cancelled" as const)
					: refund.status === "ABNORMAL"
						? ("failed" as const)
						: ("pending" as const),
		failureCode: refund.status === "ABNORMAL" ? "ABNORMAL" : null,
	};
}

function safeJson(value: string) {
	try {
		return JSON.parse(value) as unknown;
	} catch {
		throw new DomainError(
			"payment_provider_invalid_response",
			502,
			"WeChat Pay returned an invalid response",
		);
	}
}

function compactId(value: string) {
	return value.replaceAll("-", "").slice(0, 32);
}

// WeChat Pay requires the expiry to be more than one minute ahead; the order
// expiry is used when it is known, otherwise 30 minutes.
function wechatExpiry(expiresAt: number | null, now = Date.now()) {
	const requested = expiresAt ?? now + 30 * 60_000;
	return Math.max(requested, now + 2 * 60_000);
}

// yyyy-MM-DDTHH:mm:ss+08:00 (RFC 3339 without fractional seconds), as documented.
function wechatTimestamp(date: Date) {
	const value = shanghaiDateTimeParts(date);
	return `${value.year}-${value.month}-${value.day}T${value.hour}:${value.minute}:${value.second}+08:00`;
}

function wechatEventType(
	tradeState: z.output<typeof orderSchema>["trade_state"],
): PaymentWebhookEvent["type"] {
	switch (tradeState) {
		case "SUCCESS":
			return "payment_succeeded";
		case "CLOSED":
		case "REVOKED":
			return "payment_expired";
		case "PAYERROR":
			return "payment_failed";
		case "REFUND":
			// Refunds are reconciled through the refund flow, never as a payment.
			return "payment_ignored";
		default:
			// NOTPAY / USERPAYING: the payment is still in progress.
			return "payment_pending";
	}
}

function assertSafeMinor(value: string) {
	const amount = BigInt(value);
	if (amount < 0n || amount > BigInt(Number.MAX_SAFE_INTEGER))
		throw new DomainError(
			"payment_amount_invalid",
			400,
			"WeChat Pay amount is outside its supported range",
		);
	return amount;
}

function assertCny(currency: string, decimals: number) {
	if (currency !== "CNY" || decimals !== 2)
		throw new DomainError(
			"payment_currency_unsupported",
			400,
			"WeChat Pay requires CNY with two decimal places",
		);
}
