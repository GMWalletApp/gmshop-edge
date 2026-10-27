import { z } from "zod";
import {
	applyRateAdjustment,
	exchangeRatePattern,
} from "#/features/exchange-rates/rates";
import { DomainError } from "#/lib/domain-error";
import { decimalPlaces, divideByRate } from "#/lib/money";
import { decryptSecret } from "#/lib/secrets";

export const exchangeRateProviders = [
	"exchangerate_host",
	"allratestoday",
] as const;
export type ExchangeRateProvider = (typeof exchangeRateProviders)[number];
const providerUrls = {
	exchangerate_host: "https://api.exchangerate.host/live",
	// Keyless ECB reference rates (about 30 currencies), refreshed daily.
	allratestoday: "https://allratestoday.com/api/open/latest/USD",
} as const satisfies Record<ExchangeRateProvider, string>;
export function exchangeRateProviderRequiresApiKey(
	provider: ExchangeRateProvider,
) {
	return provider === "exchangerate_host";
}
export const exchangeRateSyncSettingKeys = {
	config: "exchange_rates.sync.config",
	credential: "exchange_rates.sync.credential",
	status: "exchange_rates.sync.status",
} as const;

const syncConfigSettingSchema = z.object({
	provider: z.enum(exchangeRateProviders),
	enabled: z.boolean(),
	intervalMs: z.number().int().min(300_000).max(2_592_000_000),
	adjustmentBps: z.number().int().min(-9_999).max(100_000),
});
const syncStatusSettingSchema = z.object({
	lastSyncedAt: z.number().int().nonnegative().nullable(),
	lastStatus: z.enum(["never", "succeeded", "failed"]),
	lastErrorCode: z.string().nullable(),
});
const providerRateSchema = z.union([
	z.string().regex(exchangeRatePattern),
	z.number().positive(),
]);
const providerPayloadSchema = z.looseObject({
	success: z.boolean().optional(),
	rates: z.record(z.string(), providerRateSchema).optional(),
	quotes: z.record(z.string(), providerRateSchema).optional(),
	error: z
		.object({
			code: z.union([z.string(), z.number()]).optional(),
			type: z.string().optional(),
		})
		.optional(),
});

export type ExchangeRateSyncSettings = {
	enabled: boolean;
	provider: ExchangeRateProvider;
	intervalMs: number;
	adjustmentBps: number;
	hasApiKey: boolean;
	lastSyncedAt: number | null;
	lastStatus: "never" | "succeeded" | "failed";
	lastErrorCode: string | null;
};

type SyncConfigRow = {
	provider: ExchangeRateProvider;
	enabled: boolean;
	interval_ms: number;
	adjustment_bps: number;
	api_key_encrypted: string | null;
	last_synced_at: number | null;
	last_status: "never" | "succeeded" | "failed";
	last_error_code: string | null;
};

type SyncRateRow = { id: string; quote_currency: string };

export async function loadExchangeRateSyncSettings(db: D1Database) {
	const row = await loadSyncConfig(db);
	return presentSyncSettings(row);
}

export async function syncConfiguredExchangeRates(
	db: D1Database,
	keyring: string,
	request: typeof fetch = fetch,
	now = Date.now(),
) {
	const config = await requireSyncConfig(db, keyring);
	const baseCurrency = await loadBaseCurrency(db);
	const rates = await db
		.prepare(
			`SELECT id, quote_currency FROM exchange_rates
			 WHERE base_currency = ?
			 ORDER BY sort_order, quote_currency, id`,
		)
		.bind(baseCurrency)
		.all<SyncRateRow>();
	if (rates.results.length === 0) {
		await markSyncResult(db, now, "succeeded", null);
		return { updated: 0, failed: 0, observedAt: now };
	}
	try {
		const quotes = await fetchFiatRates(
			baseCurrency,
			rates.results.map((rate) => rate.quote_currency),
			config.apiKey,
			request,
			config.provider,
		);
		const expiresAt = now + Math.max(config.intervalMs * 2, 3_600_000);
		const updates = rates.results.flatMap((rate) => {
			const rawRate = quotes.get(rate.quote_currency);
			return rawRate
				? [
						db
							.prepare(
								`UPDATE exchange_rates SET raw_rate = ?, rate = ?, source = ?,
								 adjustment_bps = ?, observed_at = ?, expires_at = ?, updated_at = ?
								 WHERE id = ?`,
							)
							.bind(
								rawRate,
								applyRateAdjustment(rawRate, config.adjustmentBps),
								config.provider,
								config.adjustmentBps,
								now,
								expiresAt,
								now,
								rate.id,
							),
					]
				: [];
		});
		await db.batch([
			...updates,
			syncStatusStatement(db, now, "succeeded", null),
		]);
		return {
			updated: updates.length,
			failed: rates.results.length - updates.length,
			observedAt: now,
		};
	} catch (error) {
		const code = providerFailureCode(error);
		await markSyncResult(db, now, "failed", code);
		throw new DomainError(
			"exchange_rate_sync_failed",
			502,
			"Exchange-rate synchronization failed",
		);
	}
}

export async function syncExchangeRatesIfDue(
	db: D1Database,
	keyring: string,
	request: typeof fetch = fetch,
	now = Date.now(),
) {
	const row = await loadSyncConfig(db);
	if (
		!row?.enabled ||
		(exchangeRateProviderRequiresApiKey(row.provider) &&
			!row.api_key_encrypted) ||
		(row.last_synced_at != null && row.last_synced_at + row.interval_ms > now)
	)
		return null;
	try {
		return await syncConfiguredExchangeRates(db, keyring, request, now);
	} catch {
		return { updated: 0, failed: 1, observedAt: now };
	}
}

export async function fetchFiatRates(
	baseCurrency: string,
	quoteCurrencies: string[],
	apiKey: string | null,
	request: typeof fetch = fetch,
	provider: ExchangeRateProvider = "exchangerate_host",
) {
	const base = baseCurrency.toUpperCase();
	const quotes = [
		...new Set(quoteCurrencies.map((currency) => currency.toUpperCase())),
	];
	const requested = [
		...new Set([base, ...quotes].filter((code) => code !== "USD")),
	];
	const parameters = new URLSearchParams({ access_key: apiKey ?? "" });
	if (requested.length > 0) parameters.set("currencies", requested.join(","));
	const url =
		provider === "allratestoday"
			? providerUrls.allratestoday
			: `${providerUrls.exchangerate_host}?${parameters}`;
	const response = await request(url, {
		headers: { accept: "application/json" },
		signal: AbortSignal.timeout(8_000),
	});
	if (!response.ok) throw new ProviderError(`http_${response.status}`);
	const payload = providerPayloadSchema.parse(await response.json());
	if (payload.success === false) throw new ProviderError("provider_error");
	const usdRates = new Map<string, string>([["USD", "1"]]);
	for (const [key, value] of Object.entries(payload.rates ?? {}))
		usdRates.set(key.toUpperCase(), normalizeProviderRate(value));
	for (const [pair, value] of Object.entries(payload.quotes ?? {})) {
		const key = pair.toUpperCase();
		usdRates.set(
			key.startsWith("USD") ? key.slice(3) : key,
			normalizeProviderRate(value),
		);
	}
	const baseRate = usdRates.get(base);
	if (!baseRate) throw new ProviderError("base_rate_missing");
	return new Map(
		quotes.flatMap((quote) => {
			const quoteRate = usdRates.get(quote);
			if (!quoteRate) return [];
			if (base === quote) return [[quote, "1"] as const];
			return [
				[
					quote,
					base === "USD"
						? quoteRate
						: divideByRate(
								quoteRate,
								decimalPlaces(quoteRate),
								baseRate,
								decimalPlaces(baseRate),
								18,
							),
				] as const,
			];
		}),
	);
}

async function requireSyncConfig(db: D1Database, keyring: string) {
	const row = await loadSyncConfig(db);
	if (!row)
		throw new DomainError(
			"exchange_rate_sync_not_configured",
			409,
			"Exchange-rate synchronization is not configured",
		);
	if (
		exchangeRateProviderRequiresApiKey(row.provider) &&
		!row.api_key_encrypted
	)
		throw new DomainError(
			"exchange_rate_sync_credentials_required",
			409,
			"Exchange-rate provider credentials are required",
		);
	return {
		provider: row.provider,
		intervalMs: row.interval_ms,
		adjustmentBps: row.adjustment_bps,
		apiKey:
			row.provider === "exchangerate_host" && row.api_key_encrypted
				? await decryptSecret(
						row.api_key_encrypted,
						keyring,
						"exchange-rate-provider",
					)
				: null,
	};
}

async function loadSyncConfig(db: D1Database) {
	const rows = await db
		.prepare(
			`SELECT key, value FROM system_settings
			 WHERE key IN (?, ?, ?)`,
		)
		.bind(
			exchangeRateSyncSettingKeys.config,
			exchangeRateSyncSettingKeys.credential,
			exchangeRateSyncSettingKeys.status,
		)
		.all<{ key: string; value: string }>();
	const settings = new Map(rows.results.map((row) => [row.key, row.value]));
	const config = parseSetting(
		settings.get(exchangeRateSyncSettingKeys.config),
		syncConfigSettingSchema,
	);
	if (!config) return null;
	const status =
		parseSetting(
			settings.get(exchangeRateSyncSettingKeys.status),
			syncStatusSettingSchema,
		) ?? defaultSyncStatus;
	return {
		provider: config.provider,
		enabled: config.enabled,
		interval_ms: config.intervalMs,
		adjustment_bps: config.adjustmentBps,
		api_key_encrypted: parseEncryptedCredential(
			settings.get(exchangeRateSyncSettingKeys.credential),
		),
		last_synced_at: status.lastSyncedAt,
		last_status: status.lastStatus,
		last_error_code: status.lastErrorCode,
	} satisfies SyncConfigRow;
}

async function loadBaseCurrency(db: D1Database) {
	const row = await db
		.prepare(
			"SELECT value FROM system_settings WHERE key = 'commerce.default_currency' LIMIT 1",
		)
		.first<{ value: string }>();
	try {
		const value: unknown = JSON.parse(row?.value ?? '"USD"');
		return typeof value === "string" ? value.toUpperCase() : "USD";
	} catch {
		return "USD";
	}
}

async function markSyncResult(
	db: D1Database,
	now: number,
	status: "succeeded" | "failed",
	errorCode: string | null,
) {
	await syncStatusStatement(db, now, status, errorCode).run();
}

function presentSyncSettings(row: SyncConfigRow | null) {
	return {
		enabled: row?.enabled ?? false,
		provider: row?.provider ?? "exchangerate_host",
		intervalMs: row?.interval_ms ?? 86_400_000,
		adjustmentBps: row?.adjustment_bps ?? 0,
		hasApiKey: Boolean(row?.api_key_encrypted),
		lastSyncedAt: row?.last_synced_at ?? null,
		lastStatus: row?.last_status ?? "never",
		lastErrorCode: row?.last_error_code ?? null,
	} satisfies ExchangeRateSyncSettings;
}

export async function loadExchangeRateSyncCredential(db: D1Database) {
	const row = await db
		.prepare("SELECT value FROM system_settings WHERE key = ? LIMIT 1")
		.bind(exchangeRateSyncSettingKeys.credential)
		.first<{ value: string }>();
	return parseEncryptedCredential(row?.value);
}

function syncStatusStatement(
	db: D1Database,
	now: number,
	status: "succeeded" | "failed",
	errorCode: string | null,
) {
	return db
		.prepare(
			`INSERT INTO system_settings
			 (key, value, is_secret, updated_by, created_at, updated_at)
			 VALUES (?, ?, 0, NULL, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value,
			 is_secret = 0, updated_at = excluded.updated_at`,
		)
		.bind(
			exchangeRateSyncSettingKeys.status,
			JSON.stringify({
				lastSyncedAt: now,
				lastStatus: status,
				lastErrorCode: errorCode,
			}),
			now,
			now,
		);
}

const defaultSyncStatus = {
	lastSyncedAt: null,
	lastStatus: "never",
	lastErrorCode: null,
} as const;

function parseEncryptedCredential(value: string | undefined) {
	if (!value) return null;
	try {
		const parsed: unknown = JSON.parse(value);
		return typeof parsed === "string" && parsed ? parsed : null;
	} catch {
		return null;
	}
}

function parseSetting<T>(
	value: string | undefined,
	schema: z.ZodType<T>,
): T | null {
	if (!value) return null;
	try {
		const parsed = schema.safeParse(JSON.parse(value));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

function normalizeProviderRate(value: string | number) {
	if (typeof value === "string") return value;
	const normalized = value.toLocaleString("en-US", {
		useGrouping: false,
		maximumSignificantDigits: 15,
	});
	if (!exchangeRatePattern.test(normalized))
		throw new ProviderError("rate_invalid");
	return normalized;
}

function providerFailureCode(error: unknown) {
	return error instanceof ProviderError ? error.code : "provider_error";
}

class ProviderError extends Error {
	constructor(readonly code: string) {
		super(code);
	}
}
