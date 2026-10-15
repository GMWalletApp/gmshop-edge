import { createFileRoute } from "@tanstack/react-router";
import { resolveRenewalClick } from "#/features/renewals/server/links";
import { getEnv } from "#/server/db.server";

export const Route = createFileRoute("/r/renew/$token")({
	server: {
		handlers: {
			GET: async ({ params }) =>
				new Response(null, {
					status: 302,
					headers: {
						Location: await resolveRenewalClick(getEnv().DB, params.token),
						"Cache-Control": "private, no-store",
						"Referrer-Policy": "no-referrer",
					},
				}),
		},
	},
});
