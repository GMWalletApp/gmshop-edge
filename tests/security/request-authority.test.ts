import { describe, expect, it, vi } from "vitest";
import {
	loadRequestAllowedHosts,
	validateRequestAuthority,
} from "#/server/middleware/authority";

function database(values: Record<string, string[] | string>) {
	return {
		prepare: vi.fn(() => ({
			bind: vi.fn(() => ({
				all: async () => ({
					results: Object.entries(values).map(([key, value]) => ({
						key,
						value: typeof value === "string" ? value : JSON.stringify(value),
					})),
				}),
			})),
		})),
	} as unknown as D1Database;
}

describe("request authority policy", () => {
	it("rejects hosts outside Security settings", async () => {
		const response = await validateRequestAuthority(
			new Request("https://unexpected.example/status"),
			database({ "security.allowed_hosts": ["pay.example"] }),
		);
		expect(response?.status).toBe(421);
	});

	it("permits configured custom hosts and trusted mutation origins", async () => {
		const db = database({
			"security.allowed_hosts": ["pay.example", "console.example"],
		});
		await expect(
			validateRequestAuthority(
				new Request("https://pay.example/api/action", {
					method: "POST",
					headers: { origin: "https://console.example" },
				}),
				db,
			),
		).resolves.toBeNull();
	});

	it("rejects untrusted cross-origin mutations but allows requests without Origin", async () => {
		const db = database({ "security.allowed_hosts": [] });
		const rejected = await validateRequestAuthority(
			new Request("https://pay.example/api/action", {
				method: "POST",
				headers: { origin: "https://evil.example" },
			}),
			db,
		);
		expect(rejected?.status).toBe(403);
		await expect(
			validateRequestAuthority(
				new Request("https://pay.example/api/action", { method: "POST" }),
				db,
			),
		).resolves.toBeNull();
	});

	it("deduplicates Allowed Hosts only within the same request", async () => {
		const db = database({ "security.allowed_hosts": ["pay.example"] });
		const request = new Request("https://pay.example/admin");
		await expect(validateRequestAuthority(request, db)).resolves.toBeNull();
		await expect(loadRequestAllowedHosts(request, db)).resolves.toEqual([
			"pay.example",
		]);
		expect(db.prepare).toHaveBeenCalledTimes(1);

		await expect(
			loadRequestAllowedHosts(new Request("https://pay.example/admin"), db),
		).resolves.toEqual(["pay.example"]);
		expect(db.prepare).toHaveBeenCalledTimes(2);
	});

	it("fails closed without a readable authority source", async () => {
		await expect(
			validateRequestAuthority(
				new Request("https://pay.example/admin"),
				undefined,
			),
		).resolves.toMatchObject({ status: 503 });

		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const db = {
			prepare: vi.fn(() => ({
				bind: vi.fn(() => ({
					all: async () => {
						throw new Error("D1_ERROR: SELECT secret");
					},
				})),
			})),
		} as unknown as D1Database;
		const response = await validateRequestAuthority(
			new Request("https://pay.example/admin"),
			db,
		);

		expect(response?.status).toBe(503);
		expect(await response?.text()).toBe("Service Unavailable");
		expect(error).toHaveBeenCalledWith(
			JSON.stringify({ event: "request_authority_unavailable" }),
		);
		expect(error.mock.calls.flat().join(" ")).not.toMatch(/SELECT|secret/);
		error.mockRestore();
	});

	it.each(["not-json", "{}", '["pay.example",1]', '["https://pay.example"]'])(
		"fails closed for corrupt Allowed Hosts data: %s",
		async (value) => {
			const error = vi.spyOn(console, "error").mockImplementation(() => {});
			const response = await validateRequestAuthority(
				new Request("https://pay.example/admin"),
				database({ "security.allowed_hosts": value }),
			);

			expect(response?.status).toBe(503);
			expect(await response?.text()).toBe("Service Unavailable");
			expect(error).toHaveBeenCalledWith(
				JSON.stringify({ event: "request_authority_unavailable" }),
			);
			expect(error.mock.calls.flat().join(" ")).not.toContain(value);
			error.mockRestore();
		},
	);
});
