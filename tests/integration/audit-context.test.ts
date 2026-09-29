import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuditStatement } from "#/server/audit";
import { applyMigrations } from "./migrations";

describe("administrative audit context", () => {
	let miniflare: Miniflare;
	let database: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmshop-edge-admin-audit" },
		});
		database = await miniflare.getD1Database("DB");
		await applyMigrations(database);
		const now = Date.now();
		await database
			.prepare(
				"INSERT INTO users (id, name, email, email_verified, enabled, created_at, updated_at) VALUES ('actor', 'Actor', 'actor@example.com', 1, 1, ?, ?)",
			)
			.bind(now, now)
			.run();
	});

	afterAll(async () => miniflare.dispose());

	it("persists actor, request and sanitized change metadata", async () => {
		const request = new Request("https://pay.example/admin/users", {
			headers: {
				"x-request-id": "request-user-update",
				"x-gmshop-client-ip": "203.0.113.10",
			},
		});
		await createAuditStatement(database, request, "actor", {
			action: "user.updated",
			targetType: "user",
			targetId: "target",
			after: { enabled: true, passwordChanged: true },
		}).run();
		const row = await database
			.prepare(
				"SELECT actor_user_id, action, target_type, target_id, request_id, ip_address, after FROM audit_logs LIMIT 1",
			)
			.first<Record<string, string>>();
		expect(row).toMatchObject({
			actor_user_id: "actor",
			action: "user.updated",
			target_type: "user",
			target_id: "target",
			request_id: "request-user-update",
			ip_address: "203.0.113.10",
		});
		expect(JSON.parse(row?.after ?? "{}")).toEqual({
			enabled: true,
			passwordChanged: true,
		});
		expect(row?.after).not.toContain("secret-password-value");
		expect(row?.after).not.toContain("hash");
	});
});
