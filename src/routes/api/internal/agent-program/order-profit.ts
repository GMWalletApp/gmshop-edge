import { createFileRoute } from "@tanstack/react-router";
import { handleOrderProfitRequest } from "#/features/agent-program/server/order-profit";
import { getCloudflareEnv } from "#/server/db.server";

export const Route = createFileRoute(
	"/api/internal/agent-program/order-profit",
)({
	server: {
		handlers: {
			POST: ({ request }) =>
				handleOrderProfitRequest(request, getCloudflareEnv(request)),
		},
	},
});
