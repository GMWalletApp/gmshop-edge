import { DomainError } from "#/lib/domain-error";
import { claimFixedWindowRateLimit } from "#/server/rate-limit";
import type { SupplierProvider } from "../schema";

const WINDOW_MS = 60_000;

export async function claimSupplierApiBudget(
	db: D1Database,
	input: {
		provider: SupplierProvider;
		normalizedApiOrigin: string;
		protocolVersion: string;
		accountId: string;
		now?: number;
	},
) {
	const digest = await sourceDigest(input);
	const [source, account] = await Promise.all([
		claimFixedWindowRateLimit(db, {
			bucketKey: `supplier:source:${digest}`,
			limit: 300,
			windowMs: WINDOW_MS,
			now: input.now,
		}),
		claimFixedWindowRateLimit(db, {
			bucketKey: `supplier:account:${input.accountId}`,
			limit: 120,
			windowMs: WINDOW_MS,
			now: input.now,
		}),
	]);
	if (!source.allowed || !account.allowed)
		throw new DomainError(
			"supplier_rate_limited",
			429,
			"Supplier request rate limit exceeded",
		);
}

export async function claimSupplierCallbackBudget(
	db: D1Database,
	accountId: string,
	now?: number,
) {
	const result = await claimFixedWindowRateLimit(db, {
		bucketKey: `supplier:callback:${accountId}`,
		limit: 120,
		windowMs: WINDOW_MS,
		now,
	});
	return result.allowed;
}

export async function claimSupplierCallbackFailureBudget(
	db: D1Database,
	ip: string,
	now?: number,
) {
	const result = await claimFixedWindowRateLimit(db, {
		bucketKey: `supplier:callback-failure:ip:${ip}`,
		limit: 30,
		windowMs: WINDOW_MS,
		now,
	});
	return result.allowed;
}

async function sourceDigest(input: {
	provider: string;
	normalizedApiOrigin: string;
	protocolVersion: string;
}) {
	const digest = new Uint8Array(
		await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(
				`${input.provider}\0${input.normalizedApiOrigin}\0${input.protocolVersion}`,
			),
		),
	);
	return Array.from(digest.slice(0, 16), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}
