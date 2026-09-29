import { m } from "#/paraglide/messages";

export function customerOperationErrorMessage(error: unknown) {
	if (!error || typeof error !== "object" || !("code" in error))
		return m.customers_operation_failed();
	if (error.code === "customer_not_found") return m.customers_error_not_found();
	if (error.code === "customer_deleted") return m.customers_error_deleted();
	if (error.code === "customer_privileged_user")
		return m.customers_error_privileged_user();
	if (error.code === "cannot_disable_self")
		return m.customers_error_cannot_disable_self();
	if (error.code === "reauthentication_failed")
		return m.auth_error_invalid_credentials();
	if (error.code === "reauthentication_rate_limited")
		return m.auth_error_reauthentication_rate_limited();
	return m.customers_operation_failed();
}
