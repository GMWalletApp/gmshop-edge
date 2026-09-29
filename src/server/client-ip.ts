import { classifyIpAddress } from "#/lib/ip-address";
import type { RuntimeKind } from "#/server/runtime/types";

/**
 * Header the request entry sets after deriving the trusted client address.
 * Anything a client sends under this name is discarded at the entry, so
 * downstream code (audit, rate limits, Better Auth) may trust it blindly.
 */
export const CLIENT_IP_HEADER = "x-gmshop-client-ip";

export const clientIpSources = [
	"auto",
	"cf-connecting-ip",
	"x-forwarded-for",
	"x-real-ip",
	"none",
] as const;
export type ClientIpSource = (typeof clientIpSources)[number];

export function isValidIpAddress(value: string) {
	return classifyIpAddress(value) !== null;
}

function normalizeIp(value: string | null | undefined) {
	const trimmed = value?.trim().replace(/^\[|\]$/g, "");
	return trimmed && isValidIpAddress(trimmed) ? trimmed : null;
}

/**
 * Derive the client address for this request.
 *
 * - Cloudflare Workers always receive the client in `cf-connecting-ip`.
 * - On Bun the connection peer is the anchor: with `auto`, proxy headers
 *   (`X-Real-IP`, then the right-most `X-Forwarded-For` entry the proxy itself
 *   appended) are honoured only when the peer is a loopback/private address —
 *   i.e. the request came through the operator's reverse proxy — otherwise the
 *   peer is the client and forged headers are ignored.
 * - An explicit header source trusts that header unconditionally (for proxies
 *   on public addresses or Cloudflare in front of Bun); `none` uses the peer
 *   address only.
 */
export function resolveClientIp(
	headers: Headers,
	runtime: RuntimeKind,
	source: ClientIpSource = "auto",
	peerAddress: string | null = null,
): string | null {
	const peer = normalizeIp(peerAddress);
	switch (source) {
		case "none":
			return peer;
		case "cf-connecting-ip":
			return normalizeIp(headers.get("cf-connecting-ip")) ?? peer;
		case "x-real-ip":
			return normalizeIp(headers.get("x-real-ip")) ?? peer;
		case "x-forwarded-for":
			return rightmostForwardedFor(headers) ?? peer;
		default:
			if (runtime === "cloudflare")
				return normalizeIp(headers.get("cf-connecting-ip")) ?? peer;
			if (peer && classifyIpAddress(peer) === "public") return peer;
			return (
				normalizeIp(headers.get("x-real-ip")) ??
				rightmostForwardedFor(headers) ??
				peer
			);
	}
}

function rightmostForwardedFor(headers: Headers) {
	const forwarded = headers.get("x-forwarded-for");
	if (!forwarded) return null;
	const entries = forwarded.split(",").map((entry) => entry.trim());
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const candidate = normalizeIp(entries[index]);
		if (candidate) return candidate;
	}
	return null;
}

/**
 * Whether proxy-supplied headers (`X-Forwarded-Proto`, `X-Real-IP`…) may be
 * believed for this connection: explicit header sources always, `none` never,
 * and `auto` only when the peer is the operator's loopback/private proxy.
 */
export function trustsProxyHeaders(
	runtime: RuntimeKind,
	source: ClientIpSource,
	peerAddress: string | null,
) {
	if (runtime === "cloudflare") return true;
	if (source === "none") return false;
	if (source !== "auto") return true;
	const peer = normalizeIp(peerAddress);
	return !peer || classifyIpAddress(peer) !== "public";
}

export function parseClientIpSource(value: unknown): ClientIpSource {
	return typeof value === "string" &&
		(clientIpSources as readonly string[]).includes(value)
		? (value as ClientIpSource)
		: "auto";
}

/**
 * The connection peer as reported by the server runtime (srvx exposes it as
 * `request.ip` on Bun); absent on Cloudflare Workers and in tests.
 */
export function requestPeerAddress(request: Request): string | null {
	const ip = (request as Request & { ip?: unknown }).ip;
	return typeof ip === "string" ? ip : null;
}

/**
 * Return a request whose trusted-client-IP header reflects `ip` (and nothing a
 * client sent). Cloudflare-specific request properties are preserved.
 */
export function withTrustedClientIp(request: Request, ip: string | null) {
	const headers = new Headers(request.headers);
	headers.delete(CLIENT_IP_HEADER);
	if (ip) headers.set(CLIENT_IP_HEADER, ip);
	const cf = (request as Request & { cf?: unknown }).cf;
	return new Request(request, {
		headers,
		...(cf === undefined ? {} : ({ cf } as RequestInit)),
	});
}

/** Trusted client address for audit, rate limiting and provider payloads. */
export function clientIp(request: Request | undefined): string | null {
	return request ? clientIpFromHeaders(request.headers) : null;
}

export function clientIpFromHeaders(headers: Headers | undefined) {
	return normalizeIp(headers?.get(CLIENT_IP_HEADER));
}
