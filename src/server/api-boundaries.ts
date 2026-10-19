const uuidSegment =
	"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const orderNumberSegment = "[a-z0-9_-]{8,80}";

const paymentWebhookPattern = new RegExp(
	`^/api/shop/payments/${uuidSegment}/webhook$`,
	"i",
);
const supplierApiPattern = /^\/api\/v1\/supplier(?:\/[^/]+)+$/;
const publicGetPatterns = [
	new RegExp(`^/api/support/web/attachments/${uuidSegment}$`, "i"),
	supplierApiPattern,
	/^\/api\/ops\/restock$/,
	/^\/api\/ops\/redeem-cutover$/,
	/^\/api\/support\/web\/(?:status|current)$/,
	paymentWebhookPattern,
	new RegExp(`^/api/configuration-logo/payment/${uuidSegment}$`, "i"),
	/^\/api\/configuration-logo\/auth\/[a-z][a-z0-9_-]{1,63}$/,
	new RegExp(`^/api/shop/products/${uuidSegment}/cover$`, "i"),
	new RegExp(`^/api/shop/products/${uuidSegment}/media/${uuidSegment}$`, "i"),
];
const publicPostPatterns = [
	/^\/api\/internal\/agent-program\/order-profit$/,
	/^\/api\/support\/web\/attachments\/?$/,
	/^\/api\/shop\/invoice-order$/,
	/^\/api\/shop\/renewal\/unsubscribe$/,
	supplierApiPattern,
	/^\/api\/ops\/restock$/,
	/^\/api\/ops\/redeem-cutover$/,
	/^\/api\/ops\/redeem-restock$/,
	/^\/api\/ops\/restock\/reconcile$/,
	/^\/api\/support\/web\/(?:conversations|messages|replies\/ack|close)$/,
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
