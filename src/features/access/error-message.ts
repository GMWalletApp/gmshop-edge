import { m } from "#/paraglide/messages";

export function accessOperationErrorMessage(error: unknown) {
	if (!error || typeof error !== "object" || !("code" in error))
		return m.access_operation_failed();
	switch (error.code) {
		case "role_not_found":
			return m.access_error_role_not_found();
		case "built_in_role":
			return m.access_error_built_in_role();
		case "role_in_use":
			return m.access_error_role_in_use();
		case "invalid_input":
			return m.access_error_invalid_input();
		case "permission_escalation":
			return m.access_error_permission_escalation();
		default:
			return m.access_operation_failed();
	}
}
