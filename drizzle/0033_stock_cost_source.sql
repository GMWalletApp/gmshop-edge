-- Where a delivered owned code's cost came from: the warehouse reports the 86 key actually bound to it.
-- NULL means not yet reported (or a code delivered before this existed).
ALTER TABLE stock_entries ADD COLUMN cost_source TEXT
 CHECK (cost_source IS NULL OR cost_source IN ('warehouse_stock','warehouse_bought','warehouse_unavailable','warehouse_unreachable','static'));
--> statement-breakpoint
ALTER TABLE stock_entries ADD COLUMN cost_note TEXT;
--> statement-breakpoint
-- The agent sub-site (e.g. 999.lsrai.shop) an internal-supply order was sold on; display only.
ALTER TABLE supplier_api_orders ADD COLUMN downstream_site_host TEXT;
