import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	applyRateAdjustment,
	convertMinorAmount,
} from "#/features/exchange-rates/rates";
import { quotePaymentCurrency } from "#/features/exchange-rates/server/quote";
import {
	loadExchangeRateSyncSettings,
	syncConfiguredExchangeRates,
	syncExchangeRatesIfDue,
} from "#/features/exchange-rates/server/sync";
import { createSecretKeyring, encryptSecret } from "#/lib/secrets";
import { applyMigrations } from "./migrations";

describe("store-owned fiat exchange rates", () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmshop-edge-exchange-rates" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await db
			.prepare(
				`INSERT INTO exchange_rates
				 (id, base_currency, quote_currency, raw_rate, rate, source,
				  enabled, adjustment_bps, sort_order, observed_at, expires_at,
				  created_at, updated_at)
				 VALUES ('cny-usd', 'CNY', 'USD', '0.14', '0.14', 'manual',
				  1, 0, 100, 1000, NULL, 1000, 1000)`,
			)
			.run();
	});

	afterAll(async () => miniflare.dispose());

	it("applies basis-point adjustments with decimal integer arithmetic", () => {
		expect(applyRateAdjustment("0.14", 100)).toBe("0.1414");
		expect(
			convertMinorAmount({
				amountMinor: "10000",
				fromCurrency: "CNY",
				fromDecimals: 2,
				toCurrency: "USD",
				rate: "0.14",
				direction: "multiply",
			}),
		).toMatchObject({ amountMinor: "1400", currency: "USD" });
	});

	it("quotes direct and inverse pairs and preserves the rate snapshot", async () => {
		await expect(
			quotePaymentCurrency(db, {
				amountMinor: "10000",
				currency: "CNY",
				currencyDecimals: 2,
				paymentCurrency: "USD",
				now: 2000,
			}),
		).resolves.toMatchObject({
			amountMinor: "1400",
			currency: "USD",
			rateId: "cny-usd",
			rate: "0.14",
			rateDirection: "multiply",
		});
		await expect(
			quotePaymentCurrency(db, {
				amountMinor: "1000",
				currency: "USD",
				currencyDecimals: 2,
				paymentCurrency: "CNY",
				now: 2000,
			}),
		).resolves.toMatchObject({
			amountMinor: "7143",
			currency: "CNY",
			rateDirection: "divide",
		});
	});

	it("withdraws a payment currency once its rate has passed the validity horizon", async () => {
		await db
			.prepare(
				"UPDATE exchange_rates SET expires_at = 1500 WHERE id = 'cny-usd'",
			)
			.run();
		await expect(
			quotePaymentCurrency(db, {
				amountMinor: "10000",
				currency: "CNY",
				currencyDecimals: 2,
				paymentCurrency: "USD",
				now: 1499,
			}),
		).resolves.toMatchObject({ amountMinor: "1400", rateId: "cny-usd" });
		await expect(
			quotePaymentCurrency(db, {
				amountMinor: "10000",
				currency: "CNY",
				currencyDecimals: 2,
				paymentCurrency: "USD",
				now: 2000,
			}),
		).rejects.toMatchObject({ code: "exchange_rate_unavailable" });
		await db
			.prepare(
				"UPDATE exchange_rates SET expires_at = NULL WHERE id = 'cny-usd'",
			)
			.run();
	});

	it("synchronizes enabled currencies through USD with the configured basis-point adjustment", async () => {
		const keyring = createSecretKeyring();
		const encrypted = await encryptSecret(
			"provider-key",
			keyring,
			"exchange-rate-provider",
		);
		await db.batch([
			db
				.prepare(
					`INSERT INTO system_settings
					 (key, value, is_secret, created_at, updated_at)
					 VALUES ('exchange_rates.sync.config', ?, 0, 1000, 1000),
					        ('exchange_rates.sync.credential', ?, 1, 1000, 1000),
					        ('exchange_rates.sync.status', ?, 0, 1000, 1000)`,
				)
				.bind(
					JSON.stringify({
						provider: "exchangerate_host",
						enabled: true,
						intervalMs: 3_600_000,
						adjustmentBps: 100,
					}),
					JSON.stringify(encrypted),
					JSON.stringify({
						lastSyncedAt: null,
						lastStatus: "never",
						lastErrorCode: null,
					}),
				),
			db.prepare(
				`INSERT INTO exchange_rates
				 (id, base_currency, quote_currency, raw_rate, rate, source,
				  adjustment_bps, sort_order, observed_at, expires_at,
				  created_at, updated_at)
				 VALUES ('usd-cny', 'USD', 'CNY', '7', '7', 'manual',
				  0, 200, 1000, NULL, 1000, 1000),
				 ('usd-eur', 'USD', 'EUR', '0.88', '0.8888', 'manual',
				  100, 200, 1000, NULL, 1000, 1000),
				 ('usd-gbp', 'USD', 'GBP', '0.75', '0.75', 'manual',
				  0, 300, 1000, NULL, 1000, 1000)`,
			),
		]);
		const requests: string[] = [];
		const request = async (input: string | URL | Request) => {
			requests.push(String(input));
			return Response.json({
				success: true,
				quotes: { USDCNY: 7.2, USDEUR: 0.9, USDGBP: 0.8 },
			});
		};
		const result = await syncConfiguredExchangeRates(
			db,
			keyring,
			request as typeof fetch,
			10_000,
		);
		expect(result).toMatchObject({ updated: 3, failed: 0 });
		expect(requests[0]).toContain("access_key=provider-key");
		const rows = await db
			.prepare(
				`SELECT id, raw_rate, rate, source FROM exchange_rates
				 WHERE id IN ('usd-cny', 'usd-eur', 'usd-gbp') ORDER BY id`,
			)
			.all<{
				id: string;
				raw_rate: string;
				rate: string;
				source: string;
			}>();
		expect(rows.results).toEqual([
			{
				id: "usd-cny",
				raw_rate: "7.2",
				rate: "7.272",
				source: "exchangerate_host",
			},
			{
				id: "usd-eur",
				raw_rate: "0.9",
				rate: "0.909",
				source: "exchangerate_host",
			},
			{
				id: "usd-gbp",
				raw_rate: "0.8",
				rate: "0.808",
				source: "exchangerate_host",
			},
		]);
		expect(await loadExchangeRateSyncSettings(db)).toMatchObject({
			adjustmentBps: 100,
			hasApiKey: true,
			lastStatus: "succeeded",
			lastSyncedAt: 10_000,
		});
		await expect(
			syncExchangeRatesIfDue(db, keyring, request as typeof fetch, 20_000),
		).resolves.toBeNull();
	});

	it("keeps the last usable rates when a scheduled provider refresh fails", async () => {
		const row = await db
			.prepare("SELECT raw_rate FROM exchange_rates WHERE id = 'usd-eur'")
			.first<{ raw_rate: string }>();
		const keyring = createSecretKeyring();
		const encrypted = await encryptSecret(
			"replacement-key",
			keyring,
			"exchange-rate-provider",
		);
		await db
			.prepare(
				`UPDATE system_settings SET value = ?
				 WHERE key = 'exchange_rates.sync.credential'`,
			)
			.bind(JSON.stringify(encrypted))
			.run();
		await db
			.prepare(
				`UPDATE system_settings SET value = ?
				 WHERE key = 'exchange_rates.sync.status'`,
			)
			.bind(
				JSON.stringify({
					lastSyncedAt: 10_000,
					lastStatus: "succeeded",
					lastErrorCode: null,
				}),
			)
			.run();
		await expect(
			syncExchangeRatesIfDue(
				db,
				keyring,
				(async () => new Response(null, { status: 503 })) as typeof fetch,
				3_700_001,
			),
		).resolves.toMatchObject({ failed: 1, updated: 0 });
		expect(
			await db
				.prepare("SELECT raw_rate FROM exchange_rates WHERE id = 'usd-eur'")
				.first<{ raw_rate: string }>(),
		).toEqual(row);
		expect(await loadExchangeRateSyncSettings(db)).toMatchObject({
			lastStatus: "failed",
			lastErrorCode: "http_503",
		});
	});

	it("rejects a payment currency when its maintained rate is absent", async () => {
		await db
			.prepare(
				`DELETE FROM exchange_rates
				 WHERE (base_currency = 'CNY' AND quote_currency = 'USD')
				    OR (base_currency = 'USD' AND quote_currency = 'CNY')`,
			)
			.run();
		await expect(
			quotePaymentCurrency(db, {
				amountMinor: "10000",
				currency: "CNY",
				currencyDecimals: 2,
				paymentCurrency: "USD",
			}),
		).rejects.toMatchObject({ code: "exchange_rate_unavailable", status: 409 });
	});
});
