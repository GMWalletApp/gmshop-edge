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

// How long an AllRatesToday publication stays quotable, measured from the
// provider's publication time (`time_last_update_unix`), never from the fetch
// time. The default is a strict 24 hours: the ECB table behind the feed is
// published once per business day, so at the default the last table stops
// being quotable over weekends and holidays until the next one is published.
// Administrators may configure a different duration within these bounds;
// exchangerate.host keeps its existing fetch-time validity.
export const ALLRATESTODAY_DEFAULT_VALIDITY_MS = 24 * 60 * 60_000;
export const ALLRATESTODAY_MIN_VALIDITY_MS = 60 * 60_000;
export const ALLRATESTODAY_MAX_VALIDITY_MS = 7 * 24 * 60 * 60_000;
export const allRatesTodayValiditySchema = z
	.number()
	.int()
	.min(ALLRATESTODAY_MIN_VALIDITY_MS)
	.max(ALLRATESTODAY_MAX_VALIDITY_MS);
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
	// Stored configurations written before this field existed, or holding an
	// out-of-range value, read back as the 24h default.
	publicationValidityMs: allRatesTodayValiditySchema.catch(
		ALLRATESTODAY_DEFAULT_VALIDITY_MS,
	),
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
// exchangerate.host payload (unchanged policy).
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
// AllRatesToday is asked for a USD table; a successful USD-base payload with
// a publication time is required at this boundary so a wrong-base or
// undated response can never be stored as rates.
const allRatesTodayPayloadSchema = z.looseObject({
	result: z.literal("success"),
	base_code: z.literal("USD"),
	rates: z.record(z.string(), providerRateSchema),
	time_last_update_unix: z.number().int().positive(),
});

export type FiatRateSnapshot = {
	rates: Map<string, string>;
	/** Observation time stored on the rows: fetch time for exchangerate.host, publication time for AllRatesToday. */
	observedAt: number;
	/** Validity end stored on the rows, or null to let the caller apply its own policy. */
	expiresAt: number | null;
};

export type ExchangeRateSyncSettings = {
	enabled: boolean;
	provider: ExchangeRateProvider;
	intervalMs: number;
	adjustmentBps: number;
	publicationValidityMs: number;
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
	publication_validity_ms: number;
	api_key_encrypted: string | null;
	last_synced_at: number | null;
	last_status: "never" | "succeeded" | "failed";
	last_error_code: string | null;
};

type SyncRateRow = { id: string; quote_currency: string };

// A shorter validity has to bind stored publications at once: a sync cannot
// be relied on for this, because it refuses a publication that is already
// past the new duration and may not reach the provider at all. Only expiry
// moves, and only downwards, so the observation time stays the publication
// time and a longer validity still waits for the next sync.
export function capAllRatesTodayExpiryStatement(
	db: D1Database,
	validityMs: number,
	now: number,
) {
	return db
		.prepare(
			`UPDATE exchange_rates SET expires_at = observed_at + ?, updated_at = ?
			 WHERE source = 'allratestoday' AND expires_at > observed_at + ?`,
		)
		.bind(validityMs, now, validityMs);
}

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
		return { updated: 0, unchanged: 0, failed: 0, observedAt: now };
	}
	try {
		const snapshot = await fetchFiatRateSnapshot(
			baseCurrency,
			rates.results.map((rate) => rate.quote_currency),
			config.apiKey,
			request,
			config.provider,
			now,
			config.publicationValidityMs,
		);
		const observedAt = snapshot.observedAt;
		const expiresAt =
			snapshot.expiresAt ?? now + Math.max(config.intervalMs * 2, 3_600_000);
		const updates = rates.results.flatMap((rate) => {
			const rawRate = snapshot.rates.get(rate.quote_currency);
			return rawRate
				? [
						// A publication already stored for the same source cannot
						// move observed_at/expires_at forward again: the row is only
						// rewritten when the incoming observation is newer, when the
						// source changed (manual or other-provider rows), or when the
						// same publication's derived values changed (adjustment or
						// configured validity). Replaying an identical publication
						// is a no-op. exchangerate.host observes at fetch time, so
						// its rows are always newer and keep their existing policy.
						db
							.prepare(
								`UPDATE exchange_rates SET raw_rate = ?, rate = ?, source = ?,
								 adjustment_bps = ?, observed_at = ?, expires_at = ?, updated_at = ?
								 WHERE id = ?
								   AND (observed_at < ? OR source <> ?
								        OR (observed_at = ?
								            AND (adjustment_bps <> ? OR expires_at IS NOT ?)))`,
							)
							.bind(
								rawRate,
								applyRateAdjustment(rawRate, config.adjustmentBps),
								config.provider,
								config.adjustmentBps,
								observedAt,
								expiresAt,
								now,
								rate.id,
								observedAt,
								config.provider,
								observedAt,
								config.adjustmentBps,
								expiresAt,
							),
					]
				: [];
		});
		const results = await db.batch([
			...updates,
			syncStatusStatement(db, now, "succeeded", null),
		]);
		const updated = results
			.slice(0, updates.length)
			.reduce((count, result) => count + (result.meta.changes ?? 0), 0);
		return {
			updated,
			unchanged: updates.length - updated,
			failed: rates.results.length - updates.length,
			observedAt,
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
		return { updated: 0, unchanged: 0, failed: 1, observedAt: now };
	}
}

export async function fetchFiatRates(
	baseCurrency: string,
	quoteCurrencies: string[],
	apiKey: string | null,
	request: typeof fetch = fetch,
	provider: ExchangeRateProvider = "exchangerate_host",
) {
	const snapshot = await fetchFiatRateSnapshot(
		baseCurrency,
		quoteCurrencies,
		apiKey,
		request,
		provider,
	);
	return snapshot.rates;
}

export async function fetchFiatRateSnapshot(
	baseCurrency: string,
	quoteCurrencies: string[],
	apiKey: string | null,
	request: typeof fetch = fetch,
	provider: ExchangeRateProvider = "exchangerate_host",
	now = Date.now(),
	publicationValidityMs = ALLRATESTODAY_DEFAULT_VALIDITY_MS,
): Promise<FiatRateSnapshot> {
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
	const body: unknown = await response.json();
	const usdRates = new Map<string, string>([["USD", "1"]]);
	let observedAt = now;
	let expiresAt: number | null = null;
	if (provider === "allratestoday") {
		const parsed = allRatesTodayPayloadSchema.safeParse(body);
		if (!parsed.success) throw new ProviderError("invalid_response");
		observedAt = parsed.data.time_last_update_unix * 1000;
		if (observedAt > now) throw new ProviderError("publication_in_future");
		const validity = allRatesTodayValiditySchema
			.catch(ALLRATESTODAY_DEFAULT_VALIDITY_MS)
			.parse(publicationValidityMs);
		expiresAt = observedAt + validity;
		// A publication that has already aged past the configured validity is
		// refused rather than stored as a fresh observation.
		if (expiresAt <= now) throw new ProviderError("publication_expired");
		for (const [key, value] of Object.entries(parsed.data.rates))
			usdRates.set(key.toUpperCase(), normalizeProviderRate(value));
	} else {
		const payload = providerPayloadSchema.parse(body);
		if (payload.success === false) throw new ProviderError("provider_error");
		for (const [key, value] of Object.entries(payload.rates ?? {}))
			usdRates.set(key.toUpperCase(), normalizeProviderRate(value));
		for (const [pair, value] of Object.entries(payload.quotes ?? {})) {
			const key = pair.toUpperCase();
			usdRates.set(
				key.startsWith("USD") ? key.slice(3) : key,
				normalizeProviderRate(value),
			);
		}
	}
	const baseRate = usdRates.get(base);
	if (!baseRate) throw new ProviderError("base_rate_missing");
	const rates = new Map(
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
	return { rates, observedAt, expiresAt };
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
		publicationValidityMs: row.publication_validity_ms,
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
		publication_validity_ms: config.publicationValidityMs,
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
		publicationValidityMs:
			row?.publication_validity_ms ?? ALLRATESTODAY_DEFAULT_VALIDITY_MS,
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
