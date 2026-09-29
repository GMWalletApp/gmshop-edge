/**
 * Header carrying the per-request CSP nonce from the entry point to the SSR
 * renderer. Set only by the server; any client-supplied value is discarded.
 */
export const CSP_NONCE_HEADER = "x-gmshop-csp-nonce";

export function createCspNonce() {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return btoa(String.fromCharCode(...bytes));
}

export function cspNonce(request: Request) {
	const value = request.headers.get(CSP_NONCE_HEADER);
	return value && /^[A-Za-z0-9+/=]{16,64}$/.test(value) ? value : null;
}

export function applySecurityHeaders(
	request: Request,
	response: Response,
	options: { nonce?: string | null } = {},
) {
	const headers = new Headers(response.headers);
	// With a nonce, CSP3 browsers only run scripts that carry it (plus the
	// scripts those load); 'self'/https:/'unsafe-inline' remain as the fallback
	// for older policy levels. Without a nonce (development server) inline
	// scripts stay allowed.
	const scriptSources = options.nonce
		? [
				`'nonce-${options.nonce}'`,
				"'strict-dynamic'",
				"'self'",
				"'unsafe-inline'",
			]
		: ["'self'", "'unsafe-inline'"];
	headers.set("x-content-type-options", "nosniff");
	headers.set("x-frame-options", "DENY");
	headers.set("referrer-policy", "strict-origin-when-cross-origin");
	headers.set(
		"permissions-policy",
		"camera=(), microphone=(), geolocation=(), payment=()",
	);
	headers.set("cross-origin-resource-policy", "same-origin");
	headers.set("cross-origin-opener-policy", "same-origin");
	headers.set(
		"content-security-policy",
		[
			"default-src 'self'",
			"base-uri 'self'",
			"object-src 'none'",
			"frame-ancestors 'none'",
			"form-action 'self'",
			"img-src 'self' data: blob: https:",
			"font-src 'self' data: https:",
			"style-src 'self' 'unsafe-inline' https:",
			`script-src ${scriptSources.join(" ")} https:`,
			"connect-src 'self' https: wss:",
			"frame-src 'self' https:",
			"worker-src 'self' blob:",
		].join("; "),
	);
	if (new URL(request.url).protocol === "https:")
		headers.set(
			"strict-transport-security",
			"max-age=31536000; includeSubDomains",
		);
	if (response.status >= 400) {
		headers.set("cache-control", "no-store");
		headers.set("pragma", "no-cache");
	} else if (!headers.has("cache-control")) {
		const cacheControl = responseCacheControl(request);
		headers.set("cache-control", cacheControl);
		if (cacheControl.includes("no-store")) headers.set("pragma", "no-cache");
	}
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

function responseCacheControl(request: Request) {
	if (request.method !== "GET" && request.method !== "HEAD")
		return "private, no-store";

	const pathname = new URL(request.url).pathname;
	if (/^\/assets\/.+/.test(pathname))
		return "public, max-age=31536000, immutable";
	if (/(?:^|;\s*)PARAGLIDE_LOCALE=/.test(request.headers.get("cookie") ?? ""))
		return "private, no-store";

	const routePath = pathname;
	if (
		/^\/(?:admin|account|pay|orders|sign-in|install|api)(?:\/|$)/.test(
			routePath,
		)
	)
		return "private, no-store";
	if (routePath === "/status") return "no-store";
	if (["", "/"].includes(routePath))
		return "public, max-age=0, must-revalidate";
	if (
		/^\/(?:apple-touch-icon\.png|favicon\.(?:ico|png)|pwa-(?:192x192|512x512|maskable-192x192|maskable-512x512)\.png|robots\.txt|site\.webmanifest)$/.test(
			routePath,
		)
	)
		return "public, max-age=0, must-revalidate";
	return "no-store";
}
