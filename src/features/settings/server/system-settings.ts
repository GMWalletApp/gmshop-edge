import { z } from "zod";
import {
	isRuntimeSecret,
	presentSettingValue,
	shouldPreserveRuntimeSecret,
} from "#/features/settings/secrecy";
import { invalidateSiteBrandCache } from "#/features/settings/server/site-brand";
import { DomainError } from "#/lib/domain-error";
import { supportedLocales } from "#/lib/locales";
import { clientIpSources } from "#/server/client-ip";

export type SettingValue = string | number | boolean | string[];

const hostSchema = z
	.string()
	.trim()
	.toLowerCase()
	.regex(
		/^(?:\[[0-9a-f:]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::\d{1,5})?$/,
		"Host must not include a scheme, path, query, or fragment",
	);

const definitions = {
	"site.name": z.string().trim().min(1).max(80),
	"site.description": z.string().trim().max(240),
	"site.seo_title": z.string().trim().max(80),
	"site.seo_description": z.string().trim().max(320),
	"site.custom_html": z.string().trim().max(100_000),
	"site.default_locale": z.enum(supportedLocales),
	"site.logo_url": z.string().max(2_048),
	"orders.allow_guest_checkout": z.boolean(),
	"orders.default_expiry_ms": z.number().int().min(60_000).max(86_400_000),
	"orders.max_quantity": z.number().int().min(1).max(1_000),
	"automation.artifact_retention_ms": z
		.number()
		.int()
		.min(86_400_000)
		.max(31_536_000_000),
	"queue.publish_batch_size": z.number().int().min(1).max(100),
	"queue.retry_base_ms": z.number().int().min(1_000).max(3_600_000),
	"security.allowed_hosts": z
		.array(hostSchema)
		.min(1)
		.max(100)
		.transform((hosts) => [...new Set(hosts)]),
	"security.client_ip_source": z.enum(clientIpSources),
	"auth.registration_enabled": z.boolean(),
	"auth.require_email_verification": z.boolean(),
	"auth.session_max_age_seconds": z.number().int().min(3_600).max(31_536_000),
	"retention.audit_ms": z
		.number()
		.int()
		.min(2_592_000_000)
		.max(315_360_000_000),
	"runtime.better_auth_secret": z.string().min(32).max(512),
	"runtime.better_auth_url": z.url(),
	"runtime.automation_callback_secret": z.string().min(32).max(512),
	"runtime.data_encryption_secret": z.string().min(16).max(8_192),
	"commerce.default_currency": z
		.string()
		.trim()
		.toUpperCase()
		.regex(/^[A-Z]{3}$/),
	"commerce.currency_decimals": z.number().int().min(0).max(8),
	"commerce.currency_symbol": z.string().trim().min(1).max(12),
	"commerce.supplier_api_enabled": z.boolean(),
} as const;

export type SettingKey = keyof typeof definitions;

const defaults: Record<SettingKey, SettingValue> = {
	"site.name": "GMShop Edge",
	"site.description": "",
	"site.seo_title": "",
	"site.seo_description": "",
	"site.custom_html": "",
	"site.default_locale": "en-US",
	"site.logo_url": "",
	"orders.allow_guest_checkout": true,
	"orders.default_expiry_ms": 900_000,
	"orders.max_quantity": 100,
	"automation.artifact_retention_ms": 2_592_000_000,
	"queue.publish_batch_size": 25,
	"queue.retry_base_ms": 15_000,
	"security.allowed_hosts": [],
	"security.client_ip_source": "auto",
	"auth.registration_enabled": true,
	"auth.require_email_verification": false,
	"auth.session_max_age_seconds": 2_592_000,
	"retention.audit_ms": 31_536_000_000,
	"runtime.better_auth_secret": "",
	"runtime.better_auth_url": "http://localhost:3000",
	"runtime.automation_callback_secret": "",
	"runtime.data_encryption_secret": "",
	"commerce.default_currency": "USD",
	"commerce.currency_decimals": 2,
	"commerce.currency_symbol": "$",
	"commerce.supplier_api_enabled": false,
};

export async function listSystemSettings(db: D1Database) {
	const rows = await db
		.prepare("SELECT key, value, updated_at FROM system_settings ORDER BY key")
		.all<{ key: string; value: string; updated_at: number }>();
	const stored = new Map(rows.results.map((row) => [row.key, row]));
	return (Object.keys(definitions) as SettingKey[]).map((key) => {
		const row = stored.get(key);
		const value = row ? parseStored(row.value, defaults[key]) : defaults[key];
		return {
			key,
			...presentSettingValue(key, value),
			isDefault: !row,
			updatedAt: row ? new Date(row.updated_at).toISOString() : null,
		};
	});
}

export async function saveSystemSettings(
	items: Array<{ key: string; value: unknown }>,
	dependencies: {
		db: D1Database;
		cache?: KVNamespace;
		userId: string;
		requestId?: string | null;
		ipAddress?: string | null;
		/** Only the keyring rotation path may replace an initialized keyring. */
		allowKeyringReplacement?: boolean;
	},
) {
	if (new Set(items.map((item) => item.key)).size !== items.length)
		throw new DomainError("invalid_settings", 400, "Duplicate setting key");
	const parsed = items.flatMap((item) => {
		if (!(item.key in definitions))
			throw new DomainError("invalid_settings", 400, "Unknown setting key");
		const key = item.key as SettingKey;
		if (shouldPreserveRuntimeSecret(key, item.value)) return [];
		const result = definitions[key].safeParse(item.value);
		if (!result.success) throw settingInvalid(key);
		return [{ key, value: result.data as SettingValue }];
	});
	await assertCommerceMoneySettingsMutable(parsed, dependencies.db);
	if (!dependencies.allowKeyringReplacement)
		await assertKeyringNotReplaced(parsed, dependencies.db);
	const now = Date.now();
	await dependencies.db.batch([
		...parsed.map((item) =>
			dependencies.db
				.prepare(
					`INSERT INTO system_settings
					 (key, value, is_secret, updated_by, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?)
					 ON CONFLICT(key) DO UPDATE SET value = excluded.value,
					 is_secret = excluded.is_secret, updated_by = excluded.updated_by,
					 updated_at = excluded.updated_at`,
				)
				.bind(
					item.key,
					JSON.stringify(item.value),
					isRuntimeSecret(item.key) ? 1 : 0,
					dependencies.userId,
					now,
					now,
				),
		),
		dependencies.db
			.prepare(
				`INSERT INTO audit_logs
				 (id, actor_user_id, action, target_type, target_id, request_id,
				  ip_address, after, created_at)
				 VALUES (?, ?, 'system_settings.updated', 'system_settings', NULL, ?, ?, ?, ?)`,
			)
			.bind(
				crypto.randomUUID(),
				dependencies.userId,
				dependencies.requestId ?? null,
				dependencies.ipAddress ?? null,
				JSON.stringify({ updatedKeys: parsed.map((item) => item.key) }),
				now,
			),
	]);
	if (parsed.some(({ key }) => key.startsWith("site.")))
		await invalidateSiteBrandCache(dependencies.cache);
	return { updated: parsed.map((item) => item.key) };
}

async function assertCommerceMoneySettingsMutable(
	parsed: Array<{ key: SettingKey; value: SettingValue }>,
	db: D1Database,
) {
	const moneySettings = parsed.filter(
		(item) =>
			item.key === "commerce.default_currency" ||
			item.key === "commerce.currency_decimals",
	);
	if (!moneySettings.length) return;
	const stored = await db
		.prepare(
			"SELECT key, value FROM system_settings WHERE key IN ('commerce.default_currency', 'commerce.currency_decimals')",
		)
		.all<{ key: string; value: string }>();
	const current = new Map(stored.results.map((row) => [row.key, row.value]));
	const changed = moneySettings.some(
		(item) =>
			JSON.stringify(item.value) !==
			(current.get(item.key) ?? JSON.stringify(defaults[item.key])),
	);
	if (!changed) return;
	const locked = await db
		.prepare(
			`SELECT
			 EXISTS(SELECT 1 FROM users WHERE balance_minor <> '0') OR
			 EXISTS(SELECT 1 FROM wallet_topups WHERE status = 'pending') OR
			 EXISTS(SELECT 1 FROM supplier_export_listings WHERE enabled = 1) AS locked`,
		)
		.first<{ locked: number }>();
	if (locked?.locked)
		throw new DomainError(
			"commerce_currency_locked",
			409,
			"Currency settings cannot change while balances, pending top-ups, or exported listings exist",
		);
}

// Fields whose rejection needs a specific explanation in the admin UI.
const settingErrorCodes: Partial<Record<SettingKey, string>> = {
	"security.allowed_hosts": "settings_allowed_hosts_required",
	"security.client_ip_source": "settings_client_ip_source_invalid",
};

function settingInvalid(key: SettingKey) {
	return new DomainError(
		settingErrorCodes[key] ?? "invalid_settings",
		400,
		`Invalid value for ${key}`,
	);
}

/**
 * The data-encryption keyring protects every stored credential. Overwriting it
 * with a free-form value would make all existing ciphertext undecryptable, so
 * an initialized keyring can only change through the rotation action.
 */
async function assertKeyringNotReplaced(
	parsed: Array<{ key: SettingKey; value: SettingValue }>,
	db: D1Database,
) {
	if (!parsed.some((item) => item.key === "runtime.data_encryption_secret"))
		return;
	const current = await db
		.prepare(
			"SELECT value FROM system_settings WHERE key = 'runtime.data_encryption_secret' LIMIT 1",
		)
		.first<{ value: string }>();
	if (!current) return;
	let stored: unknown;
	try {
		stored = JSON.parse(current.value);
	} catch {
		return;
	}
	if (typeof stored === "string" && stored.length > 0)
		throw new DomainError(
			"settings_keyring_rotate_only",
			409,
			"The data encryption keyring can only be rotated, not replaced",
		);
}

function parseStored(value: string, fallback: SettingValue): SettingValue {
	try {
		const parsed: unknown = JSON.parse(value);
		if (
			typeof parsed === "string" ||
			typeof parsed === "number" ||
			typeof parsed === "boolean"
		)
			return parsed;
		if (
			Array.isArray(parsed) &&
			parsed.every((item) => typeof item === "string")
		)
			return parsed;
		return fallback;
	} catch {
		return fallback;
	}
}
