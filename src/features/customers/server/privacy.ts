import { requireMutableNonRootUser } from "#/features/users/server/root-protection";
import { DomainError } from "#/lib/domain-error";
import { privilegedCustomerError, userHoldsPrivilegedRole } from "./update";

export async function prepareCustomerDataDeletion(
	db: D1Database,
	identityId: string,
	now: number,
) {
	const registered = await db
		.prepare(
			`SELECT id, id AS user_id, email, lower(email) AS normalized_email
			 FROM users WHERE id = ? LIMIT 1`,
		)
		.bind(identityId)
		.first<IdentityRow>();
	if (registered) {
		// Root and staff accounts are never anonymized through customer
		// management; their orders and profile stay attached to the account.
		await requireMutableNonRootUser(db, registered.id, {
			notFoundCode: "customer_not_found",
			notFoundMessage: "Customer not found",
		});
		if (await userHoldsPrivilegedRole(db, registered.id))
			throw privilegedCustomerError(409);
	}
	const guest =
		registered ??
		(await db
			.prepare(
				`SELECT id, NULL AS user_id, contact_email AS email,
				 normalized_contact_email AS normalized_email
				 FROM shop_orders WHERE id = ? AND user_id IS NULL
				  AND normalized_contact_email IS NOT NULL LIMIT 1`,
			)
			.bind(identityId)
			.first<IdentityRow>());
	if (!guest)
		throw new DomainError("customer_not_found", 404, "Customer not found");
	const scope = guest.user_id
		? { condition: "user_id = ?", bindings: [guest.user_id] }
		: {
				condition: "user_id IS NULL AND normalized_contact_email = ?",
				bindings: [guest.normalized_email],
			};
	const dependency = await db
		.prepare(
			`SELECT
			 EXISTS(SELECT 1 FROM shop_orders WHERE ${scope.condition} AND status NOT IN
			  ('completed', 'cancelled', 'expired', 'refunded', 'failed')) AS open_orders,
			 EXISTS(SELECT 1 FROM customer_entitlements ce
			  JOIN shop_order_items oi ON oi.id = ce.order_item_id
			  JOIN shop_orders o ON o.id = oi.order_id
			  WHERE ${guest.user_id ? "ce.user_id = ?" : "ce.user_id IS NULL AND o.user_id IS NULL AND o.normalized_contact_email = ?"}
			   AND ce.status = 'active') AS active_entitlements`,
		)
		.bind(...scope.bindings, ...scope.bindings)
		.first<{ open_orders: number; active_entitlements: number }>();
	if (dependency?.open_orders || dependency?.active_entitlements)
		throw new DomainError(
			"customer_data_in_use",
			409,
			"Customer has open orders or active entitlements",
		);
	const anonymousEmail = `deleted+${identityId}@invalid.gmshop`;
	const orderIds = `SELECT id FROM shop_orders WHERE ${scope.condition}`;
	const entitlementIds = `SELECT ce.id FROM customer_entitlements ce
	 JOIN shop_order_items oi ON oi.id = ce.order_item_id
	 JOIN shop_orders o ON o.id = oi.order_id
	 WHERE ${guest.user_id ? "ce.user_id = ?" : "ce.user_id IS NULL AND o.user_id IS NULL AND o.normalized_contact_email = ?"}`;
	const redemptionCondition = guest.user_id
		? "user_id = ?"
		: "user_id IS NULL AND normalized_email = ?";
	const statements = [
		db
			.prepare(
				`UPDATE shop_order_items SET input_values_json = '{}',
				 sensitive_input_values_json = '{}', updated_at = ?
				 WHERE order_id IN (${orderIds})`,
			)
			.bind(now, ...scope.bindings),
		db
			.prepare(
				`DELETE FROM entitlement_authorization_values
				 WHERE entitlement_id IN (${entitlementIds})`,
			)
			.bind(...scope.bindings),
		db
			.prepare(
				`UPDATE coupon_redemptions SET user_id = NULL, normalized_email = ?
				 WHERE ${redemptionCondition}`,
			)
			.bind(anonymousEmail, ...scope.bindings),
		db
			.prepare(
				`UPDATE customer_entitlements SET user_id = NULL, updated_at = ?
				 WHERE id IN (${entitlementIds})`,
			)
			.bind(now, ...scope.bindings),
		db
			.prepare(
				`UPDATE shop_orders SET user_id = NULL, contact_email = ?,
				 normalized_contact_email = ?, customer_note = NULL, updated_at = ?
				 WHERE ${scope.condition}`,
			)
			.bind(anonymousEmail, anonymousEmail, now, ...scope.bindings),
	];
	if (guest.user_id) {
		statements.push(
			db
				.prepare("DELETE FROM shopping_carts WHERE user_id = ?")
				.bind(guest.user_id),
			db
				.prepare(`DELETE FROM notification_subscriptions WHERE user_id = ?`)
				.bind(guest.user_id),
			db
				.prepare(
					`UPDATE users SET customer_note = NULL, last_ordered_at = NULL,
					 updated_at = ? WHERE id = ?`,
				)
				.bind(now, guest.user_id),
		);
	}
	return {
		customer: {
			userId: guest.user_id,
			email: guest.email,
		},
		statements,
	};
}

type IdentityRow = {
	id: string;
	user_id: string | null;
	email: string;
	normalized_email: string;
};
