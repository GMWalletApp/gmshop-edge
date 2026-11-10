import { Miniflare } from "miniflare";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	saveExchangeRateSyncSettingsFn,
	syncExchangeRatesNowFn,
} from "#/features/exchange-rates/server/admin";
import { quotePaymentCurrency } from "#/features/exchange-rates/server/quote";
import {
	loadExchangeRateSyncCredential,
	loadExchangeRateSyncSettings,
} from "#/features/exchange-rates/server/sync";
import { createSecretKeyring } from "#/lib/secrets";
import { applyMigrations } from "./migrations";

// The settings server functions run as plain handlers here: the Start RPC
// wrapper and the admin session belong to the framework, while the provider,
// credential and validity rules under test live in the handler bodies.
vi.mock("@tanstack/react-start", () => {
	const build = (validate?: (input: unknown) => unknown) => ({
		validator: (next: unknown) => build(next as (input: unknown) => unknown),
		handler:
			(handler: (args: { data: unknown }) => unknown) => (input: unknown) =>
				handler({ data: validate ? validate(input) : input }),
	});
	return {
		createServerFn: () => build(),
		createServerOnlyFn: (fn: unknown) => fn,
	};
});
const mocked = vi.hoisted(() => ({
	db: undefined as D1Database | undefined,
	keyring: "",
}));
vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("#/server/context", () => ({
	getAdminServerContext: async () => ({
		db: { $client: mocked.db },
		currentUser: { id: ADMIN_ID },
		request: new Request("https://gmshop.example/admin/exchange-rates"),
	}),
	getAdminRuntimeServerContext: async () => ({
		db: mocked.db,
		currentUser: { id: ADMIN_ID },
		request: new Request("https://gmshop.example/admin/exchange-rates", {
			headers: { "cf-connecting-ip": "203.0.113.9" },
		}),
		runtime: { dataEncryptionSecret: mocked.keyring },
	}),
}));

const ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const save = saveExchangeRateSyncSettingsFn as unknown as (input: {
	provider?: "exchangerate_host" | "allratestoday";
	enabled: boolean;
	intervalMs: number;
	adjustmentBps: number;
	publicationValidityMs?: number;
	apiKey?: string;
}) => Promise<Awaited<ReturnType<typeof loadExchangeRateSyncSettings>>>;
const syncNow = syncExchangeRatesNowFn as unknown as (
	input: Record<string, never>,
) => Promise<{ updated: number; failed: number; observedAt: number }>;

const base = { enabled: true, intervalMs: 86_400_000, adjustmentBps: 0 };

describe("exchange-rate sync settings server function", () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmshop-edge-exchange-rate-sync-settings" },
		});
		db = await miniflare.getD1Database("DB");
		mocked.db = db;
		mocked.keyring = createSecretKeyring();
		await applyMigrations(db);
		await db
			.prepare(
				`INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
				 VALUES (?, 'Rates admin', 'rates-admin@example.com', 1, 1000, 1000)`,
			)
			.bind(ADMIN_ID)
			.run();
		await db
			.prepare(
				`INSERT INTO exchange_rates
				 (id, base_currency, quote_currency, raw_rate, rate, source,
				  enabled, adjustment_bps, sort_order, observed_at, expires_at,
				  created_at, updated_at)
				 VALUES ('usd-eur', 'USD', 'EUR', '0.9', '0.9', 'manual',
				  1, 0, 100, 1000, NULL, 1000, 1000)`,
			)
			.run();
	});
	afterAll(async () => miniflare.dispose());
	afterEach(async () => {
		vi.restoreAllMocks();
		await db
			.prepare(
				"DELETE FROM system_settings WHERE key LIKE 'exchange_rates.sync.%'",
			)
			.run();
		await db.prepare("DELETE FROM audit_logs").run();
	});

	async function auditAfter() {
		const rows = await db
			.prepare(
				"SELECT after FROM audit_logs WHERE action = 'exchange_rate_sync.settings_updated' ORDER BY created_at, id",
			)
			.all<{ after: string }>();
		return rows.results.map((row) => JSON.parse(row.after));
	}

	it("still requires an API key to enable exchangerate.host when none is stored", async () => {
		await expect(
			save({ ...base, provider: "exchangerate_host" }),
		).rejects.toMatchObject({
			code: "exchange_rate_sync_credentials_required",
		});
		expect(await loadExchangeRateSyncSettings(db)).toMatchObject({
			provider: "exchangerate_host",
			enabled: false,
			hasApiKey: false,
		});
	});

	it("saves the keyless provider with the strict 24h default validity and no credentials", async () => {
		await expect(
			save({ ...base, provider: "allratestoday" }),
		).resolves.toMatchObject({
			provider: "allratestoday",
			enabled: true,
			hasApiKey: false,
			publicationValidityMs: 86_400_000,
		});
		expect(await auditAfter()).toEqual([
			expect.objectContaining({
				provider: "allratestoday",
				publicationValidityMs: 86_400_000,
				hasApiKey: false,
				credentialsChanged: false,
			}),
		]);
	});

	it("stores a configured validity duration and rejects values outside 1h..7d at the boundary", async () => {
		await expect(
			save({
				...base,
				provider: "allratestoday",
				publicationValidityMs: 72 * 3_600_000,
			}),
		).resolves.toMatchObject({ publicationValidityMs: 72 * 3_600_000 });
		// The input schema rejects before the handler runs (synchronously in
		// this plain-handler harness), so the refusal is awaited through a
		// promise.
		for (const publicationValidityMs of [
			0,
			3_600_000 - 1,
			7 * 86_400_000 + 1,
			1.5 * 3_600_000 + 0.5,
			-86_400_000,
		])
			await expect(
				Promise.resolve().then(() =>
					save({ ...base, provider: "allratestoday", publicationValidityMs }),
				),
			).rejects.toThrow(/Too (small|big)|expected int/);
		expect(await loadExchangeRateSyncSettings(db)).toMatchObject({
			publicationValidityMs: 72 * 3_600_000,
		});
		// The bounds themselves are accepted.
		await expect(
			save({
				...base,
				provider: "allratestoday",
				publicationValidityMs: 3_600_000,
			}),
		).resolves.toMatchObject({ publicationValidityMs: 3_600_000 });
		await expect(
			save({
				...base,
				provider: "allratestoday",
				publicationValidityMs: 7 * 86_400_000,
			}),
		).resolves.toMatchObject({ publicationValidityMs: 7 * 86_400_000 });
		expect(
			(await auditAfter()).map((entry) => entry.publicationValidityMs),
		).toEqual([72 * 3_600_000, 3_600_000, 7 * 86_400_000]);
	});

	it("keeps an existing exchangerate.host key across a switch to the keyless provider and back", async () => {
		await expect(
			save({ ...base, provider: "exchangerate_host", apiKey: "provider-key" }),
		).resolves.toMatchObject({
			provider: "exchangerate_host",
			hasApiKey: true,
		});
		const encrypted = await loadExchangeRateSyncCredential(db);
		expect(encrypted).not.toBeNull();
		// Switching to AllRatesToday hides the key field; the stored credential
		// must survive untouched.
		await expect(
			save({ ...base, provider: "allratestoday" }),
		).resolves.toMatchObject({ provider: "allratestoday", hasApiKey: true });
		expect(await loadExchangeRateSyncCredential(db)).toBe(encrypted);
		// Switching back needs no re-entry.
		await expect(
			save({ ...base, provider: "exchangerate_host" }),
		).resolves.toMatchObject({
			provider: "exchangerate_host",
			hasApiKey: true,
		});
		expect(await loadExchangeRateSyncCredential(db)).toBe(encrypted);
		expect(
			(await auditAfter()).map((entry) => [
				entry.provider,
				entry.credentialsChanged,
			]),
		).toEqual([
			["exchangerate_host", true],
			["allratestoday", false],
			["exchangerate_host", false],
		]);
	});

	it("runs the keyless provider immediately without a key and stores the publication time", async () => {
		await save({ ...base, provider: "allratestoday" });
		const now = Date.now();
		const publishedUnix = Math.floor(now / 1000) - 3_600;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({
				result: "success",
				base_code: "USD",
				time_last_update_unix: publishedUnix,
				rates: { USD: 1, EUR: 0.86 },
			}),
		);
		await expect(syncNow({})).resolves.toMatchObject({
			updated: 1,
			failed: 0,
			observedAt: publishedUnix * 1000,
		});
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
			"https://allratestoday.com/api/open/latest/USD",
		);
		expect(
			await db
				.prepare(
					"SELECT raw_rate, source, observed_at, expires_at FROM exchange_rates WHERE id = 'usd-eur'",
				)
				.first(),
		).toEqual({
			raw_rate: "0.86",
			source: "allratestoday",
			observed_at: publishedUnix * 1000,
			expires_at: publishedUnix * 1000 + 86_400_000,
		});
	});

	it("does not reach any provider when exchangerate.host is selected without a key", async () => {
		await save({ ...base, provider: "allratestoday" });
		await db
			.prepare(
				`UPDATE system_settings SET value = ? WHERE key = 'exchange_rates.sync.config'`,
			)
			.bind(
				JSON.stringify({
					provider: "exchangerate_host",
					enabled: true,
					intervalMs: 86_400_000,
					adjustmentBps: 0,
				}),
			)
			.run();
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		await expect(syncNow({})).rejects.toMatchObject({
			code: "exchange_rate_sync_credentials_required",
		});
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	describe("shortening the AllRatesToday validity", () => {
		const hour = 3_600_000;
		const published = 1_900_000_000_000;
		const allRatesToday = { ...base, provider: "allratestoday" as const };
		const shortened = {
			observed_at: published,
			expires_at: published + 24 * hour,
		};

		const publication = () =>
			Response.json({
				result: "success",
				base_code: "USD",
				time_last_update_unix: published / 1000,
				rates: { USD: 1, EUR: 0.86 },
			});
		function at(time: number) {
			vi.spyOn(Date, "now").mockReturnValue(time);
			return time;
		}
		const stored = () =>
			db
				.prepare(
					"SELECT observed_at, expires_at FROM exchange_rates WHERE id = 'usd-eur'",
				)
				.first();
		const quote = (now: number) =>
			quotePaymentCurrency(db, {
				amountMinor: "10000",
				currency: "USD",
				currencyDecimals: 2,
				paymentCurrency: "EUR",
				now,
			});
		const unavailable = { code: "exchange_rate_unavailable" };

		// Accepted at 72h, then 30 hours old: outside a 24h validity.
		async function storedAt72h() {
			at(published + hour);
			const fetchSpy = vi
				.spyOn(globalThis, "fetch")
				.mockImplementation(async () => publication());
			await save({ ...allRatesToday, publicationValidityMs: 72 * hour });
			await expect(syncNow({})).resolves.toMatchObject({ updated: 1 });
			const now = at(published + 30 * hour);
			await expect(quote(now)).resolves.toMatchObject({ rateId: "usd-eur" });
			return { fetchSpy, now };
		}

		afterEach(async () => {
			await db
				.prepare(
					`UPDATE exchange_rates SET source = 'manual', raw_rate = '0.9',
					 rate = '0.9', observed_at = 1000, expires_at = NULL
					 WHERE id = 'usd-eur'`,
				)
				.run();
			await db
				.prepare(
					"DELETE FROM exchange_rates WHERE id IN ('usd-gbp', 'usd-jpy')",
				)
				.run();
		});

		it("withdraws the stored publication on save, without contacting the provider", async () => {
			const { fetchSpy, now } = await storedAt72h();
			fetchSpy.mockClear();

			await save({ ...allRatesToday, publicationValidityMs: 24 * hour });

			expect(fetchSpy).not.toHaveBeenCalled();
			expect(await stored()).toEqual(shortened);
			await expect(quote(now)).rejects.toMatchObject(unavailable);
		});

		it.each([
			["serves the same, now expired, publication", publication],
			["rate-limits", () => new Response("slow down", { status: 429 })],
			["is unavailable", () => new Response("down", { status: 503 })],
		])("stays withdrawn when the provider then %s", async (_, response) => {
			const { fetchSpy, now } = await storedAt72h();
			await save({ ...allRatesToday, publicationValidityMs: 24 * hour });
			fetchSpy.mockImplementation(async () => response());

			await syncNow({}).catch(() => undefined);

			expect(await stored()).toEqual(shortened);
			await expect(quote(now)).rejects.toMatchObject(unavailable);
		});

		it("keeps a publication quotable until the exact new boundary", async () => {
			await storedAt72h();
			const boundary = published + 24 * hour;
			at(boundary - 1);

			await save({ ...allRatesToday, publicationValidityMs: 24 * hour });

			expect(await stored()).toEqual(shortened);
			await expect(quote(boundary - 1)).resolves.toMatchObject({
				rateId: "usd-eur",
			});
			await expect(quote(boundary)).rejects.toMatchObject(unavailable);
		});

		it("leaves a longer validity to the next sync", async () => {
			at(published + hour);
			vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
				publication(),
			);
			await save(allRatesToday);
			await syncNow({});
			expect(await stored()).toEqual(shortened);

			await save({ ...allRatesToday, publicationValidityMs: 72 * hour });

			expect(await stored()).toEqual(shortened);
		});

		it("does not touch other providers or manual rows", async () => {
			const rows = [
				["usd-gbp", "GBP", "exchangerate_host", published + 72 * hour],
				["usd-jpy", "JPY", "manual", published + 72 * hour],
			] as const;
			for (const [id, quoteCurrency, source, expiresAt] of rows)
				await db
					.prepare(
						`INSERT INTO exchange_rates
						 (id, base_currency, quote_currency, raw_rate, rate, source,
						  enabled, adjustment_bps, sort_order, observed_at, expires_at,
						  created_at, updated_at)
						 VALUES (?, 'USD', ?, '1', '1', ?, 1, 0, 100, ?, ?, 1000, 1000)`,
					)
					.bind(id, quoteCurrency, source, published, expiresAt)
					.run();
			at(published + 30 * hour);

			await save({ ...allRatesToday, publicationValidityMs: 24 * hour });

			const after = await db
				.prepare(
					"SELECT expires_at FROM exchange_rates WHERE id IN ('usd-gbp', 'usd-jpy')",
				)
				.all<{ expires_at: number }>();
			expect(after.results.map((row) => row.expires_at)).toEqual(
				rows.map((row) => row[3]),
			);
		});
	});
});
