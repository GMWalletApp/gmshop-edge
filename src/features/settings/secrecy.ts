type PresentableSettingValue = string | number | boolean | string[];

export function isRuntimeSecret(key: string) {
	return key.startsWith("runtime.") && key !== "runtime.better_auth_url";
}

/**
 * Runtime secrets never leave the server: the settings page only learns
 * whether a value is configured and submits an empty string to preserve it.
 */
export function presentSettingValue(
	key: string,
	value: PresentableSettingValue,
) {
	if (isRuntimeSecret(key))
		return {
			value: "" as PresentableSettingValue,
			configured: typeof value === "string" && value.length > 0,
		};
	return { value, configured: undefined };
}

export function shouldPreserveRuntimeSecret(key: string, value: unknown) {
	return isRuntimeSecret(key) && value === "";
}
