import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { assertGrantsWithinActor } from "#/features/access/permissions";
import {
	normalizeRoleIds,
	permissionsJsonSchema,
} from "#/features/access/rbac-json";
import { getAdminPermissions } from "#/features/access/server/require-admin";
import { systemPermission } from "#/features/access/system-rbac";
import { userIdSchema } from "#/features/users/schema";
import { replaceUserRolesAtomically } from "#/features/users/server/role-assignments";
import {
	createUser,
	deleteUser,
	setUserEnabled,
	type UserFormInput,
	updateUser,
} from "#/features/users/server/users";
import { DomainError } from "#/lib/domain-error";
import { createAuditStatement } from "#/server/audit";
import { getAdminServerContext } from "#/server/context";

const userInput = z.object({
	id: userIdSchema.optional(),
	name: z.string().trim().min(2).max(100),
	email: z.email(),
	enabled: z.boolean(),
	note: z.string().trim().max(2_000).optional(),
	password: z.string().max(200).optional(),
});

export const saveUserFn = createServerFn({ method: "POST" })
	.validator((input: UserFormInput) => userInput.parse(input))
	.handler(async ({ data }) => {
		const { currentUser, db, request } = await getAdminServerContext(
			systemPermission("users", data.id ? "update" : "create"),
		);
		const user = {
			name: data.name,
			email: data.email,
			enabled: data.enabled,
			...(data.note === undefined ? {} : { note: data.note }),
			...(data.password === undefined ? {} : { password: data.password }),
		};
		const result = data.id
			? updateUser(db, { ...user, id: data.id, currentUserId: currentUser.id })
			: createUser(db, user);
		const saved = await result;
		await createAuditStatement(db.$client, request, currentUser.id, {
			action: data.id ? "user.updated" : "user.created",
			targetType: "user",
			targetId: saved.id,
			after: {
				name: data.name,
				email: data.email.trim().toLowerCase(),
				enabled: data.enabled,
				...(data.note === undefined ? {} : { note: data.note }),
				passwordChanged: Boolean(data.password),
			},
		}).run();
		return saved;
	});

export const setUserEnabledFn = createServerFn({ method: "POST" })
	.validator((input: { id: string; enabled: boolean }) =>
		z.object({ id: userIdSchema, enabled: z.boolean() }).parse(input),
	)
	.handler(async ({ data }) => {
		const { currentUser, db, request } = await getAdminServerContext(
			systemPermission("users", "update"),
		);
		const result = await setUserEnabled(db, {
			...data,
			currentUserId: currentUser.id,
		});
		await createAuditStatement(db.$client, request, currentUser.id, {
			action: "user.enabled_changed",
			targetType: "user",
			targetId: data.id,
			after: { enabled: data.enabled },
		}).run();
		return result;
	});

export const deleteUserFn = createServerFn({ method: "POST" })
	.validator((input: { id: string }) =>
		z.object({ id: userIdSchema }).parse(input),
	)
	.handler(async ({ data }) => {
		const { currentUser, db, request } = await getAdminServerContext(
			systemPermission("users", "delete"),
		);
		const result = await deleteUser(db, {
			id: data.id,
			currentUserId: currentUser.id,
		});
		await createAuditStatement(db.$client, request, currentUser.id, {
			action: "user.deleted",
			targetType: "user",
			targetId: data.id,
		}).run();
		return result;
	});

export const setUserRolesFn = createServerFn({ method: "POST" })
	.validator((input: { userId: string; roleIds: string[] }) =>
		z
			.object({
				userId: userIdSchema,
				roleIds: z.array(z.uuid()).max(32).transform(normalizeRoleIds),
			})
			.parse(input),
	)
	.handler(async ({ data }) => {
		const { currentUser, db, request } = await getAdminServerContext(
			systemPermission("users", "update"),
		);
		const roles = data.roleIds.length
			? await db.$client
					.prepare(
						`SELECT id, permissions_json FROM roles WHERE enabled = 1
						 AND name NOT IN ('customer', 'guest')
						 AND id IN (${data.roleIds.map(() => "?").join(",")})`,
					)
					.bind(...data.roleIds)
					.all<{ id: string; permissions_json: string }>()
			: { results: [] as Array<{ id: string; permissions_json: string }> };
		if (roles.results.length !== data.roleIds.length)
			throw new DomainError(
				"role_unavailable",
				409,
				"Unknown or disabled role",
			);
		// The root role itself is guarded by replaceUserRolesAtomically.
		assertGrantsWithinActor(
			await getAdminPermissions(request),
			roles.results.flatMap((role) =>
				Object.entries(
					permissionsJsonSchema.parse(JSON.parse(role.permissions_json)),
				).map(([module, permissionMask]) => ({ module, permissionMask })),
			),
		);
		const result = await replaceUserRolesAtomically(db.$client, {
			userId: data.userId,
			roleIds: data.roleIds,
			currentUserId: currentUser.id,
		});
		await createAuditStatement(db.$client, request, currentUser.id, {
			action: "user.roles_replaced",
			targetType: "user",
			targetId: data.userId,
			after: { roleIds: result.roleIds },
		}).run();
		return result;
	});
