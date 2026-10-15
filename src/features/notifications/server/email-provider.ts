import { mailgunProvider } from "@visulima/email/providers/mailgun";
import { postmarkProvider } from "@visulima/email/providers/postmark";
import { resendProvider } from "@visulima/email/providers/resend";
import { sendGridProvider } from "@visulima/email/providers/sendgrid";
import { smtpProvider } from "@visulima/email/providers/smtp";
import { DomainError } from "#/lib/domain-error";

export const emailProviderIds = [
	"resend",
	"postmark",
	"sendgrid",
	"mailgun",
	"smtp",
	"cloudflare_email",
] as const;

export type EmailProviderId = (typeof emailProviderIds)[number];

type EmailProviderConfig = {
	provider: EmailProviderId;
	apiKey: string | null;
	domain: string | null;
	region: "us" | "eu";
	smtpHost: string | null;
	smtpPort: number | null;
	smtpUser: string | null;
	cloudflareEmail: SendEmail | null;
};

type ProviderEmailMessage = {
	to: string;
	from: string;
	replyTo: string;
	subject: string;
	text: string;
	html: string;
	idempotencyKey: string;
	headers?: Partial<Record<string, string>>;
};

type EmailAddress = {
	email: string;
	name?: string;
};

type EmailSendResult = {
	data?: { messageId: string };
	error?: unknown;
	success: boolean;
};

export async function sendProviderEmail(
	config: EmailProviderConfig,
	message: ProviderEmailMessage,
): Promise<EmailSendResult> {
	if (config.provider === "cloudflare_email") {
		if (!config.cloudflareEmail)
			throw new DomainError(
				"notification_cloudflare_email_unavailable",
				503,
				'Cloudflare Send Email binding "EMAIL" is unavailable',
			);
		const binding = config.cloudflareEmail;
		const headers = definedHeaders(message.headers);
		const send = (withHeaders: boolean) =>
			binding.send({
				from: parseCloudflareEmailAddress(message.from),
				to: parseCloudflareEmailAddress(message.to),
				...(message.replyTo
					? { replyTo: parseCloudflareEmailAddress(message.replyTo) }
					: {}),
				subject: message.subject,
				text: message.text,
				...(message.html ? { html: message.html } : {}),
				...(withHeaders && headers ? { headers } : {}),
			});
		// Optional list headers must never block delivery if the binding rejects
		// them. Only a header validation error is retried without headers: those
		// are raised before acceptance, so the retry cannot duplicate a message.
		const result = headers
			? await send(true).catch((error: unknown) => {
					if (isCloudflareHeaderRejection(error)) return send(false);
					throw error;
				})
			: await send(false);
		return { success: true, data: { messageId: result.messageId } };
	}
	const provider = createEmailProvider(config);
	return provider.sendEmail({
		from: parseEmailAddress(message.from),
		to: parseEmailAddress(message.to),
		...(message.replyTo ? { replyTo: parseEmailAddress(message.replyTo) } : {}),
		subject: message.subject,
		text: message.text,
		...(message.html ? { html: message.html } : {}),
		headers: {
			...definedHeaders(message.headers),
			"Idempotency-Key": message.idempotencyKey,
		},
	});
}

/** Cloudflare Email Service header validation codes (E_HEADER_*, E_HEADERS_*). */
export function isCloudflareHeaderRejection(error: unknown) {
	const code =
		error && typeof error === "object" && "code" in error
			? (error as { code: unknown }).code
			: undefined;
	return typeof code === "string" && /^E_HEADERS?_[A-Z_]+$/.test(code);
}

function definedHeaders(headers: Partial<Record<string, string>> | undefined) {
	const entries = Object.entries(headers ?? {}).filter(
		(entry): entry is [string, string] => typeof entry[1] === "string",
	);
	return entries.length ? Object.fromEntries(entries) : undefined;
}

function createEmailProvider(config: EmailProviderConfig) {
	if (!config.apiKey) throw new Error("Email provider credential is required");
	switch (config.provider) {
		case "resend":
			return resendProvider({
				apiKey: config.apiKey,
				retries: 0,
				timeout: 10_000,
			});
		case "postmark":
			return postmarkProvider({
				serverToken: config.apiKey,
				retries: 0,
				timeout: 10_000,
			});
		case "sendgrid":
			return sendGridProvider({
				apiKey: config.apiKey,
				retries: 0,
				timeout: 10_000,
			});
		case "mailgun":
			if (!config.domain) throw new Error("Mailgun domain is required");
			return mailgunProvider({
				apiKey: config.apiKey,
				domain: config.domain,
				endpoint:
					config.region === "eu"
						? "https://api.eu.mailgun.net"
						: "https://api.mailgun.net",
				retries: 0,
				timeout: 10_000,
			});
		case "smtp":
			if (!config.smtpHost || !config.smtpPort || !config.smtpUser)
				throw new Error("SMTP configuration is incomplete");
			return smtpProvider({
				host: config.smtpHost,
				port: config.smtpPort,
				secure: config.smtpPort === 465,
				user: config.smtpUser,
				password: config.apiKey,
				rejectUnauthorized: true,
				pool: true,
				maxConnections: 2,
				retries: 0,
				timeout: 10_000,
			});
		case "cloudflare_email":
			throw new Error("Cloudflare Email uses the SendEmail binding");
	}
}

function parseEmailAddress(value: string): EmailAddress {
	const displayAddress = /^(.*?)\s*<([^<>]+)>$/.exec(value.trim());
	if (!displayAddress) return { email: value.trim() };
	const name = displayAddress[1]?.trim().replace(/^"|"$/g, "");
	return {
		email: displayAddress[2]?.trim() ?? "",
		...(name ? { name } : {}),
	};
}

function parseCloudflareEmailAddress(
	value: string,
): string | { email: string; name: string } {
	const parsed = parseEmailAddress(value);
	return parsed.name
		? { email: parsed.email, name: parsed.name }
		: parsed.email;
}
