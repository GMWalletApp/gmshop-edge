import { DomainError } from "#/lib/domain-error";

export type PromotionCoupon = {
	id: string;
	purpose: "standard" | "referral" | "recall";
	referrer_user_id: string | null;
	recipient_user_id: string | null;
	recipient_email: string | null;
};

export async function assertPromotionOwner(
	db: D1Database,
	coupon: PromotionCoupon,
	buyer: { userId?: string; normalizedEmail: string | null },
) {
	if (coupon.purpose === "standard") return;
	if (coupon.purpose === "recall" && coupon.recipient_email) {
		// Email-bound recall coupons follow the order email, so guests can redeem them.
		if (coupon.recipient_email !== buyer.normalizedEmail?.trim().toLowerCase())
			throw new DomainError(
				"coupon_recipient_required",
				403,
				"Use the email address this coupon was sent to",
			);
	} else if (coupon.purpose === "recall") {
		const user =
			buyer.userId &&
			(await db
				.prepare(
					"SELECT id FROM users WHERE id = ? AND enabled = 1 AND email_verified = 1",
				)
				.bind(buyer.userId)
				.first());
		if (!user || coupon.recipient_user_id !== buyer.userId)
			throw new DomainError(
				"coupon_recipient_required",
				403,
				"Sign in to the account that owns this coupon",
			);
	} else {
		// Guests can switch order emails freely, so an email comparison cannot
		// stop self-referral. Only a verified account can redeem an invitation.
		const buyerAccount =
			buyer.userId &&
			(await db
				.prepare(
					"SELECT id FROM users WHERE id = ? AND enabled = 1 AND email_verified = 1",
				)
				.bind(buyer.userId)
				.first());
		if (!buyerAccount)
			throw new DomainError(
				"coupon_sign_in_required",
				403,
				"Sign in to a verified account to use an invitation code",
			);
		const owner = await db
			.prepare("SELECT id, email FROM users WHERE id = ? AND enabled = 1")
			.bind(coupon.referrer_user_id)
			.first<{ id: string; email: string }>();
		if (!owner)
			throw new DomainError("coupon_unavailable", 409, "Coupon is unavailable");
		if (
			owner.id === buyer.userId ||
			owner.email.toLowerCase() === buyer.normalizedEmail?.toLowerCase()
		)
			throw new DomainError(
				"coupon_self_referral",
				409,
				"Your own invitation code cannot be used for this order",
			);
	}
}

export async function openReferralCoupon(db: D1Database, userId: string) {
	const now = Date.now();
	const code = `INV-${crypto.randomUUID().replaceAll("-", "").slice(0, 20).toUpperCase()}`;
	await db
		.prepare(`INSERT INTO coupons (id, code, name, type, currency, currency_decimals, value_minor,
  enabled, purpose, referrer_user_id, created_at, updated_at)
  SELECT ?, ?, 'Invitation', 'fixed', 'CNY', 2, '400', 1, 'referral', id, ?, ? FROM users WHERE id = ? AND enabled = 1
  ON CONFLICT(referrer_user_id) WHERE purpose = 'referral' DO NOTHING`)
		.bind(crypto.randomUUID(), code, now, now, userId)
		.run();
	const row = await db
		.prepare(
			"SELECT code, enabled FROM coupons WHERE purpose = 'referral' AND referrer_user_id = ?",
		)
		.bind(userId)
		.first<{ code: string; enabled: number }>();
	if (!row)
		throw new DomainError("authentication_required", 401, "Sign in required");
	return row;
}

export async function issueRecallCoupon(
	db: D1Database,
	input: {
		userId: string;
		campaignKey: string;
		startsAt: number;
	},
) {
	const user = await db
		.prepare(`SELECT id FROM users WHERE id = ? AND enabled = 1 AND email_verified = 1
  AND marketing_consent = 1 AND EXISTS (SELECT 1 FROM shop_orders WHERE user_id = users.id AND paid_at IS NOT NULL
   AND status IN ('paid','fulfilling','completed'))`)
		.bind(input.userId)
		.first();
	if (!user)
		throw new DomainError(
			"recall_customer_ineligible",
			409,
			"Customer is not eligible for a personal recall coupon",
		);
	const now = Date.now();
	const code = `BACK-${crypto.randomUUID().replaceAll("-", "").toUpperCase()}`;
	await db
		.prepare(`INSERT INTO coupons (id, code, name, type, currency, currency_decimals, value_minor,
  enabled, purpose, recipient_user_id, campaign_key, usage_limit, usage_limit_per_customer, starts_at, ends_at, created_at, updated_at)
  VALUES (?, ?, 'Personal recall', 'fixed', 'CNY', 2, '800', 1, 'recall', ?, ?, 1, 1, ?, ?, ?, ?)
  ON CONFLICT(campaign_key,recipient_user_id) WHERE purpose = 'recall' DO NOTHING`)
		.bind(
			crypto.randomUUID(),
			code,
			input.userId,
			input.campaignKey,
			input.startsAt,
			input.startsAt + 7 * 86400000,
			now,
			now,
		)
		.run();
	return db
		.prepare(`SELECT id,code,starts_at,ends_at,used_count,enabled FROM coupons
  WHERE purpose = 'recall' AND campaign_key = ? AND recipient_user_id = ?`)
		.bind(input.campaignKey, input.userId)
		.first<{
			id: string;
			code: string;
			starts_at: number;
			ends_at: number;
			used_count: number;
			enabled: number;
		}>();
}

/**
 * Recall coupon bound to a past buyer's order email. Buyers who have not unsubscribed
 * from renewal email are treated as consenting; the email itself always carries the
 * unsubscribe link. Returns null when the email is ineligible.
 */
export async function issueRecallEmailCoupon(
	db: D1Database,
	input: { email: string; campaignKey: string; startsAt: number },
) {
	const email = input.email.trim().toLowerCase();
	// One coupon per campaign: an account-bound coupon issued before email binding wins.
	const accountBound = await db
		.prepare(
			"SELECT 1 AS found FROM coupons WHERE purpose = 'recall' AND campaign_key = ? AND recipient_email IS NULL LIMIT 1",
		)
		.bind(input.campaignKey)
		.first();
	if (accountBound) return null;
	const eligible = await db
		.prepare(`SELECT 1 AS found FROM shop_orders o WHERE o.paid_at IS NOT NULL
  AND o.status IN ('paid','fulfilling','completed')
  AND (o.normalized_contact_email = ?1 OR o.user_id IN (SELECT id FROM users WHERE lower(email) = ?1 AND enabled = 1))
  LIMIT 1`)
		.bind(email)
		.first();
	if (!eligible) return null;
	const now = Date.now();
	await db
		.prepare(`INSERT INTO coupons (id, code, name, type, currency, currency_decimals, value_minor,
  enabled, purpose, recipient_email, campaign_key, usage_limit, usage_limit_per_customer, starts_at, ends_at, created_at, updated_at)
  VALUES (?, ?, 'Personal recall', 'fixed', 'CNY', 2, '800', 1, 'recall', ?, ?, 1, 1, ?, ?, ?, ?)
  ON CONFLICT(campaign_key,recipient_email) WHERE purpose = 'recall' AND recipient_email IS NOT NULL DO NOTHING`)
		.bind(
			crypto.randomUUID(),
			`BACK-${crypto.randomUUID().replaceAll("-", "").toUpperCase()}`,
			email,
			input.campaignKey,
			input.startsAt,
			input.startsAt + 7 * 86400000,
			now,
			now,
		)
		.run();
	return db
		.prepare(`SELECT id,code,starts_at,ends_at,used_count,enabled FROM coupons
  WHERE purpose = 'recall' AND campaign_key = ? AND recipient_email = ?`)
		.bind(input.campaignKey, email)
		.first<{
			id: string;
			code: string;
			starts_at: number;
			ends_at: number;
			used_count: number;
			enabled: number;
		}>();
}
