import { describe, expect, it } from "vitest";
import {
	emailChannelConfigSchema,
	emailChannelOrderSchema,
} from "#/features/notifications/schema";

const baseConfig = {
	name: "Primary email",
	apiKey: "secret",
	domain: "",
	region: "us" as const,
	smtpHost: "",
	smtpPort: 587,
	smtpUser: "",
	fromAddress: "mail@example.com",
	replyTo: "",
	sortOrder: 100,
	enabled: true,
};

describe("email channel configuration", () => {
	it.each(["resend", "postmark", "sendgrid"] as const)(
		"accepts the %s HTTP provider",
		(provider) => {
			expect(
				emailChannelConfigSchema.safeParse({ ...baseConfig, provider }).success,
			).toBe(true);
		},
	);

	it("accepts Cloudflare Email without API key or SMTP fields", () => {
		expect(
			emailChannelConfigSchema.safeParse({
				...baseConfig,
				provider: "cloudflare_email",
				apiKey: "",
			}).success,
		).toBe(true);
	});

	it("requires a Mailgun domain", () => {
		expect(
			emailChannelConfigSchema.safeParse({
				...baseConfig,
				provider: "mailgun",
			}).success,
		).toBe(false);
	});

	it("allows public SMTP hosts on non-25 ports", () => {
		expect(
			emailChannelConfigSchema.safeParse({
				...baseConfig,
				provider: "smtp",
				smtpHost: "smtp.example.com",
				smtpPort: 2525,
				smtpUser: "mailer@example.com",
			}).success,
		).toBe(true);
	});

	it.each([
		{ smtpHost: "localhost", smtpPort: 587 },
		{ smtpHost: "127.0.0.1", smtpPort: 587 },
		{ smtpHost: "smtp.example.com", smtpPort: 25 },
	])("rejects unsafe SMTP target $smtpHost:$smtpPort", (target) => {
		expect(
			emailChannelConfigSchema.safeParse({
				...baseConfig,
				provider: "smtp",
				smtpUser: "mailer@example.com",
				...target,
			}).success,
		).toBe(false);
	});
});

describe("email channel ordering", () => {
	const firstId = "00000000-0000-4000-8000-000000000001";
	const secondId = "00000000-0000-4000-8000-000000000002";

	it("accepts a unique partial-page order", () => {
		expect(
			emailChannelOrderSchema.safeParse({ ids: [secondId, firstId] }).success,
		).toBe(true);
	});

	it("rejects duplicate or invalid channel IDs", () => {
		expect(
			emailChannelOrderSchema.safeParse({ ids: [firstId, firstId] }).success,
		).toBe(false);
		expect(emailChannelOrderSchema.safeParse({ ids: ["email"] }).success).toBe(
			false,
		);
	});
});
