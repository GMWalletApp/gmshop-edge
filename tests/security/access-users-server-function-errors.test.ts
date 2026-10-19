import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { accessOperationErrorMessage } from "#/features/access/error-message";
import { userOperationErrorMessage } from "#/features/users/error-message";
import { DomainError } from "#/lib/domain-error";
import { m } from "#/paraglide/messages";
import {
	normalizeServerFunctionError,
	ServerFunctionError,
} from "#/server/server-function-errors";

const request = new Request("https://example.com/_serverFn/access-users");

describe("access and user Server Function error presentation", () => {
	it.each([
		["role_not_found", m.access_error_role_not_found()],
		["built_in_role", m.access_error_built_in_role()],
		["role_in_use", m.access_error_role_in_use()],
		["invalid_input", m.access_error_invalid_input()],
		["permission_escalation", m.access_error_permission_escalation()],
	] as const)("maps reviewed access code %s", (code, message) => {
		expect(
			accessOperationErrorMessage(new ServerFunctionError(code, 409, code)),
		).toBe(message);
	});

	it.each([
		["user_not_found", m.admin_users_error_not_found()],
		["email_in_use", m.admin_users_error_email_in_use()],
		["password_too_short", m.admin_users_error_password_too_short()],
		["cannot_disable_self", m.admin_users_error_cannot_disable_self()],
		["cannot_delete_self", m.admin_users_error_cannot_delete_self()],
		["last_root_required", m.admin_users_error_last_root_required()],
		["root_user_immutable", m.admin_users_error_root_user_immutable()],
		["root_role_required", m.admin_users_error_root_role_required()],
		["role_unavailable", m.admin_users_error_role_unavailable()],
		["own_roles_required", m.admin_users_error_own_roles_required()],
		["cannot_change_own_roles", m.admin_users_error_cannot_change_own_roles()],
		["permission_escalation", m.admin_users_error_permission_escalation()],
		["user_id_required", m.admin_users_error_invalid_input()],
		["invalid_input", m.admin_users_error_invalid_input()],
	] as const)("maps reviewed user code %s", (code, message) => {
		expect(
			userOperationErrorMessage(new ServerFunctionError(code, 409, code)),
		).toBe(message);
	});

	it("preserves reviewed codes while unknown details remain generic", () => {
		const normalized = normalizeServerFunctionError(
			new DomainError("last_root_required", 409, "Internal role detail"),
			request,
		);
		expect(normalized).toMatchObject({
			code: "last_root_required",
			status: 409,
		});
		expect(
			userOperationErrorMessage(
				new Error("D1_ERROR: SELECT password; token=secret"),
			),
		).toBe(m.admin_users_operation_failed());
		expect(
			accessOperationErrorMessage(
				new Error("D1_ERROR: SELECT permission_mask; token=secret"),
			),
		).toBe(m.access_operation_failed());
	});

	it("keeps raw Error messages out of both admin pages", async () => {
		const [usersPage, accessPage] = await Promise.all([
			readFile(
				new URL("../../src/features/users/pages/admin.tsx", import.meta.url),
				"utf8",
			),
			readFile(
				new URL("../../src/features/access/pages/admin.tsx", import.meta.url),
				"utf8",
			),
		]);

		expect(usersPage).toContain("userOperationErrorMessage(error)");
		expect(accessPage).toContain("accessOperationErrorMessage(error)");
		expect(usersPage).not.toContain("error.message");
		expect(accessPage).not.toContain("error.message");
	});
});
