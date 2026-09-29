import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadSiteBrand } from "#/features/settings/server/site-brand";
import {
	listSystemSettings,
	saveSystemSettings,
} from "#/features/settings/server/system-settings";
import { loadOperationalSettings } from "#/server/operational-settings";
import { applyMigrations } from "./migrations";

describe("commerce system settings persistence", () => {
	let miniflare: Miniflare;
	let db: D1Database;
	let cache: KVNamespace;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmshop-edge-system-settings-save" },
			kvNamespaces: ["CACHE"],
		});
		db = await miniflare.getD1Database("DB");
		cache = (await miniflare.getKVNamespace("CACHE")) as unknown as KVNamespace;
		await applyMigrations(db);
		await db
			.prepare(
				"INSERT OR IGNORE INTO users (id, name, email, email_verified, enabled) VALUES ('root-user', 'Root', 'settings-root@example.com', 1, 1)",
			)
			.run();
	});

	beforeEach(async () => {
		await db.batch([
			db.prepare("DELETE FROM system_settings"),
			db.prepare(
				"DELETE FROM audit_logs WHERE action = 'system_settings.updated'",
			),
		]);
		await cache.delete("site-brand:v1");
	});

	afterAll(async () => miniflare.dispose());

	it("only lets the initialized data encryption keyring change through rotation", async () => {
		const keyring = "k".repeat(32);
		await saveSystemSettings(
			[{ key: "runtime.data_encryption_secret", value: keyring }],
			{ db, cache, userId: "root-user" },
		);
		await expect(
			saveSystemSettings(
				[{ key: "runtime.data_encryption_secret", value: "r".repeat(32) }],
				{ db, cache, userId: "root-user" },
			),
		).rejects.toMatchObject({ code: "settings_keyring_rotate_only" });
		await expect(
			saveSystemSettings(
				[{ key: "runtime.data_encryption_secret", value: "r".repeat(32) }],
				{ db, cache, userId: "root-user", allowKeyringReplacement: true },
			),
		).resolves.toMatchObject({ updated: ["runtime.data_encryption_secret"] });
		const listed = await listSystemSettings(db);
		const secret = listed.find(
			(item) => item.key === "runtime.data_encryption_secret",
		);
		expect(secret).toMatchObject({ value: "", configured: true });
		await expect(
			saveSystemSettings([{ key: "security.allowed_hosts", value: [] }], {
				db,
				cache,
				userId: "root-user",
			}),
		).rejects.toThrow();
		await expect(
			saveSystemSettings(
				[{ key: "security.client_ip_source", value: "x-real-ip" }],
				{ db, cache, userId: "root-user" },
			),
		).resolves.toMatchObject({ updated: ["security.client_ip_source"] });
	});

	it("persists commerce operations settings with bounded validation", async () => {
		await saveSystemSettings(
			[
				{ key: "orders.default_expiry_ms", value: 1_800_000 },
				{ key: "orders.allow_guest_checkout", value: false },
				{ key: "queue.publish_batch_size", value: 50 },
				{ key: "retention.audit_ms", value: 5_184_000_000 },
			],
			dependencies(),
		);

		const values = new Map(
			(await listSystemSettings(db)).map((item) => [item.key, item.value]),
		);
		expect(values.get("orders.default_expiry_ms")).toBe(1_800_000);
		expect(values.get("orders.allow_guest_checkout")).toBe(false);
		await expect(loadOperationalSettings(db)).resolves.toEqual({
			retentionAuditMs: 5_184_000_000,
		});
		await expect(
			saveSystemSettings(
				[{ key: "queue.publish_batch_size", value: 101 }],
				dependencies(),
			),
		).rejects.toBeInstanceOf(Error);
	});

	it("invalidates only the public brand cache for public settings", async () => {
		await loadSiteBrand(db, cache);
		await saveSystemSettings(
			[
				{ key: "site.name", value: "Updated Shop" },
				{
					key: "site.custom_html",
					value: '<script src="https://chat.example/widget.js"></script>',
				},
				{ key: "site.default_locale", value: "zh-CN" },
			],
			dependencies(),
		);
		expect(await cache.get("site-brand:v1")).toBeNull();
		await expect(loadSiteBrand(db, cache)).resolves.toMatchObject({
			name: "Updated Shop",
			customHtml: '<script src="https://chat.example/widget.js"></script>',
			defaultLocale: "zh-CN",
		});
		await expect(
			saveSystemSettings(
				[{ key: "site.custom_html", value: "x".repeat(100_001) }],
				dependencies(),
			),
		).rejects.toBeInstanceOf(Error);
	});

	it("preserves configured secrets and rejects unknown keys", async () => {
		await db
			.prepare(
				`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
				 VALUES ('runtime.data_encryption_secret', '"configured-secret"', 1, 0, 0)`,
			)
			.run();
		await expect(
			saveSystemSettings(
				[{ key: "runtime.data_encryption_secret", value: "" }],
				dependencies(),
			),
		).resolves.toEqual({ updated: [] });
		await expect(listSystemSettings(db)).resolves.toContainEqual(
			expect.objectContaining({
				key: "runtime.data_encryption_secret",
				value: "",
				configured: true,
			}),
		);
		await expect(
			saveSystemSettings([{ key: "unknown", value: true }], dependencies()),
		).rejects.toMatchObject({ code: "invalid_settings", status: 400 });
	});

	function dependencies() {
		return {
			db,
			cache,
			userId: "root-user",
			requestId: "request-settings",
			ipAddress: "192.0.2.2",
		};
	}
});
