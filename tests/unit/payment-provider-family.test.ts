import { describe, expect, it } from "vitest";
import { paymentChannelFormErrors } from "#/features/shop-payments/form-validation";
import {
	paymentProviderDefaultCurrency,
	paymentProviderFamily,
} from "#/features/shop-payments/provider";
import { paymentCheckoutPresentation } from "#/features/shop-payments/providers";
import { paymentChannelInputSchema } from "#/features/shop-payments/schema";
import { m } from "#/paraglide/messages";

describe("payment provider families", () => {
	it("groups Alipay and WeChat integration modes under one payment type", () => {
		expect(paymentProviderFamily("alipay_page")).toBe("alipay");
		expect(paymentProviderFamily("alipay_wap")).toBe("alipay");
		expect(paymentProviderFamily("wechat_native")).toBe("wechat");
		expect(paymentProviderFamily("wechat_h5")).toBe("wechat");
	});

	it("keeps standalone payment types unchanged", () => {
		expect(paymentProviderFamily("stripe")).toBe("stripe");
		expect(paymentProviderFamily("cryptomus")).toBe("cryptomus");
		expect(paymentProviderFamily("gmpay")).toBe("gmpay");
		expect(paymentProviderFamily("epay")).toBe("epay");
	});

	it("defaults China payment families to CNY", () => {
		expect(paymentProviderDefaultCurrency("alipay_page", "USD")).toBe("CNY");
		expect(paymentProviderDefaultCurrency("wechat_native", "EUR")).toBe("CNY");
		expect(paymentProviderDefaultCurrency("stripe", "EUR")).toBe("EUR");
	});

	it("declares checkout presentation as a provider capability", () => {
		expect(paymentCheckoutPresentation("wechat_native")).toBe("qr");
		for (const provider of [
			"stripe",
			"cryptomus",
			"gmpay",
			"alipay_page",
			"alipay_wap",
		])
			expect(paymentCheckoutPresentation(provider)).toBe("redirect");
		expect(paymentCheckoutPresentation("epay")).toBe("qr");
		expect(paymentCheckoutPresentation("wechat_native")).toBe("qr");
		expect(paymentCheckoutPresentation("wechat_h5")).toBe("qr");
		expect(
			paymentCheckoutPresentation(
				"wechat_native",
				"https://wx.tenpay.com/mobile-checkout",
			),
		).toBe("redirect");
		expect(
			paymentCheckoutPresentation(
				"wechat_native",
				"weixin://wxpay/bizpayurl?pr=fixture",
			),
		).toBe("qr");
	});

	it("requires Cryptomus credentials on create and permits blank encrypted edits", () => {
		const input = {
			provider: "cryptomus" as const,
			name: "Cryptomus",
			currency: "USD",
			defaultToken: "",
			defaultNetwork: "",
			feeBps: 40,
			fixedFeeMinor: "0",
			sortOrder: 100,
			enabled: false,
			cryptomusMerchantId: "",
			cryptomusPaymentApiKey: "",
		};
		expect(paymentChannelInputSchema.safeParse(input).success).toBe(false);
		expect(
			paymentChannelInputSchema.safeParse({
				...input,
				id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			}).success,
		).toBe(true);
		expect(
			paymentChannelInputSchema.safeParse({
				...input,
				cryptomusMerchantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
				cryptomusPaymentApiKey: "payment-api-key",
			}).success,
		).toBe(true);
	});

	it("returns provider-specific field errors before a payment request is sent", () => {
		const common = {
			name: "Payment",
			currency: "USD",
			defaultToken: "",
			defaultNetwork: "",
			feeBps: 0,
			fixedFeeMinor: "0",
			sortOrder: 100,
			enabled: false,
			epusdtPaymentMethod: "alipay",
		};
		expect(
			paymentChannelFormErrors({
				...common,
				provider: "gmpay",
				epusdtBaseUrl: "https://baidu.com",
				epusdtPid: "12345",
				epusdtSecretKey: "123456",
			}),
		).toMatchObject({
			epusdtSecretKey: [m.payment_channels_validation_secret_length()],
		});
		for (const epusdtBaseUrl of [
			"http://pay.example.com",
			"https://10.0.0.8",
			"https://pay.internal",
			"https://pay.example.com:8443",
		])
			expect(
				paymentChannelFormErrors({
					...common,
					provider: "gmpay",
					epusdtBaseUrl,
					epusdtPid: "12345",
					epusdtSecretKey: "12345678",
				}),
			).toMatchObject({
				epusdtBaseUrl: [m.payment_channels_validation_service_url()],
			});
		expect(
			paymentChannelFormErrors({
				...common,
				provider: "gmpay",
				epusdtBaseUrl: "https://pay.example.com:443",
				epusdtPid: "12345",
				epusdtSecretKey: "12345678",
			}),
		).not.toHaveProperty("epusdtBaseUrl");
		expect(
			paymentChannelFormErrors({
				...common,
				provider: "epay",
				epusdtBaseUrl: "https://example.com",
				epusdtPid: "merchant",
				epusdtSecretKey: "12345678",
			}),
		).toMatchObject({
			epusdtPid: [m.payment_channels_validation_epay_pid()],
		});
		expect(
			paymentChannelFormErrors({
				...common,
				provider: "stripe",
				stripeSecretKey: "secret",
				stripeWebhookSecret: "webhook",
			}),
		).toMatchObject({
			stripeSecretKey: [m.payment_channels_validation_stripe_secret()],
			stripeWebhookSecret: [m.payment_channels_validation_stripe_webhook()],
		});
		expect(
			paymentChannelFormErrors({
				...common,
				provider: "alipay_page",
				alipayAppId: "1234567890123456",
				alipaySellerId: "1234567890123456",
				alipayPrivateKeyPem: "PRIVATE KEY",
				alipayPublicKeyPem: "PUBLIC KEY",
			}),
		).toMatchObject({
			currency: [m.payment_channels_validation_cny_currency()],
		});
	});
});
