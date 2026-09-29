CREATE INDEX `commerce_events_order_type_idx` ON `commerce_events` (`order_id`,`event_type`);--> statement-breakpoint
CREATE INDEX `customer_entitlements_status_expiry_idx` ON `customer_entitlements` (`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `refunds_status_updated_idx` ON `refunds` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `supplier_orders_order_idx` ON `supplier_orders` (`order_id`);--> statement-breakpoint
CREATE INDEX `wallet_entries_source_idx` ON `wallet_entries` (`source_type`,`source_id`);