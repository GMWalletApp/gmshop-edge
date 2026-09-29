import { resolveStoreAccount } from "#/features/storefront/server/account";
import { revealStoreDelivery } from "#/features/storefront/server/delivery-reveal";
import {
	BodyLimitExceededError,
	readBoundedRequestJson,
} from "#/lib/bounded-stream";
import { DomainError } from "#/lib/domain-error";

export async function storeDeliveryRevealResponse(
	request: Request,
	orderNumber: string,
	deliveryId: string,
	db: D1Database,
) {
	try {
		const body: unknown = await readBoundedRequestJson(request, 4_096);
		const action =
			typeof body === "object" && body !== null && "action" in body
				? String(body.action)
				: "reveal";
		const email =
			typeof body === "object" && body !== null && "email" in body
				? String(body.email)
				: undefined;
		const account = await resolveStoreAccount(db, request);
		const result = await revealStoreDelivery(db, {
			orderNumber,
			deliveryId,
			email,
			request,
			userId: account?.user.id,
			actorUserId: account?.user.id,
			action: action as "reveal" | "copied",
		});
		return Response.json(result, { headers: privateHeaders });
	} catch (error) {
		if (error instanceof BodyLimitExceededError)
			return Response.json(
				{ code: "request_too_large" },
				{ status: 413, headers: privateHeaders },
			);
		const status = error instanceof DomainError ? error.status : 400;
		const code = error instanceof DomainError ? error.code : "invalid_request";
		return Response.json({ code }, { status, headers: privateHeaders });
	}
}

const privateHeaders = {
	"Cache-Control": "no-store, private",
	Pragma: "no-cache",
	"X-Content-Type-Options": "nosniff",
};
