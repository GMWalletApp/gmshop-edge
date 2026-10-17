import { beforeEach, describe, expect, it, vi } from "vitest";
import { publishAuthSecurityAlert } from "#/features/auth/server/security-alerts";
import {
	ownerAlertConfigured,
	sendOwnerAlert,
} from "#/features/telegram/server/owner-alerts";

vi.mock("#/features/telegram/server/owner-alerts", () => ({
	ownerAlertConfigured: vi.fn(async () => true),
	sendOwnerAlert: vi.fn(async () => ({ channel: "telegram" })),
}));
vi.mock("#/server/rate-limit", () => ({
	claimFixedWindowRateLimit: vi.fn(async () => ({ allowed: true })),
}));

function database(action: string, enabled = true) {
	return {
		prepare: vi.fn((sql: string) => {
			const statement = {
				bind: (..._args: unknown[]) => statement,
				first: async () => ({ value: String(enabled) }),
				all: async () => ({
					results: sql.includes(`'${action}'`) ? [{ action, count: 10 }] : [],
				}),
				run: async () => ({}),
			};
			return statement;
		}),
	} as unknown as D1Database;
}

describe("independent authentication security alerts", () => {
	beforeEach(() => vi.clearAllMocks());
	it.each([
		"auth.email_otp_sign_in_failed",
		"auth.telegram_oidc_failed",
	])("alerts for aggregated %s without the support alert switch", async (action) => {
		const db = database(action);
		expect(await publishAuthSecurityAlert(db, 900000)).toEqual({
			status: "sent",
		});
		expect(ownerAlertConfigured).toHaveBeenCalledWith(db);
		expect(sendOwnerAlert).toHaveBeenCalledTimes(1);
		expect(vi.mocked(sendOwnerAlert).mock.calls[0]?.[1]).toContain(
			"认证失败：10",
		);
	});
	it("still requires the security alert switch", async () => {
		expect(
			await publishAuthSecurityAlert(
				database("auth.email_otp_sign_in_failed", false),
				900000,
			),
		).toEqual({ status: "disabled" });
		expect(ownerAlertConfigured).not.toHaveBeenCalled();
		expect(sendOwnerAlert).not.toHaveBeenCalled();
	});
});
