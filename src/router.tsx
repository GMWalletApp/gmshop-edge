import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { getContext, ssrQueryDehydrateOptions } from "./context/tanstack-query";
import { cspNonce } from "./server/http-security";
import "./lib/i18n-runtime";
import { routeTree } from "./routeTree.gen";

// Start captures the nonce when it attaches SSR utilities, before rendering.
const requestNonce = createIsomorphicFn().server(
	() => cspNonce(getRequest()) ?? undefined,
);

export function getRouter() {
	const context = getContext();

	const router = createTanStackRouter({
		routeTree,
		context,
		ssr: { nonce: requestNonce() },
		scrollRestoration: true,
		defaultPreload: "intent",
		defaultPreloadStaleTime: 30_000,
	});

	setupRouterSsrQueryIntegration({
		router,
		queryClient: context.queryClient,
		dehydrateOptions: ssrQueryDehydrateOptions,
	});

	return router;
}

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof getRouter>;
	}
}
