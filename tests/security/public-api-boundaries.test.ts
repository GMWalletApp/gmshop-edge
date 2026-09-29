import { describe, expect, it } from "vitest";
import {
	isPublicApiRequest,
	isSameOriginRequest,
} from "#/server/api-boundaries";

const id = "11111111-1111-4111-8111-111111111111";
const orderNumber = "GMABC1234567";

describe("signed and customer API boundaries", () => {
	it("lets self-authenticating machine endpoints reach their handlers", () => {
		for (const [path, method] of [
			["/api/v1/supplier/ping", "POST"],
			["/api/v1/supplier/products", "GET"],
			["/api/v1/supplier/products/sku-1", "GET"],
			["/api/v1/supplier/categories", "GET"],
			["/api/v1/supplier/payment-channels", "GET"],
			["/api/v1/supplier/orders", "POST"],
			[`/api/v1/supplier/orders/${id}`, "GET"],
			[`/api/v1/supplier/orders/${id}/cancel`, "POST"],
			["/api/v1/supplier/topups", "POST"],
			[`/api/v1/supplier/topups/${id}`, "GET"],
			[`/api/suppliers/dujiao-next/callback/${id}`, "POST"],
		] as const) {
			expect(publicRequest(path, method), `${method} ${path}`).toBe(true);
		}
		for (const [path, method] of [
			["/api/v1/supplier/orders", "GET"],
			["/api/v1/supplier/products", "POST"],
			["/api/v1/supplier/admin", "GET"],
			["/api/v1/supplier/orders/../../admin", "POST"],
			[`/api/suppliers/dujiao-next/callback/${id}`, "GET"],
			["/api/suppliers/dujiao-next/callback/not-a-uuid", "POST"],
		] as const) {
			expect(publicRequest(path, method), `${method} ${path}`).toBe(false);
		}
	});

	it("exposes only the current signed webhook and build callback routes", () => {
		expect(publicRequest("/api/telegram/webhook", "POST")).toBe(true);
		expect(publicRequest("/api/telegram/webhook", "GET")).toBe(false);
		expect(publicRequest("/api/telegram/webhook/extra", "POST")).toBe(false);
		expect(publicRequest(`/api/shop/payments/${id}/webhook`, "POST")).toBe(
			true,
		);
		expect(publicRequest(`/api/shop/payments/${id}/webhook`, "GET")).toBe(true);
		expect(publicRequest(`/api/shop/payments/${id}/webhook`, "PATCH")).toBe(
			false,
		);
		expect(publicRequest("/api/shop/automation/callback", "POST")).toBe(true);
		expect(publicRequest("/api/shop/automation/callback", "GET")).toBe(false);
		expect(
			publicRequest(`/api/shop/automation/${id}/artifacts/release.zip`, "POST"),
		).toBe(true);
		expect(
			publicRequest(`/api/shop/automation/${id}/artifacts/release.zip`, "GET"),
		).toBe(false);
	});

	it("exposes public catalog media only for exact GET routes", () => {
		for (const path of [
			"/api/site-logo",
			`/api/configuration-logo/payment/${id}`,
			"/api/configuration-logo/auth/google",
			`/api/shop/products/${id}/cover`,
			`/api/shop/products/${id}/media/${id}`,
		]) {
			expect(publicRequest(path, "GET"), path).toBe(true);
			expect(publicRequest(path, "POST"), path).toBe(false);
		}
	});

	it("exposes only the exact web support mailbox routes", () => {
		for (const path of [
			"/api/support/web/status",
			"/api/support/web/current",
		]) {
			expect(publicRequest(path, "GET"), path).toBe(true);
			expect(publicRequest(path, "POST"), path).toBe(false);
		}
		for (const path of [
			"/api/support/web/conversations",
			"/api/support/web/messages",
			"/api/support/web/replies/ack",
			"/api/support/web/close",
		]) {
			expect(publicRequest(path, "POST"), path).toBe(true);
			expect(publicRequest(path, "GET"), path).toBe(false);
		}
		expect(publicRequest("/api/support/web/current/extra", "GET")).toBe(false);
		expect(publicRequest("/api/support/web/messages/extra", "POST")).toBe(
			false,
		);
	});

	it("lets customer order actions reach their own session or checkout-email checks", () => {
		for (const path of [
			`/api/shop/orders/${orderNumber}/deliveries/${id}/reveal`,
			`/api/shop/orders/${orderNumber}/downloads/${id}`,
			`/api/shop/orders/${orderNumber}/automation/${id}/artifacts/${id}`,
			`/api/shop/orders/${orderNumber}/automation`,
			`/api/shop/orders/${orderNumber}/automation/${id}/cancel`,
			`/api/shop/orders/${orderNumber}/automation/${id}/retry`,
		]) {
			expect(publicRequest(path, "POST"), path).toBe(true);
			expect(publicRequest(path, "GET"), path).toBe(false);
		}
	});

	it("removes legacy gateway routes and fails closed for lookalikes", () => {
		for (const path of [
			"/api/providers/okpay/notify",
			`/api/providers/alchemy/${id}`,
			"/api/checkout/26071306234512345678/review",
			"/api/unknown",
			"/api/site-logo/extra",
			"/api/site-background",
			"/api/configuration-logo/payment/not-a-uuid",
			"/api/configuration-logo/auth/Google",
			"/api/configuration-logo/auth/google/extra",
			`/api/shop/payments/${id}/webhook/extra`,
			"/api/shop/payments/not-a-uuid/webhook",
			`/api/telegram/${id}/webhook`,
			`/api/shop/automation/${id}/artifacts/nested/file.zip`,
		])
			expect(publicRequest(path, "POST"), path).toBe(false);
	});

	it("recognizes only an exact same-origin Origin header", () => {
		expect(sameOrigin("https://pay.example")).toBe(true);
		expect(sameOrigin("https://attacker.example")).toBe(false);
		expect(sameOrigin("https://sub.pay.example")).toBe(false);
		expect(sameOrigin()).toBe(false);
	});
});

function publicRequest(path: string, method: string) {
	return isPublicApiRequest(
		new Request(`https://pay.example${path}`, { method }),
	);
}

function sameOrigin(origin?: string) {
	return isSameOriginRequest(
		new Request(
			`https://pay.example/api/shop/orders/${orderNumber}/automation`,
			{
				method: "POST",
				headers: origin ? { Origin: origin } : undefined,
			},
		),
	);
}
