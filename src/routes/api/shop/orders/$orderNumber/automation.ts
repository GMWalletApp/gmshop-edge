import { createFileRoute } from "@tanstack/react-router";
import { createBuildJob } from "#/features/builds/server/jobs";
import { publishPendingBuilds } from "#/features/builds/server/outbox";
import { resolveStoreAccount } from "#/features/storefront/server/account";
import {
	BodyLimitExceededError,
	readBoundedRequestJson,
} from "#/lib/bounded-stream";
import { DomainError } from "#/lib/domain-error";
import { getEnv } from "#/server/db.server";

export const Route = createFileRoute(
	"/api/shop/orders/$orderNumber/automation",
)({
	server: {
		handlers: {
			POST: async ({ request, params }) => {
				try {
					const body: unknown = await readBoundedRequestJson(
						request,
						128 * 1024,
					);
					const input =
						typeof body === "object" && body !== null
							? { ...body, orderNumber: params.orderNumber }
							: body;
					const env = getEnv();
					const account = await resolveStoreAccount(env.DB, request);
					const result = await createBuildJob(env.DB, input, {
						userId: account?.user.id,
						actorUserId: account?.user.id,
						request,
					});
					await publishPendingBuilds(env.DB, env.COMMERCE_QUEUE);
					return Response.json(result, {
						status: result.duplicate ? 200 : 201,
						headers: { "Cache-Control": "private, no-store" },
					});
				} catch (error) {
					if (error instanceof BodyLimitExceededError)
						return Response.json(
							{ code: "request_too_large" },
							{
								status: 413,
								headers: { "Cache-Control": "private, no-store" },
							},
						);
					const status = error instanceof DomainError ? error.status : 400;
					const code =
						error instanceof DomainError ? error.code : "invalid_request";
					return Response.json(
						{ code },
						{ status, headers: { "Cache-Control": "private, no-store" } },
					);
				}
			},
		},
	},
});
