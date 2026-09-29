/**
 * SQL fragment that binds a batch statement to one exact order state. Every
 * statement that reserves stock, moves money or emits events for an order
 * appends it, so a batch whose leading transition did not apply changes
 * nothing else either.
 */
export type StatementGuard = {
	sql: string;
	bindings: readonly (string | number)[];
};

export function orderStateGuard(
	orderId: string,
	status: string,
	version: number,
): StatementGuard {
	return {
		sql: "EXISTS (SELECT 1 FROM shop_orders WHERE id = ? AND status = ? AND version = ?)",
		bindings: [orderId, status, version],
	};
}

export function paidOrderGuard(orderId: string, version: number) {
	return orderStateGuard(orderId, "paid", version);
}
