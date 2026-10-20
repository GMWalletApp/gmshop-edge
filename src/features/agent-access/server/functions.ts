import { createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import { resolveStoreAccount } from "#/features/storefront/server/account";
import { DomainError } from "#/lib/domain-error";
import { decryptSecret } from "#/lib/secrets";
import { getDb } from "#/server/db.server";
import { claimFixedWindowRateLimit } from "#/server/rate-limit";
import { loadRuntimeConfig } from "#/server/runtime-config";
import { type AgentAccessKind, agentAccessKind } from "../products";
import { checkSubsitePrefix } from "./checkout";
import {
	accessURL,
	agentOrigin,
	callAgent,
	requireAgentAccessEnabled,
} from "./client";

function privateResponse() {
	setResponseHeader("Cache-Control", "no-store");
}
function sameOrigin(request: Request) {
	if (request.headers.get("origin") !== new URL(request.url).origin)
		throw new DomainError("origin_invalid", 403, "Origin is not allowed");
}
async function buyer() {
	const request = getRequest();
	privateResponse();
	sameOrigin(request);
	const db = getDb(request).$client;
	const account = await resolveStoreAccount(db, request, { required: true });
	if (!account?.user.emailVerified)
		throw new DomainError(
			"agent_access_email_verification",
			403,
			"Verify your account email first",
		);
	return { db, user: account.user };
}
export const checkAgentAccessFn = createServerFn({ method: "POST" })
	.validator((input: { itemId: string }) =>
		z.object({ itemId: z.uuid() }).parse(input),
	)
	.handler(async ({ data }) => {
		const kind = agentAccessKind(data.itemId);
		if (!kind) return null;
		const { db, user } = await buyer();
		await requireAgentAccessEnabled(db);
		const result = await callAgent({
			operation: "check",
			sourceUserId: user.id,
			email: user.email.trim().toLowerCase(),
			kind,
		});
		return {
			state: result.state,
			url:
				result.state === "binding_required"
					? accessURL(result)
					: `${agentOrigin}/auth/login`,
		};
	});
export const subsitePrefixCheckLimit = { limit: 20, windowMs: 60_000 };
// Signed-in, verified buyers only; each call is one signed lsrai.shop request.
export async function checkSubsitePrefixForBuyer(
	db: D1Database,
	userId: string,
	prefix: string,
	check: typeof checkSubsitePrefix = checkSubsitePrefix,
) {
	await requireAgentAccessEnabled(db);
	const quota = await claimFixedWindowRateLimit(db, {
		bucketKey: `agent-subsite-prefix:${userId}`,
		...subsitePrefixCheckLimit,
	});
	if (!quota.allowed)
		throw new DomainError(
			"agent_subsite_prefix_rate_limited",
			429,
			"Too many sub-site name checks; wait a minute",
		);
	return check(prefix);
}
export const checkAgentSubsitePrefixFn = createServerFn({ method: "POST" })
	.validator((input: { prefix: string }) =>
		z.object({ prefix: z.string().max(64) }).parse(input),
	)
	.handler(async ({ data }) => {
		const { db, user } = await buyer();
		return checkSubsitePrefixForBuyer(db, user.id, data.prefix);
	});
const orderSchema = z.object({ orderNumber: z.string().min(1).max(100) });
async function owned(db: D1Database, userId: string, orderNumber: string) {
	const row = await db
		.prepare(
			`SELECT a.*,o.status AS order_status FROM agent_access_orders a JOIN shop_order_items oi ON oi.id=a.order_item_id JOIN shop_orders o ON o.id=oi.order_id WHERE o.order_number=? AND o.user_id=? AND a.user_id=? LIMIT 1`,
		)
		.bind(orderNumber, userId, userId)
		.first<{
			initial_password_encrypted: string | null;
			order_item_id: string;
			kind: AgentAccessKind;
			email: string;
			state: string;
			domain: string | null;
			requested_subdomain: string | null;
			subdomain_fallback: string | null;
			attempt_count: number;
			error_code: string | null;
			order_status: string;
		}>();
	if (!row) throw new DomainError("order_not_found", 404, "Order not found");
	return row;
}
export const getAgentDeliveryFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof orderSchema>) => orderSchema.parse(input))
	.handler(async ({ data }) => {
		const { db, user } = await buyer();
		const row = await owned(db, user.id, data.orderNumber);
		return {
			email: row.email,
			kind: row.kind,
			state: row.state,
			domain: row.domain,
			// Only a lost race is worth telling the buyer; other fallbacks were refused at checkout.
			prefixFallback:
				row.subdomain_fallback === "taken" && row.requested_subdomain
					? row.requested_subdomain
					: null,
			needsSupport: row.attempt_count >= 8,
			errorCode: row.error_code,
			orderStatus: row.order_status,
		};
	});
export const openAgentAccountFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof orderSchema>) => orderSchema.parse(input))
	.handler(async ({ data }) => {
		const { db, user } = await buyer();
		const row = await owned(db, user.id, data.orderNumber);
		if (row.state !== "active" || row.order_status !== "completed")
			throw new DomainError("agent_access_pending", 409, "Access is not ready");
		const initialPassword = row.initial_password_encrypted
			? await decryptSecret(
					row.initial_password_encrypted,
					(await loadRuntimeConfig(db)).commerceSecret,
					"agent-initial-password",
				)
			: undefined;
		const result = await callAgent({
			initialPassword,
			operation: "access",
			sourceUserId: user.id,
			email: row.email,
			kind: row.kind,
			orderItemId: row.order_item_id,
		});
		if (result.state !== "active")
			throw new DomainError("agent_access_pending", 409, "Access is not ready");
		if (row.initial_password_encrypted && !result.initialPasswordValid) {
			await db
				.prepare(
					"UPDATE agent_access_orders SET initial_password_encrypted=NULL WHERE order_item_id=?",
				)
				.bind(row.order_item_id)
				.run();
		}
		return {
			url: result.initialPasswordValid
				? `${agentOrigin}/auth/login`
				: accessURL(result),
			initialPassword: result.initialPasswordValid
				? initialPassword
				: undefined,
		};
	});
