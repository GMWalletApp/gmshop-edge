import { signInErrorMessage } from "#/features/auth/error-message";
import { m } from "#/paraglide/messages";
export function agentAccessErrorMessage(error: unknown) {
	const code =
		error && typeof error === "object" && "code" in error ? error.code : "";
	switch (code) {
		case "agent_access_existing_order":
			return m.agent_access_existing_order();
		case "agent_access_already_active":
			return m.agent_access_existing();
		case "agent_access_binding_required":
			return m.agent_access_bind();
		case "agent_access_terms_required":
			return m.agent_access_terms_missing();
		case "agent_subsite_prefix_invalid":
			return m.agent_subsite_prefix_invalid();
		case "agent_subsite_prefix_reserved":
			return m.agent_subsite_prefix_reserved();
		case "agent_subsite_prefix_taken":
			return m.agent_subsite_prefix_taken();
		case "agent_subsite_prefix_rate_limited":
			return m.agent_subsite_prefix_rate_limited();
		case "authentication_required":
		case "unauthorized":
		case "agent_access_email_verification":
			return m.agent_access_check_error();
		default:
			return m.agent_access_unavailable();
	}
}

export function agentEmailSendErrorMessage(error: unknown) {
	const code =
		error && typeof error === "object" && "code" in error ? error.code : "";
	if (code === "HUMAN_VERIFICATION_REQUIRED") return m.agent_access_reverify();
	if (code === "EMAIL_OTP_FLOW_DISABLED")
		return m.agent_access_original_login();
	if (code === "EMAIL_ADDRESS_UNDELIVERABLE" || code === "TOO_MANY_REQUESTS")
		return signInErrorMessage(error);
	return m.agent_access_send_failed();
}
