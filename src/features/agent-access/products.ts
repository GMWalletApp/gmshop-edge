// Fixed business products, not a general membership/tier engine.
export const agentAccessProducts = {
	subsite: {
		productId: "19900000-0000-4000-8000-000000000001",
		itemId: "19900000-0000-4000-8000-000000000002",
		priceMinor: "19900",
		name: "子站代理一次性开通",
	},
	api: {
		productId: "09900000-0000-4000-8000-000000000001",
		itemId: "09900000-0000-4000-8000-000000000002",
		priceMinor: "1990",
		name: "API 对接一次性开通",
	},
} as const;
export type AgentAccessKind = keyof typeof agentAccessProducts;
export function agentAccessKind(itemId: string): AgentAccessKind | null {
	if (itemId === agentAccessProducts.subsite.itemId) return "subsite";
	if (itemId === agentAccessProducts.api.itemId) return "api";
	return null;
}

export function isAgentAccessProduct(productId: string) {
	return Object.values(agentAccessProducts).some(
		(product) => product.productId === productId,
	);
}

// Owner contact shown to every buyer of either access product (order page and
// payment email). Static public asset; never shown for other products.
export const agentOwnerWeChat = {
	imagePath: "/owner-wechat-qr.jpg",
	"zh-CN": "有问题请添加微信联系我",
	"en-US": "Questions? Add me on WeChat.",
} as const;

// A fixed, versioned purchase notice for these two products, not a policy engine.
export const agentAccessRefundPolicy = {
	version: "2026-10-08",
	"zh-CN":
		"资格成功开通后，不支持因个人原因退款；未完成开通、重复扣款及依法应退情形除外。",
	"en-US":
		"Once access is successfully activated, refunds for personal reasons are not offered. Failed activation, duplicate charges, and legally required refunds are handled separately.",
} as const;
