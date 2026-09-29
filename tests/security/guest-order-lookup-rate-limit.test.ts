import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getStoreOrder } from "#/features/storefront/server/order-query";
import { CLIENT_IP_HEADER } from "#/server/client-ip";
import { awaitFreshRateLimitWindow } from "../helpers/rate-limit-window";
import { applyMigrations } from "../integration/migrations";

describe("guest order lookup throttling", { timeout: 60_000 }, () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: crypto.randomUUID() },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await db
			.prepare(
				`INSERT INTO shop_orders
				 (id, order_number, idempotency_key, contact_email, normalized_contact_email, status,
				  currency, currency_decimals, subtotal_minor, discount_minor, total_minor, paid_minor,
				  version, expires_at, created_at, updated_at)
				 VALUES ('order-1', 'GMTHROTTLE01', 'throttle-key', 'buyer@example.com',
				  'buyer@example.com', 'pending_payment', 'USD', 2, '100', '0', '100', '0', 1,
				  9999999999999, 1, 1)`,
			)
			.run();
	});

	afterAll(async () => miniflare.dispose());

	const lookup = (email: string, ip: string, orderNumber = "GMTHROTTLE01") =>
		getStoreOrder(
			db,
			{ orderNumber, email },
			{
				request: new Request("https://shop.example/orders", {
					headers: { [CLIENT_IP_HEADER]: ip },
				}),
			},
		).then(
			() => "found",
			(error: { code?: string }) => error.code,
		);

	it("lets the real owner poll freely: correct proofs never consume a budget", async () => {
		for (let index = 0; index < 40; index += 1)
			expect(await lookup("buyer@example.com", "198.51.100.1")).toBe("found");
		const counters = await db
			.prepare(
				"SELECT COUNT(*) AS total FROM rate_limit_counters WHERE bucket_key LIKE 'store-lookup:%'",
			)
			.first<{ total: number }>();
		expect(counters?.total).toBe(0);
	});

	it("stops e-mail guessing against one order number after the per-order failure budget", async () => {
		await awaitFreshRateLimitWindow();
		const outcomes: (string | undefined)[] = [];
		for (let index = 0; index < 16; index += 1)
			outcomes.push(
				await lookup(`guess-${index}@example.com`, `203.0.113.${index + 1}`),
			);
		expect(
			outcomes.slice(0, 15).every((code) => code === "order_not_found"),
		).toBe(true);
		expect(outcomes[15]).toBe("order_lookup_rate_limited");
		// The owner is throttled too until the window passes (the order number is
		// under attack), while an account holder is unaffected because ownership
		// comes from the session.
		expect(await lookup("buyer@example.com", "198.51.100.1")).toBe(
			"order_lookup_rate_limited",
		);
		await expect(
			getStoreOrder(db, { orderNumber: "GMTHROTTLE01" }, { userId: "someone" }),
		).rejects.toMatchObject({ code: "order_not_found" });
	});

	it("also throttles one client failing against many order numbers", async () => {
		await awaitFreshRateLimitWindow();
		let limited = 0;
		for (let index = 0; index < 41; index += 1) {
			const code = await lookup(
				"x@example.com",
				"198.51.100.7",
				`GMUNKNOWN${String(index).padStart(4, "0")}`,
			);
			if (code === "order_lookup_rate_limited") limited += 1;
		}
		expect(limited).toBe(1);
	});
});
