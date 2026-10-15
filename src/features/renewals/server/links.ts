import { recipientHash } from "#/features/notifications/server/recipient-policy";
import { constantTimeEqual, hmacSha256Hex } from "#/lib/crypto";
import type { RuntimeConfig } from "#/server/runtime-config";
import { loadRuntimeConfig } from "#/server/runtime-config";
import { isEmailAddress, type RenewalStage, renewalStageRef } from "../domain";

export function renewalOrigin(runtime: Pick<RuntimeConfig, "betterAuthUrl">) {
	try {
		return new URL(runtime.betterAuthUrl).origin;
	} catch {
		return "https://localhost";
	}
}

/** The storefront domain customers should remember, e.g. laoshirenvip.com. */
export function renewalSiteDomain(origin: string) {
	return new URL(origin).hostname.replace(/^www\./, "");
}

function unsubscribeKey(runtime: RuntimeConfig) {
	const secret = runtime.betterAuthSecret || runtime.dataEncryptionSecret;
	if (!secret) throw new Error("renewal_unsubscribe_secret_unavailable");
	return `gmshop-renewal-unsubscribe:${secret}`;
}

export async function signRenewalUnsubscribe(
	runtime: RuntimeConfig,
	email: string,
) {
	return (
		await hmacSha256Hex(unsubscribeKey(runtime), email.trim().toLowerCase())
	).slice(0, 32);
}

export async function renewalUnsubscribeUrl(
	runtime: RuntimeConfig,
	email: string,
	path = "/unsubscribe/renewal",
) {
	const url = new URL(path, renewalOrigin(runtime));
	url.searchParams.set("e", email.trim().toLowerCase());
	url.searchParams.set("sig", await signRenewalUnsubscribe(runtime, email));
	return url.toString();
}

export async function verifyRenewalUnsubscribe(
	runtime: RuntimeConfig,
	email: unknown,
	signature: unknown,
) {
	if (!isEmailAddress(email) || typeof signature !== "string") return false;
	return constantTimeEqual(
		await signRenewalUnsubscribe(runtime, email),
		signature.trim().toLowerCase(),
	);
}

/** Records a renewal opt-out when the link signature is valid. */
export async function unsubscribeRenewalEmail(
	db: D1Database,
	email: unknown,
	signature: unknown,
	now = Date.now(),
) {
	const runtime = await loadRuntimeConfig(db);
	if (!(await verifyRenewalUnsubscribe(runtime, email, signature)))
		return { ok: false as const };
	const hash = await recipientHash(String(email));
	await db.batch([
		db
			.prepare(
				`INSERT INTO email_unsubscribes (recipient_hash, scope, created_at)
				 VALUES (?, 'renewal', ?) ON CONFLICT DO NOTHING`,
			)
			.bind(hash, now),
		db
			.prepare(
				`UPDATE renewal_reminder_sends SET status = 'unsubscribed',
				 status_reason = 'unsubscribed', updated_at = ?
				 WHERE recipient_hash = ? AND status = 'pending'`,
			)
			.bind(now, hash),
	]);
	return { ok: true as const };
}

export function renewalProductPath(
	productId: string,
	sellableItemId: string,
	stage: RenewalStage,
) {
	const search = new URLSearchParams({
		item: sellableItemId,
		ref: renewalStageRef[stage],
	});
	return `/products/${encodeURIComponent(productId)}?${search}#purchase-options`;
}

/** Counts a click on a sent reminder and returns the same-site renewal target. */
export async function resolveRenewalClick(
	db: D1Database,
	token: string,
	now = Date.now(),
) {
	const runtime = await loadRuntimeConfig(db);
	const origin = renewalOrigin(runtime);
	if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return `${origin}/`;
	const row = await db
		.prepare(
			`SELECT s.id, s.stage, r.product_id, r.sellable_item_id
			 FROM renewal_reminder_sends s
			 JOIN renewal_reminders r ON r.id = s.reminder_id
			 WHERE s.click_token = ? LIMIT 1`,
		)
		.bind(token)
		.first<{
			id: string;
			stage: RenewalStage;
			product_id: string;
			sellable_item_id: string;
		}>();
	if (!row) return `${origin}/`;
	await db
		.prepare(
			`UPDATE renewal_reminder_sends SET click_count = click_count + 1,
			 first_clicked_at = COALESCE(first_clicked_at, ?), last_clicked_at = ?
			 WHERE id = ?`,
		)
		.bind(now, now, row.id)
		.run();
	return `${origin}${renewalProductPath(row.product_id, row.sellable_item_id, row.stage)}`;
}
