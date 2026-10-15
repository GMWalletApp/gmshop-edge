import { createFileRoute } from "@tanstack/react-router";
import { unsubscribeRenewalEmail } from "#/features/renewals/server/links";
import { getEnv } from "#/server/db.server";

// RFC 8058 one-click target for the List-Unsubscribe header.
export const Route = createFileRoute("/api/shop/renewal/unsubscribe")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				const url = new URL(request.url);
				const result = await unsubscribeRenewalEmail(
					getEnv().DB,
					url.searchParams.get("e"),
					url.searchParams.get("sig"),
				);
				return Response.json(
					{ code: result.ok ? "unsubscribed" : "invalid_link" },
					{
						status: result.ok ? 200 : 400,
						headers: { "Cache-Control": "private, no-store" },
					},
				);
			},
		},
	},
});
