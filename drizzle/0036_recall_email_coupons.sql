-- Recall coupons may be bound to an order email instead of an account, so guest buyers can redeem them.
-- Parenthesized CASE preserves SQLite semantics and avoids the remote D1 /query trigger splitter bug.
ALTER TABLE coupons ADD COLUMN recipient_email TEXT;
--> statement-breakpoint
CREATE UNIQUE INDEX coupons_recall_campaign_email_uidx ON coupons(campaign_key, recipient_email) WHERE purpose = 'recall' AND recipient_email IS NOT NULL;
--> statement-breakpoint
CREATE INDEX coupons_recipient_email_expiry_idx ON coupons(recipient_email,ends_at) WHERE purpose='recall' AND recipient_email IS NOT NULL;
--> statement-breakpoint
CREATE INDEX commerce_events_session_type_created_idx ON commerce_events(session_id,event_type,created_at);
--> statement-breakpoint
DROP TRIGGER coupons_promotion_insert_guard;
--> statement-breakpoint
CREATE TRIGGER coupons_promotion_insert_guard BEFORE INSERT ON coupons WHEN NEW.purpose <> 'standard' OR NEW.recipient_email IS NOT NULL BEGIN
 SELECT (CASE WHEN NEW.currency <> 'CNY' OR NEW.currency_decimals <> 2 OR NEW.type <> 'fixed'
  OR (NEW.purpose = 'standard' AND NEW.recipient_email IS NOT NULL)
  OR (NEW.purpose = 'referral' AND (NEW.referrer_user_id IS NULL OR NEW.recipient_user_id IS NOT NULL OR NEW.recipient_email IS NOT NULL))
  OR (NEW.purpose = 'recall' AND ((NEW.recipient_user_id IS NULL) = (NEW.recipient_email IS NULL)
   OR NEW.recipient_email <> lower(trim(NEW.recipient_email)) OR NEW.referrer_user_id IS NOT NULL OR NEW.campaign_key IS NULL
   OR NEW.usage_limit IS NOT 1 OR NEW.ends_at IS NULL OR NEW.starts_at IS NULL OR NEW.ends_at <= NEW.starts_at OR NEW.ends_at - NEW.starts_at > 604800000))
 THEN RAISE(ABORT, 'promotion_coupon_invalid') END);
END;
--> statement-breakpoint
DROP TRIGGER coupons_promotion_update_guard;
--> statement-breakpoint
CREATE TRIGGER coupons_promotion_update_guard BEFORE UPDATE ON coupons WHEN OLD.purpose <> 'standard' OR NEW.purpose <> 'standard' OR NEW.recipient_email IS NOT OLD.recipient_email BEGIN
 SELECT (CASE WHEN NEW.purpose <> OLD.purpose OR NEW.referrer_user_id IS NOT OLD.referrer_user_id
  OR NEW.recipient_user_id IS NOT OLD.recipient_user_id OR NEW.recipient_email IS NOT OLD.recipient_email
  OR NEW.campaign_key IS NOT OLD.campaign_key
  OR NEW.type <> OLD.type OR NEW.currency IS NOT OLD.currency OR NEW.currency_decimals IS NOT OLD.currency_decimals
  OR NEW.value_minor IS NOT OLD.value_minor OR NEW.starts_at IS NOT OLD.starts_at OR NEW.ends_at IS NOT OLD.ends_at
  OR NEW.usage_limit IS NOT OLD.usage_limit OR NEW.code <> OLD.code
 THEN RAISE(ABORT, 'promotion_coupon_immutable') END);
END;
--> statement-breakpoint
DROP TRIGGER personal_coupon_reservation_guard;
--> statement-breakpoint
CREATE TRIGGER personal_coupon_reservation_guard BEFORE INSERT ON coupon_redemptions
WHEN EXISTS (SELECT 1 FROM coupons WHERE id = NEW.coupon_id AND purpose = 'recall') BEGIN
 SELECT (CASE WHEN NOT EXISTS (SELECT 1 FROM coupons c LEFT JOIN users u ON u.id = c.recipient_user_id
  WHERE c.id = NEW.coupon_id AND c.enabled = 1 AND c.ends_at > NEW.created_at AND c.starts_at <= NEW.created_at
   AND ((u.id = NEW.user_id AND u.enabled = 1 AND u.email_verified = 1)
    OR (c.recipient_email IS NOT NULL AND c.recipient_email = lower(trim(NEW.normalized_email)))))
  OR EXISTS (SELECT 1 FROM coupon_redemptions WHERE coupon_id = NEW.coupon_id AND status IN ('reserved','consumed'))
 THEN RAISE(ABORT, 'coupon_recipient_or_usage_invalid') END);
END;
