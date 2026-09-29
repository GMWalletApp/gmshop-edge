import { md5 } from "@noble/hashes/legacy.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { z } from "zod";
import type {
	PaymentProviderAdapter,
	PaymentQuery,
} from "#/features/shop-payments/provider";
import {
	constantTimeEqual,
	hmacSha256Hex,
} from "#/features/shop-payments/signature";
import { DomainError } from "#/lib/domain-error";
import {
	fetchOutbound,
	type OutboundFetchOptions,
} from "#/server/outbound-fetch";

const encoder = new TextEncoder();

/**
 * Requests to operator-configured Epusdt-compatible gateways go through the
 * hardened outbound client: no redirects, bounded responses, and (outside
 * Workers) a public-address proof. Injected fetchers (tests) skip the DNS proof.
 */
export function epusdtFetch(
	url: string | URL,
	init: RequestInit,
	fetcher: typeof fetch,
	options: Pick<OutboundFetchOptions, "expectRedirect"> = {},
) {
	return fetchOutbound(url, init, {
		...options,
		fetcher,
		maxResponseBytes: 256 * 1024,
		validateDestination: fetcher === fetch,
	});
}

const statusResponseSchema = z.object({
	status_code: z.literal(200),
	data: z.object({
		trade_id: z.string().min(1),
		status: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
	}),
});

const healthResponseSchema = z.object({ status_code: z.literal(200) });

export type EpusdtCredential = {
	baseUrl: string;
	pid: string;
	secretKey: string;
};

export function epusdtUrl(baseUrl: string, pathname: string) {
	return new URL(pathname, `${baseUrl}/`).toString();
}

export function epusdtMerchantOrderId(attemptId: string) {
	return attemptId.replaceAll("-", "").slice(0, 32);
}

export function signEpusdt(
	params: Record<string, string>,
	secretKey: string,
	excluded: ReadonlySet<string>,
) {
	const canonical = Object.entries(params)
		.filter(([key, value]) => value !== "" && !excluded.has(key))
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(([key, value]) => `${key}=${value}`)
		.join("&");
	return bytesToHex(
		md5(encoder.encode(`${canonical}${secretKey}`)),
	).toLowerCase();
}

export function gmpaySignaturePayload(
	params: Record<string, string>,
	excluded = new Set(["signature"]),
) {
	return Object.entries(params)
		.filter(([key, value]) => value !== "" && !excluded.has(key))
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(([key, value]) => `${key}=${value}`)
		.join("&");
}

export function signGmpay(
	params: Record<string, string>,
	secretKey: string,
	excluded = new Set(["signature"]),
) {
	return hmacSha256Hex(secretKey, gmpaySignaturePayload(params, excluded));
}

export async function verifyGmpaySignature(
	params: Record<string, string>,
	secretKey: string,
) {
	const provided = params.signature ?? "";
	const expected = await signGmpay(params, secretKey);
	if (!provided || !constantTimeEqual(provided.toLowerCase(), expected))
		throw new DomainError(
			"invalid_payment_signature",
			401,
			"Invalid signature",
		);
}

export function verifyEpusdtSignature(
	params: Record<string, string>,
	secretKey: string,
	signatureField: "signature" | "sign",
) {
	const provided = params[signatureField] ?? "";
	const excluded =
		signatureField === "signature"
			? new Set(["signature"])
			: new Set(["sign", "sign_type"]);
	if (
		!provided ||
		!constantTimeEqual(
			provided.toLowerCase(),
			signEpusdt(params, secretKey, excluded),
		)
	)
		throw new DomainError(
			"invalid_payment_signature",
			401,
			"Invalid signature",
		);
}

export async function queryEpusdtPayment(
	providerPaymentId: string,
	credential: EpusdtCredential,
	fetcher: typeof fetch,
): Promise<PaymentQuery> {
	const response = await epusdtFetch(
		epusdtUrl(
			credential.baseUrl,
			`/pay/check-status/${encodeURIComponent(providerPaymentId)}`,
		),
		{},
		fetcher,
	);
	const result = statusResponseSchema.parse(await parseEpusdtJson(response));
	return {
		status:
			result.data.status === 2
				? "succeeded"
				: result.data.status === 3
					? "expired"
					: "pending",
		amountMinor: null,
		currency: null,
	};
}

export async function checkEpusdtHealth(
	credential: EpusdtCredential,
	fetcher: typeof fetch,
) {
	const response = await epusdtFetch(
		epusdtUrl(credential.baseUrl, "/payments/gmpay/v1/config"),
		{},
		fetcher,
	);
	healthResponseSchema.parse(await parseEpusdtJson(response));
}

export const manualRefundMethods: Pick<
	PaymentProviderAdapter,
	"refundPayment" | "queryRefund"
> = {
	async refundPayment() {
		throw new DomainError(
			"payment_refund_manual_required",
			409,
			"This provider requires an external refund",
		);
	},
	async queryRefund() {
		throw new DomainError(
			"payment_refund_manual_required",
			409,
			"This provider requires an external refund",
		);
	},
};

export async function parseEpusdtJson(response: Response) {
	if (!response.ok)
		throw new DomainError(
			"payment_provider_unavailable",
			502,
			"Payment provider unavailable",
		);
	try {
		return await response.json();
	} catch {
		throw new DomainError(
			"payment_provider_invalid_response",
			502,
			"Payment provider returned an invalid response",
		);
	}
}

export function scalarRecord(value: unknown) {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new DomainError(
			"invalid_payment_callback",
			400,
			"Invalid payment callback",
		);
	const result: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (
			entry !== null &&
			typeof entry !== "string" &&
			typeof entry !== "number" &&
			typeof entry !== "boolean"
		)
			throw new DomainError(
				"invalid_payment_callback",
				400,
				"Invalid payment callback",
			);
		result[key] = entry === null ? "" : String(entry);
	}
	return result;
}
