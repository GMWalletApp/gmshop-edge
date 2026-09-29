import { m } from "#/paraglide/messages";

const labels: Record<string, () => string> = {
	acg: m.supplier_provider_acg,
	dujiao_next: m.supplier_provider_dujiao_next,
	gmshop_edge: m.supplier_provider_gmshop_edge,
};

export function supplierProviderLabel(provider: string) {
	return labels[provider]?.() ?? provider;
}
