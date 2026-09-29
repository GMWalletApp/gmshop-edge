import Bowser from "bowser";
import { z } from "zod";
import type { SupportedLocale } from "#/lib/locales";
import { m } from "#/paraglide/messages";

const publicKeySchema = z.looseObject({
	kty: z.literal("RSA"),
	n: z.string().min(300).max(800),
	e: z.string().min(1).max(12),
	alg: z.literal("RSA-OAEP-256").optional(),
	key_ops: z.array(z.string()).max(4).optional(),
	ext: z.boolean().optional(),
});

export const webSupportConversationSchema = z.object({
	email: z.string().trim().pipe(z.email().max(254)).optional(),
	visitorId: z.uuid(),
	publicKeyJwk: publicKeySchema,
	fingerprint: z
		.object({
			visitorId: z.string().regex(/^[a-f0-9]{16,128}$/i),
			version: z
				.string()
				.regex(/^\d+(?:\.\d+){0,2}$/)
				.max(20),
		})
		.optional(),
	diagnostics: z.object({
		locale: z.enum(["en-US", "zh-CN"]),
		timeZone: z.string().trim().min(1).max(64),
	}),
});

export const webSupportMessageSchema = z.object({
	clientMessageId: z.uuid(),
	text: z.string().trim().min(1).max(3500),
});

export const webSupportAckSchema = z.object({
	ids: z.array(z.uuid()).min(1).max(100),
});

export type ParsedDevice = {
	browser: string | null;
	system: string | null;
	deviceType: "phone" | "tablet" | "desktop" | "unknown";
	deviceDetails: string | null;
};

export function parseDevice(userAgent: string | null): ParsedDevice {
	const ua = (userAgent ?? "").slice(0, 512);
	if (!ua)
		return {
			browser: null,
			system: null,
			deviceType: "unknown",
			deviceDetails: null,
		};
	const parsed = Bowser.parse(ua);
	const deviceType =
		parsed.platform.type === "mobile"
			? "phone"
			: parsed.platform.type === "tablet"
				? "tablet"
				: parsed.platform.type === "desktop"
					? "desktop"
					: "unknown";
	return {
		browser: formatParsedName(parsed.browser.name, parsed.browser.version),
		system: formatParsedName(parsed.os.name, parsed.os.version),
		deviceType,
		deviceDetails: sanitizeDeviceDetails(
			[parsed.platform.vendor, parsed.platform.model]
				.filter(Boolean)
				.join(" ") || (deviceType === "desktop" ? parsed.os.name : undefined),
		),
	};
}

const deviceCategoryLabels = {
	phone: m.telegram_web_support_device_phone,
	tablet: m.telegram_web_support_device_tablet,
	desktop: m.telegram_web_support_device_desktop,
	unknown: m.telegram_web_support_device_unknown,
} as const;

/** Human-readable device line for the given locale, e.g. "Desktop · Windows". */
export function describeDevice(device: ParsedDevice, locale: SupportedLocale) {
	const category = deviceCategoryLabels[device.deviceType]({}, { locale });
	return device.deviceDetails
		? `${category} · ${device.deviceDetails}`
		: category;
}

function formatParsedName(name?: string, version?: string) {
	return (
		[name, version?.split(".").slice(0, 2).join(".")]
			.filter(Boolean)
			.join(" ") || null
	);
}

function sanitizeDeviceDetails(value?: string) {
	return (
		value
			?.replace(/[^\p{L}\p{N} ._+-]/gu, "")
			.trim()
			.slice(0, 60) || null
	);
}
