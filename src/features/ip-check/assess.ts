import { canonicalIp } from "./address";
import { type IpCheck, supportedCountries } from "./check";
import type { Environment, EnvironmentFinding } from "./environment";
import { type DnsExit, isChinaGeo } from "./exits";

// Pure verdict logic for the seven check cards. Labels are message keys so the
// page stays the only place that knows about copy.

export type Level = "good" | "warn" | "bad" | "unknown";
export type CardId =
	| "region"
	| "timezone"
	| "language"
	| "network"
	| "dns"
	| "webrtc"
	| "environment";
export type Card = {
	id: CardId;
	level: Level;
	// Short status word key, e.g. "match", "near", "leak".
	status: string;
	// Machine-readable current value; page formats it.
	current: string | null;
	// Advice key.
	advice: string;
};

// Primary languages people expect for a few common exit countries. Countries
// outside this table only get an exact region-subtag comparison.
const countryLanguages: Record<string, string[]> = {
	US: ["en"],
	GB: ["en"],
	CA: ["en", "fr"],
	AU: ["en"],
	NZ: ["en"],
	IE: ["en"],
	SG: ["en", "zh"],
	JP: ["ja"],
	KR: ["ko"],
	TW: ["zh"],
	HK: ["zh", "en"],
	DE: ["de"],
	FR: ["fr"],
	NL: ["nl", "en"],
	ES: ["es"],
	IT: ["it"],
	BR: ["pt"],
	MX: ["es"],
	IN: ["en", "hi"],
	MY: ["ms", "en", "zh"],
	TH: ["th"],
	VN: ["vi"],
	PH: ["en"],
	ID: ["id"],
	TR: ["tr"],
	AE: ["ar", "en"],
};

function languageMatches(tag: string, country: string) {
	const [primary = "", ...rest] = tag.toLowerCase().split("-");
	if (rest.some((part) => part.toUpperCase() === country)) return true;
	return countryLanguages[country]?.includes(primary) ?? false;
}

export type AssessInput = {
	claudeCountry: string | null;
	browserTimezone: string | null;
	languages: string[];
	lookup: IpCheck | null;
	dns: DnsExit | null | "error";
	webrtc: string[] | "disabled" | null;
	knownExits: string[];
	chinaIp: string | null;
	environment: Environment | null;
	findings: EnvironmentFinding[];
};

export function regionCard(country: string | null): Card {
	if (!country || ["XX", "T1"].includes(country))
		return {
			id: "region",
			level: "unknown",
			status: "unknown",
			current: null,
			advice: "region_unknown",
		};
	if (country === "UA")
		return {
			id: "region",
			level: "warn",
			status: "review",
			current: country,
			advice: "region_review",
		};
	return supportedCountries.has(country)
		? {
				id: "region",
				level: "good",
				status: "available",
				current: country,
				advice: "region_keep",
			}
		: {
				id: "region",
				level: "bad",
				status: "unavailable",
				current: country,
				advice: "region_change",
			};
}

export function timezoneCard(
	browser: string | null,
	network: string | null,
): Card {
	if (!browser || !network)
		return {
			id: "timezone",
			level: "unknown",
			status: "unknown",
			current: browser,
			advice: "timezone_unknown",
		};
	if (browser === network)
		return {
			id: "timezone",
			level: "good",
			status: "match",
			current: browser,
			advice: "timezone_keep",
		};
	// Same continent block (e.g. America/New_York vs America/Chicago) is a
	// common, harmless split inside one country.
	const near = browser.split("/")[0] === network.split("/")[0];
	return {
		id: "timezone",
		level: near ? "good" : "warn",
		status: near ? "near" : "mismatch",
		current: browser,
		advice: near ? "timezone_keep" : "timezone_change",
	};
}

export function languageCard(
	languages: string[],
	country: string | null,
): Card {
	const current = languages.slice(0, 3).join(", ") || null;
	if (!country || !languages.length)
		return {
			id: "language",
			level: "unknown",
			status: "unknown",
			current,
			advice: "language_unknown",
		};
	if (languageMatches(languages[0] ?? "", country))
		return {
			id: "language",
			level: "good",
			status: "match",
			current,
			advice: "language_keep",
		};
	const partial = languages.some((tag) => languageMatches(tag, country));
	return {
		id: "language",
		level: "warn",
		status: partial ? "partial" : "mismatch",
		current,
		advice: "language_change",
	};
}

export function networkCard(lookup: IpCheck | null): Card {
	if (!lookup || lookup.mode !== "intelligence")
		return {
			id: "network",
			level: "unknown",
			status: "unknown",
			current: null,
			advice: "network_unknown",
		};
	const { flags } = lookup;
	if (flags.tor || flags.vpn || flags.proxy || (lookup.risk ?? 0) >= 70)
		return {
			id: "network",
			level: "bad",
			status: "risky",
			current: lookup.type,
			advice: "network_change",
		};
	if (flags.datacenter)
		return {
			id: "network",
			level: "warn",
			status: "hosting",
			current: lookup.type,
			advice: "network_change",
		};
	return {
		id: "network",
		level: "good",
		status: "clean",
		current: lookup.type,
		advice: "network_keep",
	};
}

export function dnsCard(
	dns: DnsExit | null | "error",
	claudeCountry: string | null,
): Card {
	if (dns === null || dns === "error")
		return {
			id: "dns",
			level: "unknown",
			status: "unknown",
			current: null,
			advice: "dns_unknown",
		};
	const exitInChina = ["CN", "HK", "MO"].includes(claudeCountry ?? "");
	if (!exitInChina && isChinaGeo(dns.resolverGeo))
		return {
			id: "dns",
			level: "bad",
			status: "leak",
			current: dns.resolverGeo,
			advice: "dns_change",
		};
	if (!exitInChina && isChinaGeo(dns.subnetGeo))
		return {
			id: "dns",
			level: "warn",
			status: "subnet",
			current: dns.resolverGeo,
			advice: "dns_change",
		};
	return {
		id: "dns",
		level: "good",
		status: "normal",
		current: dns.resolverGeo,
		advice: "dns_keep",
	};
}

export function webrtcCard(
	found: string[] | "disabled" | null,
	knownExits: string[],
	chinaIp: string | null,
): Card {
	if (found === "disabled")
		return {
			id: "webrtc",
			level: "good",
			status: "disabled",
			current: null,
			advice: "webrtc_disabled",
		};
	if (found === null)
		return {
			id: "webrtc",
			level: "unknown",
			status: "untested",
			current: null,
			advice: "webrtc_start",
		};
	const ips = found.map(canonicalIp);
	if (chinaIp && ips.includes(canonicalIp(chinaIp)))
		return {
			id: "webrtc",
			level: "bad",
			status: "leak",
			current: String(ips.length),
			advice: "webrtc_change",
		};
	const known = new Set(knownExits.map(canonicalIp));
	if (ips.some((ip) => !known.has(ip)))
		return {
			id: "webrtc",
			level: "warn",
			status: "extra",
			current: String(ips.length),
			advice: "webrtc_review",
		};
	return {
		id: "webrtc",
		level: "good",
		status: "normal",
		current: String(ips.length),
		advice: "webrtc_keep",
	};
}

export function environmentCard(
	env: Environment | null,
	findings: EnvironmentFinding[],
): Card {
	if (!env)
		return {
			id: "environment",
			level: "unknown",
			status: "unknown",
			current: null,
			advice: "env_unknown",
		};
	const current = `${env.os} · ${env.browser}`;
	if (findings.includes("automation"))
		return {
			id: "environment",
			level: "bad",
			status: "automation",
			current,
			advice: "env_automation",
		};
	if (findings.includes("virtual"))
		return {
			id: "environment",
			level: "warn",
			status: "virtual",
			current,
			advice: "env_virtual",
		};
	if (findings.includes("mismatch"))
		return {
			id: "environment",
			level: "warn",
			status: "mismatch",
			current,
			advice: "env_mismatch",
		};
	return {
		id: "environment",
		level: "good",
		status: "normal",
		current,
		advice: "env_keep",
	};
}

export function buildCards(input: AssessInput): Card[] {
	return [
		regionCard(input.claudeCountry),
		timezoneCard(input.browserTimezone, input.lookup?.networkTimezone ?? null),
		languageCard(input.languages, input.claudeCountry),
		networkCard(input.lookup),
		dnsCard(input.dns, input.claudeCountry),
		webrtcCard(input.webrtc, input.knownExits, input.chinaIp),
		environmentCard(input.environment, input.findings),
	];
}

export type Verdict = "good" | "warn" | "bad" | "unknown";
// No Claude exit means we cannot say anything about Claude; never guess.
export function overallVerdict(
	claudeIp: string | null,
	cards: Card[],
): Verdict {
	if (!claudeIp) return "unknown";
	if (cards.some((card) => card.level === "bad")) return "bad";
	if (cards.find((card) => card.id === "region")?.level === "unknown")
		return "unknown";
	if (cards.some((card) => card.level === "warn")) return "warn";
	if (cards.find((card) => card.id === "network")?.level === "unknown")
		return "warn";
	return "good";
}
