import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentAccessProducts } from "#/features/agent-access/products";
import { checkSubsitePrefix } from "#/features/agent-access/server/checkout";
import { processAgentDelivery } from "#/features/agent-access/server/fulfillment";
import { checkSubsitePrefixForBuyer } from "#/features/agent-access/server/functions";
import { prepareAgentProducts } from "#/features/agent-access/server/products";
import { completeWalletStoreOrder } from "#/features/shop-payments/server/service";
import { createMultiStoreOrder } from "#/features/storefront/server/multi-order";
import { applyMigrations } from "./migrations";

const { remote } = vi.hoisted(() => ({ remote: vi.fn() }));
vi.mock("#/features/agent-access/server/client", async (original) => ({
	...(await original<typeof import("#/features/agent-access/server/client")>()),
	callAgent: remote,
}));
const userId = "a1111111-1111-4111-8111-111111111111";
const taken = new Set(["taken"]);

describe("sub-site prefix", { timeout: 30000 }, () => {
	let mf: Miniflare;
	let db: D1Database;
	beforeEach(async () => {
		mf = new Miniflare({
			modules: true,
			script: "export default {fetch(){return new Response('ok')}}",
			d1Databases: { DB: crypto.randomUUID() },
		});
		db = await mf.getD1Database("DB");
		await applyMigrations(db);
		await db
			.prepare(
				"INSERT INTO users(id,name,email,email_verified,enabled,balance_minor,balance_version) VALUES (?,'Buyer','buyer@example.test',1,1,'50000',1)",
			)
			.bind(userId)
			.run();
		await db
			.prepare(
				`INSERT INTO system_settings(key,value) VALUES ('agent_access.enabled','true'),('commerce.default_currency','"CNY"'),('runtime.data_encryption_secret','"test-access-data-secret-32-characters"')`,
			)
			.run();
		await prepareAgentProducts(db);
		await db.prepare("UPDATE products SET status='active'").run();
		remote.mockReset();
		remote.mockImplementation(
			async (input: { operation: string; subdomain?: string }) => {
				if (input.operation === "check") return { state: "eligible" };
				if (input.operation === "check_subdomain")
					return {
						state: taken.has(input.subdomain ?? "") ? "taken" : "available",
						domain: `${input.subdomain}.lsrai.shop`,
					};
				return { state: "active", userId: 71 };
			},
		);
	}, 30000);
	afterEach(async () => {
		await mf.dispose();
	});
	const order = (
		prefix: string | null | undefined,
		itemId: string = agentAccessProducts.subsite.itemId,
	) =>
		createMultiStoreOrder(
			db,
			{
				items: [{ sellableItemId: itemId, quantity: 1 }],
				email: "buyer@example.test",
				idempotencyKey: crypto.randomUUID(),
				agentAccessTermsAccepted: true,
				agentSubsitePrefix: prefix,
			},
			{ userId },
		);
	const requested = () =>
		db
			.prepare("SELECT requested_subdomain FROM agent_access_orders")
			.first<string | null>("requested_subdomain");
	async function deliver(created: { id: string }) {
		await completeWalletStoreOrder(db, { orderId: created.id, userId });
		const d = await db
			.prepare(
				"SELECT d.id FROM delivery_records d JOIN shop_order_items oi ON oi.id=d.order_item_id WHERE oi.order_id=?",
			)
			.bind(created.id)
			.first<{ id: string }>();
		if (!d) throw new Error("no delivery");
		return d.id;
	}

	it("stores an available prefix with the order and sends it to provision", async () => {
		const created = await order(" MyStore ");
		expect(remote).toHaveBeenCalledWith({
			operation: "check_subdomain",
			subdomain: "mystore",
		});
		expect(await requested()).toBe("mystore");
		remote.mockImplementation(async (input: { operation: string }) =>
			input.operation === "provision"
				? {
						state: "active",
						userId: 71,
						domain: "mystore.lsrai.shop",
						requestedSubdomain: "mystore",
					}
				: { state: "eligible" },
		);
		await processAgentDelivery(db, await deliver(created));
		expect(remote).toHaveBeenCalledWith(
			expect.objectContaining({
				operation: "provision",
				kind: "subsite",
				subdomain: "mystore",
			}),
		);
		expect(
			await db.prepare("SELECT domain,state FROM agent_access_orders").first(),
		).toEqual({ domain: "mystore.lsrai.shop", state: "active" });
	});

	it("records the fallback host even while the opening is still provisioning", async () => {
		const created = await order("mystore");
		remote.mockImplementation(async () => ({
			state: "provisioning",
			userId: 71,
			domain: "apple.lsrai.shop",
			requestedSubdomain: "mystore",
			subdomainFallback: "taken",
		}));
		await expect(
			processAgentDelivery(db, await deliver(created)),
		).rejects.toThrow();
		expect(
			await db
				.prepare(
					"SELECT domain,subdomain_fallback,state FROM agent_access_orders",
				)
				.first(),
		).toEqual({
			domain: "apple.lsrai.shop",
			subdomain_fallback: "taken",
			state: "pending",
		});
	});

	it("leaves the prefix empty for auto-assignment and omits it from provision", async () => {
		const created = await order("");
		expect(await requested()).toBeNull();
		await processAgentDelivery(db, await deliver(created));
		const provision = remote.mock.calls
			.map(([input]) => input)
			.find((input) => input.operation === "provision");
		expect(provision).not.toHaveProperty("subdomain");
		expect(
			remote.mock.calls.some(
				([input]) => input.operation === "check_subdomain",
			),
		).toBe(false);
	});

	it("rejects taken, reserved and invalid prefixes before an order exists", async () => {
		await expect(order("taken")).rejects.toMatchObject({
			code: "agent_subsite_prefix_taken",
		});
		remote.mockClear();
		await expect(order("admin")).rejects.toMatchObject({
			code: "agent_subsite_prefix_reserved",
		});
		await expect(order("my--store")).rejects.toMatchObject({
			code: "agent_subsite_prefix_invalid",
		});
		// Local rules never spend a remote call.
		expect(
			remote.mock.calls.some(
				([input]) => input.operation === "check_subdomain",
			),
		).toBe(false);
		expect(
			await db.prepare("SELECT COUNT(*) AS n FROM shop_orders").first("n"),
		).toBe(0);
	});

	it("refuses a prefix on API-only access", async () => {
		await expect(
			order("mystore", agentAccessProducts.api.itemId),
		).rejects.toMatchObject({ code: "agent_subsite_prefix_invalid" });
	});

	it("rate-limits the buyer-facing availability check per account", async () => {
		const check = vi.fn(async (prefix: string) =>
			checkSubsitePrefix(prefix, remote),
		);
		for (let i = 0; i < 20; i++)
			await expect(
				checkSubsitePrefixForBuyer(db, userId, "mystore", check),
			).resolves.toEqual({
				state: "available",
				label: "mystore",
				domain: "mystore.lsrai.shop",
			});
		await expect(
			checkSubsitePrefixForBuyer(db, userId, "mystore", check),
		).rejects.toMatchObject({ code: "agent_subsite_prefix_rate_limited" });
		expect(check).toHaveBeenCalledTimes(20);
		await expect(
			checkSubsitePrefixForBuyer(db, "another-user", "taken", check),
		).resolves.toMatchObject({ state: "taken" });
	});

	it("refuses availability checks while access sales are disabled", async () => {
		await db
			.prepare(
				"UPDATE system_settings SET value='false' WHERE key='agent_access.enabled'",
			)
			.run();
		await expect(
			checkSubsitePrefixForBuyer(db, userId, "mystore"),
		).rejects.toMatchObject({ code: "agent_access_disabled" });
	});
});
