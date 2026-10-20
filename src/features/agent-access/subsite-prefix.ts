// Mirrors agent-shop's SubdomainProblem so the buyer gets instant feedback.
// lsrai.shop stays authoritative for reserved names and availability.
export const subsiteDomainBase = "lsrai.shop";

export type SubsitePrefixState = "available" | "invalid" | "reserved" | "taken";

const reserved = new Set([
	"www",
	"api",
	"app",
	"admin",
	"shop",
	"redeem",
	"mail",
	"smtp",
	"imap",
	"pop",
	"pop3",
	"ftp",
	"docs",
	"static",
	"cdn",
	"assets",
	"pay",
	"payment",
	"payments",
	"support",
	"help",
	"status",
	"test",
	"dev",
	"staging",
	"prod",
	"lsrai",
	"ns1",
	"ns2",
	"dns",
	"mx",
	"webmail",
	"autodiscover",
	"autoconfig",
	"acceptance",
	"partner",
	"partners",
	"vip",
	"agent",
	"agents",
	"auth",
	"login",
	"account",
	"accounts",
	"console",
	"dashboard",
	"backend",
	"internal",
	"webhook",
	"webhooks",
	"blog",
	"gmshop",
	"gmpay",
	"official",
	"service",
	"billing",
	"invoice",
	"root",
	"system",
	"security",
]);

export function normalizeSubsitePrefix(raw: string) {
	return raw.trim().toLowerCase();
}

/** Returns null when the label may be requested, otherwise the local reason. */
export function subsitePrefixProblem(
	label: string,
): Exclude<SubsitePrefixState, "available" | "taken"> | null {
	if (!/^[a-z][a-z0-9-]{1,18}[a-z0-9]$/.test(label) || label.includes("--"))
		return "invalid";
	if (
		reserved.has(label) ||
		label.startsWith("laoshiren") ||
		/^shop[0-9a-f]{12}$/.test(label)
	)
		return "reserved";
	return null;
}

export function subsiteDomain(label: string) {
	return `${label}.${subsiteDomainBase}`;
}
