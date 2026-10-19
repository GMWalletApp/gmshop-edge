import { createStoreOrderSchema } from "#/features/storefront/schema";
import { createMultiStoreOrder } from "./multi-order";

export async function createStoreOrder(
	db: D1Database,
	rawInput: unknown,
	access: {
		userId?: string;
		identityEmail?: string;
		pricingChannelId?: string;
		clientIp?: string | null;
	} = {},
) {
	return createMultiStoreOrder(
		db,
		createStoreOrderSchema.parse(rawInput),
		access,
	);
}
