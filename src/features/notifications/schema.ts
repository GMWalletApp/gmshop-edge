import { z } from "zod";
import { assertNotificationTemplate } from "#/features/notifications/templates";

export const emailMessageSchema = z.object({
	to: z.email().max(320),
	from: z.string().trim().min(3).max(320),
	replyTo: z.union([z.literal(""), z.email().max(320)]).default(""),
	subject: z.string().trim().min(1).max(500),
	text: z.string().min(1).max(100_000),
	html: z.string().max(200_000).default(""),
	// Only list-unsubscribe headers are allowed; older stored messages omit it.
	headers: z
		.partialRecord(
			z.enum(["List-Unsubscribe", "List-Unsubscribe-Post"]),
			z.string().trim().min(1).max(2_000),
		)
		.optional(),
});

export const emailChannelConfigSchema = z
	.object({
		id: z.uuid().optional(),
		name: z.string().trim().min(1).max(80),
		provider: z.enum([
			"resend",
			"postmark",
			"sendgrid",
			"mailgun",
			"smtp",
			"cloudflare_email",
		]),
		apiKey: z.string().trim().max(1_000).default(""),
		domain: z.string().trim().max(253).default(""),
		region: z.enum(["us", "eu"]).default("us"),
		smtpHost: z
			.string()
			.trim()
			.max(253)
			.regex(
				/^(?=.{1,253}$)(?!localhost$)(?!\d{1,3}(?:\.\d{1,3}){3}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i,
				"Enter a public SMTP hostname",
			)
			.or(z.literal(""))
			.default(""),
		smtpPort: z
			.number()
			.int()
			.min(1)
			.max(65_535)
			.refine(
				(port) => port !== 25,
				"Cloudflare Workers cannot use SMTP port 25",
			)
			.default(587),
		smtpUser: z.string().trim().max(320).default(""),
		fromAddress: z.string().trim().min(3).max(320),
		replyTo: z.union([z.literal(""), z.email().max(320)]).default(""),
		sortOrder: z.number().int().min(0).max(1_000_000).default(100),
		enabled: z.boolean(),
	})
	.superRefine((value, context) => {
		if (value.provider === "mailgun" && !value.domain)
			context.addIssue({
				code: "custom",
				message: "Mailgun domain is required",
				path: ["domain"],
			});
		if (value.provider === "smtp") {
			if (!value.smtpHost)
				context.addIssue({
					code: "custom",
					message: "SMTP host is required",
					path: ["smtpHost"],
				});
			if (!value.smtpUser)
				context.addIssue({
					code: "custom",
					message: "SMTP username is required",
					path: ["smtpUser"],
				});
		}
	});

export const emailChannelOrderSchema = z
	.object({
		ids: z.array(z.uuid()).min(1).max(100),
	})
	.superRefine((value, context) => {
		if (new Set(value.ids).size !== value.ids.length)
			context.addIssue({
				code: "custom",
				path: ["ids"],
				message: "Email channel order IDs must be unique",
			});
	});

export const emailChannelEnabledSchema = z.object({
	id: z.uuid(),
	enabled: z.boolean(),
});

export const notificationTemplateSchema = z
	.object({
		id: z.string().trim().min(1).max(200),
		subject: z.string().trim().max(500).default(""),
		body: z.string().trim().min(1).max(100_000),
	})
	.superRefine((value, context) => {
		for (const [field, template] of [
			["subject", value.subject],
			["body", value.body],
		] as const) {
			try {
				assertNotificationTemplate(template);
			} catch {
				context.addIssue({
					code: "custom",
					message: "Template contains an unsupported variable",
					path: [field],
				});
			}
		}
	});
