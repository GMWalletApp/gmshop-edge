import {
	BodyLimitExceededError,
	readBoundedResponseBytes,
} from "#/lib/bounded-stream";
import { DomainError } from "#/lib/domain-error";
import { classifyIpAddress, isPublicIpAddress } from "#/lib/ip-address";
import { isSafeWebhookUrl } from "#/lib/webhook-url";
import { currentRuntimeEnv } from "#/server/runtime/context";

export type DnsResolver = (
	hostname: string,
	type: "A" | "AAAA",
) => Promise<string[]>;

export type OutboundFetchOptions = {
	fetcher?: typeof fetch;
	/** Cancel and reject response bodies larger than this many bytes. */
	maxResponseBytes?: number;
	/** Abort the request after this long. Defaults to 10 seconds. */
	timeoutMs?: number;
	/** DNS resolver used to prove the hostname is public. */
	resolve?: DnsResolver;
	/**
	 * Skip the DNS check. Only for tests that inject a fetcher; Cloudflare
	 * Workers skip it automatically because private ranges are unreachable.
	 */
	validateDestination?: boolean;
	/**
	 * Return 3xx responses instead of rejecting them, for the rare endpoint
	 * whose success answer is a redirect (a hosted checkout submit). The
	 * redirect is never followed.
	 */
	expectRedirect?: boolean;
};

const defaultTimeoutMs = 10_000;
const nullBodyStatuses = new Set([101, 204, 205, 304]);

/**
 * Fetches an administrator-configured HTTPS endpoint without following
 * redirects, with a timeout, an optional response-size bound, and (outside
 * Cloudflare Workers) a proof that the hostname resolves only to public
 * addresses. Failures surface as structured `DomainError`s.
 */
export async function fetchOutbound(
	input: string | URL,
	init: RequestInit = {},
	options: OutboundFetchOptions = {},
): Promise<Response> {
	const url = parseOutboundUrl(input);
	if (options.validateDestination !== false && !runningOnCloudflareWorkers())
		await assertPublicHostname(url.hostname, options.resolve);
	const fetcher = options.fetcher ?? fetch;
	const timeout = AbortSignal.timeout(options.timeoutMs ?? defaultTimeoutMs);
	let response: Response;
	try {
		response = await fetcher(url.toString(), {
			...init,
			redirect: "manual",
			signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
		});
	} catch {
		throw requestFailed();
	}
	if (
		!options.expectRedirect &&
		response.status >= 300 &&
		response.status < 400
	)
		throw new DomainError(
			"outbound_redirect_rejected",
			502,
			"Outbound redirects are not followed",
		);
	if (options.maxResponseBytes === undefined) return response;
	let bytes: Uint8Array;
	try {
		bytes = await readBoundedResponseBytes(response, options.maxResponseBytes);
	} catch (error) {
		if (error instanceof BodyLimitExceededError)
			throw new DomainError(
				"outbound_response_too_large",
				502,
				"Outbound response exceeded the size limit",
			);
		// A body that stalls past the timeout or a connection reset while
		// draining is the same failure class as a request that never connected.
		throw requestFailed();
	}
	return new Response(
		nullBodyStatuses.has(response.status) ? null : new Uint8Array(bytes),
		{
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		},
	);
}

// Verdicts are cached briefly so a checkout does not pay two DNS lookups per
// provider call; the bound keeps the map small under hostile hostnames.
const HOSTNAME_VERDICT_TTL_MS = 60_000;
const HOSTNAME_VERDICT_LIMIT = 256;
const publicHostnameVerdicts = new Map<string, number>();

/**
 * Rejects hostnames that resolve to any non-public address, including mixed
 * answers used for DNS rebinding. Literal addresses were already screened by
 * the URL rules and need no lookup.
 */
export async function assertPublicHostname(
	hostname: string,
	resolve: DnsResolver = resolvePublicly,
) {
	const key = hostname.toLowerCase();
	if (classifyIpAddress(key) === "public") return;
	// Only verdicts from the real resolver are cached; injected resolvers
	// (tests) always run.
	const cacheable = resolve === resolvePublicly;
	const cachedUntil = cacheable ? publicHostnameVerdicts.get(key) : undefined;
	if (cachedUntil !== undefined && cachedUntil > Date.now()) return;
	const answers = (
		await Promise.all([resolve(key, "A"), resolve(key, "AAAA")])
	).flat();
	if (!answers.length || answers.some((answer) => !isPublicIpAddress(answer)))
		throw new DomainError(
			"outbound_destination_rejected",
			400,
			"Outbound hostname must resolve only to public addresses",
		);
	if (!cacheable) return;
	if (publicHostnameVerdicts.size >= HOSTNAME_VERDICT_LIMIT)
		publicHostnameVerdicts.delete(
			publicHostnameVerdicts.keys().next().value as string,
		);
	publicHostnameVerdicts.set(key, Date.now() + HOSTNAME_VERDICT_TTL_MS);
}

export function runningOnCloudflareWorkers() {
	try {
		return currentRuntimeEnv().runtime === "cloudflare";
	} catch {
		// Outside a request scope (queue or cron work) fall back to the runtime's
		// own user agent.
	}
	return (
		typeof navigator !== "undefined" &&
		navigator.userAgent === "Cloudflare-Workers"
	);
}

function parseOutboundUrl(input: string | URL) {
	const value = input instanceof URL ? input.toString() : input;
	if (!isSafeWebhookUrl(value))
		throw new DomainError(
			"outbound_url_rejected",
			400,
			"Outbound URL must be a public HTTPS address",
		);
	return new URL(value);
}

/**
 * DNS-over-HTTPS first (independent of the host's resolver configuration);
 * when that service is unreachable the runtime's own resolver answers, which
 * is also the resolver the subsequent fetch will use.
 */
async function resolvePublicly(hostname: string, type: "A" | "AAAA") {
	try {
		return await resolveDnsOverHttps(hostname, type);
	} catch (error) {
		const fallback = await resolveWithRuntime(hostname, type);
		if (fallback === null) throw error;
		return fallback;
	}
}

async function resolveDnsOverHttps(hostname: string, type: "A" | "AAAA") {
	const url = new URL("https://cloudflare-dns.com/dns-query");
	url.searchParams.set("name", hostname);
	url.searchParams.set("type", type);
	const response = await fetch(url, {
		headers: { Accept: "application/dns-json" },
		redirect: "error",
		signal: AbortSignal.timeout(5_000),
	}).catch(() => null);
	if (!response?.ok) throw dnsUnavailable();
	const value = (await response.json().catch(() => null)) as {
		Status?: unknown;
		Answer?: Array<{ type?: unknown; data?: unknown }>;
	} | null;
	if (!value || (value.Status !== 0 && value.Status !== 3))
		throw dnsUnavailable();
	const expected = type === "A" ? 1 : 28;
	return (value.Answer ?? [])
		.filter(
			(answer) => answer.type === expected && typeof answer.data === "string",
		)
		.map((answer) => String(answer.data).toLowerCase());
}

async function resolveWithRuntime(
	hostname: string,
	type: "A" | "AAAA",
): Promise<string[] | null> {
	try {
		const dns = await import("node:dns/promises");
		const answers =
			type === "A"
				? await dns.resolve4(hostname)
				: await dns.resolve6(hostname);
		return answers.map((answer) => answer.toLowerCase());
	} catch (error) {
		// NODATA/NXDOMAIN mean "no addresses of this family", which is a valid
		// answer; anything else (resolver down, module unavailable) is not.
		const code = (error as { code?: unknown }).code;
		if (code === "ENODATA" || code === "ENOTFOUND") return [];
		return null;
	}
}

function requestFailed() {
	return new DomainError(
		"outbound_request_failed",
		502,
		"Outbound request failed",
	);
}

function dnsUnavailable() {
	return new DomainError(
		"outbound_dns_unavailable",
		503,
		"Outbound hostname could not be resolved safely",
	);
}
