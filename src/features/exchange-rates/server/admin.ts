import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { systemPermission } from "#/features/access/system-rbac";
import {
	applyRateAdjustment,
	exchangeRatePattern,
} from "#/features/exchange-rates/rates";
import {
	exchangeRateProviderRequiresApiKey,
	exchangeRateProviders,
	exchangeRateSyncSettingKeys,
	loadExchangeRateSyncCredential,
	loadExchangeRateSyncSettings,
	syncConfiguredExchangeRates,
} from "#/features/exchange-rates/server/sync";
import { DomainError } from "#/lib/domain-error";
import { encryptSecret } from "#/lib/secrets";
import { createAuditStatement } from "#/server/audit";
import {
	getAdminRuntimeServerContext,
	getAdminServerContext,
} from "#/server/context";

const currencySchema = z
	.string()
	.trim()
	.toUpperCase()
	.regex(/^[A-Z]{3}$/);
const rateSchema = z.string().trim().max(80).regex(exchangeRatePattern);
const idSchema = z.uuid();

const listSchema = z.object({
	pageIndex: z.number().int().min(0).default(0),
	pageSize: z.number().int().min(1).max(100).default(20),
	search: z.string().trim().max(100).default(""),
});

const saveSchema = z
	.object({
		id: idSchema.optional(),
		baseCurrency: currencySchema,
		quoteCurrency: currencySchema,
		rawRate: rateSchema,
		adjustmentBps: z.number().int().min(-9_999).max(100_000).default(0),
		expiresAt: z.number().int().positive().nullable().default(null),
	})
	.refine((value) => value.baseCurrency !== value.quoteCurrency, {
		path: ["quoteCurrency"],
		message: "Currencies must be different",
	});

const deleteSchema = z.object({ id: idSchema });
const enabledSchema = z.object({ id: idSchema, enabled: z.boolean() });
const reorderSchema = z.object({ ids: z.array(idSchema).min(1).max(500) });
const syncSettingsSchema = z.object({
	provider: z.enum(exchangeRateProviders).default("exchangerate_host"),
	enabled: z.boolean(),
	intervalMs: z.number().int().min(300_000).max(2_592_000_000),
	adjustmentBps: z.number().int().min(-9_999).max(100_000),
	apiKey: z.string().trim().max(512).optional(),
});

type RateRow = {
	id: string;
	base_currency: string;
	quote_currency: string;
	raw_rate: string;
	rate: string;
	source: string;
	enabled: number;
	adjustment_bps: number;
	sort_order: number;
	observed_at: number;
	expires_at: number | null;
	created_at: number;
	updated_at: number;
};

export const listExchangeRatesFn = createServerFn({ method: "GET" })
	.validator((input: z.input<typeof listSchema>) => listSchema.parse(input))
	.handler(async ({ data }) => {
		const { db } = await getAdminServerContext(
			systemPermission("settings", "read"),
		);
		const search = data.search ? `%${data.search.toUpperCase()}%` : null;
		const where = search
			? "WHERE base_currency LIKE ? OR quote_currency LIKE ? OR source LIKE ?"
			: "";
		const bindings = search ? [search, search, search] : [];
		const [count, rows] = await db.$client.batch([
			db.$client
				.prepare(`SELECT COUNT(*) AS total FROM exchange_rates ${where}`)
				.bind(...bindings),
			db.$client
				.prepare(
					`SELECT * FROM exchange_rates ${where}
					 ORDER BY sort_order, quote_currency, id LIMIT ? OFFSET ?`,
				)
				.bind(...bindings, data.pageSize, data.pageIndex * data.pageSize),
		]);
		return {
			data: ((rows?.results ?? []) as RateRow[]).map(presentRate),
			total: Number(
				(count?.results[0] as { total?: unknown } | undefined)?.total ?? 0,
			),
		};
	});

export const getExchangeRateSyncSettingsFn = createServerFn({
	method: "GET",
}).handler(async () => {
	const { db } = await getAdminServerContext(
		systemPermission("settings", "read"),
	);
	return loadExchangeRateSyncSettings(db.$client);
});

export const saveExchangeRateSyncSettingsFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof syncSettingsSchema>) =>
		syncSettingsSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await getAdminRuntimeServerContext(
			systemPermission("settings", "update"),
		);
		const [before, existingApiKey] = await Promise.all([
			loadExchangeRateSyncSettings(context.db),
			loadExchangeRateSyncCredential(context.db),
		]);
		const apiKey = data.apiKey?.trim();
		const apiKeyEncrypted = apiKey
			? await encryptSecret(
					apiKey,
					context.runtime.dataEncryptionSecret,
					"exchange-rate-provider",
				)
			: existingApiKey;
		if (
			data.enabled &&
			exchangeRateProviderRequiresApiKey(data.provider) &&
			!apiKeyEncrypted
		)
			throw new DomainError(
				"exchange_rate_sync_credentials_required",
				409,
				"Exchange-rate provider credentials are required",
			);
		const now = Date.now();
		const statements = [
			context.db
				.prepare(
					`INSERT INTO system_settings
					 (key, value, is_secret, updated_by, created_at, updated_at)
					 VALUES (?, ?, 0, ?, ?, ?)
					 ON CONFLICT(key) DO UPDATE SET value = excluded.value,
					 is_secret = 0, updated_by = excluded.updated_by,
					 updated_at = excluded.updated_at`,
				)
				.bind(
					exchangeRateSyncSettingKeys.config,
					JSON.stringify({
						provider: data.provider,
						enabled: data.enabled,
						intervalMs: data.intervalMs,
						adjustmentBps: data.adjustmentBps,
					}),
					context.currentUser.id,
					now,
					now,
				),
			...(apiKey
				? [
						context.db
							.prepare(
								`INSERT INTO system_settings
								 (key, value, is_secret, updated_by, created_at, updated_at)
								 VALUES (?, ?, 1, ?, ?, ?)
								 ON CONFLICT(key) DO UPDATE SET value = excluded.value,
								 is_secret = 1, updated_by = excluded.updated_by,
								 updated_at = excluded.updated_at`,
							)
							.bind(
								exchangeRateSyncSettingKeys.credential,
								JSON.stringify(apiKeyEncrypted),
								context.currentUser.id,
								now,
								now,
							),
					]
				: []),
			createAuditStatement(
				context.db,
				context.request,
				context.currentUser.id,
				{
					action: "exchange_rate_sync.settings_updated",
					targetType: "exchange_rate_sync",
					targetId: "fiat",
					before: {
						provider: before.provider,
						enabled: before.enabled,
						intervalMs: before.intervalMs,
						adjustmentBps: before.adjustmentBps,
						hasApiKey: before.hasApiKey,
					},
					after: {
						provider: data.provider,
						enabled: data.enabled,
						intervalMs: data.intervalMs,
						adjustmentBps: data.adjustmentBps,
						hasApiKey: Boolean(apiKeyEncrypted),
						credentialsChanged: Boolean(apiKey),
					},
				},
			),
		];
		await context.db.batch(statements);
		return loadExchangeRateSyncSettings(context.db);
	});

export const syncExchangeRatesNowFn = createServerFn({ method: "POST" })
	.validator((input: Record<string, never>) => z.object({}).parse(input))
	.handler(async () => {
		const context = await getAdminRuntimeServerContext(
			systemPermission("settings", "update"),
		);
		const result = await syncConfiguredExchangeRates(
			context.db,
			context.runtime.dataEncryptionSecret,
			fetch,
		);
		await createAuditStatement(
			context.db,
			context.request,
			context.currentUser.id,
			{
				action: "exchange_rates.synced",
				targetType: "exchange_rates",
				after: result,
			},
		).run();
		return result;
	});

export const saveExchangeRateFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof saveSchema>) => saveSchema.parse(input))
	.handler(async ({ data }) => {
		const { currentUser, db, request } = await getAdminServerContext(
			systemPermission("settings", data.id ? "update" : "create"),
		);
		const currencySetting = await db.$client
			.prepare(
				"SELECT value FROM system_settings WHERE key = 'commerce.default_currency' LIMIT 1",
			)
			.first<{ value: string }>();
		const storeBaseCurrency = parseSettingString(
			currencySetting?.value,
			"USD",
		).toUpperCase();
		if (data.baseCurrency !== storeBaseCurrency)
			throw new DomainError(
				"exchange_rate_base_currency_invalid",
				409,
				"Exchange rates must use the store base currency",
			);
		const before = data.id
			? await db.$client
					.prepare("SELECT * FROM exchange_rates WHERE id = ? LIMIT 1")
					.bind(data.id)
					.first<RateRow>()
			: null;
		if (data.id && !before)
			throw new DomainError(
				"exchange_rate_not_found",
				404,
				"Exchange rate not found",
			);
		const duplicate = await db.$client
			.prepare(
				"SELECT id FROM exchange_rates WHERE base_currency = ? AND quote_currency = ? AND id <> ? LIMIT 1",
			)
			.bind(data.baseCurrency, data.quoteCurrency, data.id ?? "")
			.first<{ id: string }>();
		if (duplicate)
			throw new DomainError(
				"exchange_rate_exists",
				409,
				"Exchange-rate pair already exists",
			);
		const now = Date.now();
		if (data.expiresAt != null && data.expiresAt <= now)
			throw new DomainError(
				"exchange_rate_expiry_invalid",
				400,
				"Expiry must be in the future",
			);
		const id = data.id ?? crypto.randomUUID();
		const rate = applyRateAdjustment(data.rawRate, data.adjustmentBps);
		const mutation = data.id
			? db.$client
					.prepare(
						`UPDATE exchange_rates SET base_currency = ?, quote_currency = ?,
						 raw_rate = ?, rate = ?, source = 'manual', adjustment_bps = ?,
						 observed_at = ?, expires_at = ?, updated_at = ? WHERE id = ?`,
					)
					.bind(
						data.baseCurrency,
						data.quoteCurrency,
						data.rawRate,
						rate,
						data.adjustmentBps,
						now,
						data.expiresAt,
						now,
						id,
					)
			: db.$client
					.prepare(
						`INSERT INTO exchange_rates
						 (id, base_currency, quote_currency, raw_rate, rate, source,
						  adjustment_bps, sort_order, observed_at, expires_at,
						  created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?, 'manual', ?,
						  COALESCE((SELECT MAX(sort_order) + 100 FROM exchange_rates), 100),
						  ?, ?, ?, ?)`,
					)
					.bind(
						id,
						data.baseCurrency,
						data.quoteCurrency,
						data.rawRate,
						rate,
						data.adjustmentBps,
						now,
						data.expiresAt,
						now,
						now,
					);
		await db.$client.batch([
			mutation,
			createAuditStatement(db.$client, request, currentUser.id, {
				action: data.id ? "exchange_rate.updated" : "exchange_rate.created",
				targetType: "exchange_rate",
				targetId: id,
				before: before ? presentRate(before) : null,
				after: {
					baseCurrency: data.baseCurrency,
					quoteCurrency: data.quoteCurrency,
					rawRate: data.rawRate,
					rate,
					adjustmentBps: data.adjustmentBps,
					expiresAt: data.expiresAt,
				},
			}),
		]);
		return { id };
	});

export const reorderExchangeRatesFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof reorderSchema>) =>
		reorderSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const { currentUser, db, request } = await getAdminServerContext(
			systemPermission("settings", "update"),
		);
		const now = Date.now();
		const results = await db.$client.batch([
			...data.ids.map((id, index) =>
				db.$client
					.prepare(
						"UPDATE exchange_rates SET sort_order = ?, updated_at = ? WHERE id = ?",
					)
					.bind((index + 1) * 100, now, id),
			),
			createAuditStatement(db.$client, request, currentUser.id, {
				action: "exchange_rate.reordered",
				targetType: "exchange_rate",
				after: { ids: data.ids },
			}),
		]);
		if (
			results.slice(0, data.ids.length).some((item) => item.meta.changes !== 1)
		)
			throw new DomainError(
				"exchange_rate_order_conflict",
				409,
				"Exchange-rate order changed",
			);
		return { updated: data.ids.length };
	});

export const setExchangeRateEnabledFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof enabledSchema>) =>
		enabledSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const { currentUser, db, request } = await getAdminServerContext(
			systemPermission("settings", "update"),
		);
		const before = await db.$client
			.prepare("SELECT * FROM exchange_rates WHERE id = ? LIMIT 1")
			.bind(data.id)
			.first<RateRow>();
		if (!before)
			throw new DomainError(
				"exchange_rate_not_found",
				404,
				"Exchange rate not found",
			);
		const now = Date.now();
		await db.$client.batch([
			db.$client
				.prepare(
					"UPDATE exchange_rates SET enabled = ?, updated_at = ? WHERE id = ?",
				)
				.bind(data.enabled ? 1 : 0, now, data.id),
			createAuditStatement(db.$client, request, currentUser.id, {
				action: "exchange_rate.enabled_changed",
				targetType: "exchange_rate",
				targetId: data.id,
				before: { enabled: Boolean(before.enabled) },
				after: { enabled: data.enabled },
			}),
		]);
		return { id: data.id, enabled: data.enabled };
	});

export const deleteExchangeRateFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof deleteSchema>) => deleteSchema.parse(input))
	.handler(async ({ data }) => {
		const { currentUser, db, request } = await getAdminServerContext(
			systemPermission("settings", "delete"),
		);
		const before = await db.$client
			.prepare("SELECT * FROM exchange_rates WHERE id = ? LIMIT 1")
			.bind(data.id)
			.first<RateRow>();
		if (!before)
			throw new DomainError(
				"exchange_rate_not_found",
				404,
				"Exchange rate not found",
			);
		const inUse = await db.$client
			.prepare(
				"SELECT 1 FROM payment_attempts WHERE exchange_rate_id = ? LIMIT 1",
			)
			.bind(data.id)
			.first();
		if (inUse)
			throw new DomainError(
				"exchange_rate_in_use",
				409,
				"Used exchange rates can only be disabled",
			);
		await db.$client.batch([
			db.$client
				.prepare("DELETE FROM exchange_rates WHERE id = ?")
				.bind(data.id),
			createAuditStatement(db.$client, request, currentUser.id, {
				action: "exchange_rate.deleted",
				targetType: "exchange_rate",
				targetId: data.id,
				before: presentRate(before),
			}),
		]);
		return { id: data.id };
	});

function presentRate(row: RateRow) {
	return {
		id: row.id,
		baseCurrency: row.base_currency,
		quoteCurrency: row.quote_currency,
		rawRate: row.raw_rate,
		rate: row.rate,
		source: row.source,
		enabled: Boolean(row.enabled),
		adjustmentBps: row.adjustment_bps,
		sortOrder: row.sort_order,
		observedAt: row.observed_at,
		expiresAt: row.expires_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function parseSettingString(value: string | undefined, fallback: string) {
	if (!value) return fallback;
	try {
		const parsed: unknown = JSON.parse(value);
		return typeof parsed === "string" ? parsed : fallback;
	} catch {
		return fallback;
	}
}
