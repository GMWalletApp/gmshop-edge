import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));

import { handleRedeemRestockRequest } from "#/features/redeem-warehouse/server/restock-api";
import type { CloudflareBindings } from "#/server/runtime/cloudflare";
import { applyMigrations } from "./migrations";

const TOKEN = "redeem-restock-api-test-token-0123456789";

describe("redeem restock ops API", { timeout: 30_000 }, () => {
	let miniflare: Miniflare;
	let env: CloudflareBindings;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmshop-redeem-restock-api" },
		});
		const db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await db
			.prepare(
				`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
				 VALUES ('runtime.data_encryption_secret', ?, 1, 1, 1)`,
			)
			.bind(JSON.stringify("redeem-restock-api-data-secret-0123456789"))
			.run();
		env = { DB: db, RESTOCK_API_TOKEN: TOKEN } as unknown as CloudflareBindings;
	});

	afterAll(async () => miniflare.dispose());

	const body = {
		requestRef: "restock_api_test_0001",
		sku: "GPT_20X_IOS",
		componentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
		unitCostYuan: "1600",
		content: "KEY-1\nKEY-2",
	};

	function post(payload: unknown, token = TOKEN) {
		return new Request("https://shop.example/api/ops/redeem-restock", {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(payload),
		});
	}

	it("rejects a wrong token before doing any work", async () => {
		const restock = vi.fn();
		const response = await handleRedeemRestockRequest(
			post(body, "wrong-token"),
			env,
			restock,
		);
		expect(response.status).toBe(401);
		expect(restock).not.toHaveBeenCalled();
	});

	it("rejects invalid input", async () => {
		const restock = vi.fn();
		const response = await handleRedeemRestockRequest(
			post({ ...body, componentId: "not-a-uuid" }),
			env,
			restock,
		);
		expect(response.status).toBe(400);
		expect(restock).not.toHaveBeenCalled();
	});

	it("runs the quick restock without an acting user and returns counts only", async () => {
		const restock = vi.fn(async () => ({
			total: 2,
			imported: 2,
			counts: { available: 2 },
			generated: 2,
			generationFailed: false,
		}));
		const response = await handleRedeemRestockRequest(post(body), env, restock);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			ok: true,
			total: 2,
			imported: 2,
			counts: { available: 2 },
			generated: 2,
			generationFailed: false,
		});
		expect(restock).toHaveBeenCalledWith(
			expect.objectContaining({ sku: "GPT_20X_IOS", content: "KEY-1\nKEY-2" }),
			expect.objectContaining({ currentUser: { id: null } }),
		);
	});

	it("only issues owned codes when no keys are supplied", async () => {
		const restock = vi.fn();
		const generate = vi.fn(async () => ({
			idempotent: false,
			imported: 3,
			count: 3,
		}));
		const { content: _content, unitCostYuan: _cost, ...generateBody } = body;
		const response = await handleRedeemRestockRequest(
			post({ ...generateBody, sku: "CODEX_250", count: 3 }),
			env,
			restock,
			generate,
		);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			ok: true,
			idempotent: false,
			imported: 3,
			count: 3,
		});
		expect(restock).not.toHaveBeenCalled();
		expect(generate).toHaveBeenCalledWith(
			expect.objectContaining({ sku: "CODEX_250", count: 3 }),
			expect.objectContaining({ currentUser: { id: null } }),
		);
	});
});
