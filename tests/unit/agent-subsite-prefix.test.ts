import { expect, it } from "vitest";
import {
	normalizeSubsitePrefix,
	subsiteDomain,
	subsitePrefixProblem,
} from "#/features/agent-access/subsite-prefix";

it("accepts readable prefixes and mirrors lsrai.shop rules", () => {
	for (const label of [
		"mystore",
		"abc",
		"a1-b2",
		"store-2026",
		"abcdefghijklmnopqrst",
	])
		expect(subsitePrefixProblem(label), label).toBeNull();
	for (const label of [
		"",
		"ab",
		"abcdefghijklmnopqrstu",
		"1store",
		"-store",
		"store-",
		"my--store",
		"My-Store",
		"my_store",
		"my.store",
		"商店",
	])
		expect(subsitePrefixProblem(label), label).toBe("invalid");
	for (const label of [
		"www",
		"api",
		"redeem",
		"shop",
		"ns1",
		"lsrai",
		"laoshirenvip",
		"laoshiren-ai",
		"shopf3bcc0658fc2",
	])
		expect(subsitePrefixProblem(label), label).toBe("reserved");
	expect(normalizeSubsitePrefix("  MyStore ")).toBe("mystore");
	expect(subsiteDomain("mystore")).toBe("mystore.lsrai.shop");
});
