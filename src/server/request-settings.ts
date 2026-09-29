const requestSettingsKeys = [
	"runtime.better_auth_secret",
	"runtime.better_auth_url",
	"runtime.data_encryption_secret",
	"security.allowed_hosts",
	"security.client_ip_source",
] as const;

type RequestSettings = ReadonlyMap<string, string>;

const pendingSettings = new WeakMap<Request, Promise<RequestSettings>>();

/**
 * Reuse the settings already loaded for `source` when the entry point rewrites
 * the request object (trusted client IP, forwarded protocol).
 */
export function carryRequestSettings(source: Request, target: Request) {
	const pending = pendingSettings.get(source);
	if (pending) pendingSettings.set(target, pending);
}

/**
 * Load request-scoped settings once so authority and Better Auth share one D1
 * read. D1 remains authoritative; this memo only covers one request lifetime.
 */
export function loadRequestSettings(
	request: Request,
	db: D1Database,
): Promise<RequestSettings> {
	const cached = pendingSettings.get(request);
	if (cached) return cached;
	const pending = db
		.prepare(
			`SELECT key, value FROM system_settings WHERE key IN (${requestSettingsKeys
				.map(() => "?")
				.join(",")})`,
		)
		.bind(...requestSettingsKeys)
		.all<{ key: string; value: string }>()
		.then((rows) => new Map(rows.results.map((row) => [row.key, row.value])));
	pendingSettings.set(request, pending);
	return pending;
}
