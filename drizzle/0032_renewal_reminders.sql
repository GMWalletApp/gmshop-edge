-- Renewal reminders: a sellable item opts in with its billing cycle in days.
ALTER TABLE product_sellable_items ADD COLUMN reminder_cycle_days INTEGER
 CHECK (reminder_cycle_days IS NULL OR reminder_cycle_days BETWEEN 7 AND 366);
--> statement-breakpoint
-- Current one-month membership items; one-off (接码) and test items stay excluded.
UPDATE product_sellable_items SET reminder_cycle_days = 30
WHERE name LIKE '%1个月%' AND name NOT LIKE '%接码%' AND name NOT LIKE '%测试%'
 AND NOT EXISTS (SELECT 1 FROM products p WHERE p.id = product_sellable_items.product_id
  AND (p.name LIKE '%测试%' OR p.name LIKE '%接码%'));
--> statement-breakpoint
CREATE TABLE renewal_reminders (
 id TEXT PRIMARY KEY NOT NULL,
 source_key TEXT NOT NULL,
 order_id TEXT NOT NULL REFERENCES shop_orders(id),
 order_item_id TEXT NOT NULL REFERENCES shop_order_items(id),
 delivery_record_id TEXT NOT NULL REFERENCES delivery_records(id),
 code_hash TEXT,
 user_id TEXT,
 contact_email TEXT,
 account_email TEXT,
 product_id TEXT NOT NULL,
 sellable_item_id TEXT NOT NULL,
 item_name TEXT NOT NULL,
 locale TEXT NOT NULL CHECK (locale IN ('en-US','zh-CN')),
 cycle_days INTEGER NOT NULL CHECK (cycle_days BETWEEN 7 AND 366),
 order_paid_at INTEGER NOT NULL,
 delivered_at INTEGER NOT NULL,
 anchor_at INTEGER,
 anchor_source TEXT CHECK (anchor_source IS NULL OR anchor_source IN ('redeem','delivery')),
 status TEXT NOT NULL CHECK (status IN ('awaiting_redeem','scheduled','abandoned','cancelled')),
 status_reason TEXT,
 lookup_attempts INTEGER NOT NULL DEFAULT 0 CHECK (lookup_attempts >= 0),
 next_lookup_at INTEGER,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 CHECK (status <> 'scheduled' OR anchor_at IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX renewal_reminders_source_uidx ON renewal_reminders (source_key);
--> statement-breakpoint
CREATE INDEX renewal_reminders_delivery_idx ON renewal_reminders (delivery_record_id);
--> statement-breakpoint
CREATE INDEX renewal_reminders_status_lookup_idx ON renewal_reminders (status, next_lookup_at, id);
--> statement-breakpoint
CREATE INDEX renewal_reminders_order_idx ON renewal_reminders (order_id);
--> statement-breakpoint
CREATE TABLE renewal_reminder_sends (
 id TEXT PRIMARY KEY NOT NULL,
 reminder_id TEXT NOT NULL REFERENCES renewal_reminders(id) ON DELETE CASCADE,
 stage TEXT NOT NULL CHECK (stage IN ('remind_3d','remind_due','recall')),
 recipient_email TEXT NOT NULL,
 recipient_hash TEXT NOT NULL,
 recipient_kind TEXT NOT NULL CHECK (recipient_kind IN ('order','account')),
 due_at INTEGER NOT NULL,
 status TEXT NOT NULL CHECK (status IN ('pending','sending','sent','merged','skipped','cancelled','suppressed','unsubscribed','failed')),
 status_reason TEXT,
 click_token TEXT,
 notification_delivery_id TEXT,
 sent_at INTEGER,
 click_count INTEGER NOT NULL DEFAULT 0 CHECK (click_count >= 0),
 first_clicked_at INTEGER,
 last_clicked_at INTEGER,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX renewal_reminder_sends_stage_uidx ON renewal_reminder_sends (reminder_id, stage, recipient_hash);
--> statement-breakpoint
CREATE UNIQUE INDEX renewal_reminder_sends_token_uidx ON renewal_reminder_sends (click_token);
--> statement-breakpoint
CREATE INDEX renewal_reminder_sends_due_idx ON renewal_reminder_sends (status, due_at, id);
--> statement-breakpoint
CREATE INDEX renewal_reminder_sends_recipient_idx ON renewal_reminder_sends (recipient_hash, sent_at);
--> statement-breakpoint
CREATE INDEX renewal_reminder_sends_stage_idx ON renewal_reminder_sends (stage, status);
--> statement-breakpoint
CREATE TABLE email_unsubscribes (
 recipient_hash TEXT NOT NULL,
 scope TEXT NOT NULL CHECK (scope IN ('renewal')),
 created_at INTEGER NOT NULL,
 PRIMARY KEY (recipient_hash, scope)
);
