import { normalizeRoleIds } from "#/features/access/rbac-json";
import { DomainError } from "#/lib/domain-error";
import { isEnabledRootUser, loadRootUserState } from "./root-protection";

export async function replaceUserRolesAtomically(
	db: D1Database,
	input: {
		userId: string;
		roleIds: string[];
		currentUserId: string;
	},
) {
	if (input.userId === input.currentUserId)
		throw new DomainError(
			"cannot_change_own_roles",
			409,
			"You cannot change the roles of your own account",
		);
	const roleIds = normalizeRoleIds(input.roleIds);
	let nextIncludesRoot = false;
	if (roleIds.length) {
		const placeholders = roleIds.map(() => "?").join(",");
		const roles = await db
			.prepare(
				`SELECT id, name FROM roles
				 WHERE enabled = 1 AND id IN (${placeholders})`,
			)
			.bind(...roleIds)
			.all<{ id: string; name: string }>();
		if (
			roles.results.length !== roleIds.length ||
			roles.results.some((role) => role.name === "guest")
		)
			throw new DomainError(
				"user_role_ids_invalid",
				400,
				"Roles must exist, be enabled, and cannot include guest",
			);
		nextIncludesRoot = roles.results.some((role) => role.name === "root");
	}
	const targetBefore = await loadRootUserState(db, input.userId);
	if (!targetBefore.exists)
		throw new DomainError("user_not_found", 404, "User not found");
	if (
		(targetBefore.isRoot || nextIncludesRoot) &&
		!(await isEnabledRootUser(db, input.currentUserId))
	)
		throw new DomainError(
			"root_role_required",
			403,
			"Only an enabled root user can change the root role",
		);
	const now = Date.now();
	const nextRolesJson = JSON.stringify(roleIds);
	const result = await db
		.prepare(`UPDATE users SET role_ids = ?,
				updated_at = CASE WHEN updated_at >= ? THEN updated_at + 1 ELSE ? END
					WHERE id = ? AND (
					 (
					  NOT EXISTS (
					   SELECT 1 FROM json_each(users.role_ids) current_assigned
					   JOIN roles current_root ON current_root.id = current_assigned.value
					   WHERE current_root.name = 'root' AND current_root.enabled = 1
					  ) AND NOT EXISTS (
					   SELECT 1 FROM json_each(?) next_root_assigned
					   JOIN roles requested_root ON requested_root.id = next_root_assigned.value
					   WHERE requested_root.name = 'root' AND requested_root.enabled = 1
					  )
					 ) OR EXISTS (
					  SELECT 1 FROM users actor
					  JOIN json_each(actor.role_ids) actor_assigned
					  JOIN roles actor_root ON actor_root.id = actor_assigned.value
					  WHERE actor.id = ? AND actor.enabled = 1
					   AND actor_root.name = 'root' AND actor_root.enabled = 1
					 )
					) AND (
					 enabled <> 1 OR NOT EXISTS (
				  SELECT 1 FROM json_each(users.role_ids) assigned
				  JOIN roles current_role ON current_role.id = assigned.value
				  WHERE current_role.name = 'root' AND current_role.enabled = 1
				 ) OR EXISTS (
				  SELECT 1 FROM json_each(?) next_assigned
				  JOIN roles next_role ON next_role.id = next_assigned.value
				  WHERE next_role.name = 'root' AND next_role.enabled = 1
				 ) OR EXISTS (
				  SELECT 1 FROM users other
				  WHERE other.id <> users.id AND other.enabled = 1
				   AND EXISTS (
				    SELECT 1 FROM json_each(other.role_ids) other_assigned
				    JOIN roles other_role ON other_role.id = other_assigned.value
				    WHERE other_role.name = 'root' AND other_role.enabled = 1
				   )
				 )
				)`)
		.bind(
			nextRolesJson,
			now,
			now,
			input.userId,
			nextRolesJson,
			input.currentUserId,
			nextRolesJson,
		)
		.run();
	if ((result.meta.changes ?? 0) !== 1) {
		const target = await loadRootUserState(db, input.userId);
		if (!target.exists)
			throw new DomainError("user_not_found", 404, "User not found");
		if (
			(target.isRoot || nextIncludesRoot) &&
			!(await isEnabledRootUser(db, input.currentUserId))
		)
			throw new DomainError(
				"root_role_required",
				403,
				"Only an enabled root user can change the root role",
			);
		throw new DomainError(
			"last_root_required",
			409,
			"The last enabled root user cannot lose the root role",
		);
	}
	const actual = await db
		.prepare("SELECT role_ids FROM users WHERE id = ?")
		.bind(input.userId)
		.first<{ role_ids: string }>();
	if (!actual) throw new DomainError("user_not_found", 404, "User not found");
	return {
		userId: input.userId,
		roleIds: JSON.parse(actual.role_ids) as string[],
	};
}
