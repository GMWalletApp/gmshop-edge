// One redemption site serves two channels. Storefront buyers see the storefront host; resellers,
// who order through the supplier API, see theirs. The host stored inside older stock entries is
// irrelevant: it is rewritten when content is shown, emailed or returned.
export const STOREFRONT_REDEEM_URL = "https://redeem.laoshirenvip.com";
export const RESELLER_REDEEM_URL = "https://redeem.lsrai.shop";

const KNOWN_REDEEM_URL =
	/https:\/\/redeem\.(?:lsrai\.shop|laoshirenvip\.com)\/?/g;

export function withRedeemHost(content: string, url: string) {
	return content.replace(KNOWN_REDEEM_URL, url);
}

export async function redeemUrlForOrder(db: D1Database, orderId: string) {
	const viaApi = await db
		.prepare(
			"SELECT 1 FROM supplier_api_orders WHERE shop_order_id = ? LIMIT 1",
		)
		.bind(orderId)
		.first();
	return viaApi ? RESELLER_REDEEM_URL : STOREFRONT_REDEEM_URL;
}
