import { describe, expect, it, vi } from "vitest";
import { epayPaymentProvider } from "#/features/shop-payments/providers/epay";
import {
	signEpusdt,
	signGmpay,
} from "#/features/shop-payments/providers/epusdt";
import { gmpayPaymentProvider } from "#/features/shop-payments/providers/gmpay";
import { stripePaymentProvider } from "#/features/shop-payments/providers/stripe";
import { hmacSha256Hex } from "#/features/shop-payments/signature";

describe("shop payment providers", () => {
	it("presents ZPay checkout URLs as QR codes", () => {
		expect(epayPaymentProvider.checkoutPresentation).toBe("qr");
	});

	it("matches the current GMPay HMAC-SHA256 signature vector", async () => {
		await expect(
			signGmpay(
				{
					pid: "gmp_merchant",
					order_id: "ORDER-1001",
					currency: "cny",
					token: "usdt",
					network: "tron",
					amount: "100",
					notify_url: "https://merchant.example/notify",
					redirect_url: "",
				},
				"merchant-secret",
			),
		).resolves.toBe(
			"c6e53cbcc50ed62160c4e9689bb5d266376baa2b15a2c054db88350f2f20f4b3",
		);
	});

	it("creates GMPay transactions with exact minor-unit conversion", async () => {
		const fetcher = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				const body = new URLSearchParams(String(init?.body));
				expect(body.has("type")).toBe(false);
				expect(body.has("payment_type")).toBe(false);
				expect(body.get("amount")).toBe("12.345");
				expect(body.get("currency")).toBe("KWD");
				expect(body.get("token")).toBe("usdt");
				expect(body.get("network")).toBe("tron");
				expect(body.get("order_id")).toBe("11111111111141118111111111111111");
				expect(body.get("signature")).toBe(
					await signGmpay(Object.fromEntries(body), "epusdt_secret_key"),
				);
				return Response.json({
					status_code: 200,
					message: "success",
					data: {
						trade_id: "trade-gmpay-1",
						payment_url: "https://pay.example.com/cashier/trade-gmpay-1",
						expiration_time: 1_800_000_000,
					},
				});
			},
		);
		await expect(
			gmpayPaymentProvider.createPayment(
				paymentInput({
					amountMinor: "12345",
					currency: "KWD",
					currencyDecimals: 3,
					defaultToken: "usdt",
					defaultNetwork: "tron",
				}),
				epusdtCredential(),
				fetcher,
			),
		).resolves.toEqual({
			providerPaymentId: "trade-gmpay-1",
			checkoutUrl: "https://pay.example.com/cashier/trade-gmpay-1",
			expiresAt: 1_800_000_000_000,
		});
	});

	it("verifies GMPay JSON callbacks and preserves signed decimal money", async () => {
		const params = {
			pid: "1000",
			trade_id: "trade-gmpay-1",
			order_id: "11111111111141118111111111111111",
			amount: 12.345,
			actual_amount: 1.2,
			receive_address: "TAddress",
			token: "USDT",
			block_transaction_id: "0xabc",
			status: "paid",
		};
		const strings = Object.fromEntries(
			Object.entries(params).map(([key, value]) => [key, String(value)]),
		);
		const body = JSON.stringify({
			...params,
			signature: await signGmpay(strings, "epusdt_secret_key"),
		});
		await expect(
			gmpayPaymentProvider.parseWebhook(
				new Request("https://shop.example/webhook", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body,
				}),
				epusdtCredential(),
			),
		).resolves.toMatchObject({
			providerPaymentId: "trade-gmpay-1",
			type: "payment_succeeded",
			amountMinor: null,
			amountDecimal: "12.345",
			merchantOrderId: "11111111111141118111111111111111",
		});
	});

	it("accepts the numeric paid status emitted by GMPay Edge callbacks", async () => {
		const params = {
			pid: "1000",
			trade_id: "trade-gmpay-numeric-paid",
			order_id: "11111111111141118111111111111111",
			amount: "630",
			actual_amount: "92.9171",
			block_transaction_id: "0xabc",
			status: "2",
		};
		const body = JSON.stringify({
			...params,
			status: 2,
			signature: await signGmpay(params, "epusdt_secret_key"),
		});
		await expect(
			gmpayPaymentProvider.parseWebhook(
				new Request("https://shop.example/webhook", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body,
				}),
				epusdtCredential(),
			),
		).resolves.toMatchObject({
			providerPaymentId: "trade-gmpay-numeric-paid",
			type: "payment_succeeded",
		});
	});

	it("accepts the numeric paid status returned by GMPay Edge queries", async () => {
		const fetcher = vi.fn(async () =>
			Response.json({
				status_code: 200,
				message: "success",
				data: {
					trade_id: "trade-gmpay-numeric-paid",
					order_id: "11111111111141118111111111111111",
					amount: "630",
					currency: "CNY",
					status: 2,
					status_detail: "paid",
				},
			}),
		);
		await expect(
			gmpayPaymentProvider.queryPayment(
				"trade-gmpay-numeric-paid",
				epusdtCredential(),
				fetcher,
			),
		).resolves.toMatchObject({ status: "succeeded", currency: "CNY" });
	});

	it.each([
		"pending",
		"confirming",
		"partially_paid",
	] as const)("keeps GMPay %s callbacks pending instead of failing the payment", async (status) => {
		const params = {
			pid: "1000",
			trade_id: `trade-gmpay-${status}`,
			order_id: "11111111111141118111111111111111",
			amount: "12.345",
			actual_amount: status === "partially_paid" ? "1.2" : "0",
			block_transaction_id: "",
			status,
		};
		const body = JSON.stringify({
			...params,
			signature: await signGmpay(params, "epusdt_secret_key"),
		});
		await expect(
			gmpayPaymentProvider.parseWebhook(
				new Request("https://shop.example/webhook", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body,
				}),
				epusdtCredential(),
			),
		).resolves.toMatchObject({ type: "payment_pending" });
	});

	it("creates standard ZPay orders and verifies its callback", async () => {
		const fetcher = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe("https://pay.example.com/mapi.php");
				expect(init?.body).toBeInstanceOf(FormData);
				const body = init?.body as FormData;
				expect(body.get("type")).toBe("wxpay");
				expect(body.get("name")).toBe("老实人AI 额度");
				expect(body.get("clientip")).toBe("203.0.113.9");
				expect(body.get("sign_type")).toBe("MD5");
				return Response.json({
					code: 1,
					msg: "success",
					trade_no: "trade-epay-1",
					payurl2: "https://pay.example.com/pay/trade-epay-1",
				});
			},
		);
		await expect(
			epayPaymentProvider.createPayment(
				paymentInput({ payerIp: "203.0.113.9" }),
				{ ...epusdtCredential(), paymentMethod: "wxpay" },
				fetcher,
			),
		).resolves.toEqual({
			providerPaymentId: "trade-epay-1:11111111111141118111111111111111",
			checkoutUrl: "https://pay.example.com/pay/trade-epay-1",
			expiresAt: null,
		});

		const callback = {
			pid: "1000",
			trade_no: "trade-epay-1",
			out_trade_no: "11111111111141118111111111111111",
			type: "alipay",
			name: "Order GM100001",
			money: "123.4500",
			trade_status: "TRADE_SUCCESS",
			sign_type: "MD5",
		};
		const query = new URLSearchParams({
			...callback,
			sign: signEpusdt(
				callback,
				"epusdt_secret_key",
				new Set(["sign", "sign_type"]),
			),
		});
		await expect(
			epayPaymentProvider.parseWebhook(
				new Request(`https://shop.example/webhook?${query}`),
				epusdtCredential(),
			),
		).resolves.toMatchObject({
			providerPaymentId: "trade-epay-1:11111111111141118111111111111111",
			amountDecimal: "123.4500",
			currency: "CNY",
			merchantOrderId: "11111111111141118111111111111111",
		});
	});

	it("refuses an EPay order in any currency but CNY", async () => {
		const fetcher = vi.fn();
		await expect(
			epayPaymentProvider.createPayment(
				paymentInput({ payerIp: "203.0.113.9", currency: "USD" }),
				{ ...epusdtCredential(), paymentMethod: "alipay" },
				fetcher,
			),
		).rejects.toMatchObject({ code: "payment_currency_unsupported" });
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("keeps generic EPay refunds manual and enables only the exact ZPAY origin", () => {
		expect(
			epayPaymentProvider.refundModeForCredential?.({
				...epusdtCredential(),
				paymentMethod: "alipay",
			}),
		).toBe("manual");
		expect(
			epayPaymentProvider.refundModeForCredential?.({
				...epusdtCredential(),
				baseUrl: "https://zpayz.cn",
				paymentMethod: "alipay",
			}),
		).toBe("automatic");
	});

	it("preflights and submits a full ZPAY original-route refund", async () => {
		const fetcher = vi
			.fn()
			.mockImplementationOnce(async (input: RequestInfo | URL) => {
				const url = new URL(String(input));
				expect(url.pathname).toBe("/api.php");
				expect(url.searchParams.get("act")).toBe("order");
				expect(url.searchParams.get("out_trade_no")).toBe("merchant-order-1");
				return Response.json({
					code: 1,
					status: 1,
					trade_no: "trade-zpay-1",
					out_trade_no: "merchant-order-1",
					type: "alipay",
					money: "123.45",
				});
			})
			.mockImplementationOnce(
				async (input: RequestInfo | URL, init?: RequestInit) => {
					const url = new URL(String(input));
					expect(url.pathname).toBe("/api.php");
					expect(url.searchParams.get("act")).toBe("refund");
					const body = new URLSearchParams(String(init?.body));
					expect(body.get("trade_no")).toBe("trade-zpay-1");
					expect(body.get("money")).toBe("123.45");
					return Response.json({ code: 1, msg: "退款成功" });
				},
			);
		await expect(
			epayPaymentProvider.refundPayment(
				{
					refundId: "refund-zpay-1",
					providerPaymentId: "create-response-id:merchant-order-1",
					amountMinor: "12345",
					reason: "Customer refund",
				},
				{
					...epusdtCredential(),
					baseUrl: "https://zpayz.cn",
					paymentMethod: "alipay",
				},
				fetcher,
			),
		).resolves.toEqual({
			providerRefundId: "zpay:trade-zpay-1",
			status: "succeeded",
			failureCode: null,
		});
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it("stops ZPAY refund retries when the provider result is ambiguous", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json({
					code: 1,
					status: 1,
					trade_no: "trade-zpay-1",
					out_trade_no: "merchant-order-1",
					type: "alipay",
					money: "123.45",
				}),
			)
			.mockRejectedValueOnce(new TypeError("network closed"));
		await expect(
			epayPaymentProvider.refundPayment(
				{
					refundId: "refund-zpay-1",
					providerPaymentId: "create-response-id:merchant-order-1",
					amountMinor: "12345",
					reason: "Customer refund",
				},
				{
					...epusdtCredential(),
					baseUrl: "https://zpayz.cn",
					paymentMethod: "alipay",
				},
				fetcher,
			),
		).rejects.toMatchObject({
			code: "payment_refund_reconciliation_required",
		});
	});

	it("rejects a modified Stripe callback payload", async () => {
		const timestamp = 1_700_000_000;
		const webhookSecret = "whsec_test-secret";
		const signature = await hmacSha256Hex(
			webhookSecret,
			`${timestamp}.original`,
		);
		await expect(
			stripePaymentProvider.parseWebhook(
				new Request("https://shop.test/webhook", {
					method: "POST",
					headers: { "stripe-signature": `t=${timestamp},v1=${signature}` },
					body: "modified",
				}),
				{ secretKey: "sk_test_key", webhookSecret },
				timestamp * 1000,
			),
		).rejects.toMatchObject({ code: "invalid_payment_signature" });
	});

	it("rejects a chunked oversized payment callback before signature work", async () => {
		const request = new Request("https://shop.test/webhook", {
			method: "POST",
			headers: { "stripe-signature": "t=1700000000,v1=invalid" },
			body: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array(40_000));
					controller.enqueue(new Uint8Array(40_000));
					controller.close();
				},
			}),
			duplex: "half",
		} as RequestInit & { duplex: "half" });
		await expect(
			stripePaymentProvider.parseWebhook(
				request,
				{ secretKey: "sk_test_key", webhookSecret: "whsec_test-secret" },
				1_700_000_000_000,
			),
		).rejects.toMatchObject({ code: "payment_webhook_too_large", status: 413 });
	});

	it("creates Stripe refunds through the fixed idempotent provider boundary", async () => {
		const fetcher = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/v1/checkout/sessions/cs_test_1"))
					return Response.json({
						id: "cs_test_1",
						status: "complete",
						payment_status: "paid",
						amount_total: 1200,
						currency: "usd",
						payment_intent: "pi_test_1",
					});
				expect(url).toBe("https://api.stripe.com/v1/refunds");
				const headers = new Headers(init?.headers);
				expect(headers.get("Idempotency-Key")).toBe("refund-id-1");
				expect(String(init?.body)).toContain("payment_intent=pi_test_1");
				expect(String(init?.body)).toContain("amount=1200");
				return Response.json({
					id: "re_test_1",
					status: "succeeded",
					failure_reason: null,
				});
			},
		);
		await expect(
			stripePaymentProvider.refundPayment(
				{
					refundId: "refund-id-1",
					providerPaymentId: "cs_test_1",
					amountMinor: "1200",
					reason: "Customer request",
				},
				{ secretKey: "sk_test_key", webhookSecret: "whsec_test-secret" },
				fetcher,
			),
		).resolves.toEqual({
			providerRefundId: "re_test_1",
			status: "succeeded",
			failureCode: null,
		});
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
});

function epusdtCredential() {
	return {
		baseUrl: "https://pay.example.com",
		pid: "1000",
		secretKey: "epusdt_secret_key",
	};
}

function paymentInput(
	overrides: Partial<
		Parameters<typeof gmpayPaymentProvider.createPayment>[0]
	> = {},
) {
	return {
		attemptId: "11111111-1111-4111-8111-111111111111",
		orderId: "22222222-2222-4222-8222-222222222222",
		orderNumber: "GM100001",
		amountMinor: "12345",
		currency: "CNY",
		currencyDecimals: 2,
		customerEmail: "customer@example.com",
		description: "Order GM100001",
		successUrl: "https://shop.example/orders/GM100001",
		cancelUrl: "https://shop.example/pay/GM100001",
		webhookUrl: "https://shop.example/api/shop/payments/channel/webhook",
		defaultToken: "",
		defaultNetwork: "",
		...overrides,
		payerIp: overrides.payerIp ?? null,
	};
}
