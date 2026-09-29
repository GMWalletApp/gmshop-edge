/**
 * Reconstruct the public scheme for a request that reached Bun behind a
 * TLS-terminating reverse proxy. The `X-Forwarded-Proto` header is only
 * honoured when the deployment trusts its proxy headers; otherwise (or when the
 * proxy does not send it) the scheme of the configured public application URL
 * decides, which no client can influence.
 */
export function withForwardedProtocol(
	request: Request,
	options: {
		trustProxyHeaders?: boolean;
		canonicalOrigin?: string | null;
	} = {},
) {
	const trustProxyHeaders = options.trustProxyHeaders ?? true;
	const url = new URL(request.url);
	if (url.protocol === "https:") return request;
	const forwarded = request.headers
		.get("x-forwarded-proto")
		?.split(",", 1)[0]
		?.trim()
		.toLowerCase();
	const canonical = canonicalHttps(options.canonicalOrigin, url.host);
	if (!(trustProxyHeaders && forwarded === "https") && !canonical)
		return request;
	url.protocol = "https:";
	return new Request(url, request);
}

function canonicalHttps(origin: string | null | undefined, host: string) {
	if (!origin) return false;
	try {
		const canonical = new URL(origin);
		return (
			canonical.protocol === "https:" &&
			canonical.host.toLowerCase() === host.toLowerCase()
		);
	} catch {
		return false;
	}
}
