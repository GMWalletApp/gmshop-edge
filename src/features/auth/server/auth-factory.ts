import type {
	BetterAuthRateLimitStorage,
	GenericEndpointContext,
} from "@better-auth/core";
import {
	APIError,
	type BetterAuthOptions,
	type BetterAuthPlugin,
	betterAuth,
} from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { emailOTP } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { createTelegramOIDCProvider, telegram } from "better-auth-telegram";
import { createRemoteJWKSet, jwtVerify } from "jose";
import * as schema from "#/db/schema";
import { storefrontCustomerRoleName } from "#/features/access/storefront-access";
import {
	isInternalIdentityEmail,
	telegramIdentityEmail,
} from "#/features/auth/identity-email";
import { assertAccountCanBeUnlinked } from "#/features/auth/server/provider-policy";
import type { RuntimeAuthProvider } from "#/features/auth/server/provider-runtime";
import {
	TelegramMiniAppAuthError,
	verifyTelegramMiniAppInitData,
} from "#/features/auth/server/telegram-mini-app";
import {
	telegramWidgetAuthDataSchema,
	verifyTelegramWidgetAuthData,
} from "#/features/auth/telegram-widget";
import { enqueueConfiguredEmailNotification } from "#/features/notifications/server/delivery";
import { DomainError } from "#/lib/domain-error";
import { m } from "#/paraglide/messages";
import { CLIENT_IP_HEADER, clientIpFromHeaders } from "#/server/client-ip";
import type { AppDb } from "#/server/db.server";
import { claimFixedWindowRateLimit } from "#/server/rate-limit";

export type AuthEnv = {
	BETTER_AUTH_SECRET: string;
	BETTER_AUTH_URL: string;
	TRUSTED_ORIGINS?: string[];
	AUTH_PROVIDERS?: RuntimeAuthProvider[];
	AUTH_PROVIDER_SECRET?: string;
	EMAIL_DELIVERY_ENABLED?: boolean;
	REQUIRE_EMAIL_VERIFICATION?: boolean;
	SITE_NAME?: string;
	SESSION_MAX_AGE_SECONDS?: number;
};

export function createAuth(db: AppDb, env: AuthEnv) {
	const authProviders = env.AUTH_PROVIDERS ?? [defaultCredentialProvider];
	const emailProvider = authProviders.find(
		(provider) => provider.providerType === "email",
	);
	const telegramOidcProvider = authProviders.find(
		(provider) =>
			provider.providerType === "social" && provider.providerId === "telegram",
	);
	const emailDeliveryEnabled = env.EMAIL_DELIVERY_ENABLED === true;
	const siteName = env.SITE_NAME?.trim() || "GMShop Edge";
	const trustedOrigins = [
		env.BETTER_AUTH_URL,
		...(env.TRUSTED_ORIGINS ?? []),
	].filter(
		(value, index, values) => Boolean(value) && values.indexOf(value) === index,
	);
	return betterAuth({
		secret: env.BETTER_AUTH_SECRET,
		baseURL: env.BETTER_AUTH_URL,
		trustedOrigins,
		advanced: {
			ipAddress: {
				// Both server entries strip any client-supplied value and set this
				// single-value header from the trusted client address (Workers:
				// cf-connecting-ip; Bun: the reverse proxy). Better Auth otherwise
				// only checks X-Forwarded-For, which clients can spoof.
				ipAddressHeaders: [CLIENT_IP_HEADER],
			},
		},
		account: {
			accountLinking: {
				enabled: true,
				trustedProviders: ["telegram"],
				allowDifferentEmails: true,
			},
		},
		database: drizzleAdapter(db, { provider: "sqlite", schema }),
		databaseHooks: {
			user: {
				create: {
					after: async (newUser) => {
						const now = Date.now();
						const assigned = await db.$client
							.prepare(
								`UPDATE users SET role_ids = (
								  SELECT json_array(id) FROM roles
								  WHERE name = ? AND built_in = 1 AND enabled = 1
								  LIMIT 1
								 ), updated_at = CASE
								  WHEN updated_at >= ? THEN updated_at + 1 ELSE ? END
								 WHERE id = ? AND EXISTS (
								  SELECT 1 FROM roles
								  WHERE name = ? AND built_in = 1 AND enabled = 1
								 )`,
							)
							.bind(
								storefrontCustomerRoleName,
								now,
								now,
								newUser.id,
								storefrontCustomerRoleName,
							)
							.run();
						if (Number(assigned.meta.changes ?? 0) !== 1) {
							await db.$client
								.prepare(
									"DELETE FROM users WHERE id = ? AND json_array_length(role_ids) = 0",
								)
								.bind(newUser.id)
								.run();
							throw APIError.from("INTERNAL_SERVER_ERROR", {
								code: "CUSTOMER_ROLE_UNAVAILABLE",
								message: "Customer registration is temporarily unavailable",
							});
						}
					},
				},
			},
		},
		session: {
			expiresIn: env.SESSION_MAX_AGE_SECONDS ?? 2_592_000,
			updateAge: Math.min(
				86_400,
				Math.max(
					3_600,
					Math.floor((env.SESSION_MAX_AGE_SECONDS ?? 2_592_000) / 4),
				),
			),
		},
		socialProviders: createSocialProviders(authProviders),
		user: {
			changeEmail: {
				enabled: emailDeliveryEnabled,
				updateEmailWithoutVerification: false,
				...(emailDeliveryEnabled
					? {
							sendChangeEmailConfirmation: async ({
								user,
								newEmail,
								url,
								token,
							}) => {
								const locale = supportedEmailLocale(
									(user as { preferredLocale?: unknown }).preferredLocale,
								);
								await enqueueConfiguredEmailNotification(db.$client, {
									event: "auth.email_verification",
									idempotencyKey: `auth-email-change-confirmation:${user.id}:${await tokenDigest(token)}`,
									to: user.email,
									locale,
									subject: m.auth_email_change_confirmation_subject(
										{ siteName },
										{ locale },
									),
									text: m.auth_email_change_confirmation_text(
										{ newEmail, url },
										{ locale },
									),
								});
							},
						}
					: {}),
			},
			additionalFields: {
				enabled: {
					type: "boolean",
					required: false,
					defaultValue: true,
					input: false,
				},
				preferredLocale: {
					type: "string",
					required: false,
					defaultValue: "en-US",
					input: true,
				},
			},
		},
		emailAndPassword: {
			enabled: Boolean(emailProvider?.passwordLoginEnabled),
			disableSignUp:
				!emailProvider?.passwordLoginEnabled || !emailProvider.allowSignup,
			minPasswordLength: 12,
			requireEmailVerification:
				emailDeliveryEnabled && env.REQUIRE_EMAIL_VERIFICATION === true,
			revokeSessionsOnPasswordReset: true,
		},
		emailVerification: emailDeliveryEnabled
			? {
					sendOnSignUp: true,
					autoSignInAfterVerification: true,
					sendVerificationEmail: async ({ user, url, token }) => {
						const locale = supportedEmailLocale(
							(user as { preferredLocale?: unknown }).preferredLocale,
						);
						await enqueueConfiguredEmailNotification(db.$client, {
							event: "auth.email_verification",
							idempotencyKey: `auth-email-verification:${user.id}:${await tokenDigest(token)}`,
							to: user.email,
							locale,
							subject: m.auth_email_verification_subject(
								{ siteName },
								{ locale },
							),
							text: m.auth_email_verification_text({ url }, { locale }),
						});
					},
				}
			: undefined,
		rateLimit: {
			enabled: true,
			window: 60,
			max: 20,
			// Better Auth's default store is per-isolate memory, which every
			// Workers isolate (and every Bun restart) resets. Budgets live in D1.
			customStorage: createAuthRateLimitStorage(db.$client),
			customRules: {
				// Read-only endpoints polled by every storefront page must not cost a
				// D1 write per call nor share a budget with credential submissions.
				"/get-session": false,
				"/ok": false,
				"/list-sessions": false,
				"/sign-in/email": { window: 60, max: 5 },
				"/sign-in/email-otp": { window: 60, max: 5 },
				"/sign-up/email": { window: 60, max: 5 },
				"/email-otp/send-verification-otp": { window: 60, max: 3 },
				"/email-otp/request-password-reset": { window: 60, max: 3 },
				"/email-otp/reset-password": { window: 60, max: 5 },
				"/send-verification-email": { window: 60, max: 3 },
				"/change-email": { window: 60, max: 3 },
			},
		},
		hooks: {
			before: createAuthMiddleware(async (ctx) => {
				if (
					(ctx.path === "/sign-in/email-otp" ||
						ctx.path === "/email-otp/send-verification-otp") &&
					!emailProvider?.emailOtpEnabled
				)
					throw APIError.from("BAD_REQUEST", {
						code: "EMAIL_OTP_FLOW_DISABLED",
						message: "Email code sign-in is unavailable",
					});
				if (ctx.path === "/sign-in/email") {
					const email = (ctx.body as { email?: unknown } | undefined)?.email;
					if (typeof email === "string" && isInternalIdentityEmail(email))
						throw APIError.from("UNAUTHORIZED", {
							code: "INVALID_EMAIL_OR_PASSWORD",
							message: "Invalid email or password",
						});
				}
				// Internal identity addresses (<telegramId>@telegram.invalid) are
				// reserved for Telegram-created users; a squatter must not register
				// or move onto one and inherit that identity's account.
				if (ctx.path === "/sign-up/email" || ctx.path === "/change-email") {
					const body = ctx.body as
						| { email?: unknown; newEmail?: unknown }
						| undefined;
					const email =
						ctx.path === "/sign-up/email" ? body?.email : body?.newEmail;
					if (typeof email === "string" && isInternalIdentityEmail(email))
						throw invalidEmailError();
				}
				if (ctx.path === "/telegram/miniapp/signin") {
					assertTrustedTelegramOrigin(ctx, trustedOrigins);
					await reserveTelegramMiniAppReplay(ctx, telegramOidcProvider);
					return;
				}
				if (ctx.path === "/telegram/signin") {
					assertTrustedTelegramOrigin(ctx, trustedOrigins);
					await reserveTelegramWidgetReplay(ctx, telegramOidcProvider);
					return;
				}
				if (ctx.path !== "/unlink-account") return;
				const session = await getSessionFromCtx(ctx);
				if (!session) return;
				const body = ctx.body as
					| { providerId?: unknown; accountId?: unknown }
					| undefined;
				if (typeof body?.providerId !== "string") return;
				try {
					await assertAccountCanBeUnlinked(db.$client, {
						userId: session.user.id,
						providerId: body.providerId,
						accountId:
							typeof body.accountId === "string" ? body.accountId : undefined,
					});
				} catch (error) {
					if (!(error instanceof DomainError)) throw error;
					throw APIError.from("CONFLICT", {
						code: "AUTH_LAST_LOGIN_METHOD",
						message:
							"Link another enabled login method before unlinking this account",
					});
				}
			}),
			after: createAuthMiddleware(async (ctx) => {
				if (ctx.context.returned instanceof APIError) {
					await auditAuthenticationFailure(db.$client, ctx.path, ctx.headers);
					return;
				}
				if (ctx.path === "/telegram/miniapp/signin")
					await backfillTelegramMiniAppImage(
						ctx,
						telegramOidcProvider,
						db.$client,
					);
				if (ctx.path === "/telegram/signin")
					await backfillTelegramWidgetImage(ctx, db.$client);
				const action = securityAuditAction(ctx.path);
				if (!action) return;
				const userId =
					securityAuditUserId(ctx.context) ??
					(await getSessionFromCtx(ctx).catch(() => null))?.user.id;
				if (!userId) return;
				const after =
					ctx.path === "/change-password"
						? {
								revokeOtherSessions: Boolean(
									(ctx.body as { revokeOtherSessions?: boolean } | undefined)
										?.revokeOtherSessions,
								),
							}
						: null;
				await db.$client.batch([
					...(passwordCredentialChanged(ctx.path)
						? [
								db.$client
									.prepare(
										`UPDATE supplier_api_keys SET revoked_at = ?, updated_at = ?
										 WHERE user_id = ? AND revoked_at IS NULL`,
									)
									.bind(Date.now(), Date.now(), userId),
							]
						: []),
					db.$client
						.prepare(
							`INSERT INTO audit_logs
						(id, actor_user_id, action, target_type, target_id, request_id, ip_address, after, created_at)
						VALUES (?, ?, ?, 'user', ?, ?, ?, ?, ?)`,
						)
						.bind(
							crypto.randomUUID(),
							userId,
							action,
							userId,
							ctx.headers?.get("x-request-id") ?? null,
							clientIpFromHeaders(ctx.headers),
							after ? JSON.stringify(after) : null,
							Date.now(),
						),
				]);
			}),
		},
		plugins: [
			...(emailDeliveryEnabled
				? [
						emailOTP({
							allowedAttempts: 3,
							disableSignUp: true,
							expiresIn: 600,
							otpLength: 6,
							rateLimit: { window: 60, max: 3 },
							storeOTP: "hashed",
							sendVerificationOTP: async ({ email, otp, type }) => {
								if (type === "sign-in" && emailProvider?.emailOtpEnabled) {
									const locale = await loadUserEmailLocale(db.$client, email);
									await enqueueConfiguredEmailNotification(db.$client, {
										event: "auth.email_otp_sign_in",
										idempotencyKey: `auth-email-otp-sign-in:${await tokenDigest(`${email}:${otp}`)}`,
										to: email,
										locale,
										subject: m.auth_email_otp_subject({ siteName }, { locale }),
										text: m.auth_email_otp_text({ otp }, { locale }),
									});
									return;
								}
								if (type !== "forget-password")
									throw APIError.from("BAD_REQUEST", {
										code: "EMAIL_OTP_FLOW_DISABLED",
										message: "This email OTP flow is unavailable",
									});
								const locale = await loadUserEmailLocale(db.$client, email);
								await enqueueConfiguredEmailNotification(db.$client, {
									event: "auth.password_reset",
									idempotencyKey: `auth-password-reset:${await tokenDigest(`${email}:${otp}`)}`,
									to: email,
									locale,
									subject: m.auth_email_password_reset_subject(
										{ siteName },
										{ locale },
									),
									text: m.auth_email_password_reset_text({ otp }, { locale }),
								});
							},
						}),
					]
				: []),
			...(telegramOidcProvider?.telegramBotToken &&
			telegramOidcProvider.telegramBotUsername
				? [
						telegram({
							botToken: telegramOidcProvider.telegramBotToken,
							botUsername: telegramOidcProvider.telegramBotUsername,
							loginWidget: true,
							autoCreateUser: telegramOidcProvider.allowSignup,
							maxAuthAge: 300,
							mapTelegramDataToUser: (user) => ({
								name:
									[user.first_name, user.last_name].filter(Boolean).join(" ") ||
									user.username ||
									`Telegram ${user.id}`,
								email: telegramIdentityEmail(String(user.id)),
								image: telegramProfileImage(user.photo_url),
							}),
							miniApp: {
								enabled: telegramOidcProvider.telegramMiniAppEnabled,
								validateInitData: true,
								allowAutoSignin: telegramOidcProvider.allowSignup,
								mapMiniAppDataToUser: (user) => ({
									name:
										[user.first_name, user.last_name]
											.filter(Boolean)
											.join(" ") ||
										user.username ||
										`Telegram ${user.id}`,
									email: telegramIdentityEmail(String(user.id)),
									image: telegramProfileImage(user.photo_url),
									preferredLocale: telegramPreferredLocale(user.language_code),
								}),
							},
						}),
					]
				: []),
			...(telegramOidcProvider?.clientId &&
			(telegramOidcProvider.clientSecret ||
				telegramOidcProvider.telegramBotToken)
				? [
						telegramOidcBetterAuthPlugin(
							telegramOidcProvider,
							db.$client,
							new URL(env.BETTER_AUTH_URL).origin,
						),
					]
				: []),
			enabledUsersPlugin(),
			tanstackStartCookies(),
		],
	});
}

/**
 * D1-authoritative Better Auth rate-limit storage. Better Auth now requires
 * custom storage to expose the atomic `consume` operation directly, so the
 * fixed-window counter remains the single source of truth shared by every
 * isolate.
 */
export function createAuthRateLimitStorage(
	database: D1Database,
	now: () => number = Date.now,
): BetterAuthRateLimitStorage {
	return {
		consume: async (key, rule) => {
			const windowMs = rule.window * 1_000;
			const claimedAt = now();
			const budget = await claimFixedWindowRateLimit(database, {
				bucketKey: `better-auth:${key}`,
				limit: rule.max,
				windowMs,
				now: claimedAt,
			});
			return {
				allowed: budget.allowed,
				retryAfter: budget.allowed
					? null
					: Math.max(
							1,
							Math.ceil((budget.windowStart + windowMs - claimedAt) / 1_000),
						),
			};
		},
	};
}

function invalidEmailError() {
	return APIError.from("BAD_REQUEST", {
		code: "INVALID_EMAIL",
		message: "Invalid email address",
	});
}

/**
 * Only Telegram sign-in flows may create users on the reserved
 * `<telegramId>@telegram.invalid` identity domain. Better Auth passes the
 * endpoint context to database hooks; routed requests carry the concrete
 * path while direct `auth.api` calls carry the declared pattern.
 */
function createsTelegramIdentity(
	ctx: { path?: string; params?: Record<string, unknown> } | null | undefined,
) {
	if (!ctx?.path) return true;
	if (
		ctx.path === "/telegram/signin" ||
		ctx.path === "/telegram/miniapp/signin"
	)
		return true;
	return (
		ctx.path === "/callback/telegram" ||
		(ctx.path === "/callback/:id" && ctx.params?.id === "telegram")
	);
}

function assertTrustedTelegramOrigin(
	ctx: GenericEndpointContext,
	trustedOrigins: string[],
) {
	const origin = ctx.headers?.get("origin");
	if (!origin || !trustedOrigins.includes(origin))
		throw APIError.from("FORBIDDEN", {
			code: "UNTRUSTED_ORIGIN",
			message: "The request origin is not trusted",
		});
}

async function reserveTelegramWidgetReplay(
	ctx: GenericEndpointContext,
	provider: RuntimeAuthProvider | undefined,
) {
	if (!provider?.telegramBotToken)
		throw APIError.from("NOT_FOUND", {
			code: "AUTH_PROVIDER_UNAVAILABLE",
			message: "Authentication provider is unavailable",
		});
	const parsed = telegramWidgetAuthDataSchema.safeParse(ctx.body);
	if (!parsed.success) return;
	const verified = await verifyTelegramWidgetAuthData(
		parsed.data,
		provider.telegramBotToken,
		{ maxAgeMs: 300_000 },
	);
	if (!verified)
		throw APIError.from("UNAUTHORIZED", {
			code: "TELEGRAM_AUTH_INVALID",
			message: "Telegram authentication is invalid or expired",
		});
	const reserved = await ctx.context.internalAdapter.reserveVerificationValue({
		identifier: `telegram-widget:${verified.replayDigest}`,
		value: provider.id,
		expiresAt: new Date(verified.authenticatedAt + 300_000),
	});
	if (!reserved)
		throw APIError.from("UNAUTHORIZED", {
			code: "TELEGRAM_AUTH_REPLAYED",
			message: "Telegram authentication is invalid or expired",
		});
}

async function reserveTelegramMiniAppReplay(
	ctx: GenericEndpointContext,
	provider: RuntimeAuthProvider | undefined,
) {
	if (!provider?.telegramBotToken)
		throw APIError.from("NOT_FOUND", {
			code: "AUTH_PROVIDER_UNAVAILABLE",
			message: "Authentication provider is unavailable",
		});
	const initData = (ctx.body as { initData?: unknown } | undefined)?.initData;
	if (typeof initData !== "string") return;
	let replayDigest: string;
	let expiresAt: number;
	try {
		const identity = await verifyTelegramMiniAppInitData(
			initData,
			provider.telegramBotToken,
			{ maxAgeMs: 300_000 },
		);
		replayDigest = identity.replayDigest;
		expiresAt = identity.authenticatedAt + 300_000;
	} catch (error) {
		if (error instanceof TelegramMiniAppAuthError)
			throw APIError.from("UNAUTHORIZED", {
				code: "TELEGRAM_AUTH_INVALID",
				message: "Telegram authentication is invalid or expired",
			});
		throw error;
	}
	const reserved = await ctx.context.internalAdapter.reserveVerificationValue({
		identifier: `telegram-mini-app:${replayDigest}`,
		value: provider.id,
		expiresAt: new Date(expiresAt),
	});
	if (!reserved)
		throw APIError.from("UNAUTHORIZED", {
			code: "TELEGRAM_AUTH_REPLAYED",
			message: "Telegram authentication is invalid or expired",
		});
}

async function backfillTelegramMiniAppImage(
	ctx: GenericEndpointContext,
	provider: RuntimeAuthProvider | undefined,
	database: D1Database,
) {
	const initData = (ctx.body as { initData?: unknown } | undefined)?.initData;
	if (typeof initData !== "string" || !provider?.telegramBotToken) return;
	try {
		const identity = await verifyTelegramMiniAppInitData(
			initData,
			provider.telegramBotToken,
			{ maxAgeMs: 300_000 },
		);
		const image = telegramProfileImage(identity.photoUrl);
		if (!image) return;
		const userId =
			securityAuditUserId(ctx.context) ??
			(await getSessionFromCtx(ctx).catch(() => null))?.user.id;
		if (!userId) return;
		await database
			.prepare(
				`UPDATE users SET image = ?, updated_at = ?
				 WHERE id = ? AND image IS NULL`,
			)
			.bind(image, Date.now(), userId)
			.run();
	} catch (error) {
		if (!(error instanceof TelegramMiniAppAuthError)) throw error;
	}
}

async function backfillTelegramWidgetImage(
	ctx: GenericEndpointContext,
	database: D1Database,
) {
	const parsed = telegramWidgetAuthDataSchema.safeParse(ctx.body);
	const image = parsed.success
		? telegramProfileImage(parsed.data.photo_url)
		: undefined;
	if (!image) return;
	const userId =
		securityAuditUserId(ctx.context) ??
		(await getSessionFromCtx(ctx).catch(() => null))?.user.id;
	if (!userId) return;
	await database
		.prepare(
			`UPDATE users SET image = ?, updated_at = ?
			 WHERE id = ? AND image IS NULL`,
		)
		.bind(image, Date.now(), userId)
		.run();
}

function telegramOidcBetterAuthPlugin(
	provider: RuntimeAuthProvider,
	database: D1Database,
	authOrigin: string,
) {
	const clientSecret = provider.clientSecret ?? "telegram-widget-fallback";
	const baseProvider = createTelegramOIDCProvider(clientSecret, {
		clientId: provider.clientId ?? "",
		clientSecret,
		scopes: provider.scopes,
		mapOIDCProfileToUser: (claims) => ({
			email: telegramIdentityEmail(claims.sub),
			image: telegramProfileImage(claims.picture),
		}),
	});
	const telegramProvider = {
		...baseProvider,
		accountSubject: ({ profile }: { profile: object }) => {
			if (
				!("sub" in profile) ||
				typeof profile.sub !== "string" ||
				!profile.sub
			)
				throw new Error("Telegram OIDC subject is invalid");
			return profile.sub;
		},
		async createAuthorizationURL(
			input: Parameters<typeof baseProvider.createAuthorizationURL>[0],
		) {
			if (!input.codeVerifier)
				throw new Error("Telegram OIDC requires a PKCE verifier");
			const redirectOrigin = new URL(input.redirectURI).origin;
			if (redirectOrigin !== authOrigin)
				throw new Error(
					"Telegram OIDC callback origin must match the authentication origin",
				);
			const url = await baseProvider.createAuthorizationURL(input);
			url.searchParams.set("nonce", await oidcNonce(input.codeVerifier));
			url.searchParams.set("origin", redirectOrigin);
			return url;
		},
		async validateAuthorizationCode(
			input: Parameters<typeof baseProvider.validateAuthorizationCode>[0],
		) {
			if (!provider.clientSecret)
				throw new Error("Telegram OIDC client secret is not configured");
			if (!input.codeVerifier)
				throw new Error("Telegram OIDC requires a PKCE verifier");
			const tokens = await baseProvider.validateAuthorizationCode(input);
			if (!tokens?.idToken)
				throw new Error("Telegram OIDC did not return an ID token");
			const verified = await jwtVerify(tokens.idToken, telegramOidcJwks, {
				issuer: "https://oauth.telegram.org",
				audience: provider.clientId ?? "",
				algorithms: ["RS256", "ES256", "EdDSA", "ES256K"],
				clockTolerance: 30,
				maxTokenAge: "10m",
				requiredClaims: ["sub", "iat", "exp", "nonce"],
			});
			if (verified.payload.nonce !== (await oidcNonce(input.codeVerifier)))
				throw new Error("Telegram OIDC nonce is invalid");
			const image = telegramProfileImage(verified.payload.picture);
			await database.batch([
				...(image
					? [
							database
								.prepare(
									`UPDATE users SET image = ?, updated_at = ?
									 WHERE image IS NULL AND id = (
									  SELECT user_id FROM accounts
									  WHERE provider_id = 'telegram' AND account_id = ?
									  LIMIT 1
									 )`,
								)
								.bind(image, Date.now(), verified.payload.sub),
						]
					: []),
				database
					.prepare(
						`INSERT INTO audit_logs
					 (id, action, target_type, target_id, after, created_at)
					 VALUES (?, 'auth.telegram_oidc_signed_in', 'auth', ?, ?, ?)`,
					)
					.bind(
						crypto.randomUUID(),
						`telegram:${verified.payload.sub}`,
						JSON.stringify({ providerId: "telegram" }),
						Date.now(),
					),
			]);
			return tokens;
		},
	};
	return {
		id: "telegram-oidc-provider",
		init(ctx) {
			return {
				context: {
					socialProviders: [
						{
							...telegramProvider,
							id: "telegram",
							options: {
								...telegramProvider.options,
								disableImplicitSignUp: !provider.allowSignup,
							},
						},
						...ctx.socialProviders,
					],
				},
			};
		},
	} satisfies BetterAuthPlugin;
}

const telegramOidcJwks = createRemoteJWKSet(
	new URL("https://oauth.telegram.org/.well-known/jwks.json"),
);

async function oidcNonce(codeVerifier: string) {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(codeVerifier),
	);
	return bytesToBase64Url(new Uint8Array(digest));
}

function bytesToBase64Url(bytes: Uint8Array) {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

async function tokenDigest(token: string) {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(token),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

const defaultCredentialProvider = {
	id: "auth-provider-credential",
	providerId: "credential",
	providerType: "email",
	displayName: "Email",
	clientId: null,
	clientSecret: null,
	scopes: [],
	allowSignup: false,
	passwordLoginEnabled: true,
	emailOtpEnabled: false,
	revision: 1,
	telegramBotUserId: null,
	telegramBotUsername: null,
	telegramBotToken: null,
	telegramMiniAppEnabled: false,
} satisfies RuntimeAuthProvider;

function createSocialProviders(
	providers: RuntimeAuthProvider[],
): BetterAuthOptions["socialProviders"] {
	const find = (providerId: string) =>
		providers.find(
			(provider) =>
				provider.providerType === "social" &&
				provider.providerId === providerId &&
				provider.clientId &&
				provider.clientSecret,
		);
	const option = (provider: RuntimeAuthProvider) => ({
		clientId: provider.clientId ?? "",
		clientSecret: provider.clientSecret ?? "",
		scopes: provider.scopes,
		disableImplicitSignUp: !provider.allowSignup,
	});
	const apple = find("apple");
	const discord = find("discord");
	const github = find("github");
	const google = find("google");
	const line = find("line");
	const microsoft = find("microsoft");
	const wechat = find("wechat");
	return {
		...(apple ? { apple: option(apple) } : {}),
		...(discord ? { discord: option(discord) } : {}),
		...(github ? { github: option(github) } : {}),
		...(google ? { google: option(google) } : {}),
		...(line ? { line: option(line) } : {}),
		...(microsoft ? { microsoft: option(microsoft) } : {}),
		...(wechat ? { wechat: option(wechat) } : {}),
	};
}

function securityAuditAction(path: string) {
	return (
		{
			"/telegram/signin": "auth.telegram_widget_signed_in",
			"/telegram/miniapp/signin": "auth.telegram_mini_app_signed_in",
			"/sign-in/email": "auth.signed_in",
			"/sign-in/email-otp": "auth.email_otp_signed_in",
			"/sign-up/email": "auth.signed_up",
			"/sign-out": "auth.signed_out",
			"/change-password": "auth.password_changed",
			"/set-password": "auth.password_set",
			"/change-email": "auth.email_change_requested",
			"/email-otp/reset-password": "auth.password_reset",
			"/verify-email": "auth.email_verified",
			"/send-verification-email": "auth.verification_requested",
			"/link-social": "auth.account_link_started",
			"/unlink-account": "auth.account_unlinked",
		}[path] ?? null
	);
}

function passwordCredentialChanged(path: string) {
	return [
		"/change-password",
		"/set-password",
		"/reset-password",
		"/email-otp/reset-password",
	].includes(path);
}

async function auditAuthenticationFailure(
	database: D1Database,
	path: string,
	headers: Headers | undefined,
) {
	const action = authenticationFailureAction(path);
	if (!action) return;
	await database
		.prepare(
			`INSERT INTO audit_logs
			 (id, action, target_type, target_id, request_id, ip_address, after, created_at)
			 VALUES (?, ?, 'auth', 'anonymous', ?, ?, ?, ?)`,
		)
		.bind(
			crypto.randomUUID(),
			action,
			headers?.get("x-request-id") ?? null,
			clientIpFromHeaders(headers),
			JSON.stringify({ path }),
			Date.now(),
		)
		.run();
}

function authenticationFailureAction(path: string) {
	if (path === "/callback/telegram") return "auth.telegram_oidc_failed";
	return (
		{
			"/sign-in/email": "auth.sign_in_failed",
			"/sign-in/email-otp": "auth.email_otp_sign_in_failed",
			"/change-email": "auth.email_change_failed",
			"/telegram/miniapp/signin": "auth.telegram_mini_app_failed",
			"/telegram/signin": "auth.telegram_widget_failed",
		}[path] ?? null
	);
}

function securityAuditUserId(context: {
	session?: { user?: { id?: string } } | null;
	newSession?: { user?: { id?: string } } | null;
	returned?: unknown;
}) {
	return (
		context.session?.user?.id ??
		context.newSession?.user?.id ??
		findReturnedUserId(context.returned) ??
		null
	);
}

function findReturnedUserId(value: unknown, depth = 0): string | undefined {
	if (!value || typeof value !== "object" || depth > 3) return undefined;
	const object = value as Record<string, unknown>;
	if (object.user && typeof object.user === "object") {
		const id = (object.user as Record<string, unknown>).id;
		if (typeof id === "string") return id;
	}
	for (const key of ["response", "data", "result"]) {
		const id = findReturnedUserId(object[key], depth + 1);
		if (id) return id;
	}
	return undefined;
}

function supportedEmailLocale(value: unknown): "en-US" | "zh-CN" {
	return value === "zh-CN" ? "zh-CN" : "en-US";
}

function telegramPreferredLocale(value: unknown): "en-US" | "zh-CN" {
	return typeof value === "string" && value.toLowerCase().startsWith("zh")
		? "zh-CN"
		: "en-US";
}

function telegramProfileImage(value: unknown) {
	if (typeof value !== "string" || value.length > 2_048) return undefined;
	try {
		return new URL(value).protocol === "https:" ? value : undefined;
	} catch {
		return undefined;
	}
}

async function loadUserEmailLocale(db: D1Database, email: string) {
	const user = await db
		.prepare(
			"SELECT preferred_locale FROM users WHERE lower(email) = lower(?) LIMIT 1",
		)
		.bind(email.trim())
		.first<{ preferred_locale: string }>();
	return supportedEmailLocale(user?.preferred_locale);
}

function enabledUsersPlugin() {
	return {
		id: "enabled-users",
		init() {
			return {
				options: {
					databaseHooks: {
						user: {
							create: {
								async before(
									newUser: Record<string, unknown>,
									ctx?: {
										path?: string;
										params?: Record<string, unknown>;
									} | null,
								) {
									if (
										typeof newUser.email === "string" &&
										isInternalIdentityEmail(newUser.email) &&
										!createsTelegramIdentity(ctx)
									)
										throw invalidEmailError();
									return {
										data: {
											enabled: true,
											...newUser,
											preferredLocale: supportedEmailLocale(
												newUser.preferredLocale,
											),
										},
									};
								},
							},
						},
						session: {
							create: {
								async before(
									newSession: { userId?: string },
									ctx?: {
										context?: {
											internalAdapter?: {
												findUserById?: (id: string) => Promise<unknown>;
											};
										};
									} | null,
								) {
									const userId = newSession.userId;
									const currentUser =
										userId &&
										(await ctx?.context?.internalAdapter?.findUserById?.(
											userId,
										));
									if (
										(currentUser as { enabled?: boolean | null } | null)
											?.enabled !== true
									)
										throw APIError.from("FORBIDDEN", {
											message: "This user has been disabled.",
											code: "USER_DISABLED",
										});
								},
							},
						},
					},
				},
			};
		},
	} as unknown as BetterAuthPlugin;
}
