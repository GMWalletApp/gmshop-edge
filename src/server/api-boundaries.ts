const uuidSegment =
	"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const orderNumberSegment = "[a-z0-9_-]{8,80}";

const paymentWebhookPattern = new RegExp(
	`^/api/shop/payments/${uuidSegment}/webhook$`,
	"i",
);
// Machine endpoints authenticate themselves (HMAC API keys, provider
// signatures); they must bypass the session-only protected API gate.
const supplierApiResource = "[^/]{1,200}";
const supplierApiGetPattern = new RegExp(
	`^/api/v1/supplier/(?:categories|payment-channels|products(?:/${supplierApiResource})?|orders/${supplierApiResource}|topups/${supplierApiResource})$`,
);
const supplierApiPostPattern = new RegExp(
	`^/api/v1/supplier/(?:ping|orders|orders/${supplierApiResource}/cancel|topups)$`,
);
const dujiaoCallbackPattern = new RegExp(
	`^/api/suppliers/dujiao-next/callback/${uuidSegment}$`,
	"i",
);
const publicGetPatterns = [
	/^\/api\/support\/web\/(?:status|current)$/,
	supplierApiGetPattern,
	paymentWebhookPattern,
	new RegExp(`^/api/configuration-logo/payment/${uuidSegment}$`, "i"),
	/^\/api\/configuration-logo\/auth\/[a-z][a-z0-9_-]{1,63}$/,
	new RegExp(`^/api/shop/products/${uuidSegment}/cover$`, "i"),
	new RegExp(`^/api/shop/products/${uuidSegment}/media/${uuidSegment}$`, "i"),
];
const publicPostPatterns = [
	/^\/api\/support\/web\/(?:conversations|messages|replies\/ack|close)$/,
	supplierApiPostPattern,
	dujiaoCallbackPattern,
	/^\/api\/telegram\/webhook$/,
	paymentWebhookPattern,
	new RegExp(
		`^/api/shop/automation/${uuidSegment}/artifacts/[^/]{1,255}$`,
		"i",
	),
	new RegExp(
		`^/api/shop/orders/${orderNumberSegment}/deliveries/${uuidSegment}/reveal$`,
		"i",
	),
	new RegExp(
		`^/api/shop/orders/${orderNumberSegment}/downloads/${uuidSegment}$`,
		"i",
	),
	new RegExp(
		`^/api/shop/orders/${orderNumberSegment}/automation/${uuidSegment}/artifacts/${uuidSegment}$`,
		"i",
	),
	new RegExp(`^/api/shop/orders/${orderNumberSegment}/automation$`, "i"),
	new RegExp(
		`^/api/shop/orders/${orderNumberSegment}/automation/${uuidSegment}/(?:cancel|retry)$`,
		"i",
	),
];

export function isPublicApiRequest(request: Request) {
	const { pathname } = new URL(request.url);
	if (pathname === "/api/auth" || pathname.startsWith("/api/auth/"))
		return true;
	if (request.method === "GET")
		return (
			pathname === "/api/site-logo" ||
			publicGetPatterns.some((pattern) => pattern.test(pathname))
		);
	if (request.method !== "POST") return false;
	return (
		pathname === "/api/shop/automation/callback" ||
		publicPostPatterns.some((pattern) => pattern.test(pathname))
	);
}

export function isSameOriginRequest(request: Request) {
	const origin = request.headers.get("origin");
	if (!origin) return false;
	try {
		return new URL(origin).origin === new URL(request.url).origin;
	} catch {
		return false;
	}
}
