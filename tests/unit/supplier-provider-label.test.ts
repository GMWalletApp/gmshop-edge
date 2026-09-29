import { describe, expect, it } from "vitest";
import { supplierProviderLabel } from "#/features/suppliers/provider-label";
import { supplierProviderSchema } from "#/features/suppliers/schema";
import { m } from "#/paraglide/messages";

describe("supplier provider labels", () => {
	it("localizes every supported provider and falls back to the raw id", () => {
		for (const provider of supplierProviderSchema.options)
			expect(supplierProviderLabel(provider)).not.toBe(provider);
		expect(supplierProviderLabel("acg")).toBe(m.supplier_provider_acg());
		expect(supplierProviderLabel("dujiao_next")).toBe(
			m.supplier_provider_dujiao_next(),
		);
		expect(supplierProviderLabel("gmshop_edge")).toBe(
			m.supplier_provider_gmshop_edge(),
		);
		expect(supplierProviderLabel("unknown_provider")).toBe("unknown_provider");
	});
});
