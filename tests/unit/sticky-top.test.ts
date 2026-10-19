import { describe, expect, it } from "vitest";
import { stickyTop } from "#/features/storefront/sticky-top";

describe("stickyTop", () => {
	it("pins a column that fits below the header", () => {
		expect(stickyTop(600, 900, 104)).toBe(104);
	});

	it("lets a taller column scroll until its bottom is in view", () => {
		expect(stickyTop(1500, 900, 104)).toBe(900 - 1500 - 16);
	});
});
