import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
	cryptomusPaymentProvider,
	cryptomusSign,
} from "#/features/shop-payments/providers/cryptomus";

const merchantId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const paymentApiKey = "cryptomus-payment-api-key";
const credential = { merchantId, paymentApiKey };
const webhookFixture = JSON.parse(
	readFileSync(
		new URL(
			"../fixtures/providers/cryptomus-payment-webhook.json",
			import.meta.url,
		),
		"utf8",
	),
) as Record<string, unknown>;

describe("Cryptomus payment provider", () => {
	it("signs and creates an exact hosted invoice with an optional fixed asset", async () => {
		const fetcher = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				const body = String(init?.body);
				const headers = new Headers(init?.headers);
				expect(headers.get("merchant")).toBe(merchantId);
				expect(headers.get("sign")).toBe(referenceSign(body));
				expect(JSON.parse(body)).toEqual({
					amount: "123.45",
					currency: "CNY",
					order_id: "11111111-1111-4111-8111-111111111111",
					url_callback:
						"https://shop.example/api/shop/payments/channel/webhook",
					url_return: "https://shop.example/pay/GM100001",
					url_success: "https://shop.example/orders/GM100001",
					to_currency: "USDT",
					network: "tron",
				});
				return invoiceResponse("check");
			},
		);

		await expect(
			cryptomusPaymentProvider.createPayment(
				paymentInput({ defaultToken: "usdt", defaultNetwork: "TRON" }),
				credential,
				fetcher,
			),
		).resolves.toEqual({
			providerPaymentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			checkoutUrl:
				"https://pay.cryptomus.com/pay/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			expiresAt: 1_900_000_000_000,
		});
	});

	it("omits asset restrictions when the hosted cashier should offer all assets", async () => {
		const fetcher = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				const payload = JSON.parse(String(init?.body)) as Record<
					string,
					unknown
				>;
				expect(payload).not.toHaveProperty("to_currency");
				expect(payload).not.toHaveProperty("network");
				return invoiceResponse("check");
			},
		);
		await cryptomusPaymentProvider.createPayment(
			paymentInput(),
			credential,
			fetcher,
		);
	});

	it.each([
		["paid", "succeeded"],
		["paid_over", "succeeded"],
		["wrong_amount", "failed"],
		["fail", "failed"],
		["system_fail", "failed"],
		["cancel", "expired"],
		["confirm_check", "pending"],
		["future_status", "pending"],
	] as const)(
		"maps queried %s status to %s",
		async (paymentStatus, expected) => {
			const fetcher = vi.fn(async () => invoiceResponse(paymentStatus));
			await expect(
				cryptomusPaymentProvider.queryPayment(
					"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
					credential,
					fetcher,
				),
			).resolves.toMatchObject({ status: expected, currency: "CNY" });
		},
	);

	it("rejects a query response for a different invoice", async () => {
		const fetcher = vi.fn(async () => {
			const response = (await invoiceResponse("paid").json()) as {
				state: number;
				result: Record<string, unknown>;
			};
			return Response.json({
				...response,
				result: {
					...response.result,
					uuid: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
				},
			});
		});
		await expect(
			cryptomusPaymentProvider.queryPayment(
				"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
				credential,
				fetcher,
			),
		).rejects.toMatchObject({ code: "payment_provider_invalid_response" });
	});

	it.each([
		["paid", "payment_succeeded"],
		["paid_over", "payment_succeeded"],
		["wrong_amount", "payment_failed"],
		["cancel", "payment_expired"],
		["confirm_check", "payment_pending"],
	] as const)("verifies and maps %s webhooks", async (status, expectedType) => {
		const body = signedWebhook(status);
		await expect(
			cryptomusPaymentProvider.parseWebhook(
				new Request("https://shop.example/webhook", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body,
				}),
				credential,
			),
		).resolves.toMatchObject({
			providerPaymentId: webhookFixture.uuid,
			type: expectedType,
			amountDecimal: "123.45",
			currency: "CNY",
			merchantOrderId: webhookFixture.order_id,
		});
	});

	it("rejects modified, oversized, and non-JSON callbacks", async () => {
		const modified = signedWebhook("paid").replace("123.45", "1.00");
		await expect(parseWebhook(modified)).rejects.toMatchObject({
			code: "invalid_payment_signature",
		});
		await expect(
			parseWebhook("x".repeat(65_537), "application/json"),
		).rejects.toMatchObject({ code: "payment_webhook_too_large", status: 413 });
		await expect(parseWebhook("{}", "text/plain")).rejects.toMatchObject({
			code: "invalid_payment_callback",
		});
	});

	it("uses the documented MD5 base64 request signature", () => {
		expect(cryptomusSign("{}", paymentApiKey)).toBe(referenceSign("{}"));
	});

	it("checks merchant connectivity with a signed services request", async () => {
		const fetcher = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe(
					"https://api.cryptomus.com/v1/payment/services",
				);
				expect(String(init?.body)).toBe("{}");
				expect(new Headers(init?.headers).get("sign")).toBe(
					referenceSign("{}"),
				);
				return Response.json({ state: 0, result: [] });
			},
		);
		await expect(
			cryptomusPaymentProvider.checkHealth(credential, fetcher),
		).resolves.toBeUndefined();
	});

	it("keeps refunds in the external manual workflow", async () => {
		await expect(
			cryptomusPaymentProvider.refundPayment(
				{
					refundId: "refund-1",
					providerPaymentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
					amountMinor: "12345",
					reason: "Customer request",
				},
				credential,
			),
		).rejects.toMatchObject({ code: "payment_refund_manual_required" });
	});

	it("verifies the PHP json_encode canonical form, which escapes slashes", async () => {
		const unsigned = {
			...webhookFixture,
			additional_data: "https://shop.example/orders/GM100001",
		};
		const phpCanonical = JSON.stringify(unsigned).replaceAll("/", "\\/");
		const body = JSON.stringify({
			...unsigned,
			sign: cryptomusSign(phpCanonical, paymentApiKey),
		});
		await expect(parseWebhook(body)).resolves.toMatchObject({
			type: "payment_succeeded",
		});
	});

	it("accepts the plain JSON canonical form for gateways that do not escape slashes", async () => {
		const unsigned = {
			...webhookFixture,
			additional_data: "https://shop.example/orders/GM100001",
		};
		const body = JSON.stringify({
			...unsigned,
			sign: cryptomusSign(JSON.stringify(unsigned), paymentApiKey),
		});
		await expect(parseWebhook(body)).resolves.toMatchObject({
			type: "payment_succeeded",
		});
	});

	it("rejects a signature computed over a corrupted canonical form", async () => {
		const unsigned = {
			...webhookFixture,
			additional_data: "folder\\item",
		};
		const corrupted = JSON.stringify(unsigned).replaceAll("\\", "/");
		const body = JSON.stringify({
			...unsigned,
			sign: cryptomusSign(corrupted, paymentApiKey),
		});
		await expect(parseWebhook(body)).rejects.toMatchObject({
			code: "invalid_payment_signature",
		});
	});
});

function signedWebhook(status: string) {
	const unsigned = { ...webhookFixture, status };
	return JSON.stringify({
		...unsigned,
		sign: cryptomusSign(JSON.stringify(unsigned), paymentApiKey),
	});
}

function parseWebhook(body: string, contentType = "application/json") {
	return cryptomusPaymentProvider.parseWebhook(
		new Request("https://shop.example/webhook", {
			method: "POST",
			headers: { "content-type": contentType },
			body,
		}),
		credential,
	);
}

function referenceSign(body: string) {
	return createHash("md5")
		.update(`${Buffer.from(body).toString("base64")}${paymentApiKey}`)
		.digest("hex");
}

function invoiceResponse(paymentStatus: string) {
	return Response.json({
		state: 0,
		result: {
			uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			order_id: "11111111-1111-4111-8111-111111111111",
			amount: "123.45",
			currency: "CNY",
			payment_status: paymentStatus,
			url: "https://pay.cryptomus.com/pay/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			expired_at: 1_900_000_000,
		},
	});
}

function paymentInput(overrides: Record<string, unknown> = {}) {
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
		payerIp: null,
		...overrides,
	};
}
