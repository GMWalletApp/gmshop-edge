import { z } from "zod";
import { constantTimeEqual } from "#/lib/crypto";
import { DomainError } from "#/lib/domain-error";
import { claimFixedWindowRateLimit } from "#/server/rate-limit";
import type { CloudflareBindings } from "#/server/runtime/cloudflare";
import { loadRuntimeConfig } from "#/server/runtime-config";
import {
	generateRedeemSellableInventory,
	generateSellableSchema,
	quickRestockRedeemWarehouse,
	quickRestockSchema,
} from "./admin";

// Token-authenticated counterpart of the admin quick restock, so the restock
// skill fills the warehouse and the storefront item in one call. A body without
// `content` only issues owned codes, for SKUs the warehouse buys keys for itself.
export async function handleRedeemRestockRequest(
	request: Request,
	env: CloudflareBindings,
	restock: typeof quickRestockRedeemWarehouse = quickRestockRedeemWarehouse,
	generate: typeof generateRedeemSellableInventory = generateRedeemSellableInventory,
): Promise<Response> {
	try {
		const db = env.DB;
		if (!db || !env.RESTOCK_API_TOKEN)
			throw new DomainError(
				"restock_api_unavailable",
				503,
				"Restock API unavailable",
			);
		const header = request.headers.get("authorization") ?? "";
		const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
		if (!supplied || !constantTimeEqual(supplied, env.RESTOCK_API_TOKEN))
			throw new DomainError("restock_unauthorized", 401, "Invalid credentials");
		if (request.method !== "POST")
			return new Response(null, { status: 405, headers: { Allow: "POST" } });
		const budget = await claimFixedWindowRateLimit(db, {
			bucketKey: `redeem-restock-api:${request.headers.get("cf-connecting-ip") ?? "unknown"}`,
			limit: 20,
			windowMs: 60_000,
			now: Date.now(),
		});
		if (!budget.allowed)
			throw new DomainError("restock_rate_limited", 429, "Rate limit exceeded");
		if (Number(request.headers.get("content-length") ?? "0") > 250_000)
			throw new DomainError(
				"restock_payload_too_large",
				413,
				"Payload too large",
			);
		const body: unknown = await request.json();
		const generateOnly =
			typeof body === "object" && body !== null && !("content" in body);
		const runtime = await loadRuntimeConfig(db);
		if (!runtime.commerceSecret)
			throw new DomainError(
				"restock_api_unavailable",
				503,
				"Restock API unavailable",
			);
		const context = {
			db,
			currentUser: { id: null },
			request,
			runtime: { commerceSecret: runtime.commerceSecret },
		};
		const result = generateOnly
			? await generate(generateSellableSchema.parse(body), context)
			: await restock(quickRestockSchema.parse(body), context);
		return json({ ok: true, ...result }, 200);
	} catch (error) {
		if (error instanceof DomainError)
			return json({ ok: false, error: error.code }, error.status);
		if (error instanceof z.ZodError || error instanceof SyntaxError)
			return json({ ok: false, error: "restock_invalid" }, 400);
		return json({ ok: false, error: "restock_failed" }, 500);
	}
}

function json(payload: unknown, status: number) {
	return Response.json(payload, {
		status,
		headers: { "Cache-Control": "no-store" },
	});
}
