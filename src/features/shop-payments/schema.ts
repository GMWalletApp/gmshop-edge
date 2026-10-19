import { z } from "zod";
import {
	alipayCredentialSchema,
	cryptomusCredentialSchema,
	epayCredentialSchema,
	gmpayCredentialSchema,
	paymentProviderValues,
	stripeCredentialSchema,
	wechatCredentialSchema,
} from "#/features/shop-payments/provider";

const idSchema = z.uuid();

export const paymentChannelListSchema = z.object({
	pageIndex: z.number().int().min(0).default(0),
	pageSize: z.number().int().min(1).max(100).default(10),
	search: z.string().trim().max(200).default(""),
});

export const paymentChannelInputSchema = z
	.object({
		id: idSchema.optional(),
		provider: z.enum(paymentProviderValues),
		name: z.string().trim().min(1).max(120),
		currency: z
			.string()
			.trim()
			.toUpperCase()
			.regex(/^[A-Z]{3}$/),
		defaultToken: z.string().trim().toLowerCase().max(40).default(""),
		defaultNetwork: z.string().trim().toLowerCase().max(40).default(""),
		feeBps: z.number().int().min(0).max(10_000),
		fixedFeeMinor: z.string().trim().regex(/^\d+$/).max(40),
		sortOrder: z.number().int().min(0).max(1_000_000),
		enabled: z.boolean(),
		stripeSecretKey: z.string().trim().max(512).optional(),
		stripeWebhookSecret: z.string().trim().max(512).optional(),
		cryptomusMerchantId: z.string().trim().max(64).optional(),
		cryptomusPaymentApiKey: z.string().trim().max(512).optional(),
		epusdtBaseUrl: z.string().trim().max(2_048).optional(),
		epusdtPid: z.string().trim().max(80).optional(),
		epusdtSecretKey: z.string().max(512).optional(),
		epusdtPaymentMethod: z
			.string()
			.trim()
			.toLowerCase()
			.regex(/^(?:[a-z][a-z0-9_-]{0,39})?$/)
			.default(""),
		alipayAppId: z.string().trim().max(32).optional(),
		alipaySellerId: z.string().trim().max(32).optional(),
		alipayPrivateKeyPem: z.string().max(8_192).optional(),
		alipayPublicKeyPem: z.string().max(8_192).optional(),
		wechatAppId: z.string().trim().max(32).optional(),
		wechatMchId: z.string().trim().max(32).optional(),
		wechatMerchantSerialNumber: z.string().trim().max(128).optional(),
		wechatMerchantPrivateKeyPem: z.string().max(8_192).optional(),
		wechatApiV3Key: z.string().max(64).optional(),
		wechatPlatformSerialNumber: z.string().trim().max(128).optional(),
		wechatPlatformPublicKeyPem: z.string().max(8_192).optional(),
	})
	.superRefine((value, context) => {
		if (Boolean(value.defaultToken) !== Boolean(value.defaultNetwork))
			context.addIssue({
				code: "custom",
				path: value.defaultToken ? ["defaultNetwork"] : ["defaultToken"],
				message: "Default token and network must be configured together",
			});
		const changingCryptomus = Boolean(
			value.cryptomusMerchantId || value.cryptomusPaymentApiKey,
		);
		if (value.provider === "cryptomus") {
			if (!value.id || changingCryptomus)
				addCredentialIssues(
					cryptomusCredentialSchema.safeParse({
						merchantId: value.cryptomusMerchantId,
						paymentApiKey: value.cryptomusPaymentApiKey,
					}),
					{
						merchantId: "cryptomusMerchantId",
						paymentApiKey: "cryptomusPaymentApiKey",
					},
					context,
				);
			return;
		}
		const changingStripe =
			Boolean(value.stripeSecretKey) || Boolean(value.stripeWebhookSecret);
		if (value.provider === "stripe") {
			if (!value.id || changingStripe)
				addCredentialIssues(
					stripeCredentialSchema.safeParse({
						secretKey: value.stripeSecretKey,
						webhookSecret: value.stripeWebhookSecret,
					}),
					{
						secretKey: "stripeSecretKey",
						webhookSecret: "stripeWebhookSecret",
					},
					context,
				);
			return;
		}
		if (
			["alipay_page", "alipay_wap", "wechat_native", "wechat_h5"].includes(
				value.provider,
			) &&
			value.currency !== "CNY"
		)
			context.addIssue({
				code: "custom",
				path: ["currency"],
				message: "This provider requires CNY",
			});
		if (value.provider === "alipay_page" || value.provider === "alipay_wap") {
			const changingCredential = Boolean(
				value.alipayAppId ||
					value.alipaySellerId ||
					value.alipayPrivateKeyPem ||
					value.alipayPublicKeyPem,
			);
			if (!value.id || changingCredential)
				addCredentialIssues(
					alipayCredentialSchema.safeParse({
						appId: value.alipayAppId,
						sellerId: value.alipaySellerId,
						privateKeyPem: value.alipayPrivateKeyPem,
						alipayPublicKeyPem: value.alipayPublicKeyPem,
					}),
					{
						appId: "alipayAppId",
						sellerId: "alipaySellerId",
						privateKeyPem: "alipayPrivateKeyPem",
						alipayPublicKeyPem: "alipayPublicKeyPem",
					},
					context,
				);
			return;
		}
		if (value.provider === "wechat_native" || value.provider === "wechat_h5") {
			const changingCredential = Boolean(
				value.wechatAppId ||
					value.wechatMchId ||
					value.wechatMerchantSerialNumber ||
					value.wechatMerchantPrivateKeyPem ||
					value.wechatApiV3Key ||
					value.wechatPlatformSerialNumber ||
					value.wechatPlatformPublicKeyPem,
			);
			if (!value.id || changingCredential)
				addCredentialIssues(
					wechatCredentialSchema.safeParse({
						appId: value.wechatAppId,
						mchId: value.wechatMchId,
						merchantSerialNumber: value.wechatMerchantSerialNumber,
						merchantPrivateKeyPem: value.wechatMerchantPrivateKeyPem,
						apiV3Key: value.wechatApiV3Key,
						platformSerialNumber: value.wechatPlatformSerialNumber,
						platformPublicKeyPem: value.wechatPlatformPublicKeyPem,
					}),
					{
						appId: "wechatAppId",
						mchId: "wechatMchId",
						merchantSerialNumber: "wechatMerchantSerialNumber",
						merchantPrivateKeyPem: "wechatMerchantPrivateKeyPem",
						apiV3Key: "wechatApiV3Key",
						platformSerialNumber: "wechatPlatformSerialNumber",
						platformPublicKeyPem: "wechatPlatformPublicKeyPem",
					},
					context,
				);
			return;
		}
		const changingEpusdt = Boolean(
			value.epusdtBaseUrl || value.epusdtPid || value.epusdtSecretKey,
		);
		if (!value.id || changingEpusdt) {
			const schema =
				value.provider === "gmpay"
					? gmpayCredentialSchema
					: epayCredentialSchema;
			addCredentialIssues(
				schema.safeParse({
					baseUrl: value.epusdtBaseUrl,
					pid: value.epusdtPid,
					secretKey: value.epusdtSecretKey,
					paymentMethod: value.epusdtPaymentMethod,
				}),
				{
					baseUrl: "epusdtBaseUrl",
					pid: "epusdtPid",
					secretKey: "epusdtSecretKey",
					paymentMethod: "epusdtPaymentMethod",
				},
				context,
			);
			// New configuration only: stored channels keep working at payment time.
			if (value.epusdtBaseUrl && URL.parse(value.epusdtBaseUrl)?.port)
				context.addIssue({
					code: "custom",
					path: ["epusdtBaseUrl"],
					message: "Payment service URLs cannot use a custom port",
				});
		}
	});

type CredentialParseResult =
	| { success: true }
	| {
			success: false;
			error: { issues: readonly { path: PropertyKey[]; message: string }[] };
	  };

function addCredentialIssues(
	result: CredentialParseResult,
	fieldNames: Record<string, string>,
	context: z.RefinementCtx,
) {
	if (result.success) return;
	for (const issue of result.error.issues) {
		const credentialField = issue.path[0];
		const field =
			typeof credentialField === "string"
				? fieldNames[credentialField]
				: undefined;
		if (!field) continue;
		context.addIssue({
			code: "custom",
			path: [field],
			message: issue.message,
		});
	}
}

export const paymentChannelIdSchema = z.object({ id: idSchema });
export const paymentChannelOrderSchema = z.object({
	ids: z
		.array(idSchema)
		.min(1)
		.max(100)
		.refine((ids) => new Set(ids).size === ids.length),
});
export const paymentChannelEnabledSchema = z.object({
	id: idSchema,
	enabled: z.boolean(),
});
