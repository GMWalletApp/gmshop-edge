import { createMiddleware } from "@tanstack/react-start";

import { requireAdmin } from "#/features/access/server/require-admin";
import { adminAccessErrorResponse } from "#/server/access-error-response";
import { isPublicApiRequest } from "#/server/api-boundaries";

export const protectedApiMiddleware = createMiddleware({
	type: "request",
}).server(async ({ request, next }) => {
	const url = new URL(request.url);

	if (!url.pathname.startsWith("/api/") || isPublicApiRequest(request)) {
		return next();
	}

	try {
		await requireAdmin(request);
		return await next();
	} catch (error) {
		return adminAccessErrorResponse(request, error);
	}
});
