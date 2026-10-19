import { describe, expect, it } from "vitest";
import { handleOrderProfitRequest } from "#/features/agent-program/server/order-profit";
import {
	isPublicApiRequest,
	isSameOriginRequest,
} from "#/server/api-boundaries";

const id = "11111111-1111-4111-8111-111111111111";
const orderNumber = "GMABC1234567";

describe("signed and customer API boundaries", () => {
	it("lets signed supplier endpoints reach their own HMAC guard", () => {
		for (const path of [
			"/api/v1/supplier/ping",
			"/api/v1/supplier/products",
			`/api/v1/supplier/products/${id}`,
			`/api/v1/supplier/orders/${id}/cancel`,
		]) {
			expect(publicRequest(path, "GET"), path).toBe(true);
			expect(publicRequest(path, "POST"), path).toBe(true);
		}
		expect(publicRequest("/api/v1/supplier", "GET")).toBe(false);
		expect(publicRequest("/api/v1/supplier/", "POST")).toBe(false);
		expect(publicRequest("/api/v1/supplier/ping", "PATCH")).toBe(false);
	});

	it("lets only the exact profit POST reach its own bearer guard without browser headers", async () => {
		const path = "/api/internal/agent-program/order-profit";
		const request = new Request(`https://pay.example${path}`, {
			method: "POST",
		});
		expect(isSameOriginRequest(request)).toBe(false);
		expect(isPublicApiRequest(request)).toBe(true);
		const response = await handleOrderProfitRequest(request, {
			AGENT_PROGRAM_PROFIT_TOKEN: "synthetic-profit-token",
		});
		expect(response.status).toBe(401);
		for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"])
			expect(publicRequest(path, method), method).toBe(false);
		for (const otherPath of [
			`${path}/`,
			`${path}/extra`,
			`${path}-extra`,
			"/api/internal/agent-program",
			"/api/internal/agent-program/agents",
			"/api/internal/other",
		])
			expect(publicRequest(otherPath, "POST"), otherPath).toBe(false);
	});

	it("lets the exact bearer-authenticated restock route reach its own guard", () => {
		expect(publicRequest("/api/ops/restock", "GET")).toBe(true);
		expect(publicRequest("/api/ops/restock", "POST")).toBe(true);
		expect(publicRequest("/api/ops/restock/reconcile", "POST")).toBe(true);
		expect(publicRequest("/api/ops/restock/reconcile", "GET")).toBe(false);
		expect(publicRequest("/api/ops/restock/swap", "POST")).toBe(true);
		expect(publicRequest("/api/ops/restock/swap", "GET")).toBe(false);
		expect(publicRequest("/api/ops/restock", "PATCH")).toBe(false);
		expect(publicRequest("/api/ops/restock/extra", "GET")).toBe(false);
		expect(publicRequest("/api/ops/restock/extra", "POST")).toBe(false);
	});

	it("lets only POST reach the bearer-authenticated redeem restock route", () => {
		expect(publicRequest("/api/ops/redeem-restock", "POST")).toBe(true);
		expect(publicRequest("/api/ops/redeem-restock", "GET")).toBe(false);
		expect(publicRequest("/api/ops/redeem-restock/extra", "POST")).toBe(false);
	});

	it("lets the exact cutover endpoint reach its own bearer guard without exposing prefixes or other methods", () => {
		expect(publicRequest("/api/ops/redeem-cutover", "GET")).toBe(true);
		expect(publicRequest("/api/ops/redeem-cutover", "POST")).toBe(true);
		expect(publicRequest("/api/ops/redeem-cutover/extra", "POST")).toBe(false);
		expect(publicRequest("/api/ops/redeem-cutover", "PATCH")).toBe(false);
	});

	it("lets only the exact bearer-authenticated invoice lookup route through", () => {
		expect(publicRequest("/api/shop/invoice-order", "POST")).toBe(true);
		expect(publicRequest("/api/shop/invoice-order", "GET")).toBe(false);
		expect(publicRequest("/api/shop/invoice-order/extra", "POST")).toBe(false);
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
			`/api/support/web/attachments/${id}`,
		]) {
			expect(publicRequest(path, "GET"), path).toBe(true);
			expect(publicRequest(path, "POST"), path).toBe(false);
		}
		for (const path of [
			"/api/support/web/conversations",
			"/api/support/web/messages",
			"/api/support/web/replies/ack",
			"/api/support/web/close",
			"/api/support/web/attachments",
			"/api/support/web/attachments/",
		]) {
			expect(publicRequest(path, "POST"), path).toBe(true);
			expect(publicRequest(path, "GET"), path).toBe(false);
		}
		for (const path of [
			"/api/support/web/attachments/not-a-uuid",
			`/api/support/web/attachments/${id}/extra`,
			"/api/support/web/attachments/admin",
		]) {
			expect(publicRequest(path, "GET")).toBe(false);
			expect(publicRequest(path, "POST")).toBe(false);
		}
		expect(publicRequest(`/api/support/web/attachments/${id}`, "DELETE")).toBe(
			false,
		);
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
