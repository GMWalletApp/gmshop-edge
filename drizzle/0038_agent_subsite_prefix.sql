-- Buyer-chosen sub-site prefix (label only) and, when lsrai.shop could not use it, why.
ALTER TABLE agent_access_orders ADD COLUMN requested_subdomain TEXT;
--> statement-breakpoint
ALTER TABLE agent_access_orders ADD COLUMN subdomain_fallback TEXT;
