import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { assertGrantsWithinActor } from "#/features/access/permissions";
import { RBAC_REGISTERED_ACTION_MASK } from "#/features/access/rbac-bitmask";
import {
	permissionsJsonFromGrants,
	permissionsJsonSchema,
} from "#/features/access/rbac-json";
import {
	getAdminPermissions,
	requireAdmin,
} from "#/features/access/server/require-admin";
import {
	bumpRoleMemberRevisionsStatement,
	setCustomRoleEnabled,
} from "#/features/access/server/role-enabled";
import {
	allSystemPermissionGrants,
	normalizeSystemPermissionGrants,
	type SystemPermissionGrant,
	systemPermission,
	systemRbacModuleIds,
} from "#/features/access/system-rbac";
import { DomainError } from "#/lib/domain-error";
import { createAuditStatement } from "#/server/audit";
import { getCloudflareEnv } from "#/server/db.server";

export const listSystemAccessFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const { db } = await context(systemPermission("roles", "read"));
		const roles = await db
			.prepare(`SELECT r.id, r.name, r.description, r.built_in, r.enabled,
			 r.permissions_json, r.created_at,
			 (SELECT COUNT(*) FROM users u WHERE EXISTS (
			  SELECT 1 FROM json_each(u.role_ids) assigned
			  WHERE assigned.value = r.id
			 )) AS user_count
			 FROM roles r
			 WHERE r.name NOT IN ('customer', 'guest')
			 ORDER BY r.built_in DESC, r.name`)
			.all<{
				id: string;
				name: string;
				description: string | null;
				built_in: number;
				enabled: number;
				permissions_json: string;
				created_at: number;
				user_count: number;
			}>();
		return {
			roles: roles.results.map((role) => ({
				id: role.id,
				name: role.name,
				description: role.description,
				permissions:
					role.name === "root"
						? [...allSystemPermissionGrants]
						: Object.entries(
								permissionsJsonSchema.parse(JSON.parse(role.permissions_json)),
							).map(([module, permissionMask]) => ({
								module: module as SystemPermissionGrant["module"],
								permissionMask,
							})),
				memberCount: role.user_count,
				protected: Boolean(role.built_in),
				enabled: Boolean(role.enabled),
				createdAt: new Date(role.created_at).toISOString(),
			})),
		};
	},
);

const roleInput = z.object({
	id: z.uuid().optional(),
	name: z
		.string()
		.trim()
		.min(2)
		.max(64)
		.regex(/^[a-z][a-z0-9_-]*$/)
		.refine((name) => !["root", "customer", "guest"].includes(name), {
			message: "Reserved role name",
		}),
	description: z.string().trim().max(240).optional(),
	permissions: z.array(
		z.object({
			module: z.enum(systemRbacModuleIds),
			permissionMask: z.number().int().min(0).max(RBAC_REGISTERED_ACTION_MASK),
		}),
	),
});

export const saveSystemRoleFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof roleInput>) => roleInput.parse(input))
	.handler(async ({ data }) => {
		const { db, request, user } = await context(
			systemPermission("roles", data.id ? "update" : "create"),
		);
		const now = Date.now();
		const id = data.id ?? crypto.randomUUID();
		const permissions = normalizeSystemPermissionGrants(data.permissions);
		// Also covers editing a role the operator holds: the ceiling is the
		// operator's current permissions, never the role's new contents.
		assertGrantsWithinActor(await getAdminPermissions(request), permissions);
		const permissionsJson = JSON.stringify(
			permissionsJsonFromGrants(permissions),
		);
		if (data.id) {
			const role = await db
				.prepare("SELECT built_in FROM roles WHERE id = ? LIMIT 1")
				.bind(id)
				.first<{ built_in: number }>();
			if (!role) throw new DomainError("role_not_found", 404, "Role not found");
			if (role.built_in)
				throw new DomainError(
					"built_in_role",
					409,
					"Built-in roles cannot be edited",
				);
		}
		const statements: D1PreparedStatement[] = [
			data.id
				? db
						.prepare(
							"UPDATE roles SET name = ?, description = ?, permissions_json = ?, updated_at = ? WHERE id = ? AND built_in = 0",
						)
						.bind(data.name, data.description || null, permissionsJson, now, id)
				: db
						.prepare(
							"INSERT INTO roles (id, name, description, built_in, enabled, permissions_json, created_at, updated_at) VALUES (?, ?, ?, 0, 1, ?, ?, ?)",
						)
						.bind(
							id,
							data.name,
							data.description || null,
							permissionsJson,
							now,
							now,
						),
		];
		if (data.id) statements.push(bumpRoleMemberRevisionsStatement(db, id, now));
		statements.push(
			createAuditStatement(db, request, user.id, {
				action: data.id ? "role.updated" : "role.created",
				targetType: "role",
				targetId: id,
				after: {
					name: data.name,
					description: data.description || null,
					permissions,
				},
			}),
		);
		await db.batch(statements);
		return { id };
	});

export const deleteSystemRoleFn = createServerFn({ method: "POST" })
	.validator((input: { id: string }) => z.object({ id: z.uuid() }).parse(input))
	.handler(async ({ data }) => {
		const { db, request, user } = await context(
			systemPermission("roles", "delete"),
		);
		const role = await db
			.prepare(`SELECT r.built_in,
			 (SELECT COUNT(*) FROM users u WHERE EXISTS (
			  SELECT 1 FROM json_each(u.role_ids) assigned
			  WHERE assigned.value = r.id
			 )) AS user_count
			 FROM roles r WHERE r.id = ?`)
			.bind(data.id)
			.first<{ built_in: number; user_count: number }>();
		if (!role) throw new DomainError("role_not_found", 404, "Role not found");
		if (role.built_in)
			throw new DomainError(
				"built_in_role",
				409,
				"Built-in roles cannot be deleted",
			);
		if (role.user_count)
			throw new DomainError(
				"role_in_use",
				409,
				"Remove this role from users first",
			);
		await db.batch([
			db.prepare("DELETE FROM roles WHERE id = ?").bind(data.id),
			createAuditStatement(db, request, user.id, {
				action: "role.deleted",
				targetType: "role",
				targetId: data.id,
			}),
		]);
		return data;
	});

export const setSystemRoleEnabledFn = createServerFn({ method: "POST" })
	.validator((input: { id: string; enabled: boolean }) =>
		z.object({ id: z.uuid(), enabled: z.boolean() }).parse(input),
	)
	.handler(async ({ data }) => {
		const { db, request, user } = await context(
			systemPermission("roles", "update"),
		);
		return setCustomRoleEnabled(
			db,
			data.id,
			data.enabled,
			createAuditStatement(db, request, user.id, {
				action: "role.enabled_changed",
				targetType: "role",
				targetId: data.id,
				after: { enabled: data.enabled },
			}),
		);
	});

async function context(permission: ReturnType<typeof systemPermission>) {
	const request = getRequest();
	const user = await requireAdmin(request, permission);
	const db = getCloudflareEnv(request).DB;
	if (!db) throw new Error("D1 binding DB is unavailable");
	return { db, request, user };
}
