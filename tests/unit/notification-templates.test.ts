import { describe, expect, it } from "vitest";
import { notificationTemplateSchema } from "#/features/notifications/schema";
import {
	builtinNotificationTemplateRows,
	commerceNotificationEvents,
	renderNotificationTemplate,
	sanitizeNotificationValue,
} from "#/features/notifications/templates";
import { supportedLocales } from "#/lib/locales";

describe("notification templates", () => {
	it("provides safe defaults for every event, channel, and locale", () => {
		expect(builtinNotificationTemplateRows).toHaveLength(
			commerceNotificationEvents.length * supportedLocales.length,
		);
		const values = {
			site_name: "GMShop Edge",
			order_number: "ORDER-1001",
			product_name: "Digital product",
			status: "completed",
			amount: "USD 12.99",
			order_url: "https://shop.example/orders/ORDER-1001",
			case_number: "AS-1001",
			resolution: "Resolved",
		};
		for (const template of builtinNotificationTemplateRows) {
			const rendered = renderNotificationTemplate(template.body, values);
			expect(rendered).not.toMatch(/{{\s*[a-z_]+\s*}}/);
			expect(rendered).toContain("https://shop.example/");
		}
	});

	it("strips header-breaking control characters from substituted values", () => {
		const subject = renderNotificationTemplate(
			"Your order {{order_number}} from {{site_name}}",
			{
				site_name: "Shop\u0000\u001b[2J",
				order_number: "GM-1\r\nBcc: victim@example.com\nX-Injected: yes",
				product_name: "",
				status: "",
				amount: "",
				order_url: "",
				case_number: "",
				resolution: "",
			},
		);
		expect(subject).toBe(
			"Your order GM-1 Bcc: victim@example.com X-Injected: yes from Shop [2J",
		);
		// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting the sanitizer removed them.
		expect(subject).not.toMatch(/[\r\n\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
		expect(sanitizeNotificationValue("line\u2028break\u0085here")).toBe(
			"line break here",
		);
		expect(sanitizeNotificationValue("plain 文本 value")).toBe(
			"plain 文本 value",
		);
	});

	it("accepts content-only edits and rejects unsupported variables", () => {
		expect(() =>
			notificationTemplateSchema.parse({
				id: "notification-email-order_paid-en-US",
				subject: "",
				body: "Hello {{unknown_secret}}",
			}),
		).toThrow();
		expect(
			notificationTemplateSchema.parse({
				id: "notification-email-automation_ready-zh-CN",
				subject: "",
				body: "构建完成：{{order_url}}",
			}),
		).toMatchObject({
			id: "notification-email-automation_ready-zh-CN",
		});
	});
});
