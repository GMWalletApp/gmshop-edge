import { createFileRoute } from "@tanstack/react-router";
import { renewalOrigin } from "#/features/renewals/server/links";
import { resolveItemLinkPath } from "#/features/storefront/server/order-growth";
import { getEnv } from "#/server/db.server";
import { loadRuntimeConfig } from "#/server/runtime-config";

// Stable deep link for other sites (e.g. the redeem site): /go/item/{itemId}?src=redeem.
export const Route = createFileRoute("/go/item/$itemId")({
	server: {
		handlers: {
			GET: async ({ params, request }) => {
				const db = getEnv().DB;
				const origin = renewalOrigin(await loadRuntimeConfig(db));
				const path = await resolveItemLinkPath(
					db,
					params.itemId,
					new URL(request.url).searchParams.get("src"),
				);
				return new Response(null, {
					status: 302,
					headers: {
						Location: `${origin}${path}`,
						"Cache-Control": "private, no-store",
						"Referrer-Policy": "no-referrer",
					},
				});
			},
		},
	},
});
