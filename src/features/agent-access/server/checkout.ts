import { DomainError } from "#/lib/domain-error";
import {
	agentAccessKind,
	agentAccessProducts,
	agentAccessRefundPolicy,
} from "../products";
import {
	normalizeSubsitePrefix,
	type SubsitePrefixState,
	subsiteDomain,
	subsitePrefixProblem,
} from "../subsite-prefix";
import {
	type AgentTransport,
	callAgent,
	requireAgentAccessEnabled,
} from "./client";

/**
 * Local rules first (no remote call for obvious mistakes), then lsrai.shop,
 * which owns the domain table. Advisory only: provision re-checks and falls back.
 */
export async function checkSubsitePrefix(
	raw: string,
	transport: AgentTransport = callAgent,
): Promise<{
	state: SubsitePrefixState;
	label: string;
	domain: string | null;
}> {
	const label = normalizeSubsitePrefix(raw);
	const problem = subsitePrefixProblem(label);
	if (problem)
		return {
			state: problem,
			label,
			domain: problem === "invalid" ? null : subsiteDomain(label),
		};
	const result = await transport({
		operation: "check_subdomain",
		subdomain: label,
	});
	if (
		result.state !== "available" &&
		result.state !== "invalid" &&
		result.state !== "reserved" &&
		result.state !== "taken"
	)
		throw new DomainError(
			"agent_access_unavailable",
			503,
			"Sub-site name check is unavailable",
		);
	return {
		state: result.state,
		label,
		domain: result.state === "invalid" ? null : subsiteDomain(label),
	};
}

export async function prepareAgentCheckout(
	db: D1Database,
	input: {
		items: Array<{ sellableItemId: string; quantity: number }>;
		couponCode?: string | null;
		agentAccessTermsAccepted?: boolean;
		agentSubsitePrefix?: string | null;
	},
	userId?: string,
	transport: AgentTransport = callAgent,
) {
	const items = input.items.filter((item) =>
		agentAccessKind(item.sellableItemId),
	);
	if (!items.length) return null;
	await requireAgentAccessEnabled(db);
	const item = items[0];
	const kind = item && agentAccessKind(item.sellableItemId);
	if (
		!kind ||
		!item ||
		input.items.length !== 1 ||
		item.quantity !== 1 ||
		input.couponCode
	)
		throw new DomainError(
			"agent_access_checkout_invalid",
			400,
			"Buy one access qualification separately without a coupon",
		);
	if (!userId)
		throw new DomainError("authentication_required", 401, "Sign in first");
	const user = await db
		.prepare("SELECT email,email_verified,enabled FROM users WHERE id=?")
		.bind(userId)
		.first<{ email: string; email_verified: number; enabled: number }>();
	if (!user || !user.enabled || !user.email_verified)
		throw new DomainError(
			"agent_access_email_verification",
			403,
			"Verify your account email before purchasing access",
		);
	if (input.agentAccessTermsAccepted !== true)
		throw new DomainError(
			"agent_access_terms_required",
			400,
			"Read and confirm the access activation and refund policy before purchasing",
		);
	const sku = await db
		.prepare(
			"SELECT price_minor,currency,currency_decimals FROM product_sellable_items WHERE id=?",
		)
		.bind(item.sellableItemId)
		.first<{
			price_minor: string;
			currency: string;
			currency_decimals: number;
		}>();
	if (
		!sku ||
		sku.price_minor !== agentAccessProducts[kind].priceMinor ||
		sku.currency !== "CNY" ||
		sku.currency_decimals !== 2
	)
		throw new DomainError(
			"agent_access_price_invalid",
			409,
			"Access product price configuration is invalid",
		);
	await db
		.prepare(
			`UPDATE agent_access_orders SET active_key=NULL,state='cancelled',updated_at=? WHERE state='pending' AND order_item_id IN (SELECT oi.id FROM shop_order_items oi JOIN shop_orders o ON o.id=oi.order_id WHERE o.status IN ('expired','cancelled') AND o.paid_minor='0')`,
		)
		.bind(Date.now())
		.run();
	const activeKey = `${userId}:${kind}`;
	const old = await db
		.prepare("SELECT order_item_id FROM agent_access_orders WHERE active_key=?")
		.bind(activeKey)
		.first();
	if (old)
		throw new DomainError(
			"agent_access_existing_order",
			409,
			"Continue your existing access order instead of paying again",
		);
	const email = user.email.trim().toLowerCase();
	const result = await transport({
		operation: "check",
		sourceUserId: userId,
		email,
		kind,
	});
	if (result.state !== "eligible")
		throw new DomainError(
			result.state === "already_active"
				? "agent_access_already_active"
				: "agent_access_binding_required",
			409,
			"Confirm the linked account on the product page before paying",
		);
	// Optional; empty means lsrai.shop assigns a pooled name at provision time.
	const prefix = normalizeSubsitePrefix(input.agentSubsitePrefix ?? "");
	if (prefix && kind !== "subsite")
		throw new DomainError(
			"agent_subsite_prefix_invalid",
			400,
			"Only sub-site access takes a sub-site name",
		);
	if (prefix) {
		const checked = await checkSubsitePrefix(prefix, transport);
		if (checked.state !== "available")
			throw new DomainError(
				`agent_subsite_prefix_${checked.state}`,
				409,
				"Choose another sub-site name or leave it empty",
			);
	}
	return {
		kind,
		email,
		userId,
		activeKey,
		itemId: item.sellableItemId,
		subdomain: prefix || null,
	};
}
export function agentCheckoutStatement(
	db: D1Database,
	prepared: NonNullable<Awaited<ReturnType<typeof prepareAgentCheckout>>>,
	orderItemId: string,
	now: number,
) {
	return db
		.prepare(
			`INSERT INTO agent_access_orders (order_item_id,user_id,kind,email,active_key,policy_snapshot,requested_subdomain,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
		)
		.bind(
			orderItemId,
			prepared.userId,
			prepared.kind,
			prepared.email,
			prepared.activeKey,
			JSON.stringify({ ...agentAccessRefundPolicy, acceptedAt: now }),
			prepared.subdomain,
			now,
			now,
		);
}
