import { normalizePermissionMask } from "#/features/access/rbac-bitmask";
import { DomainError } from "#/lib/domain-error";

export type PermissionRow = { module: string; permissionMask: number };

export function mergeRolePermissions(rows: readonly PermissionRow[]) {
	const permissions = new Map<string, number>();
	for (const row of rows) {
		permissions.set(
			row.module,
			(permissions.get(row.module) ?? 0) |
				normalizePermissionMask(row.permissionMask),
		);
	}
	return permissions;
}

export function hasGrantedPermission(
	root: boolean,
	permissions: ReadonlyMap<string, number>,
	requirement: PermissionRow,
) {
	if (root) return true;
	const mask = permissions.get(requirement.module) ?? 0;
	return (mask & requirement.permissionMask) === requirement.permissionMask;
}

// An operator may only hand out (or write into a role) actions they hold
// themselves; root is the only unrestricted grantor.
export function assertGrantsWithinActor(
	actor: { root: boolean; permissions: readonly PermissionRow[] },
	requested: readonly PermissionRow[],
) {
	if (actor.root) return;
	const held = mergeRolePermissions(actor.permissions);
	for (const [module, mask] of mergeRolePermissions(requested))
		if ((mask & (held.get(module) ?? 0)) !== mask)
			throw new DomainError(
				"permission_escalation",
				403,
				"You cannot grant permissions you do not have",
			);
}
