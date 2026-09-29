import { describe, expect, it } from "vitest";
import { AccessDeniedError } from "#/features/access/server/access-cache";
import { adminAccessErrorResponse } from "#/server/access-error-response";
import { apiError, json, requestId, withRequestId } from "#/server/http";
import {
	applySecurityHeaders,
	CSP_NONCE_HEADER,
	createCspNonce,
	cspNonce,
} from "#/server/http-security";
import { withForwardedProtocol } from "#/server/runtime/forwarded-protocol";

describe("application security headers", () => {
	it("keeps one request ID for the complete request lifecycle", () => {
		const request = new Request("https://example.com/api/test");
		const first = requestId(request);

		expect(requestId(request)).toBe(first);
		expect(
			withRequestId(request, new Response()).headers.get("x-request-id"),
		).toBe(first);
		expect(
			apiError(
				request,
				500,
				"internal_error",
				"Internal server error",
			).headers.get("x-request-id"),
		).toBe(first);
	});

	it("uses the first valid upstream request ID", () => {
		const request = new Request("https://example.com/api/test", {
			headers: {
				"cf-ray": "invalid ray value",
				"x-request-id": "valid-request-id",
			},
		});

		expect(requestId(request)).toBe("valid-request-id");
	});

	it("applies CSP, isolation, framing and HTTPS transport policy", () => {
		const response = applySecurityHeaders(
			new Request("https://pay.example/admin"),
			new Response("ok"),
		);
		expect(response.headers.get("content-security-policy")).toContain(
			"frame-ancestors 'none'",
		);
		expect(response.headers.get("content-security-policy")).toContain(
			"object-src 'none'",
		);
		expect(response.headers.get("content-security-policy")).toContain(
			"script-src 'self' 'unsafe-inline' https:",
		);
		expect(response.headers.get("content-security-policy")).not.toContain(
			"script-src 'self' 'unsafe-inline' http:",
		);
		expect(response.headers.get("content-security-policy")).not.toContain(
			"'nonce-",
		);
		expect(response.headers.get("content-security-policy")).toContain(
			"frame-src 'self' https:",
		);
		expect(response.headers.get("content-security-policy")).not.toContain(
			"cdn.jsdmirror.com",
		);
		expect(response.headers.get("cross-origin-opener-policy")).toBe(
			"same-origin",
		);
		expect(response.headers.get("x-frame-options")).toBe("DENY");
		expect(response.headers.get("strict-transport-security")).toContain(
			"max-age=31536000",
		);
	});

	it("enforces a nonce-based script policy for production renders", () => {
		const nonce = createCspNonce();
		const request = new Request("https://pay.example/", {
			headers: { [CSP_NONCE_HEADER]: nonce },
		});
		expect(cspNonce(request)).toBe(nonce);
		const policy = applySecurityHeaders(request, new Response("ok"), {
			nonce,
		}).headers.get("content-security-policy");
		expect(policy).toContain(
			`script-src 'nonce-${nonce}' 'strict-dynamic' 'self' 'unsafe-inline' https:`,
		);
		expect(policy).toContain("object-src 'none'");
		expect(
			cspNonce(
				new Request("https://pay.example/", {
					headers: { [CSP_NONCE_HEADER]: "<script>" },
				}),
			),
		).toBeNull();
	});

	it("derives HTTPS from the configured public origin when the proxy sends no header", () => {
		const canonical = withForwardedProtocol(
			new Request("http://shop.example/install"),
			{ trustProxyHeaders: false, canonicalOrigin: "https://shop.example" },
		);
		expect(canonical.url).toBe("https://shop.example/install");
		const untrusted = withForwardedProtocol(
			new Request("http://shop.example/install", {
				headers: { "x-forwarded-proto": "https" },
			}),
			{ trustProxyHeaders: false, canonicalOrigin: "http://localhost:3000" },
		);
		expect(untrusted.url).toBe("http://shop.example/install");
	});

	it("does not send HSTS over local HTTP", () => {
		const response = applySecurityHeaders(
			new Request("http://localhost:3000/"),
			new Response("ok"),
		);
		expect(response.headers.has("strict-transport-security")).toBe(false);
	});

	it("recognizes HTTPS terminated by the first reverse proxy", () => {
		const request = withForwardedProtocol(
			new Request("http://shop.example/install", {
				headers: { "x-forwarded-proto": "https, http" },
			}),
		);
		const response = applySecurityHeaders(request, new Response("ok"));

		expect(request.url).toBe("https://shop.example/install");
		expect(response.headers.get("strict-transport-security")).toContain(
			"max-age=31536000",
		);
	});

	it("applies an explicit route cache matrix without overriding R2 assets", () => {
		for (const path of [
			"/admin",
			"/account/orders/order-id",
			"/orders/lookup",
			"/sign-in",
			"/install",
			"/api/auth/get-session",
		]) {
			const response = applySecurityHeaders(
				new Request(`https://pay.example${path}`),
				new Response("ok"),
			);
			expect(response.headers.get("cache-control"), path).toBe(
				"private, no-store",
			);
		}
		for (const path of ["/", "/favicon.ico", "/robots.txt"]) {
			const response = applySecurityHeaders(
				new Request(`https://pay.example${path}`),
				new Response("ok"),
			);
			expect(response.headers.get("cache-control"), path).toBe(
				"public, max-age=0, must-revalidate",
			);
		}
		const status = applySecurityHeaders(
			new Request("https://pay.example/status"),
			new Response("ok"),
		);
		expect(status.headers.get("cache-control")).toBe("no-store");
		const localized = applySecurityHeaders(
			new Request("https://pay.example/", {
				headers: { cookie: "PARAGLIDE_LOCALE=zh-CN" },
			}),
			new Response("ok"),
		);
		expect(localized.headers.get("cache-control")).toBe("private, no-store");
		const builtAsset = applySecurityHeaders(
			new Request("https://pay.example/assets/app-C0FFEE12.js"),
			new Response("ok"),
		);
		expect(builtAsset.headers.get("cache-control")).toBe(
			"public, max-age=31536000, immutable",
		);
		const siteAsset = applySecurityHeaders(
			new Request("https://pay.example/api/site-logo"),
			new Response("ok", {
				headers: { "cache-control": "public, max-age=3600" },
			}),
		);
		expect(siteAsset.headers.get("cache-control")).toBe("public, max-age=3600");
	});

	it("does not heuristically cache unknown routes or mutations", () => {
		for (const request of [
			new Request("https://pay.example/not-found"),
			new Request("https://pay.example/", { method: "POST" }),
		]) {
			const response = applySecurityHeaders(request, new Response("ok"));
			expect(response.headers.get("cache-control")).toContain("no-store");
			expect(response.headers.get("pragma")).toBe("no-cache");
		}
	});

	it("prevents caching successful and error JSON API responses", () => {
		const request = new Request(
			"https://pay.example/api/store/orders/order-id",
		);
		const success = withRequestId(request, json({ data: { status: "paid" } }));
		const failure = apiError(request, 404, "order_not_found", "Not found");
		for (const response of [success, failure]) {
			expect(response.headers.get("cache-control")).toBe("no-store");
			expect(response.headers.get("pragma")).toBe("no-cache");
			expect(response.headers.get("x-request-id")).toBeTruthy();
		}
	});

	it("overrides accidental public cache headers on error responses", () => {
		const response = applySecurityHeaders(
			new Request("https://pay.example/assets/missing.js"),
			new Response("not found", {
				status: 404,
				headers: { "cache-control": "public, max-age=31536000, immutable" },
			}),
		);

		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("pragma")).toBe("no-cache");
	});

	it("maps only explicit access denials and redacts internal failures", async () => {
		const request = new Request("https://pay.example/api/admin/resource");
		const unauthorized = adminAccessErrorResponse(
			request,
			new AccessDeniedError(401),
		);
		const forbidden = adminAccessErrorResponse(
			request,
			new AccessDeniedError(403),
		);
		const internal = adminAccessErrorResponse(
			request,
			new Error("D1_ERROR: secret query text"),
		);

		expect(unauthorized.status).toBe(401);
		expect(forbidden.status).toBe(403);
		expect(internal.status).toBe(500);
		expect(await internal.text()).not.toContain("D1_ERROR");
		expect(internal.headers.get("cache-control")).toBe("no-store");
		expect(internal.headers.get("x-request-id")).toBeTruthy();
	});
});
