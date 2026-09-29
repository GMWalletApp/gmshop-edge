import type { ShopOrderStatus } from "#/features/shop-orders/schema";
import { DomainError } from "#/lib/domain-error";

const allowedTransitions: Record<ShopOrderStatus, readonly ShopOrderStatus[]> =
	{
		pending_payment: ["paid", "cancelled", "expired", "failed"],
		paid: ["fulfilling", "refunding", "failed"],
		fulfilling: ["completed", "refunding", "failed"],
		completed: ["refunding"],
		cancelled: [],
		// A verified late payment (or an administrator confirming an offline
		// payment) may revive an expired order; fulfillment runs as for any paid order.
		expired: ["paid"],
		refunding: ["refunded", "completed", "failed"],
		refunded: [],
		failed: ["fulfilling", "refunding"],
	};

export function canTransitionShopOrder(
	from: ShopOrderStatus,
	to: ShopOrderStatus,
) {
	return allowedTransitions[from].includes(to);
}

export function assertShopOrderTransition(
	from: ShopOrderStatus,
	to: ShopOrderStatus,
) {
	if (!canTransitionShopOrder(from, to))
		throw new DomainError(
			"order_transition_invalid",
			409,
			`Cannot transition an order from ${from} to ${to}`,
		);
}
