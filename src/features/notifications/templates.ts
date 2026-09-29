import { z } from "zod";
import { type SupportedLocale, supportedLocales } from "#/lib/locales";

export const commerceNotificationEvents = [
	"order_paid",
	"delivery_ready",
	"automation_ready",
	"automation_failed",
	"refund_succeeded",
	"refund_failed",
	"after_sale_updated",
	"entitlement_expiring",
] as const;

export type CommerceNotificationEvent =
	(typeof commerceNotificationEvents)[number];

export const commerceNotificationEventSchema = z.enum(
	commerceNotificationEvents,
);

const variables = [
	"site_name",
	"order_number",
	"product_name",
	"status",
	"amount",
	"order_url",
	"case_number",
	"resolution",
] as const;

const allowedVariables = new Set<string>(variables);
const variablePattern = /{{\s*([a-z_]+)\s*}}/g;
// C0/C1 controls (CR, LF, NUL, ESC…) plus Unicode line separators: any of
// them inside a substituted value could inject or fold e-mail headers.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the control range is the point of this pattern.
const controlCharacterPattern = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

export type NotificationTemplateValues = Record<
	(typeof variables)[number],
	string
>;

/** Collapses control characters in a substituted value to single spaces. */
export function sanitizeNotificationValue(value: string) {
	return value.replace(controlCharacterPattern, " ");
}

export function renderNotificationTemplate(
	template: string,
	values: NotificationTemplateValues,
) {
	return template.replace(variablePattern, (_, key: string) => {
		if (!allowedVariables.has(key)) return "";
		return sanitizeNotificationValue(
			values[key as keyof NotificationTemplateValues] ?? "",
		);
	});
}

export function assertNotificationTemplate(template: string) {
	for (const match of template.matchAll(variablePattern)) {
		if (!allowedVariables.has(match[1] ?? ""))
			throw new Error("notification_template_variable_invalid");
	}
	return template;
}

type BuiltinTemplate = { subject: string; body: string };

const englishTemplates: Record<CommerceNotificationEvent, BuiltinTemplate> = {
	order_paid: {
		subject: "Payment received for {{order_number}}",
		body: "We received {{amount}} for {{order_number}}. View your order: {{order_url}}",
	},
	delivery_ready: {
		subject: "Your order {{order_number}} is ready",
		body: "{{product_name}} is ready. Open your order to view the delivery: {{order_url}}",
	},
	automation_ready: {
		subject: "Your build for {{order_number}} is ready",
		body: "The build for {{product_name}} completed successfully. Download it from {{order_url}}",
	},
	automation_failed: {
		subject: "Build update for {{order_number}}",
		body: "The build for {{product_name}} could not be completed. Check the order or contact support: {{order_url}}",
	},
	refund_succeeded: {
		subject: "Refund completed for {{order_number}}",
		body: "Your refund for {{order_number}} has been completed. View the order: {{order_url}}",
	},
	refund_failed: {
		subject: "Refund update for {{order_number}}",
		body: "The refund for {{order_number}} could not be completed. Please check the order or contact support: {{order_url}}",
	},
	after_sale_updated: {
		subject: "Support case {{case_number}} updated",
		body: "Your support case for {{order_number}} was updated. {{resolution}} View the order: {{order_url}}",
	},
	entitlement_expiring: {
		subject: "Your {{product_name}} access expires soon",
		body: "Your access for {{product_name}} expires soon. Review or renew it here: {{order_url}}",
	},
};

const translatedTemplates: Partial<
	Record<
		SupportedLocale,
		Partial<Record<CommerceNotificationEvent, BuiltinTemplate>>
	>
> = {
	"zh-CN": {
		order_paid: {
			subject: "订单 {{order_number}} 已付款",
			body: "我们已收到订单 {{order_number}} 的 {{amount}}。查看订单：{{order_url}}",
		},
		delivery_ready: {
			subject: "订单 {{order_number}} 已交付",
			body: "{{product_name}} 已准备完成，请打开订单查看交付内容：{{order_url}}",
		},
		automation_ready: {
			subject: "订单 {{order_number}} 的构建已完成",
			body: "{{product_name}} 构建成功，请前往订单下载制品：{{order_url}}",
		},
		automation_failed: {
			subject: "订单 {{order_number}} 的构建状态更新",
			body: "{{product_name}} 构建未完成，请查看订单或联系支持：{{order_url}}",
		},
		refund_succeeded: {
			subject: "订单 {{order_number}} 已完成退款",
			body: "订单 {{order_number}} 的退款已完成。查看订单：{{order_url}}",
		},
		refund_failed: {
			subject: "订单 {{order_number}} 的退款状态更新",
			body: "订单 {{order_number}} 的退款未能完成，请查看订单或联系支持：{{order_url}}",
		},
		after_sale_updated: {
			subject: "售后工单 {{case_number}} 已更新",
			body: "订单 {{order_number}} 的售后工单已更新。{{resolution}} 查看订单：{{order_url}}",
		},
	},
};

export function builtinNotificationTemplate(
	event: CommerceNotificationEvent,
	locale: SupportedLocale,
) {
	return translatedTemplates[locale]?.[event] ?? englishTemplates[event];
}

export const builtinNotificationTemplateRows = supportedLocales.flatMap(
	(locale) =>
		commerceNotificationEvents.flatMap((event) => {
			const template = builtinNotificationTemplate(event, locale);
			return (["email"] as const).map((channel) => ({
				id: `notification-${channel}-${event}-${locale}`,
				event,
				channel,
				locale,
				subject: channel === "email" ? template.subject : null,
				body: template.body,
			}));
		}),
);

export function builtinNotificationTemplateRow(id: string) {
	return builtinNotificationTemplateRows.find((template) => template.id === id);
}
