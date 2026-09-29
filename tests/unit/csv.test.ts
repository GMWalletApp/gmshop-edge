import { describe, expect, it } from "vitest";
import { csvCell } from "#/lib/csv";

describe("spreadsheet-safe CSV cells", () => {
	it.each(["=1+1", "+cmd", "-2+3", "@SUM(A1:A2)", "  =HYPERLINK(x)"])(
		"neutralizes formula input %s",
		(value) => {
			expect(csvCell(value)).toBe(`"'${value}"`);
		},
	);

	it.each(["\tformula", "\rformula", "\nformula"])(
		"neutralizes control-prefixed input",
		(value) => {
			expect(csvCell(value)).toBe(`"'${value}"`);
		},
	);

	it("preserves normal Unicode text and CSV quoting", () => {
		expect(csvCell('  商品 "高级版"')).toBe('"  商品 ""高级版"""');
	});
});
