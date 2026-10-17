import { authProviderSecretPurpose } from "#/features/auth/provider-settings";
import { exchangeRateSyncSettingKeys } from "#/features/exchange-rates/server/sync";
import {
	feishuAlertSettingKeys,
	feishuAppSecretPurpose,
} from "#/features/telegram/server/feishu-alerts";
import {
	telegramOwnerAlertBotTokenPurpose,
	telegramOwnerAlertSettingKeys,
} from "#/features/telegram/server/owner-alerts";
import { reencryptSecret, secretKeyIds } from "#/lib/secrets";
import type { RuntimeConfig } from "#/server/runtime-config";

type SecretSpec = {
	table: string;
	column: string;
	purpose: string;
	keyring: keyof Pick<RuntimeConfig, "dataEncryptionSecret">;
};

const secretSpecs: SecretSpec[] = [
	{
		table: "stock_entries",
		column: "content_encrypted",
		purpose: "card-secret",
		keyring: "dataEncryptionSecret",
	},
	{
		table: "product_sellable_items",
		column: "automation_credential_encrypted",
		purpose: "build-config",
		keyring: "dataEncryptionSecret",
	},
	{
		table: "automation_jobs",
		column: "callback_secret_encrypted",
		purpose: "build-callback",
		keyring: "dataEncryptionSecret",
	},
	{
		table: "entitlement_authorization_values",
		column: "value_encrypted",
		purpose: "build-input",
		keyring: "dataEncryptionSecret",
	},
	{
		table: "delivery_records",
		column: "content_encrypted",
		purpose: "delivery-content",
		keyring: "dataEncryptionSecret",
	},
	{
		table: "payment_channels",
		column: "credential_encrypted",
		purpose: "payment-credential",
		keyring: "dataEncryptionSecret",
	},
	{
		table: "supplier_accounts",
		column: "credentials_encrypted",
		purpose: "supplier-account-credentials",
		keyring: "dataEncryptionSecret",
	},
	{
		table: "notification_channel_configs",
		column: "api_key_encrypted",
		purpose: "notification-config",
		keyring: "dataEncryptionSecret",
	},
	{
		table: "notification_subscriptions",
		column: "destination_encrypted",
		purpose: "notification-destination",
		keyring: "dataEncryptionSecret",
	},
	{
		table: "notification_deliveries",
		column: "message_encrypted",
		purpose: "notification-message",
		keyring: "dataEncryptionSecret",
	},
];

export async function progressivelyReencryptSecrets(
	db: D1Database,
	runtime: RuntimeConfig,
	limitPerField = 10,
) {
	let rewritten = await reencryptExchangeRateCredential(
		db,
		runtime.dataEncryptionSecret,
	);
	rewritten += await reencryptAuthProviderSecrets(
		db,
		runtime.dataEncryptionSecret,
		limitPerField,
	);
	rewritten += await reencryptSettingSecret(
		db,
		feishuAlertSettingKeys.appSecret,
		feishuAppSecretPurpose,
		runtime.dataEncryptionSecret,
	);
	rewritten += await reencryptSettingSecret(
		db,
		telegramOwnerAlertSettingKeys.botToken,
		telegramOwnerAlertBotTokenPurpose,
		runtime.dataEncryptionSecret,
	);
	rewritten += await reencryptJsonSecretMap(
		db,
		"shop_order_items",
		"sensitive_input_values_json",
		"order-input",
		runtime.dataEncryptionSecret,
		limitPerField,
	);
	rewritten += await reencryptJsonSecretMap(
		db,
		"automation_jobs",
		"sensitive_inputs_json",
		"build-input",
		runtime.dataEncryptionSecret,
		limitPerField,
	);
	for (const spec of secretSpecs) {
		const keyring = runtime[spec.keyring];
		if (!keyring) continue;
		const currentEnvelopePrefix = `v1.${secretKeyIds(keyring).current}.%`;
		const rows = await db
			.prepare(
				`SELECT id, ${spec.column} AS encrypted FROM ${spec.table}
				 WHERE ${spec.column} IS NOT NULL AND ${spec.column} NOT LIKE ?
				 ORDER BY id LIMIT ?`,
			)
			.bind(currentEnvelopePrefix, limitPerField)
			.all<{ id: string; encrypted: string }>();
		const updates: D1PreparedStatement[] = [];
		for (const row of rows.results) {
			const encrypted = await reencryptSecret(
				row.encrypted,
				keyring,
				spec.purpose,
			);
			if (encrypted)
				updates.push(
					db
						.prepare(`UPDATE ${spec.table} SET ${spec.column} = ? WHERE id = ?`)
						.bind(encrypted, row.id),
				);
		}
		if (updates.length) {
			const results = await db.batch(updates);
			rewritten += results.reduce(
				(total, result) => total + Number(result.meta.changes ?? 0),
				0,
			);
		}
	}
	return rewritten;
}

async function reencryptJsonSecretMap(
	db: D1Database,
	table: "shop_order_items" | "automation_jobs",
	column: "sensitive_input_values_json" | "sensitive_inputs_json",
	purpose: "order-input" | "build-input",
	keyring: string,
	limit: number,
) {
	if (!keyring) return 0;
	const rows = await db
		.prepare(
			`SELECT id, ${column} AS values_json FROM ${table}
			 WHERE ${column} <> '{}' ORDER BY id LIMIT ?`,
		)
		.bind(limit)
		.all<{ id: string; values_json: string }>();
	const updates: D1PreparedStatement[] = [];
	for (const row of rows.results) {
		const values = parseSecretMap(row.values_json);
		let changed = false;
		for (const entry of Object.values(values)) {
			const rewritten = await reencryptSecret(entry.envelope, keyring, purpose);
			if (!rewritten) continue;
			entry.envelope = rewritten;
			entry.keyVersion = 1;
			changed = true;
		}
		if (changed)
			updates.push(
				db
					.prepare(
						`UPDATE ${table} SET ${column} = ?, updated_at = ? WHERE id = ?`,
					)
					.bind(JSON.stringify(values), Date.now(), row.id),
			);
	}
	if (!updates.length) return 0;
	const results = await db.batch(updates);
	return results.reduce(
		(total, result) => total + Number(result.meta.changes ?? 0),
		0,
	);
}

function parseSecretMap(value: string) {
	try {
		const parsed: unknown = JSON.parse(value);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
			return {};
		const entries = Object.entries(parsed).filter(
			(entry): entry is [string, { envelope: string; keyVersion: number }] =>
				entry[1] != null &&
				typeof entry[1] === "object" &&
				typeof (entry[1] as { envelope?: unknown }).envelope === "string" &&
				typeof (entry[1] as { keyVersion?: unknown }).keyVersion === "number",
		);
		return Object.fromEntries(entries);
	} catch {
		return {};
	}
}

async function reencryptAuthProviderSecrets(
	db: D1Database,
	keyring: string,
	limit: number,
) {
	if (!keyring) return 0;
	const rows = await db
		.prepare(
			`SELECT key, value FROM system_settings
			 WHERE key LIKE 'auth.provider.%.secret' AND is_secret = 1
			 ORDER BY key LIMIT ?`,
		)
		.bind(limit)
		.all<{ key: string; value: string }>();
	const updates: D1PreparedStatement[] = [];
	for (const row of rows.results) {
		const match = /^auth\.provider\.([a-z][a-z0-9_-]{1,63})\.secret$/.exec(
			row.key,
		);
		if (!match?.[1]) continue;
		let encrypted: unknown;
		try {
			encrypted = JSON.parse(row.value);
		} catch {
			continue;
		}
		if (typeof encrypted !== "string") continue;
		const next = await reencryptSecret(
			encrypted,
			keyring,
			authProviderSecretPurpose(match[1]),
		);
		if (next)
			updates.push(
				db
					.prepare(
						"UPDATE system_settings SET value = ?, updated_at = ? WHERE key = ?",
					)
					.bind(JSON.stringify(next), Date.now(), row.key),
			);
	}
	if (!updates.length) return 0;
	const results = await db.batch(updates);
	return results.reduce(
		(total, result) => total + Number(result.meta.changes ?? 0),
		0,
	);
}

async function reencryptExchangeRateCredential(
	db: D1Database,
	keyring: string,
) {
	if (!keyring) return 0;
	const row = await db
		.prepare("SELECT value FROM system_settings WHERE key = ? LIMIT 1")
		.bind(exchangeRateSyncSettingKeys.credential)
		.first<{ value: string }>();
	if (!row) return 0;
	let encrypted: unknown;
	try {
		encrypted = JSON.parse(row.value);
	} catch {
		return 0;
	}
	if (typeof encrypted !== "string") return 0;
	const rewritten = await reencryptSecret(
		encrypted,
		keyring,
		"exchange-rate-provider",
	);
	if (!rewritten) return 0;
	const result = await db
		.prepare(
			"UPDATE system_settings SET value = ?, updated_at = ? WHERE key = ?",
		)
		.bind(
			JSON.stringify(rewritten),
			Date.now(),
			exchangeRateSyncSettingKeys.credential,
		)
		.run();
	return Number(result.meta.changes ?? 0);
}

async function reencryptSettingSecret(
	db: D1Database,
	key: string,
	purpose: string,
	keyring: string,
) {
	if (!keyring) return 0;
	const row = await db
		.prepare(
			"SELECT value FROM system_settings WHERE key = ? AND is_secret = 1 LIMIT 1",
		)
		.bind(key)
		.first<{ value: string }>();
	if (!row) return 0;
	let encrypted: unknown;
	try {
		encrypted = JSON.parse(row.value);
	} catch {
		return 0;
	}
	if (typeof encrypted !== "string") return 0;
	const rewritten = await reencryptSecret(encrypted, keyring, purpose);
	if (!rewritten) return 0;
	const result = await db
		.prepare(
			"UPDATE system_settings SET value = ?, updated_at = ? WHERE key = ?",
		)
		.bind(JSON.stringify(rewritten), Date.now(), key)
		.run();
	return Number(result.meta.changes ?? 0);
}
