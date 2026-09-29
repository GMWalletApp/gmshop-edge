import { timingSafeEqual } from "node:crypto";
import { signGmshopEdgeRequest } from "#/features/suppliers/providers/signatures";
import { DomainError } from "#/lib/domain-error";
import { decryptSecret } from "#/lib/secrets";
import { clientIp } from "#/server/client-ip";
import {
	claimFixedWindowRateLimit,
	peekFixedWindowRateLimit,
} from "#/server/rate-limit";
import { loadRuntimeConfig } from "#/server/runtime-config";

export type SupplierApiIdentity = {
	userId: string;
	keyId: string;
	keyRowId: string;
	allowedCallbackOrigin: string | null;
};

export async function authenticateSupplierApi(
	request: Request,
	db: D1Database,
	rawBody: string,
): Promise<SupplierApiIdentity> {
	const requestUrl = new URL(request.url);
	if (requestUrl.protocol !== "https:" || requestUrl.port) throw unauthorized();
	const apiKey = request.headers.get("GMShop-Edge-Api-Key") ?? "";
	const timestamp = request.headers.get("GMShop-Edge-Timestamp") ?? "";
	const nonce = request.headers.get("GMShop-Edge-Nonce") ?? "";
	const signature = request.headers.get("GMShop-Edge-Signature") ?? "";
	if (
		!apiKey ||
		!/^\d{10}$/.test(timestamp) ||
		!/^[A-Za-z0-9-]{16,100}$/.test(nonce) ||
		!/^[a-f0-9]{64}$/.test(signature)
	)
		throw unauthorized();
	const now = Date.now();
	if (Math.abs(now - Number(timestamp) * 1000) > 60_000) throw unauthorized();
	if (!(await supplierApiIsEnabled(db))) throw unauthorized();
	const row = await db
		.prepare(
			`SELECT key.id, key.user_id, key.key_id, key.secret_encrypted,
			 key.allowed_callback_origin
			 FROM supplier_api_keys key JOIN users user ON user.id = key.user_id
			 WHERE key.key_id = ? AND key.revoked_at IS NULL AND user.enabled = 1 LIMIT 1`,
		)
		.bind(apiKey)
		.first<{
			id: string;
			user_id: string;
			key_id: string;
			secret_encrypted: string;
			allowed_callback_origin: string | null;
		}>();
	if (!row) throw unauthorized();
	const runtime = await loadRuntimeConfig(db);
	if (!runtime.commerceSecret)
		throw new DomainError(
			"supplier_api_unavailable",
			503,
			"Supplier API unavailable",
		);
	// Forged requests are throttled by the client that sends them, so a flood
	// on a public key id is refused cheaply while the key owner (a different
	// client) keeps its full quota.
	const forgerIp = clientIp(request);
	const failureBucket = forgerIp
		? {
				bucketKey: `supplier-api:invalid:${forgerIp}`,
				limit: 60,
				windowMs: 60_000,
				now,
			}
		: null;
	if (
		failureBucket &&
		(await peekFixedWindowRateLimit(db, failureBucket)).exhausted
	)
		throw new DomainError("supplier_rate_limited", 429, "Rate limit exceeded");
	const secret = await decryptSecret(
		row.secret_encrypted,
		runtime.commerceSecret,
		"supplier-api-key",
	);
	const expected = signGmshopEdgeRequest({
		method: request.method,
		pathWithQuery: `${requestUrl.pathname}${requestUrl.search}`,
		timestamp,
		nonce,
		rawBody,
		apiSecret: secret,
	});
	if (!safeEqual(signature, expected)) {
		if (failureBucket) await claimFixedWindowRateLimit(db, failureBucket);
		throw unauthorized();
	}
	// Budgets are claimed only for correctly signed requests so that anyone
	// who learns a public key id cannot exhaust its owner's quota.
	const [keyBudget, userBudget] = await Promise.all([
		claimFixedWindowRateLimit(db, {
			bucketKey: `supplier-api:key:${row.id}`,
			limit: 120,
			windowMs: 60_000,
			now,
		}),
		claimFixedWindowRateLimit(db, {
			bucketKey: `supplier-api:user:${row.user_id}`,
			limit: 300,
			windowMs: 60_000,
			now,
		}),
	]);
	if (!keyBudget.allowed || !userBudget.allowed)
		throw new DomainError("supplier_rate_limited", 429, "Rate limit exceeded");
	try {
		await db.batch([
			db
				.prepare(
					`INSERT INTO replay_receipts (id, namespace, scope_id, external_id, event_type, payload_digest, status, processed_at, created_at, updated_at) VALUES (?, 'supplier_api', ?, ?, ?, ?, 'processed', ?, ?, ?)`,
				)
				.bind(
					crypto.randomUUID(),
					row.id,
					nonce,
					request.method,
					signature,
					now,
					now,
					now,
				),
			db
				.prepare(
					"UPDATE supplier_api_keys SET last_used_at = ?, updated_at = ? WHERE id = ?",
				)
				.bind(now, now, row.id),
		]);
	} catch {
		throw new DomainError(
			"supplier_replay",
			409,
			"Request was already processed",
		);
	}
	return {
		userId: row.user_id,
		keyId: row.key_id,
		keyRowId: row.id,
		allowedCallbackOrigin: row.allowed_callback_origin,
	};
}

export async function supplierApiIsEnabled(db: D1Database) {
	const setting = await db
		.prepare(
			"SELECT value FROM system_settings WHERE key = 'commerce.supplier_api_enabled' LIMIT 1",
		)
		.first<{ value: string }>();
	return setting ? JSON.parse(setting.value) === true : false;
}

function safeEqual(left: string, right: string) {
	const a = Buffer.from(left);
	const b = Buffer.from(right);
	return a.length === b.length && timingSafeEqual(a, b);
}

function unauthorized() {
	return new DomainError(
		"supplier_api_unauthorized",
		401,
		"Invalid supplier credentials",
	);
}
