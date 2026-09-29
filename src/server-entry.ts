import {
	createStartHandler,
	defaultStreamHandler,
} from "@tanstack/react-start/server";
import { handleLivenessRequest } from "#/features/status/server/health";
import {
	parseClientIpSource,
	requestPeerAddress,
	resolveClientIp,
	trustsProxyHeaders,
	withTrustedClientIp,
} from "#/server/client-ip";
import {
	applySecurityHeaders,
	CSP_NONCE_HEADER,
	createCspNonce,
	cspNonce,
} from "#/server/http-security";
import { validateRequestAuthority } from "#/server/middleware/authority";
import { handleI18nRequest } from "#/server/middleware/i18n";
import { handleQueue } from "#/server/queue";
import {
	carryRequestSettings,
	loadRequestSettings,
} from "#/server/request-settings";
import { adaptCloudflareEnv } from "#/server/runtime/cloudflare";
import { runWithRuntimeEnv } from "#/server/runtime/context";
import { withForwardedProtocol } from "#/server/runtime/forwarded-protocol";
import type { RuntimeEnv } from "#/server/runtime/types";
import { handleScheduled } from "#/server/scheduled";
import { appendServerTiming, takeRequestTiming } from "#/server/server-timing";

// The SSR renderer stamps the request's CSP nonce on every inline and module
// script it emits (and exposes it to the client through the csp-nonce meta).
const streamHandler: typeof defaultStreamHandler = (context) => {
	const nonce = cspNonce(context.request);
	if (nonce) context.router.options.ssr = { nonce };
	return defaultStreamHandler(context);
};
const appFetch = createStartHandler(streamHandler);

// Requests above this size are refused before any handler buffers them; the
// largest legitimate body is an automation artifact upload (100 MiB).
const MAX_REQUEST_BODY_BYTES = 100 * 1024 * 1024;

export async function handleAppRequest(incoming: Request, env: RuntimeEnv) {
	const startedAt = performance.now();
	const liveness = handleLivenessRequest(incoming);
	if (liveness)
		return applySecurityHeaders(
			incoming,
			appendServerTiming(liveness, [
				{ name: "total", durationMs: performance.now() - startedAt },
			]),
		);
	const declaredLength = Number(incoming.headers.get("content-length") ?? 0);
	if (
		!Number.isFinite(declaredLength) ||
		declaredLength > MAX_REQUEST_BODY_BYTES
	)
		return applySecurityHeaders(
			incoming,
			new Response("Payload Too Large", { status: 413 }),
		);
	const authorityStartedAt = performance.now();
	const rejected = await validateRequestAuthority(
		incoming,
		env.DB as D1Database | undefined,
	);
	const authorityDurationMs = performance.now() - authorityStartedAt;
	if (rejected)
		return applySecurityHeaders(
			incoming,
			appendServerTiming(rejected, [
				{ name: "authority", durationMs: authorityDurationMs },
				{ name: "total", durationMs: performance.now() - startedAt },
			]),
		);
	const request = await normalizeRequest(incoming, env);
	const appStartedAt = performance.now();
	const response = await handleI18nRequest(
		request,
		env.DB as D1Database | undefined,
		env.CACHE as KVNamespace | undefined,
		appFetch,
	);
	return applySecurityHeaders(
		request,
		appendServerTiming(response, [
			{ name: "authority", durationMs: authorityDurationMs },
			...takeRequestTiming(request),
			{ name: "app", durationMs: performance.now() - appStartedAt },
			{ name: "total", durationMs: performance.now() - startedAt },
		]),
		{ nonce: cspNonce(request) },
	);
}

/**
 * Derive the trusted client address and public scheme once, from settings the
 * operator controls, and hand downstream code a request that carries them.
 */
async function normalizeRequest(incoming: Request, env: RuntimeEnv) {
	const db = env.DB as D1Database | undefined;
	const settings = db ? await loadRequestSettings(incoming, db) : null;
	const source = parseClientIpSource(
		parseStoredString(settings?.get("security.client_ip_source")),
	);
	const canonicalOrigin = parseStoredString(
		settings?.get("runtime.better_auth_url"),
	);
	const peer = requestPeerAddress(incoming);
	const withProtocol =
		env.runtime === "cloudflare"
			? incoming
			: withForwardedProtocol(incoming, {
					trustProxyHeaders: trustsProxyHeaders(env.runtime, source, peer),
					canonicalOrigin,
				});
	const request = withTrustedClientIp(
		withProtocol,
		resolveClientIp(incoming.headers, env.runtime, source, peer),
	);
	// The Vite development server injects its own inline scripts, so the nonce
	// policy is only enforced on production builds.
	const nonce = import.meta.env.DEV ? null : createCspNonce();
	request.headers.delete(CSP_NONCE_HEADER);
	if (nonce) request.headers.set(CSP_NONCE_HEADER, nonce);
	carryRequestSettings(incoming, request);
	return request;
}

function parseStoredString(value: string | undefined) {
	if (!value) return null;
	try {
		const parsed: unknown = JSON.parse(value);
		return typeof parsed === "string" ? parsed : null;
	} catch {
		return null;
	}
}

export default {
	async fetch(request: Request, env: Env, context: ExecutionContext) {
		const runtimeEnv = adaptCloudflareEnv(env, context.waitUntil.bind(context));
		return runWithRuntimeEnv(runtimeEnv, () =>
			handleAppRequest(request, runtimeEnv),
		);
	},
	queue: handleQueue,
	scheduled: handleScheduled,
};
