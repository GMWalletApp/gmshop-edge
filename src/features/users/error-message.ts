import { m } from "#/paraglide/messages";

export function userOperationErrorMessage(error: unknown) {
	if (!error || typeof error !== "object" || !("code" in error))
		return m.admin_users_operation_failed();
	switch (error.code) {
		case "user_not_found":
			return m.admin_users_error_not_found();
		case "email_in_use":
			return m.admin_users_error_email_in_use();
		case "password_too_short":
			return m.admin_users_error_password_too_short();
		case "cannot_disable_self":
			return m.admin_users_error_cannot_disable_self();
		case "cannot_delete_self":
			return m.admin_users_error_cannot_delete_self();
		case "last_root_required":
			return m.admin_users_error_last_root_required();
		case "root_user_immutable":
			return m.admin_users_error_root_user_immutable();
		case "root_role_required":
			return m.admin_users_error_root_role_required();
		case "role_unavailable":
			return m.admin_users_error_role_unavailable();
		case "own_roles_required":
			return m.admin_users_error_own_roles_required();
		case "cannot_change_own_roles":
			return m.admin_users_error_cannot_change_own_roles();
		case "permission_escalation":
			return m.admin_users_error_permission_escalation();
		case "user_id_required":
		case "invalid_input":
			return m.admin_users_error_invalid_input();
		default:
			return m.admin_users_operation_failed();
	}
}
