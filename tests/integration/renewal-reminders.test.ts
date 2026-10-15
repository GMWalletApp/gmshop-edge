import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptDeliveryContent } from "#/features/fulfillment/secrets";
import { decryptNotificationMessage } from "#/features/notifications/secrets";
import { sendProviderEmail } from "#/features/notifications/server/email-provider";
import { recipientHash } from "#/features/notifications/server/recipient-policy";
import type { requestWarehouse } from "#/features/redeem-warehouse/server/warehouse-client";
import { redeemCodeHash } from "#/features/renewals/domain";
import {
	resolveRenewalClick,
	signRenewalUnsubscribe,
	unsubscribeRenewalEmail,
	verifyRenewalUnsubscribe,
} from "#/features/renewals/server/links";
import {
	meteredD1,
	type RedeemLookup,
	renewalD1Budget,
	runRenewalReminders,
	warehouseRedeemLookup,
} from "#/features/renewals/server/scheduler";
import {
	loadRenewalStats,
	previewRenewalEmails,
} from "#/features/renewals/server/stats";
import { loadRuntimeConfig } from "#/server/runtime-config";
import { applyMigrations } from "./migrations";

const secret = "data-test-secret";
const code = "gpt-plus-ph-ABCD-EFGH-JK23-MNPQ";
const deliveredAt = Date.parse("2026-09-01T03:00:00Z");
// Redemption of the final code in the exchange chain (13:00 Beijing, Sep 1).
const redeemedAt = Date.parse("2026-09-01T05:00:00Z");
const at = (iso: string) => Date.parse(iso);
// 10:00 Beijing == 02:00Z.
const remind3dDue = at("2026-09-28T02:00:00Z");
const remindDueDue = at("2026-10-01T02:00:00Z");
const recallDue = at("2026-10-11T02:00:00Z");

describe("renewal reminders", { timeout: 120_000 }, () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeEach(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: crypto.randomUUID() },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await seedBase(db);
	}, 120_000);

	afterEach(async () => {
		vi.unstubAllGlobals();
		await miniflare.dispose();
	}, 60_000);

	it("backfills one-month items by name and excludes one-off and test items", async () => {
		const local = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: crypto.randomUUID() },
		});
		try {
			const database = await local.getD1Database("DB");
			await applyMigrations(database, "0031_agent_initial_password.sql");
			await database.batch([
				database.prepare(
					"INSERT INTO products (id, name, product_type, status, created_at, updated_at) VALUES ('p1','ChatGPT','stock','active',1,1)",
				),
				...[
					["a", "ChatGPT Plus 菲区 1个月"],
					["b", "Claude Pro 1个月"],
					["c", "Codex 美国一次性接码 1次"],
					["d", "测试一｜自动发货 1个月"],
					["e", "ChatGPT Pro 20X 菲区续费1个月"],
				].map(([id, name]) =>
					database
						.prepare(
							"INSERT INTO product_sellable_items (id, product_id, name, price_minor, created_at, updated_at) VALUES (?, 'p1', ?, '100', 1, 1)",
						)
						.bind(id, name),
				),
			]);
			const migration = await readFile(
				new URL("../../drizzle/0032_renewal_reminders.sql", import.meta.url),
				"utf8",
			);
			for (const statement of migration
				.split("--> statement-breakpoint")
				.map((value) => value.trim())
				.filter(Boolean))
				await database.prepare(statement).run();
			const rows = await database
				.prepare(
					"SELECT id, reminder_cycle_days AS days FROM product_sellable_items ORDER BY id",
				)
				.all<{ id: string; days: number | null }>();
			expect(rows.results).toEqual([
				{ id: "a", days: 30 },
				{ id: "b", days: 30 },
				{ id: "c", days: null },
				{ id: "d", days: null },
				{ id: "e", days: 30 },
			]);
		} finally {
			await local.dispose();
		}
	});

	it("anchors on the redeem lookup (exchange leaf) and schedules both recipients", async () => {
		await seedOrder(db, {
			id: "o1",
			email: "Buyer@Customer.com",
			content: `CDK：${code}\n充值地址：https://redeem.laoshirenvip.com`,
		});
		const hash = await redeemCodeHash(code);
		expect(hash).toBe(await sha256(code.toLowerCase()));
		const lookup = vi.fn<RedeemLookup>(async (hashes) =>
			hashes.map((value) => ({
				code_hash: value,
				found: true,
				status: "completed",
				completed_at: new Date(redeemedAt).toISOString(),
				account_email: "Account@Customer.com",
			})),
		);
		const result = await runRenewalReminders(db, {
			now: deliveredAt + 60_000,
			force: true,
			lookup,
		});
		expect(result).toMatchObject({ status: "ran", discovered: 1, redeemed: 1 });
		expect(lookup).toHaveBeenCalledWith([hash]);
		const reminder = await db
			.prepare(
				"SELECT anchor_at, anchor_source, account_email, contact_email, status, item_name FROM renewal_reminders",
			)
			.first();
		expect(reminder).toEqual({
			anchor_at: redeemedAt,
			anchor_source: "redeem",
			account_email: "account@customer.com",
			contact_email: "buyer@customer.com",
			status: "scheduled",
			item_name: "ChatGPT Plus 菲区 1个月",
		});
		const sends = await db
			.prepare(
				"SELECT stage, recipient_email, recipient_kind, due_at, status FROM renewal_reminder_sends ORDER BY recipient_kind DESC, due_at",
			)
			.all();
		expect(sends.results).toEqual([
			...["order", "account"].flatMap((kind) =>
				[
					["remind_3d", remind3dDue],
					["remind_due", remindDueDue],
					["recall", recallDue],
				].map(([stage, due]) => ({
					stage,
					recipient_email:
						kind === "order" ? "buyer@customer.com" : "account@customer.com",
					recipient_kind: kind,
					due_at: due,
					status: "pending",
				})),
			),
		]);
	});

	it("dedupes the account email when it equals the order email", async () => {
		await seedOrder(db, {
			id: "o1",
			email: "same@customer.com",
			content: code,
		});
		await runRenewalReminders(db, {
			now: deliveredAt + 60_000,
			force: true,
			lookup: completedLookup("SAME@customer.com"),
		});
		expect(await count(db, "renewal_reminder_sends")).toBe(3);
	});

	it("waits for redemption, retries later and abandons after 60 days", async () => {
		await seedOrder(db, {
			id: "o1",
			email: "buyer@customer.com",
			content: code,
		});
		const pending: RedeemLookup = async (hashes) =>
			hashes.map((value) => ({
				code_hash: value,
				found: true,
				status: "pending",
				completed_at: null,
				account_email: null,
			}));
		await runRenewalReminders(db, {
			now: deliveredAt + 60_000,
			force: true,
			lookup: pending,
		});
		expect(await reminderStatus(db)).toBe("awaiting_redeem");
		expect(await count(db, "renewal_reminder_sends")).toBe(0);
		await runRenewalReminders(db, {
			now: deliveredAt + 61 * 86_400_000,
			force: true,
			lookup: pending,
		});
		expect(await reminderStatus(db)).toBe("abandoned");
	});

	it("falls back to the delivery time for content without warehouse codes", async () => {
		await seedOrder(db, {
			id: "o1",
			email: "buyer@customer.com",
			content: "CDK：UPSTREAM-KEY-123\n充值地址：https://example.net",
		});
		const lookup = vi.fn<RedeemLookup>(async () => []);
		await runRenewalReminders(db, {
			now: deliveredAt + 60_000,
			force: true,
			lookup,
		});
		expect(lookup).not.toHaveBeenCalled();
		expect(
			await db
				.prepare(
					"SELECT anchor_at, anchor_source, status FROM renewal_reminders",
				)
				.first(),
		).toEqual({
			anchor_at: deliveredAt,
			anchor_source: "delivery",
			status: "scheduled",
		});
	});

	it("excludes supplier API orders and items without a reminder cycle", async () => {
		await seedOrder(db, {
			id: "o1",
			email: "buyer@customer.com",
			content: code,
		});
		await seedOrder(db, {
			id: "o2",
			email: "other@customer.com",
			content: code,
			sellableItemId: "item-otp",
		});
		await db.batch([
			db.prepare(
				"INSERT INTO users (id, name, email, email_verified, enabled) VALUES ('reseller','Reseller','reseller@partner.com',1,1)",
			),
			db.prepare(
				"INSERT INTO supplier_api_keys (id, user_id, name, key_id, secret_encrypted, created_at, updated_at) VALUES ('key-1','reseller','Main','kid','enc',1,1)",
			),
			db.prepare(
				"INSERT INTO supplier_api_orders (id, shop_order_id, user_id, api_key_id, downstream_order_no, request_digest, created_at, updated_at) VALUES ('sa-1','o1','reseller','key-1','DS-1','digest',1,1)",
			),
		]);
		const result = await runRenewalReminders(db, {
			now: deliveredAt + 60_000,
			force: true,
			lookup: completedLookup(null),
		});
		expect(result).toMatchObject({ discovered: 0 });
		expect(await count(db, "renewal_reminders")).toBe(0);
	});

	it("sends only from 10:00 Beijing, one email per recipient per day", async () => {
		await seedOrder(db, {
			id: "o1",
			email: "buyer@customer.com",
			content: code,
		});
		await runRenewalReminders(db, {
			now: deliveredAt + 60_000,
			force: true,
			lookup: completedLookup("account@customer.com"),
		});
		const early = await runRenewalReminders(db, {
			now: remind3dDue - 60_000,
			force: true,
		});
		expect(early).toMatchObject({ sent: 0 });
		const run = await runRenewalReminders(db, {
			now: remind3dDue,
			force: true,
		});
		expect(run).toMatchObject({ sent: 2 });
		const deliveries = await db
			.prepare(
				"SELECT event, message_encrypted, status FROM notification_deliveries ORDER BY created_at",
			)
			.all<{ event: string; message_encrypted: string; status: string }>();
		expect(deliveries.results.map((row) => row.event)).toEqual([
			"renewal_remind_3d",
			"renewal_remind_3d",
		]);
		const message = JSON.parse(
			await decryptNotificationMessage(
				deliveries.results[0]?.message_encrypted ?? "",
				secret,
			),
		);
		expect(message.subject).toBe(
			"你的 ChatGPT Plus 菲区 1个月 将于 10月1日 到期",
		);
		expect(message.text).toContain("https://laoshirenvip.com/r/renew/");
		expect(message.text).toContain("记住我们：laoshirenvip.com");
		expect(message.text).toContain("/unsubscribe/renewal?e=");
		expect(message.text).not.toMatch(/优惠|coupon/i);
		expect(message.headers).toEqual({
			"List-Unsubscribe": expect.stringMatching(
				/^<https:\/\/laoshirenvip\.com\/api\/shop\/renewal\/unsubscribe\?e=/,
			),
			"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
		});
		// A second same-day reminder for the same recipient waits until tomorrow.
		await seedOrder(db, {
			id: "o2",
			email: "buyer@customer.com",
			content: "plain delivery",
			sellableItemId: "item-claude",
			paidAt: deliveredAt - 60_000,
			deliveredAt: redeemedAt,
		});
		await runRenewalReminders(db, {
			now: remind3dDue + 60_000,
			force: true,
		});
		expect(
			await db
				.prepare(
					"SELECT s.status AS status FROM renewal_reminder_sends s JOIN renewal_reminders r ON r.id = s.reminder_id WHERE r.order_id = 'o2' AND s.stage = 'remind_3d'",
				)
				.first("status"),
		).toBe("pending");
	});

	it("skips stale reminders and holds recall until the switch is on", async () => {
		await seedOrder(db, {
			id: "o1",
			email: "buyer@customer.com",
			content: code,
		});
		await runRenewalReminders(db, {
			now: deliveredAt + 60_000,
			force: true,
			lookup: completedLookup(null),
		});
		// Due day + 1: the 3-day reminder is superseded, the due reminder still goes.
		const late = await runRenewalReminders(db, {
			now: remindDueDue + 86_400_000,
			force: true,
		});
		expect(late).toMatchObject({ sent: 1, skipped: 1 });
		expect(await stageStatuses(db)).toEqual({
			remind_3d: "skipped",
			remind_due: "sent",
			recall: "pending",
		});
		const recallOff = await runRenewalReminders(db, {
			now: recallDue + 5 * 86_400_000,
			force: true,
		});
		expect(recallOff).toMatchObject({ sent: 0 });
		const preview = await previewRenewalEmails(db, recallDue + 5 * 86_400_000);
		expect(preview).toMatchObject({
			recallEnabled: false,
			recallDueRows: 1,
			recallDueRecipients: 1,
		});
		expect(preview.examples.map((example) => example.to)).toContain(
			"bu***@customer.com",
		);
		expect(await count(db, "notification_deliveries")).toBe(1);
		await setSetting(db, "notifications.renewal_recall_enabled", true);
		const recallOn = await runRenewalReminders(db, {
			now: recallDue + 5 * 86_400_000,
			force: true,
		});
		expect(recallOn).toMatchObject({ sent: 1 });
		expect((await stageStatuses(db)).recall).toBe("sent");
	});

	it("never sends stale reminders for backfilled history", async () => {
		await seedOrder(db, {
			id: "o1",
			email: "buyer@customer.com",
			content: code,
		});
		const now = recallDue + 20 * 86_400_000;
		await runRenewalReminders(db, {
			now,
			force: true,
			lookup: completedLookup(null),
		});
		expect(await stageStatuses(db)).toEqual({
			remind_3d: "skipped",
			remind_due: "skipped",
			recall: "pending",
		});
		expect(await count(db, "notification_deliveries")).toBe(0);
	});

	it("cancels every unsent stage after a repurchase", async () => {
		await seedOrder(db, {
			id: "o1",
			email: "buyer@customer.com",
			content: code,
		});
		await runRenewalReminders(db, {
			now: deliveredAt + 60_000,
			force: true,
			lookup: completedLookup(null),
		});
		await db
			.prepare(
				`INSERT INTO shop_orders (id, order_number, contact_email, normalized_contact_email,
				 status, currency, currency_decimals, subtotal_minor, discount_minor, total_minor,
				 paid_minor, version, expires_at, paid_at, created_at, updated_at)
				 VALUES ('o9', 'ORDER-O9', 'BUYER@customer.com', 'buyer@customer.com', 'completed',
				 'CNY', 2, '100', '0', '100', '100', 2, 1, ?, 1, 1)`,
			)
			.bind(at("2026-09-20T00:00:00Z"))
			.run();
		const run = await runRenewalReminders(db, {
			now: remind3dDue,
			force: true,
		});
		expect(run).toMatchObject({ cancelled: 1, sent: 0 });
		expect(await stageStatuses(db)).toEqual({
			remind_3d: "cancelled",
			remind_due: "cancelled",
			recall: "cancelled",
		});
		expect(
			await db
				.prepare("SELECT status_reason FROM renewal_reminders")
				.first("status_reason"),
		).toBe("repurchased");
	});

	it("skips orders placed by staff accounts and cancels ones already scheduled", async () => {
		await seedOrder(db, {
			id: "o1",
			email: "owner@shop.com",
			content: code,
		});
		await db.batch([
			db.prepare(
				"INSERT OR IGNORE INTO roles(id,name,built_in,enabled,permissions_json,created_at,updated_at) VALUES ('staff-role','admin',1,1,'{}',1,1)",
			),
			db.prepare(
				"INSERT INTO users (id, name, email, email_verified, enabled, role_ids) VALUES ('staff','Owner','owner@shop.com',1,1,'[\"staff-role\"]')",
			),
		]);
		const first = await runRenewalReminders(db, {
			now: deliveredAt + 60_000,
			force: true,
			lookup: completedLookup(null),
		});
		expect(first).toMatchObject({ discovered: 0 });
		expect(await count(db, "renewal_reminders")).toBe(0);

		// A reminder scheduled before the account became staff is cancelled.
		await db
			.prepare("UPDATE users SET role_ids = '[]' WHERE id = 'staff'")
			.run();
		await runRenewalReminders(db, {
			now: deliveredAt + 120_000,
			force: true,
			lookup: completedLookup(null),
		});
		expect(await count(db, "renewal_reminders")).toBe(1);
		await db
			.prepare(
				"UPDATE users SET role_ids = '[\"staff-role\"]' WHERE id = 'staff'",
			)
			.run();
		const run = await runRenewalReminders(db, {
			now: remind3dDue,
			force: true,
		});
		expect(run).toMatchObject({ cancelled: 1, sent: 0 });
		expect(
			await db
				.prepare("SELECT status_reason FROM renewal_reminders")
				.first("status_reason"),
		).toBe("staff");
	});

	it("cancels reminders when the order has a succeeded partial refund", async () => {
		await seedOrder(db, {
			id: "o1",
			email: "buyer@customer.com",
			content: code,
		});
		await runRenewalReminders(db, {
			now: deliveredAt + 60_000,
			force: true,
			lookup: completedLookup(null),
		});
		// A partial refund restores the previous order status, so only the
		// refunds row shows it.
		await db
			.prepare(
				`INSERT INTO refunds (id, order_id, idempotency_key, amount_minor, currency,
				 payment_amount_minor, payment_currency, payment_currency_decimals,
				 order_status_before, status, reason, completed_at, created_at, updated_at)
				 VALUES ('rf1', 'o1', 'rf1', '50', 'CNY', '50', 'CNY', 2, 'completed',
				 'succeeded', 'partial', 1, 1, 1)`,
			)
			.run();
		const run = await runRenewalReminders(db, {
			now: remind3dDue,
			force: true,
		});
		expect(run).toMatchObject({ cancelled: 1, sent: 0 });
		expect(await stageStatuses(db)).toEqual({
			remind_3d: "cancelled",
			remind_due: "cancelled",
			recall: "cancelled",
		});
		expect(
			await db
				.prepare("SELECT status_reason FROM renewal_reminders")
				.first("status_reason"),
		).toBe("refunded");
	});

	it("marks sends stuck in 'sending' as failed after 15 minutes and never resends them", async () => {
		await seedOrder(db, {
			id: "o1",
			email: "buyer@customer.com",
			content: code,
		});
		await runRenewalReminders(db, {
			now: deliveredAt + 60_000,
			force: true,
			lookup: completedLookup(null),
		});
		await db
			.prepare(
				"UPDATE renewal_reminder_sends SET status = 'sending', updated_at = ? WHERE stage = 'remind_3d'",
			)
			.bind(remind3dDue - 10 * 60_000)
			.run();
		const early = await runRenewalReminders(db, {
			now: remind3dDue,
			force: true,
		});
		expect(early).toMatchObject({ recovered: 0, sent: 0 });
		const late = await runRenewalReminders(db, {
			now: remind3dDue + 6 * 60_000,
			force: true,
		});
		expect(late).toMatchObject({ recovered: 1, sent: 0 });
		expect((await stageStatuses(db)).remind_3d).toBe("failed");
		const stats = await loadRenewalStats(db, remind3dDue + 6 * 60_000);
		expect(
			stats.stages.find((stage) => stage.stage === "remind_3d"),
		).toMatchObject({ failed: 1, sent: 0 });
	});

	it("keeps each pass within its D1 budget", async () => {
		for (const id of ["o1", "o2", "o3"])
			await seedOrder(db, {
				id,
				email: `${id}@customer.com`,
				content: code,
			});
		const run = await runRenewalReminders(db, {
			now: deliveredAt + 60_000,
			force: true,
			lookup: completedLookup(null),
		});
		expect(run).toMatchObject({ status: "ran", discovered: 3, redeemed: 3 });
		expect(run.status === "ran" && run.d1Calls).toBeLessThan(40);
		// Discovery stops once only the reserve is left.
		const tight = await runRenewalReminders(db, {
			now: deliveredAt + 60_000,
			force: true,
			d1Budget: 155,
		});
		expect(tight).toMatchObject({ status: "ran" });
		expect(renewalD1Budget).toBeLessThanOrEqual(300);
		const meter = meteredD1(db, 2);
		await meter.db.batch([
			meter.db.prepare("SELECT 1"),
			meter.db.prepare("SELECT 2"),
		]);
		await meter.db.prepare("SELECT ?").bind(1).first();
		expect(meter.used()).toBe(2);
		await expect(meter.db.prepare("SELECT 1").run()).rejects.toThrow(
			/D1 budget/,
		);
	});

	it("retries without list headers only for a Cloudflare header rejection", async () => {
		const config = {
			provider: "cloudflare_email" as const,
			apiKey: null,
			domain: null,
			region: "us" as const,
			smtpHost: null,
			smtpPort: null,
			smtpUser: null,
		};
		const message = {
			to: "buyer@customer.com",
			from: "Shop <no-reply@laoshirenvip.com>",
			replyTo: "",
			subject: "s",
			text: "t",
			html: "",
			idempotencyKey: "k",
			headers: { "List-Unsubscribe": "<https://x.test/u>" },
		};
		const rejected = vi.fn(async (input: { headers?: unknown }) => {
			if (input.headers)
				throw Object.assign(new Error("Header not allowed"), {
					code: "E_HEADER_NOT_ALLOWED",
				});
			return { messageId: "m1" };
		});
		await expect(
			sendProviderEmail(
				{
					...config,
					cloudflareEmail: { send: rejected } as unknown as SendEmail,
				},
				message,
			),
		).resolves.toMatchObject({ data: { messageId: "m1" } });
		expect(rejected).toHaveBeenCalledTimes(2);
		const timeout = vi.fn(async () => {
			throw Object.assign(new Error("timeout"), {
				code: "E_INTERNAL_SERVER_ERROR",
			});
		});
		await expect(
			sendProviderEmail(
				{
					...config,
					cloudflareEmail: { send: timeout } as unknown as SendEmail,
				},
				message,
			),
		).rejects.toThrow("timeout");
		expect(timeout).toHaveBeenCalledTimes(1);
	});

	it("honors bounce suppression and signed unsubscribe", async () => {
		await seedOrder(db, {
			id: "o1",
			email: "buyer@customer.com",
			content: code,
		});
		await runRenewalReminders(db, {
			now: deliveredAt + 60_000,
			force: true,
			lookup: completedLookup("account@customer.com"),
		});
		await db
			.prepare(
				"INSERT INTO email_recipient_suppressions (recipient_hash, reason, source_delivery_id, created_at) VALUES (?, 'hard_bounce', 'x', 1)",
			)
			.bind(await recipientHash("account@customer.com"))
			.run();
		const runtime = await loadRuntimeConfig(db);
		expect(
			await unsubscribeRenewalEmail(db, "buyer@customer.com", "0".repeat(32)),
		).toEqual({ ok: false });
		expect(
			await unsubscribeRenewalEmail(
				db,
				"BUYER@customer.com",
				await signRenewalUnsubscribe(runtime, "buyer@customer.com"),
			),
		).toEqual({ ok: true });
		const run = await runRenewalReminders(db, {
			now: remind3dDue,
			force: true,
		});
		expect(run).toMatchObject({ sent: 0, excluded: 1 });
		const statuses = await db
			.prepare(
				"SELECT recipient_kind, status FROM renewal_reminder_sends WHERE stage = 'remind_3d' ORDER BY recipient_kind",
			)
			.all();
		expect(statuses.results).toEqual([
			{ recipient_kind: "account", status: "suppressed" },
			{ recipient_kind: "order", status: "unsubscribed" },
		]);
		expect(await count(db, "notification_deliveries")).toBe(0);
	});

	it("validates unsubscribe signatures", async () => {
		const runtime = await loadRuntimeConfig(db);
		const signature = await signRenewalUnsubscribe(runtime, "a@customer.com");
		expect(signature).toMatch(/^[0-9a-f]{32}$/);
		await expect(
			verifyRenewalUnsubscribe(runtime, "A@Customer.com", signature),
		).resolves.toBe(true);
		await expect(
			verifyRenewalUnsubscribe(runtime, "b@customer.com", signature),
		).resolves.toBe(false);
		const tampered = `${signature.slice(0, 31)}${signature.endsWith("0") ? "1" : "0"}`;
		await expect(
			verifyRenewalUnsubscribe(runtime, "a@customer.com", tampered),
		).resolves.toBe(false);
		await expect(
			verifyRenewalUnsubscribe(runtime, "not-an-email", signature),
		).resolves.toBe(false);
		await expect(
			verifyRenewalUnsubscribe(
				{ ...runtime, betterAuthSecret: "another-secret-value-long-enough" },
				"a@customer.com",
				signature,
			),
		).resolves.toBe(false);
	});

	it("tracks clicks and redirects to the same item", async () => {
		await seedOrder(db, {
			id: "o1",
			email: "buyer@customer.com",
			content: code,
		});
		await runRenewalReminders(db, {
			now: deliveredAt + 60_000,
			force: true,
			lookup: completedLookup(null),
		});
		await runRenewalReminders(db, { now: remind3dDue, force: true });
		const token = String(
			await db
				.prepare(
					"SELECT click_token FROM renewal_reminder_sends WHERE stage = 'remind_3d'",
				)
				.first("click_token"),
		);
		expect(await resolveRenewalClick(db, token, remind3dDue + 1_000)).toBe(
			"https://laoshirenvip.com/products/product-plus?item=item-plus&ref=renew_3d#purchase-options",
		);
		await resolveRenewalClick(db, token, remind3dDue + 2_000);
		expect(
			await db
				.prepare(
					"SELECT click_count, first_clicked_at, last_clicked_at FROM renewal_reminder_sends WHERE click_token = ?",
				)
				.bind(token)
				.first(),
		).toEqual({
			click_count: 2,
			first_clicked_at: remind3dDue + 1_000,
			last_clicked_at: remind3dDue + 2_000,
		});
		expect(await resolveRenewalClick(db, "unknown-token-value-xx")).toBe(
			"https://laoshirenvip.com/",
		);
		expect(await resolveRenewalClick(db, "../evil")).toBe(
			"https://laoshirenvip.com/",
		);
		const stats = await loadRenewalStats(db, remind3dDue + 3_000);
		expect(stats.stages[0]).toMatchObject({
			stage: "remind_3d",
			planned: 1,
			clicked: 1,
		});
	});

	it("throttles to one pass per ten minutes and respects the master switch", async () => {
		const first = await runRenewalReminders(db, {
			now: remind3dDue,
			lookup: completedLookup(null),
		});
		expect(first.status).toBe("ran");
		expect(
			(await runRenewalReminders(db, { now: remind3dDue + 60_000 })).status,
		).toBe("throttled");
		await setSetting(db, "notifications.renewal_reminders_enabled", false);
		expect(
			(
				await runRenewalReminders(db, {
					now: remind3dDue + 600_000,
				})
			).status,
		).toBe("disabled");
	});

	it("calls the warehouse lookup contract with the delivery token", async () => {
		const requester = vi.fn(async () => ({
			success: true,
			code: "ok",
			data: {
				items: [
					{
						code_hash: "a".repeat(64),
						found: true,
						status: "completed",
						sku: "gpt-plus-ph",
						completed_at: "2026-10-07T11:15:00.000Z",
						account_email: null,
					},
				],
			},
		}));
		const { encryptSecret } = await import("#/lib/secrets");
		await setSetting(
			db,
			"integration.redeem_warehouse_token",
			await encryptSecret("warehouse-token", secret, "redeem-warehouse-token"),
		);
		const lookup = warehouseRedeemLookup(
			db,
			secret,
			requester as unknown as typeof requestWarehouse,
		);
		await expect(lookup(["a".repeat(64)])).resolves.toHaveLength(1);
		expect(requester).toHaveBeenCalledWith(
			"warehouse-token",
			"/api/internal/redemptions/lookup",
			{
				method: "POST",
				body: JSON.stringify({ code_hashes: ["a".repeat(64)] }),
			},
		);
	});
});

function completedLookup(accountEmail: string | null): RedeemLookup {
	return async (hashes) =>
		hashes.map((value) => ({
			code_hash: value,
			found: true,
			status: "completed",
			completed_at: new Date(redeemedAt).toISOString(),
			account_email: accountEmail,
		}));
}

async function sha256(value: string) {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

async function count(db: D1Database, table: string) {
	return Number(
		await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first("n"),
	);
}

async function reminderStatus(db: D1Database) {
	return db.prepare("SELECT status FROM renewal_reminders").first("status");
}

async function stageStatuses(db: D1Database) {
	const rows = await db
		.prepare("SELECT stage, status FROM renewal_reminder_sends")
		.all<{ stage: string; status: string }>();
	return Object.fromEntries(rows.results.map((row) => [row.stage, row.status]));
}

async function setSetting(db: D1Database, key: string, value: unknown) {
	await db
		.prepare(
			`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
			 VALUES (?, ?, 0, 1, 1) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		)
		.bind(key, JSON.stringify(value))
		.run();
}

async function seedBase(db: D1Database) {
	await db.batch([
		db.prepare(
			`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
			 VALUES ('runtime.better_auth_url', '"https://laoshirenvip.com"', 0, 1, 1)`,
		),
		db.prepare(
			`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
			 VALUES ('runtime.data_encryption_secret', '"${secret}"', 1, 1, 1)`,
		),
		db.prepare(
			`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
			 VALUES ('runtime.better_auth_secret', '"auth-test-secret-0123456789abcdef"', 1, 1, 1)`,
		),
		db.prepare(
			`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
			 VALUES ('site.name', '"老实人AI VIP"', 0, 1, 1)`,
		),
		db.prepare(
			`INSERT INTO notification_channel_configs
			 (id, channel, name, provider, api_key_encrypted, api_key_version,
			  from_address, reply_to, sort_order, enabled, created_at, updated_at)
			 VALUES ('cloudflare-email', 'email', 'Cloudflare Email', 'cloudflare_email',
			  NULL, NULL, '老实人AI VIP <no-reply@laoshirenvip.com>', NULL, 10, 1, 1, 1)`,
		),
		db.prepare(
			"INSERT INTO products (id, name, product_type, status, created_at, updated_at) VALUES ('product-plus', 'ChatGPT Plus', 'stock', 'active', 1, 1)",
		),
		...[
			["item-plus", "ChatGPT Plus 菲区 1个月", 30],
			["item-claude", "Claude Pro 1个月", 30],
			["item-otp", "Codex 美国一次性接码 1次", null],
		].map(([id, name, days]) =>
			db
				.prepare(
					`INSERT INTO product_sellable_items
					 (id, product_id, name, price_minor, reminder_cycle_days, created_at, updated_at)
					 VALUES (?, 'product-plus', ?, '100', ?, 1, 1)`,
				)
				.bind(id, name, days),
		),
	]);
}

async function seedOrder(
	db: D1Database,
	input: {
		id: string;
		email: string;
		content: string;
		sellableItemId?: string;
		paidAt?: number;
		deliveredAt?: number;
	},
) {
	const item = input.sellableItemId ?? "item-plus";
	const name = String(
		await db
			.prepare("SELECT name FROM product_sellable_items WHERE id = ?")
			.bind(item)
			.first("name"),
	);
	const paidAt = input.paidAt ?? deliveredAt - 60_000;
	await db.batch([
		db
			.prepare(
				`INSERT INTO shop_orders
				 (id, order_number, contact_email, normalized_contact_email, locale,
				  status, currency, currency_decimals, subtotal_minor, discount_minor,
				  total_minor, paid_minor, version, expires_at, paid_at, created_at, updated_at)
				 VALUES (?, ?, ?, ?, 'zh-CN', 'completed', 'CNY', 2, '100', '0', '100', '100',
				  2, 1, ?, ?, ?)`,
			)
			.bind(
				input.id,
				`ORDER-${input.id.toUpperCase()}`,
				input.email,
				input.email.toLowerCase(),
				paidAt,
				paidAt,
				paidAt,
			),
		db
			.prepare(
				`INSERT INTO shop_order_items
				 (id, order_id, product_id, sellable_item_id, delivery_component_id,
				  product_name, delivery_component_type, delivery_component_version,
				  sellable_item_name, quantity, unit_price_minor, discount_minor,
				  subtotal_minor, created_at, updated_at)
				 VALUES (?, ?, 'product-plus', ?, ?, 'ChatGPT Plus', 'stock', 1, ?, 1,
				  '100', '0', '100', 1, 1)`,
			)
			.bind(`${input.id}-item`, input.id, item, item, name),
		db
			.prepare(
				`INSERT INTO delivery_records
				 (id, order_item_id, delivery_type, status, content_encrypted,
				  content_key_version, delivered_at, created_at, updated_at)
				 VALUES (?, ?, 'stock', 'delivered', ?, 1, ?, 1, 1)`,
			)
			.bind(
				`${input.id}-delivery`,
				`${input.id}-item`,
				await encryptDeliveryContent(input.content, secret),
				input.deliveredAt ?? deliveredAt,
			),
	]);
}
