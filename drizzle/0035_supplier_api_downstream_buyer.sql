-- lsrai.shop customer-facing parent order number and the customer who placed it; display only.
ALTER TABLE supplier_api_orders ADD COLUMN downstream_parent_order_no TEXT;
--> statement-breakpoint
ALTER TABLE supplier_api_orders ADD COLUMN downstream_buyer_email TEXT;
