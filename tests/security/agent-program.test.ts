import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { systemPermission } from "#/features/access/system-rbac";
import {
	amountMinor,
	canManageAgentProgram,
	feeInputSchema,
	monthQuerySchema,
} from "#/features/agent-program/schema";
import { requestProgram } from "#/features/agent-program/server/client";

const mocks = vi.hoisted(() => ({
	requireAdmin: vi.fn(),
	getRequest: vi.fn(),
	setResponseHeader: vi.fn(),
	env: { AGENT_SHOP_PROGRAM_TOKEN: "synthetic-test-token" },
}));
vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => {
		let validate: ((input: unknown) => unknown) | undefined;
		const builder = {
			validator: (fn: (input: unknown) => unknown) => {
				validate = fn;
				return builder;
			},
			handler:
				(fn: (input: { data: unknown }) => unknown) =>
				(input?: { data: unknown }) =>
					fn({ data: validate ? validate(input?.data) : input?.data }),
		};
		return builder;
	},
}));
vi.mock("@tanstack/react-start/server", () => ({
	getRequest: mocks.getRequest,
	setResponseHeader: mocks.setResponseHeader,
}));
vi.mock("#/features/access/server/require-admin", () => ({
	requireAdmin: mocks.requireAdmin,
}));
vi.mock("#/server/db.server", () => ({ getCloudflareEnv: () => mocks.env }));

import {
	getWithdrawalsFn,
	listAgentsFn,
	markWithdrawalPaidFn,
	reviewLeaderboardFn,
	updateOpeningFeeFn,
} from "#/features/agent-program/server/admin";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getRequest.mockReturnValue(
		new Request("https://laoshirenvip.com/_serverFn/test", {
			headers: { origin: "https://laoshirenvip.com" },
		}),
	);
	mocks.requireAdmin.mockResolvedValue({
		id: "owner-id",
		root: true,
		roles: ["root"],
	});
});
afterEach(() => vi.unstubAllGlobals());

describe("agent program access and transport", () => {
	it.each([
		undefined,
		"",
		"   ",
	])("fails closed for a missing token", async (token) => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		await expect(
			requestProgram(token, "rules", z.unknown()),
		).rejects.toMatchObject({ code: "agent_program_unconfigured" });
		expect(fetch).not.toHaveBeenCalled();
	});
	it("keeps the secret in a server-side header, never browser credentials or return values", async () => {
		const fetch = vi.fn(async () =>
			Response.json({
				status_code: 0,
				data: { ok: true, secret: "synthetic-test-token" },
			}),
		);
		vi.stubGlobal("fetch", fetch);
		const result = await requestProgram(
			"synthetic-test-token",
			"rules",
			z.object({ ok: z.boolean() }),
		);
		expect(result).toEqual({ ok: true });
		expect(fetch).toHaveBeenCalledWith(
			"https://lsrai.shop/api/internal/reseller-program/rules",
			expect.objectContaining({
				credentials: "omit",
				redirect: "manual",
				headers: {
					authorization: "Bearer synthetic-test-token",
					"content-type": "application/json",
				},
			}),
		);
	});

	it.each([
		301, 302, 303, 307, 308, 400, 500,
	])("rejects upstream status %s without following redirects", async (status) => {
		const fetch = vi.fn(
			async () =>
				new Response(null, {
					status,
					headers: { location: "https://other.test" },
				}),
		);
		vi.stubGlobal("fetch", fetch);
		await expect(
			requestProgram("synthetic-test-token", "rules", z.unknown()),
		).rejects.toMatchObject({ code: "agent_program_unavailable" });
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ redirect: "manual" }),
		);
	});
	it.each([
		"http",
		"envelope",
		"schema",
		"network",
	])("never reflects upstream errors or secrets: %s", async (failure) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				if (failure === "network") throw new Error("synthetic-test-token");
				return Response.json(
					{
						status_code: failure === "envelope" ? 1 : 0,
						msg: "synthetic-test-token",
						data: { ok: "synthetic-test-token" },
					},
					{ status: failure === "http" ? 401 : 200 },
				);
			}),
		);
		await expect(
			requestProgram(
				"synthetic-test-token",
				"rules",
				z.object({ ok: z.boolean() }),
			),
		).rejects.toMatchObject({
			code: "agent_program_unavailable",
			message: "Agent program request failed",
		});
	});
	it("allows root or admin, not other named or custom roles", () => {
		expect(canManageAgentProgram({ root: true, roles: ["root"] })).toBe(true);
		expect(canManageAgentProgram({ root: false, roles: ["admin"] })).toBe(true);
		expect(
			canManageAgentProgram({ root: false, roles: ["operator", "customer"] }),
		).toBe(false);
	});
	it("checks the authenticated permission and named role before any upstream call", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		mocks.requireAdmin.mockResolvedValue({
			id: "restricted",
			root: false,
			roles: ["support"],
		});
		await expect(getWithdrawalsFn()).rejects.toMatchObject({ status: 403 });
		expect(mocks.requireAdmin).toHaveBeenCalledWith(
			expect.any(Request),
			systemPermission("operations", "read"),
		);
		expect(fetch).not.toHaveBeenCalled();
	});
	it("propagates disabled or unauthenticated session denial without sending", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		mocks.requireAdmin.mockRejectedValue({ status: 401 });
		await expect(listAgentsFn({ data: {} })).rejects.toMatchObject({
			status: 401,
		});
		expect(fetch).not.toHaveBeenCalled();
	});
	it("fails closed for cross-origin mutations", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		mocks.getRequest.mockReturnValue(
			new Request("https://laoshirenvip.com/_serverFn/test", {
				headers: { origin: "https://attacker.test" },
			}),
		);
		await expect(
			updateOpeningFeeFn({
				data: { id: 33, amount: "199.00", source: "manual", reason: "review" },
			}),
		).rejects.toMatchObject({ status: 403 });
		expect(fetch).not.toHaveBeenCalled();
	});
	it("derives the audited operator from the session, ignoring forged input", async () => {
		const fetch = vi.fn(async () =>
			Response.json({
				status_code: 0,
				data: { opening_fee_paid: "99.00", opening_fee_source: "manual" },
			}),
		);
		vi.stubGlobal("fetch", fetch);
		await updateOpeningFeeFn({
			data: {
				id: 33,
				amount: "99.00",
				source: "manual",
				reason: "owner reviewed",
				operator: "forged",
			} as never,
		});
		expect(mocks.requireAdmin).toHaveBeenCalledWith(
			expect.any(Request),
			systemPermission("operations", "update"),
		);
		const init = (
			fetch.mock.calls as unknown as Array<[string, RequestInit]>
		)[0]?.[1];
		expect(JSON.parse(String(init?.body))).toEqual({
			amount: "99.00",
			source: "manual",
			reason: "owner reviewed",
			operator: "gmshop:owner-id",
		});
		expect(mocks.setResponseHeader).toHaveBeenCalledWith(
			"Cache-Control",
			"no-store",
		);
	});
	it("reviews rewards and records payouts with the same authenticated operator", async () => {
		const fetch = vi.fn(async () =>
			Response.json({ status_code: 0, data: { id: 7, status: "approved" } }),
		);
		vi.stubGlobal("fetch", fetch);
		await reviewLeaderboardFn({
			data: { id: 7, action: "reject", reason: "refund review" },
		});
		expect(fetch).toHaveBeenLastCalledWith(
			"https://lsrai.shop/api/internal/reseller-program/leaderboard/7/reject",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					operator: "gmshop:owner-id",
					reason: "refund review",
				}),
			}),
		);
		await markWithdrawalPaidFn({
			data: { id: 7, alipay_trade_no: "20261018001" },
		});
		expect(fetch).toHaveBeenLastCalledWith(
			"https://lsrai.shop/api/internal/reseller-program/withdrawals/7/mark-paid",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					alipay_trade_no: "20261018001",
					operator: "gmshop:owner-id",
				}),
			}),
		);
	});
	it("validates input without float conversion", () => {
		expect(amountMinor("9900000000.01")).toBe(990000000001n);
		expect(amountMinor("0.01")).toBe(1n);
		expect(amountMinor("-49.09")).toBe(-4909n);
		expect(() => amountMinor("0.001")).toThrow();
		expect(
			feeInputSchema.safeParse({
				id: 33,
				amount: "99.001",
				source: "manual",
				reason: "review",
			}).success,
		).toBe(false);
		expect(monthQuerySchema.safeParse({ month: "2026-13" }).success).toBe(
			false,
		);
	});
	it("keeps the bearer binding and transport out of feature browser source", async () => {
		for (const path of [
			"page.tsx",
			"views.tsx",
			"presentation.tsx",
			"schema.ts",
		]) {
			const text = await readFile(`src/features/agent-program/${path}`, "utf8");
			expect(text).not.toContain("AGENT_SHOP_PROGRAM_TOKEN");
			expect(text).not.toContain("requestProgram");
		}
	});
});
