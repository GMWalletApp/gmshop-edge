import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordCustomerWalletAdjustmentAudit } from "#/features/customers/server/admin";
import { prepareCustomerDataDeletion } from "#/features/customers/server/privacy";
import { updateCustomerRecord } from "#/features/customers/server/update";
import { mutateWallet } from "#/features/wallet/server/ledger";
import { applyMigrations } from "../integration/migrations";

const rootRoleId = "00000000-0000-4000-8000-000000000020";
const customerRoleId = "00000000-0000-4000-8000-000000000021";
const supportRoleId = "00000000-0000-4000-8000-000000000022";
const request = new Request("https://shop.example/admin/customers", {
	headers: {
		"x-request-id": "customer-privilege-test",
		"x-gmshop-client-ip": "203.0.113.7",
	},
});

describe("customer management privilege boundaries", () => {
	let miniflare: Miniflare;
	let database: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmshop-edge-customer-privileges" },
		});
		database = await miniflare.getD1Database("DB");
		await applyMigrations(database);
		await seed(database);
	});

	afterAll(async () => miniflare.dispose());

	it("refuses to let an operator disable their own account through customers", async () => {
		await expect(
			updateCustomerRecord(database, request, "support-a", {
				id: "support-a",
				name: "Support A",
				note: null,
				status: "disabled",
			}),
		).rejects.toMatchObject({ code: "cannot_disable_self", status: 409 });
		await expect(
			updateCustomerRecord(database, request, "support-a", {
				id: "support-a",
				name: "Support A (renamed)",
				note: "self-service note",
				status: "active",
			}),
		).resolves.toEqual({ id: "support-a" });
		expect(await userState(database, "support-a")).toMatchObject({
			name: "Support A (renamed)",
			enabled: 1,
			sessions: 1,
		});
	});

	it("requires users:update before customers:update may disable a staff account", async () => {
		await expect(
			updateCustomerRecord(database, request, "operator", {
				id: "support-a",
				name: "Support A",
				note: null,
				status: "disabled",
			}),
		).rejects.toMatchObject({ code: "customer_privileged_user", status: 403 });
		expect(await userState(database, "support-a")).toMatchObject({
			enabled: 1,
			sessions: 1,
		});
		await expect(
			updateCustomerRecord(
				database,
				request,
				"operator",
				{ id: "support-a", name: "Support A", note: null, status: "disabled" },
				{ canManagePrivilegedUsers: true },
			),
		).resolves.toEqual({ id: "support-a" });
		const disabled = await userState(database, "support-a");
		expect(disabled).toMatchObject({ enabled: 0, sessions: 0 });
		expect(disabled?.disabled_at).toBeTypeOf("number");
	});

	it("disables a storefront customer atomically with their sessions", async () => {
		await expect(
			updateCustomerRecord(database, request, "operator", {
				id: "customer-a",
				name: "Customer A",
				note: "chargeback risk",
				status: "disabled",
			}),
		).resolves.toEqual({ id: "customer-a" });
		expect(await userState(database, "customer-a")).toMatchObject({
			enabled: 0,
			sessions: 0,
			customer_note: "chargeback risk",
		});
		await expect(
			updateCustomerRecord(database, request, "operator", {
				id: "customer-a",
				name: "Customer A",
				note: null,
				status: "active",
			}),
		).resolves.toEqual({ id: "customer-a" });
		expect(await userState(database, "customer-a")).toMatchObject({
			enabled: 1,
			disabled_at: null,
		});
		const audits = await database
			.prepare(
				"SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'customer.updated' AND target_id = 'customer-a' AND ip_address = '203.0.113.7'",
			)
			.first<{ count: number }>();
		expect(audits?.count).toBe(2);
	});

	it("never anonymizes root or staff accounts through customer data deletion", async () => {
		await expect(
			prepareCustomerDataDeletion(database, "root-a", 10),
		).rejects.toMatchObject({ code: "root_user_immutable", status: 409 });
		await expect(
			prepareCustomerDataDeletion(database, "support-a", 10),
		).rejects.toMatchObject({ code: "customer_privileged_user", status: 409 });
		await expect(
			prepareCustomerDataDeletion(database, "missing-user", 10),
		).rejects.toMatchObject({ code: "customer_not_found", status: 404 });
		const deletion = await prepareCustomerDataDeletion(
			database,
			"customer-a",
			10,
		);
		expect(deletion.customer).toEqual({
			userId: "customer-a",
			email: "customer-a@example.com",
		});
		const orders = await database
			.prepare(
				"SELECT user_id FROM shop_orders WHERE id IN ('order-root', 'order-support')",
			)
			.all<{ user_id: string }>();
		expect(orders.results.map((row) => row.user_id).sort()).toEqual([
			"root-a",
			"support-a",
		]);
	});

	it("writes exactly one wallet adjustment audit per ledger entry, even on replay", async () => {
		const adjustment = {
			id: "customer-a",
			direction: "credit" as const,
			amountMinor: "500",
			reason: "Goodwill credit",
		};
		const mutation = {
			userId: adjustment.id,
			direction: adjustment.direction,
			amountMinor: adjustment.amountMinor,
			currency: "USD",
			sourceType: "adjustment" as const,
			sourceId: adjustment.id,
			idempotencyKey: "wallet-adjustment-audit",
			reason: adjustment.reason,
			actorUserId: "operator",
		};
		const first = await mutateWallet(database, mutation);
		expect(first).toMatchObject({ duplicate: false, balanceMinor: "500" });
		await recordCustomerWalletAdjustmentAudit(
			database,
			request,
			"operator",
			adjustment,
			first,
		);
		const replay = await mutateWallet(database, mutation);
		expect(replay).toMatchObject({ duplicate: true, id: first.id });
		await recordCustomerWalletAdjustmentAudit(
			database,
			request,
			"operator",
			adjustment,
			replay,
		);
		const audits = await database
			.prepare(
				"SELECT id, actor_user_id, target_id, ip_address, after FROM audit_logs WHERE action = 'customer.wallet_adjusted'",
			)
			.all<{
				id: string;
				actor_user_id: string;
				target_id: string;
				ip_address: string;
				after: string;
			}>();
		expect(audits.results).toHaveLength(1);
		expect(audits.results[0]).toMatchObject({
			id: `wallet-adjustment:${first.id}`,
			actor_user_id: "operator",
			target_id: "customer-a",
			ip_address: "203.0.113.7",
		});
		expect(JSON.parse(audits.results[0]?.after ?? "{}")).toMatchObject({
			direction: "credit",
			amountMinor: "500",
			walletEntryId: first.id,
			balanceMinor: "500",
		});
		await expect(
			recordCustomerWalletAdjustmentAudit(
				database,
				request,
				"operator",
				adjustment,
				{
					id: "missing-entry",
					balanceMinor: "0",
				},
			),
		).resolves.toBeUndefined();
		const total = await database
			.prepare(
				"SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'customer.wallet_adjusted'",
			)
			.first<{ count: number }>();
		expect(total?.count).toBe(1);
	});
});

async function userState(database: D1Database, userId: string) {
	return database
		.prepare(
			`SELECT name, enabled, disabled_at, customer_note,
			 (SELECT COUNT(*) FROM sessions WHERE user_id = users.id) AS sessions
			 FROM users WHERE id = ?`,
		)
		.bind(userId)
		.first<{
			name: string;
			enabled: number;
			disabled_at: number | null;
			customer_note: string | null;
			sessions: number;
		}>();
}

async function seed(database: D1Database) {
	const now = Date.now();
	const role = (id: string, name: string, builtIn: number) =>
		database
			.prepare(
				"INSERT INTO roles (id, name, description, built_in, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
			)
			.bind(id, name, name, builtIn, now, now);
	const user = (id: string, roleIds: string[]) =>
		database
			.prepare(
				"INSERT INTO users (id, name, email, email_verified, enabled, role_ids, created_at, updated_at) VALUES (?, ?, ?, 1, 1, ?, ?, ?)",
			)
			.bind(id, id, `${id}@example.com`, JSON.stringify(roleIds), now, now);
	const session = (userId: string) =>
		database
			.prepare(
				"INSERT INTO sessions (id, user_id, token, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.bind(
				`${userId}-session`,
				userId,
				`${userId}-token`,
				now + 60_000,
				now,
				now,
			);
	const order = (id: string, userId: string) =>
		database
			.prepare(
				`INSERT INTO shop_orders
				 (id, order_number, idempotency_key, user_id, contact_email,
				  normalized_contact_email, locale, status, currency, currency_decimals,
				  subtotal_minor, total_minor, expires_at, completed_at, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, 'en-US', 'completed', 'USD', 2, '100', '100', 999999, 2, 1, 1)`,
			)
			.bind(
				id,
				id.toUpperCase(),
				`${id}-key`,
				userId,
				`${userId}@example.com`,
				`${userId}@example.com`,
			);
	await database.batch([
		role(rootRoleId, "root", 1),
		role(customerRoleId, "customer", 1),
		role(supportRoleId, "support", 0),
		user("root-a", [rootRoleId]),
		user("support-a", [supportRoleId, customerRoleId]),
		user("operator", [supportRoleId]),
		user("customer-a", [customerRoleId]),
		session("support-a"),
		session("customer-a"),
		order("order-root", "root-a"),
		order("order-support", "support-a"),
		order("order-customer", "customer-a"),
	]);
}
