import { trackCommerceEventFn } from "#/features/storefront/server/functions";

const SESSION_KEY = "gmshop-commerce-session";

export function commerceSessionId() {
	if (typeof window === "undefined") return null;
	let value = window.sessionStorage.getItem(SESSION_KEY);
	if (!value) {
		value = crypto.randomUUID();
		window.sessionStorage.setItem(SESSION_KEY, value);
	}
	return value;
}

export function trackCommerceEvent(input: {
	eventType:
		| "catalog_viewed"
		| "product_viewed"
		| "cart_item_added"
		| "checkout_started"
		| "cross_sell_landed"
		| "redeem_landed";
	productId?: string;
	sellableItemId?: string;
}) {
	const sessionId = commerceSessionId();
	if (!sessionId) return;
	void trackCommerceEventFn({
		data: {
			...input,
			sessionId,
			productId: input.productId ?? null,
			sellableItemId: input.sellableItemId ?? null,
		},
	}).catch(() => undefined);
}
