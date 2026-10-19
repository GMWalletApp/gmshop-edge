import { createFileRoute } from "@tanstack/react-router";
import { handleDeliverySwapRequest } from "#/features/catalog/server/delivery-swap";
import { getCloudflareEnv } from "#/server/db.server";

export const Route = createFileRoute("/api/ops/restock/swap")({
	server: {
		handlers: {
			POST: ({ request }) =>
				handleDeliverySwapRequest(request, getCloudflareEnv(request)),
		},
	},
});
