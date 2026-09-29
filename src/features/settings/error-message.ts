import { m } from "#/paraglide/messages";

export function settingsErrorMessage(error: unknown) {
	if (!error || typeof error !== "object" || !("code" in error))
		return m.settings_save_failed();
	switch (error.code) {
		case "site_asset_storage_unavailable":
			return m.settings_error_storage_unavailable();
		case "site_asset_too_large":
			return m.settings_error_asset_too_large();
		case "site_asset_invalid":
			return m.settings_error_asset_invalid();
		case "site_logo_not_square":
			return m.settings_site_logo_square();
		case "settings_keyring_rotate_only":
			return m.settings_error_keyring_rotate_only();
		case "settings_allowed_hosts_required":
			return m.settings_error_allowed_hosts_required();
		case "settings_client_ip_source_invalid":
			return m.settings_error_client_ip_source_invalid();
		default:
			return m.settings_save_failed();
	}
}
