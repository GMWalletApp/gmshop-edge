import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { users } from "./auth";
import { shopOrderItems } from "./commerce";
export const agentAccessOrders = sqliteTable(
	"agent_access_orders",
	{
		orderItemId: text("order_item_id")
			.primaryKey()
			.references(() => shopOrderItems.id),
		userId: text("user_id")
			.notNull()
			.references(() => users.id),
		kind: text("kind", { enum: ["subsite", "api"] }).notNull(),
		email: text("email").notNull(),
		activeKey: text("active_key").unique(),
		policySnapshot: text("policy_snapshot"),
		initialPasswordEncrypted: text("initial_password_encrypted"),
		state: text("state", {
			enum: ["pending", "active", "revoked", "cancelled"],
		})
			.notNull()
			.default("pending"),
		remoteUserId: integer("remote_user_id"),
		domain: text("domain"),
		requestedSubdomain: text("requested_subdomain"),
		subdomainFallback: text("subdomain_fallback"),
		attemptCount: integer("attempt_count").notNull().default(0),
		nextAttemptAt: integer("next_attempt_at").notNull().default(0),
		errorCode: text("error_code"),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(table) => [
		index("agent_access_orders_retry_idx").on(table.state, table.nextAttemptAt),
	],
);
