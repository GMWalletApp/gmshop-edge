import { createFileRoute } from "@tanstack/react-router";
import { resolveStoreAccount } from "#/features/storefront/server/account";
import { storeDownloadResponse } from "#/features/storefront/server/download-response";
import {
	BodyLimitExceededError,
	readBoundedRequestJson,
} from "#/lib/bounded-stream";
import { DomainError } from "#/lib/domain-error";
import { getEnv } from "#/server/db.server";

export const Route = createFileRoute(
	"/api/shop/orders/$orderNumber/downloads/$assetId",
)({
	server: {
		handlers: {
			POST: async ({ request, params }) => {
				try {
					const body: unknown = await readBoundedRequestJson(request, 4_096);
					const email =
						typeof body === "object" && body !== null && "email" in body
							? String(body.email)
							: undefined;
					const env = getEnv();
					const account = await resolveStoreAccount(env.DB, request);
					return await storeDownloadResponse(
						request,
						{
							orderNumber: params.orderNumber,
							assetId: params.assetId,
							email,
						},
						env.DB,
						env.FILES,
						{ userId: account?.user.id },
					);
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
						{
							status,
							headers: {
								"Cache-Control": "private, no-store",
								"X-Content-Type-Options": "nosniff",
							},
						},
					);
				}
			},
		},
	},
});
