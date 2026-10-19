import { describe, expect, it } from "vitest";
import { assertGrantsWithinActor } from "#/features/access/permissions";

const operator = {
	root: false,
	permissions: [
		{ module: "users", permissionMask: 1 | 4 },
		{ module: "orders", permissionMask: 1 },
	],
};

describe("RBAC grant ceiling", () => {
	it("allows grants that stay within the operator's own permissions", () => {
		expect(() =>
			assertGrantsWithinActor(operator, [
				{ module: "users", permissionMask: 4 },
				{ module: "users", permissionMask: 1 },
				{ module: "orders", permissionMask: 1 },
			]),
		).not.toThrow();
		expect(() => assertGrantsWithinActor(operator, [])).not.toThrow();
	});

	it("rejects an extra action or module the operator does not hold", () => {
		for (const grant of [
			{ module: "users", permissionMask: 8 },
			{ module: "orders", permissionMask: 1 | 4 },
			{ module: "roles", permissionMask: 1 },
		])
			expect(() => assertGrantsWithinActor(operator, [grant])).toThrow(
				expect.objectContaining({ code: "permission_escalation", status: 403 }),
			);
	});

	it("does not restrict root", () => {
		expect(() =>
			assertGrantsWithinActor({ root: true, permissions: [] }, [
				{ module: "roles", permissionMask: 31 },
			]),
		).not.toThrow();
	});
});
