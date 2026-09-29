import type { z } from "zod";
import { storefrontRoleNames } from "#/features/access/storefront-access";
import type { customerUpdateSchema } from "#/features/customers/schema";
import { requireMutableNonRootUser } from "#/features/users/server/root-protection";
import { DomainError } from "#/lib/domain-error";
import { createAuditStatement } from "#/server/audit";

export type CustomerUpdateOptions = {
	/**
	 * Whether the actor also holds `users:update`. Only then may customer
	 * management change the status of a user holding a non-storefront role.
	 */
	canManagePrivilegedUsers?: boolean;
};

type CustomerRow = {
	id: string;
	name: string | null;
	note: string | null;
	status: "active" | "disabled";
	privileged: number;
};

const storefrontRolePlaceholders = storefrontRoleNames
	.map(() => "?")
	.join(", ");
const privilegedRoleCondition = `EXISTS (
 SELECT 1 FROM json_each(users.role_ids) assigned
 JOIN roles privileged_role ON privileged_role.id = assigned.value
 WHERE privileged_role.name NOT IN (${storefrontRolePlaceholders})
)`;
const rootRoleCondition = `EXISTS (
 SELECT 1 FROM json_each(users.role_ids) assigned
 JOIN roles root_role ON root_role.id = assigned.value
 WHERE root_role.name = 'root' AND root_role.enabled = 1
)`;

export async function updateCustomerRecord(
	db: D1Database,
	request: Request,
	actorUserId: string,
	data: z.infer<typeof customerUpdateSchema>,
	options: CustomerUpdateOptions = {},
) {
	const before = await db
		.prepare(
			`SELECT id, name, customer_note AS note,
			 CASE WHEN enabled = 1 THEN 'active' ELSE 'disabled' END AS status,
			 ${privilegedRoleCondition} AS privileged
			 FROM users WHERE id = ? LIMIT 1`,
		)
		.bind(...storefrontRoleNames, data.id)
		.first<CustomerRow>();
	if (!before)
		throw new DomainError("customer_not_found", 404, "User not found");
	await requireMutableNonRootUser(db, data.id, {
		notFoundCode: "customer_not_found",
		notFoundMessage: "User not found",
	});
	const statusChanges = before.status !== data.status;
	if (statusChanges) {
		if (data.id === actorUserId)
			throw new DomainError(
				"cannot_disable_self",
				409,
				"Cannot disable your own account",
			);
		if (before.privileged === 1 && !options.canManagePrivilegedUsers)
			throw privilegedCustomerError(403);
	}
	const now = Date.now();
	const enabled = data.status === "active" ? 1 : 0;
	const { privileged: _privileged, ...auditBefore } = before;
	const results = await db.batch([
		db
			.prepare(
				`UPDATE users SET name = ?, customer_note = ?, enabled = ?,
				 disabled_at = CASE WHEN ? = 1 THEN NULL ELSE COALESCE(disabled_at, ?) END,
				 updated_at = CASE WHEN updated_at >= ? THEN updated_at + 1 ELSE ? END
				 WHERE id = ? AND NOT ${rootRoleCondition}
				 AND (enabled = ? OR ? = 1 OR NOT ${privilegedRoleCondition})`,
			)
			.bind(
				data.name,
				data.note,
				enabled,
				enabled,
				now,
				now,
				now,
				data.id,
				enabled,
				options.canManagePrivilegedUsers ? 1 : 0,
				...storefrontRoleNames,
			),
		// Disabling revokes every session in the same transaction so the user
		// cannot keep acting on a live cookie.
		...(enabled
			? []
			: [
					db
						.prepare(
							`DELETE FROM sessions WHERE user_id = ?
							 AND EXISTS (SELECT 1 FROM users WHERE id = ? AND enabled = 0)`,
						)
						.bind(data.id, data.id),
				]),
		createAuditStatement(db, request, actorUserId, {
			action: "customer.updated",
			targetType: "user",
			targetId: data.id,
			before: auditBefore,
			after: data,
		}),
	]);
	if (Number(results[0]?.meta.changes ?? 0) !== 1) {
		await requireMutableNonRootUser(db, data.id, {
			notFoundCode: "customer_not_found",
			notFoundMessage: "User not found",
		});
		if (
			statusChanges &&
			!options.canManagePrivilegedUsers &&
			(await userHoldsPrivilegedRole(db, data.id))
		)
			throw privilegedCustomerError(403);
		throw new DomainError(
			"customer_update_conflict",
			409,
			"Customer changed; retry the update",
		);
	}
	return { id: data.id };
}

/** Whether the user holds any role beyond the built-in storefront roles. */
export async function userHoldsPrivilegedRole(db: D1Database, userId: string) {
	const row = await db
		.prepare(
			`SELECT ${privilegedRoleCondition} AS privileged FROM users WHERE id = ? LIMIT 1`,
		)
		.bind(...storefrontRoleNames, userId)
		.first<{ privileged: number }>();
	return row?.privileged === 1;
}

export function privilegedCustomerError(status: 403 | 409) {
	return new DomainError(
		"customer_privileged_user",
		status,
		"Users holding administrative roles are managed under Users",
	);
}
