import { DomainError } from "#/lib/domain-error";
import {
	assertPublicHostname,
	type DnsResolver,
} from "#/server/outbound-fetch";

/**
 * Supplier endpoints share the hardened outbound resolver; only the error
 * codes stay supplier-specific for the callers that map them.
 */
export async function assertPublicSupplierHostname(
	hostname: string,
	resolve?: DnsResolver,
) {
	try {
		await assertPublicHostname(hostname, resolve);
	} catch (error) {
		if (
			error instanceof DomainError &&
			error.code === "outbound_dns_unavailable"
		)
			throw new DomainError(
				"supplier_dns_unavailable",
				503,
				"Supplier hostname could not be resolved safely",
			);
		if (
			error instanceof DomainError &&
			error.code === "outbound_destination_rejected"
		)
			throw new DomainError(
				"supplier_destination_rejected",
				400,
				"Supplier hostname must resolve only to public addresses",
			);
		throw error;
	}
}
