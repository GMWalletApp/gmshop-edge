import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	applyRateAdjustment,
	convertMinorAmount,
} from "#/features/exchange-rates/rates";
import { quotePaymentCurrency } from "#/features/exchange-rates/server/quote";
import {
	fetchFiatRateSnapshot,
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

	it("synchronizes through the keyless AllRatesToday provider without credentials", async () => {
		await db.batch([
			db
				.prepare(
					`UPDATE system_settings SET value = ?
					 WHERE key = 'exchange_rates.sync.config'`,
				)
				.bind(
					JSON.stringify({
						provider: "allratestoday",
						enabled: true,
						intervalMs: 3_600_000,
						adjustmentBps: 0,
					}),
				),
			db.prepare(
				"DELETE FROM system_settings WHERE key = 'exchange_rates.sync.credential'",
			),
		]);
		const before = await db
			.prepare("SELECT raw_rate FROM exchange_rates WHERE id = 'usd-gbp'")
			.first<{ raw_rate: string }>();
		const requests: string[] = [];
		const request = async (input: string | URL | Request) => {
			requests.push(String(input));
			return Response.json({
				result: "success",
				base_code: "USD",
				// Published one hour before the sync; the announced next update
				// is not used for validity.
				time_last_update_unix: 6_400,
				time_next_update_unix: 6_400 + 86_400,
				rates: { USD: 1, CNY: 7.1, EUR: 0.86 },
			});
		};
		await expect(
			syncExchangeRatesIfDue(
				db,
				createSecretKeyring(),
				request as typeof fetch,
				10_000_000,
			),
		).resolves.toMatchObject({
			updated: 2,
			failed: 1,
			observedAt: 6_400_000,
		});
		expect(requests).toEqual(["https://allratestoday.com/api/open/latest/USD"]);
		const rows = await db
			.prepare(
				`SELECT id, raw_rate, source, observed_at, expires_at FROM exchange_rates
				 WHERE id IN ('usd-cny', 'usd-eur') ORDER BY id`,
			)
			.all<{
				id: string;
				raw_rate: string;
				source: string;
				observed_at: number;
				expires_at: number;
			}>();
		// observed_at is the provider's publication time, not the fetch time,
		// and validity is the default 24h from that publication.
		expect(rows.results).toEqual([
			{
				id: "usd-cny",
				raw_rate: "7.1",
				source: "allratestoday",
				observed_at: 6_400_000,
				expires_at: 6_400_000 + 86_400_000,
			},
			{
				id: "usd-eur",
				raw_rate: "0.86",
				source: "allratestoday",
				observed_at: 6_400_000,
				expires_at: 6_400_000 + 86_400_000,
			},
		]);
		expect(
			await db
				.prepare("SELECT raw_rate FROM exchange_rates WHERE id = 'usd-gbp'")
				.first<{ raw_rate: string }>(),
		).toEqual(before);
		expect(await loadExchangeRateSyncSettings(db)).toMatchObject({
			provider: "allratestoday",
			hasApiKey: false,
			lastStatus: "succeeded",
		});
	});

	it("refuses AllRatesToday payloads with a wrong or missing base, or malformed or future publication timestamps, without touching stored rates", async () => {
		const before = await db
			.prepare(
				"SELECT id, raw_rate, source, observed_at, expires_at FROM exchange_rates ORDER BY id",
			)
			.all();
		const now = 10_100_000;
		const payloads: Array<[unknown, string]> = [
			// EUR table served where a USD one was requested
			[
				{
					result: "success",
					base_code: "EUR",
					time_last_update_unix: 10_000,
					rates: { USD: 1.16, CNY: 8.3 },
				},
				"invalid_response",
			],
			// base omitted
			[
				{
					result: "success",
					time_last_update_unix: 10_000,
					rates: { USD: 1, CNY: 7.1 },
				},
				"invalid_response",
			],
			// provider error envelope
			[
				{ result: "error", "error-type": "unsupported-code" },
				"invalid_response",
			],
			// publication time missing, wrong type, non-integer, zero, negative
			[
				{ result: "success", base_code: "USD", rates: { USD: 1, CNY: 7.1 } },
				"invalid_response",
			],
			[
				{
					result: "success",
					base_code: "USD",
					time_last_update_unix: "10000",
					rates: { USD: 1, CNY: 7.1 },
				},
				"invalid_response",
			],
			[
				{
					result: "success",
					base_code: "USD",
					time_last_update_unix: 10_000.5,
					rates: { USD: 1, CNY: 7.1 },
				},
				"invalid_response",
			],
			[
				{
					result: "success",
					base_code: "USD",
					time_last_update_unix: 0,
					rates: { USD: 1, CNY: 7.1 },
				},
				"invalid_response",
			],
			[
				{
					result: "success",
					base_code: "USD",
					time_last_update_unix: -1,
					rates: { USD: 1, CNY: 7.1 },
				},
				"invalid_response",
			],
			// published in the future (one second, and far ahead)
			[
				{
					result: "success",
					base_code: "USD",
					time_last_update_unix: now / 1000 + 1,
					rates: { USD: 1, CNY: 7.1 },
				},
				"publication_in_future",
			],
			[
				{
					result: "success",
					base_code: "USD",
					time_last_update_unix: now / 1000 + 365 * 86_400,
					rates: { USD: 1, CNY: 7.1 },
				},
				"publication_in_future",
			],
		];
		for (const [payload, code] of payloads) {
			await expect(
				syncConfiguredExchangeRates(
					db,
					createSecretKeyring(),
					(async () => Response.json(payload)) as typeof fetch,
					now,
				),
			).rejects.toMatchObject({ code: "exchange_rate_sync_failed" });
			expect(await loadExchangeRateSyncSettings(db)).toMatchObject({
				lastStatus: "failed",
				lastErrorCode: code,
			});
		}
		const after = await db
			.prepare(
				"SELECT id, raw_rate, source, observed_at, expires_at FROM exchange_rates ORDER BY id",
			)
			.all();
		expect(after.results).toEqual(before.results);
	});

	it("does not extend validity when AllRatesToday replays an unchanged publication, and refuses one past its validity", async () => {
		const published = 6_400_000;
		const snapshot = {
			result: "success",
			base_code: "USD",
			time_last_update_unix: published / 1000,
			rates: { USD: 1, CNY: 7.1, EUR: 0.86 },
		};
		const serve = (async () => Response.json(snapshot)) as typeof fetch;
		const read = () =>
			db
				.prepare(
					"SELECT id, raw_rate, observed_at, expires_at, updated_at FROM exchange_rates WHERE id IN ('usd-cny', 'usd-eur') ORDER BY id",
				)
				.all();
		const stored = await read();
		expect(stored.results).toMatchObject([
			{ observed_at: published, expires_at: published + 86_400_000 },
			{ observed_at: published, expires_at: published + 86_400_000 },
		]);
		// Twelve hours after publication the identical payload is replayed:
		// no row is rewritten and expires_at does not move.
		await expect(
			syncConfiguredExchangeRates(
				db,
				createSecretKeyring(),
				serve,
				published + 12 * 3_600_000,
			),
		).resolves.toMatchObject({
			updated: 0,
			unchanged: 2,
			failed: 1,
			observedAt: published,
		});
		expect((await read()).results).toEqual(stored.results);
		// Exactly at expiry the publication is refused rather than stored as
		// fresh; the stored rows (now expired, so not quotable) are untouched.
		await expect(
			syncConfiguredExchangeRates(
				db,
				createSecretKeyring(),
				serve,
				published + 86_400_000,
			),
		).rejects.toMatchObject({ code: "exchange_rate_sync_failed" });
		expect(await loadExchangeRateSyncSettings(db)).toMatchObject({
			lastErrorCode: "publication_expired",
		});
		expect((await read()).results).toEqual(stored.results);
		// Quoting treats expires_at as exclusive: quotable up to, not at, expiry.
		await db
			.prepare("UPDATE exchange_rates SET enabled = 1 WHERE id = 'usd-eur'")
			.run();
		await expect(
			quotePaymentCurrency(db, {
				amountMinor: "10000",
				currency: "USD",
				currencyDecimals: 2,
				paymentCurrency: "EUR",
				now: published + 86_400_000 - 1,
			}),
		).resolves.toMatchObject({ rateId: "usd-eur", rate: "0.86" });
		await expect(
			quotePaymentCurrency(db, {
				amountMinor: "10000",
				currency: "USD",
				currencyDecimals: 2,
				paymentCurrency: "EUR",
				now: published + 86_400_000,
			}),
		).rejects.toMatchObject({ code: "exchange_rate_unavailable" });
		// A genuinely newer publication replaces the rows.
		const newer = published + 86_400_000 - 1_800_000;
		await expect(
			syncConfiguredExchangeRates(
				db,
				createSecretKeyring(),
				(async () =>
					Response.json({
						...snapshot,
						time_last_update_unix: newer / 1000,
						rates: { USD: 1, CNY: 7.2, EUR: 0.87 },
					})) as typeof fetch,
				published + 86_400_000,
			),
		).resolves.toMatchObject({ updated: 2, failed: 1, observedAt: newer });
		expect((await read()).results).toMatchObject([
			{ raw_rate: "7.2", observed_at: newer, expires_at: newer + 86_400_000 },
			{ raw_rate: "0.87", observed_at: newer, expires_at: newer + 86_400_000 },
		]);
	});

	it("measures AllRatesToday validity from publication: default, configured duration and the exact boundary", async () => {
		// Friday 2027-01-08 15:00 UTC publication.
		const published = Date.UTC(2027, 0, 8, 15);
		const payload = {
			result: "success",
			base_code: "USD",
			time_last_update_unix: published / 1000,
			time_next_update_unix: published / 1000 + 3 * 86_400,
			rates: { USD: 1, EUR: 0.87 },
		};
		const fetchAt = (now: number, validityMs?: number) =>
			fetchFiatRateSnapshot(
				"USD",
				["EUR"],
				null,
				(async () => Response.json(payload)) as typeof fetch,
				"allratestoday",
				now,
				validityMs,
			);
		// Default: strictly 24h from publication, whatever the announced next
		// update says, so Friday's table is not quotable over the weekend.
		await expect(fetchAt(published + 3_600_000)).resolves.toMatchObject({
			observedAt: published,
			expiresAt: published + 86_400_000,
		});
		await expect(fetchAt(published + 86_400_000 - 1)).resolves.toMatchObject({
			expiresAt: published + 86_400_000,
		});
		await expect(fetchAt(published + 86_400_000)).rejects.toMatchObject({
			code: "publication_expired",
		});
		// A configured 72h duration keeps the same publication quotable over
		// the weekend; the boundary moves with it.
		await expect(
			fetchAt(published + 2 * 86_400_000, 72 * 3_600_000),
		).resolves.toMatchObject({
			observedAt: published,
			expiresAt: published + 72 * 3_600_000,
		});
		await expect(
			fetchAt(published + 72 * 3_600_000, 72 * 3_600_000),
		).rejects.toMatchObject({ code: "publication_expired" });
		// Out-of-range durations fall back to the 24h default.
		await expect(fetchAt(published + 3_600_000, 0)).resolves.toMatchObject({
			expiresAt: published + 86_400_000,
		});
		await expect(
			fetchAt(published + 3_600_000, 365 * 86_400_000),
		).resolves.toMatchObject({ expiresAt: published + 86_400_000 });
	});

	it("applies a changed adjustment or validity duration to an unchanged AllRatesToday publication without advancing its observation", async () => {
		// Later than any publication the previous cases stored, so the first
		// sync here replaces their rows.
		const published = 200_000_000;
		const serve = (async () =>
			Response.json({
				result: "success",
				base_code: "USD",
				time_last_update_unix: published / 1000,
				rates: { USD: 1, CNY: 7, EUR: 0.8 },
			})) as typeof fetch;
		const configure = (adjustmentBps: number, publicationValidityMs?: number) =>
			db
				.prepare(
					`UPDATE system_settings SET value = ?
					 WHERE key = 'exchange_rates.sync.config'`,
				)
				.bind(
					JSON.stringify({
						provider: "allratestoday",
						enabled: true,
						intervalMs: 3_600_000,
						adjustmentBps,
						...(publicationValidityMs === undefined
							? {}
							: { publicationValidityMs }),
					}),
				)
				.run();
		const read = () =>
			db
				.prepare(
					"SELECT raw_rate, rate, adjustment_bps, observed_at, expires_at FROM exchange_rates WHERE id = 'usd-eur'",
				)
				.first<{
					raw_rate: string;
					rate: string;
					adjustment_bps: number;
					observed_at: number;
					expires_at: number;
				}>();
		await configure(0);
		await expect(
			syncConfiguredExchangeRates(
				db,
				createSecretKeyring(),
				serve,
				published + 60_000,
			),
		).resolves.toMatchObject({ updated: 2 });
		expect(await read()).toEqual({
			raw_rate: "0.8",
			rate: "0.8",
			adjustment_bps: 0,
			observed_at: published,
			expires_at: published + 86_400_000,
		});
		// A new adjustment on the same publication recomputes the adjusted
		// rate from the identical raw rate and keeps observed_at/expires_at.
		await configure(100);
		await expect(
			syncConfiguredExchangeRates(
				db,
				createSecretKeyring(),
				serve,
				published + 120_000,
			),
		).resolves.toMatchObject({ updated: 2, unchanged: 0 });
		expect(await read()).toEqual({
			raw_rate: "0.8",
			rate: "0.808",
			adjustment_bps: 100,
			observed_at: published,
			expires_at: published + 86_400_000,
		});
		// A new validity duration rewrites expires_at from the same
		// publication time; observed_at still does not move.
		await configure(100, 72 * 3_600_000);
		await expect(
			syncConfiguredExchangeRates(
				db,
				createSecretKeyring(),
				serve,
				published + 180_000,
			),
		).resolves.toMatchObject({ updated: 2, unchanged: 0 });
		expect(await read()).toMatchObject({
			observed_at: published,
			expires_at: published + 72 * 3_600_000,
		});
		expect(await loadExchangeRateSyncSettings(db)).toMatchObject({
			publicationValidityMs: 72 * 3_600_000,
		});
		// Same publication, same settings: nothing to rewrite.
		await expect(
			syncConfiguredExchangeRates(
				db,
				createSecretKeyring(),
				serve,
				published + 240_000,
			),
		).resolves.toMatchObject({ updated: 0, unchanged: 2 });
		// A stored out-of-range duration reads back as the 24h default.
		await configure(100, 30 * 86_400_000);
		expect(await loadExchangeRateSyncSettings(db)).toMatchObject({
			publicationValidityMs: 86_400_000,
		});
		await configure(0);
	});

	it("keeps stored rates and records a structured error when AllRatesToday is rate limited or unreachable", async () => {
		await db.batch([
			db
				.prepare(
					`UPDATE system_settings SET value = ?
					 WHERE key = 'exchange_rates.sync.config'`,
				)
				.bind(
					JSON.stringify({
						provider: "allratestoday",
						enabled: true,
						intervalMs: 3_600_000,
						adjustmentBps: 0,
					}),
				),
			db.prepare(
				"DELETE FROM system_settings WHERE key = 'exchange_rates.sync.credential'",
			),
			db
				.prepare(
					`UPDATE system_settings SET value = ?
					 WHERE key = 'exchange_rates.sync.status'`,
				)
				.bind(
					JSON.stringify({
						lastSyncedAt: 10_000_000,
						lastStatus: "succeeded",
						lastErrorCode: null,
					}),
				),
		]);
		const before = await db
			.prepare("SELECT id, raw_rate, source FROM exchange_rates ORDER BY id")
			.all<{ id: string; raw_rate: string; source: string }>();
		await expect(
			syncExchangeRatesIfDue(
				db,
				createSecretKeyring(),
				(async () =>
					new Response("slow down", { status: 429 })) as typeof fetch,
				13_700_001,
			),
		).resolves.toMatchObject({ failed: 1, updated: 0 });
		expect(await loadExchangeRateSyncSettings(db)).toMatchObject({
			provider: "allratestoday",
			lastStatus: "failed",
			lastErrorCode: "http_429",
		});
		// The manual-sync path records the failure and then throws the
		// structured domain error; only syncExchangeRatesIfDue turns it into
		// a result object.
		await expect(
			syncConfiguredExchangeRates(
				db,
				createSecretKeyring(),
				(async () => {
					throw new Error("socket hang up");
				}) as typeof fetch,
				13_700_002,
			),
		).rejects.toMatchObject({ code: "exchange_rate_sync_failed", status: 502 });
		expect(await loadExchangeRateSyncSettings(db)).toMatchObject({
			lastStatus: "failed",
			lastErrorCode: "provider_error",
		});
		const after = await db
			.prepare("SELECT id, raw_rate, source FROM exchange_rates ORDER BY id")
			.all<{ id: string; raw_rate: string; source: string }>();
		expect(after.results).toEqual(before.results);
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
