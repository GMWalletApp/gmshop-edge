import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withPasswordFailureBudget } from "#/features/auth/server/reauthenticate";
import { applyMigrations } from "./migrations";

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("#/features/auth/server/auth", () => ({ getAuth: vi.fn() }));

describe("sensitive action reauthentication budget", {
	timeout: 30_000,
}, () => {
	let runtime: Miniflare;
	let db: D1Database;
	beforeAll(async () => {
		runtime = new Miniflare({
			modules: true,
			script: "export default {fetch(){return new Response('ok')}}",
			d1Databases: { DB: crypto.randomUUID() },
		});
		db = await runtime.getD1Database("DB");
		await applyMigrations(db);
	});
	afterAll(async () => runtime.dispose());
	const request = (ip: string) =>
		new Request("https://shop.example.com/_serverFn/x", {
			headers: { "cf-connecting-ip": ip },
		});

	it("never throttles successful verification", async () => {
		for (let i = 0; i < 12; i++)
			await expect(
				withPasswordFailureBudget(
					db,
					request("198.51.100.1"),
					"admin-ok",
					async () => true,
				),
			).resolves.toBeUndefined();
	});

	it("locks a user and IP after five wrong passwords, even for the right one", async () => {
		for (let i = 0; i < 5; i++)
			await expect(
				withPasswordFailureBudget(
					db,
					request("198.51.100.2"),
					"admin-guess",
					async () => false,
				),
			).rejects.toMatchObject({ code: "reauthentication_failed" });
		const verify = vi.fn(async () => true);
		await expect(
			withPasswordFailureBudget(
				db,
				request("198.51.100.2"),
				"admin-guess",
				verify,
			),
		).rejects.toMatchObject({
			code: "reauthentication_rate_limited",
			status: 429,
		});
		expect(verify).not.toHaveBeenCalled();
		await expect(
			withPasswordFailureBudget(
				db,
				request("198.51.100.3"),
				"admin-guess",
				async () => true,
			),
		).resolves.toBeUndefined();
	});
});
