import { describe, expect, it } from "vitest";
import { groupPlans } from "#/features/storefront/pages/product";

const item = (name: string) => ({ id: name, name }) as never;

describe("groupPlans", () => {
	it("groups channels under their plan and drops the shared brand word", () => {
		const groups = groupPlans([
			item("ChatGPT Go｜1个月"),
			item("ChatGPT Plus｜菲区｜1个月"),
			item("ChatGPT Plus｜iOS｜1个月"),
			item("ChatGPT Pro 200｜菲区续费｜1个月"),
			item("ChatGPT Business｜2 个标准席位｜1个月"),
		]);
		expect(
			groups?.map((group) => [group.label, group.options.map((o) => o.label)]),
		).toEqual([
			["Go", ["1个月"]],
			["Plus", ["菲区", "iOS"]],
			["Pro 200", ["菲区续费"]],
			["Business", ["2 个标准席位"]],
		]);
	});

	it("keeps the flat grid when nothing would merge", () => {
		expect(
			groupPlans([item("Claude 算力卡｜¥50"), item("Claude 算力卡 Max｜¥100")]),
		).toBeNull();
	});
});
