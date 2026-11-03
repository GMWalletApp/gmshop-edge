import { createRootRoute } from "@tanstack/react-router";
import { attachRouterServerSsrUtils } from "@tanstack/router-core/ssr/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRouter } from "../../src/router";
import {
	CSP_NONCE_HEADER,
	createCspNonce,
} from "../../src/server/http-security";

const { getRequest } = vi.hoisted(() => ({ getRequest: vi.fn() }));
vi.mock("@tanstack/react-start/server", () => ({ getRequest }));
vi.mock("../../src/routeTree.gen", () => ({ routeTree: createRootRoute() }));
vi.mock("../../src/lib/i18n-runtime", () => ({}));

describe("request-scoped SSR nonce", () => {
	beforeEach(() => {
		getRequest.mockReturnValue(new Request("https://shop.example/install"));
	});

	it("nonces hydration bootstrap and boundary scripts before SSR attaches", () => {
		const nonce = createCspNonce();
		getRequest.mockReturnValue(
			new Request("https://shop.example/install", {
				headers: { [CSP_NONCE_HEADER]: nonce },
			}),
		);
		const router = getRouter();
		attachRouterServerSsrUtils({ router, manifest: undefined });
		const tags = router.serverSsr?.takeInitialHydrationScriptTags();

		expect(tags?.before.length).toBeGreaterThan(0);
		for (const tag of [...(tags?.before ?? []), tags?.boundary]) {
			expect(tag?.attrs?.nonce).toBe(nonce);
		}
	});

	it("does not reuse another request's nonce", () => {
		const firstNonce = createCspNonce();
		const secondNonce = createCspNonce();
		const routers = [firstNonce, secondNonce].map((nonce) => {
			getRequest.mockReturnValue(
				new Request("https://shop.example/", {
					headers: { [CSP_NONCE_HEADER]: nonce },
				}),
			);
			return getRouter();
		});
		expect(routers.map((router) => router.options.ssr?.nonce)).toEqual([
			firstNonce,
			secondNonce,
		]);
	});

	it.each([null, "<script>"])(
		"does not create a nonce policy from a missing or invalid header (%s)",
		(value) => {
			getRequest.mockReturnValue(
				new Request("https://shop.example/", {
					headers: value ? { [CSP_NONCE_HEADER]: value } : {},
				}),
			);
			expect(getRouter().options.ssr?.nonce).toBeUndefined();
		},
	);
});
