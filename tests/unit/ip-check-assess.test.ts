import { expect, it } from "vitest";
import {
	buildCards,
	dnsCard,
	languageCard,
	networkCard,
	overallVerdict,
	regionCard,
	timezoneCard,
	webrtcCard,
} from "#/features/ip-check/assess";
import { ipCheckSchema } from "#/features/ip-check/check";
import {
	assessEnvironment,
	browserFromUserAgent,
	type Environment,
	fnv1a,
	osFromUserAgent,
} from "#/features/ip-check/environment";
import { isChinaGeo, parseTrace } from "#/features/ip-check/exits";

const lookup = (patch: Record<string, unknown> = {}) =>
	ipCheckSchema.parse({
		ip: "161.77.8.204",
		country: "US",
		city: "Springfield",
		asn: 7849,
		organization: "RingSquared",
		colo: null,
		region: "listed",
		hosting: "unknown",
		status: "clear",
		mode: "intelligence",
		type: "residential",
		score: 100,
		risk: 0,
		networkTimezone: "America/New_York",
		flags: {
			datacenter: false,
			chinaCloud: false,
			vpn: false,
			proxy: false,
			residentialProxy: false,
			tor: false,
			mobile: false,
			anycast: null,
		},
		...patch,
	});
const env = (patch: Partial<Environment> = {}): Environment => ({
	canvasHash: "B6D9DB7A",
	webglHash: "3452E832",
	gpuVendor: "Google Inc. (Apple)",
	gpuRenderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M3)",
	os: "macOS",
	platform: "MacIntel",
	browser: "Chrome 155.0.0.0",
	screen: "1512×982 @2x",
	cores: 8,
	memory: 8,
	touchPoints: 0,
	languages: ["en-US", "en"],
	timezone: "America/New_York",
	webdriver: false,
	userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/155.0.0.0",
	...patch,
});

it("parses Cloudflare trace and rejects bodies without a valid IP", () => {
	expect(
		parseTrace(
			"fl=1\nh=claude.ai\nip=161.77.8.204\ncolo=BOS\nloc=US\nwarp=off\n",
		),
	).toEqual({ ip: "161.77.8.204", country: "US", colo: "BOS" });
	expect(
		parseTrace("ip=2605:52C0:2:5182:be24:11ff:feab:3da2\nloc=xx\ncolo=lax"),
	).toEqual({
		ip: "2605:52c0:2:5182:be24:11ff:feab:3da2",
		country: "XX",
		colo: "LAX",
	});
	expect(parseTrace("<html>blocked</html>")).toBeNull();
	expect(parseTrace("ip=not-an-ip\nloc=US")).toBeNull();
});

it("region follows the exit Claude sees, including the UA exception", () => {
	expect(regionCard("US").level).toBe("good");
	expect(regionCard("CN")).toMatchObject({
		level: "bad",
		status: "unavailable",
	});
	expect(regionCard("UA").level).toBe("warn");
	expect(regionCard(null).level).toBe("unknown");
	expect(regionCard("T1").level).toBe("unknown");
});

it("time zone: exact or same-continent match passes, cross-continent warns", () => {
	expect(timezoneCard("America/New_York", "America/New_York").status).toBe(
		"match",
	);
	expect(timezoneCard("America/Chicago", "America/New_York")).toMatchObject({
		level: "good",
		status: "near",
	});
	expect(timezoneCard("Asia/Shanghai", "America/New_York")).toMatchObject({
		level: "warn",
		advice: "timezone_change",
	});
	expect(timezoneCard("Asia/Shanghai", null).level).toBe("unknown");
});

it("language compares the first browser language with the exit country", () => {
	expect(languageCard(["en-US", "en"], "US").level).toBe("good");
	expect(languageCard(["zh-CN", "en-US"], "US")).toMatchObject({
		level: "warn",
		status: "partial",
	});
	expect(languageCard(["zh-CN"], "US").status).toBe("mismatch");
	expect(languageCard(["ja-JP"], "JP").level).toBe("good");
	expect(languageCard(["fr-CH"], "CH").level).toBe("good");
	expect(languageCard(["en-US"], null).level).toBe("unknown");
});

it("network type comes only from a full intelligence lookup", () => {
	expect(networkCard(null).level).toBe("unknown");
	expect(networkCard(lookup({ mode: "edge" })).level).toBe("unknown");
	expect(networkCard(lookup()).level).toBe("good");
	expect(
		networkCard(
			lookup({
				type: "hosting",
				flags: { ...lookup().flags, datacenter: true },
			}),
		).level,
	).toBe("warn");
	expect(
		networkCard(lookup({ flags: { ...lookup().flags, vpn: true } })).level,
	).toBe("bad");
});

it("DNS flags a domestic resolver only when the Claude exit is abroad", () => {
	const dns = (resolverGeo: string, subnetGeo: string | null = null) => ({
		resolver: "1.1.1.1",
		resolverGeo,
		subnet: null,
		subnetGeo,
	});
	expect(dnsCard(dns("United States - Google LLC"), "US").level).toBe("good");
	expect(dnsCard(dns("China - China Telecom"), "US")).toMatchObject({
		level: "bad",
		status: "leak",
	});
	expect(dnsCard(dns("China - China Telecom"), "CN").level).toBe("good");
	expect(
		dnsCard(dns("United States - Google LLC", "China - China Telecom"), "US")
			.level,
	).toBe("warn");
	expect(dnsCard("error", "US").level).toBe("unknown");
	expect(isChinaGeo("Hong Kong - HKT")).toBe(true);
	expect(isChinaGeo("Chinatown Networks - X")).toBe(false);
});

it("WebRTC: domestic IP is a leak, unknown extra warns, known exits pass", () => {
	expect(webrtcCard(null, [], null).status).toBe("untested");
	expect(
		webrtcCard(["125.83.245.226"], ["161.77.8.204"], "125.83.245.226").level,
	).toBe("bad");
	expect(webrtcCard(["198.51.100.7"], ["161.77.8.204"], null).level).toBe(
		"warn",
	);
	expect(webrtcCard(["161.77.8.204"], ["161.77.8.204"], null).level).toBe(
		"good",
	);
	expect(webrtcCard([], [], null).level).toBe("good");
});

it("environment findings: automation, virtual GPU and OS mismatch", () => {
	expect(assessEnvironment(env())).toEqual([]);
	expect(assessEnvironment(env({ webdriver: true }))).toContain("automation");
	expect(
		assessEnvironment(env({ userAgent: "Mozilla/5.0 HeadlessChrome/155" })),
	).toContain("automation");
	expect(
		assessEnvironment(env({ gpuRenderer: "Google SwiftShader" })),
	).toContain("virtual");
	expect(
		assessEnvironment(
			env({ os: "Windows", platform: "MacIntel", gpuRenderer: "Apple M3" }),
		),
	).toContain("mismatch");
	expect(
		assessEnvironment(env({ os: "iOS", platform: "iPhone", touchPoints: 0 })),
	).toContain("mismatch");
	expect(
		assessEnvironment(
			env({
				os: "Windows",
				platform: "Win32",
				gpuRenderer: "ANGLE (NVIDIA Direct3D11)",
			}),
		),
	).toEqual([]);
});

it("user agent parsing and stable short hash", () => {
	expect(
		osFromUserAgent(
			"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Safari/604.1",
		),
	).toBe("iOS");
	expect(osFromUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe(
		"Windows",
	);
	expect(
		browserFromUserAgent(
			"Mozilla/5.0 (Windows NT 10.0) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.1",
		),
	).toBe("Edge 155.0.1");
	expect(
		browserFromUserAgent(
			"Mozilla/5.0 (Macintosh) AppleWebKit/605 (KHTML) Version/18.1 Safari/605.1.15",
		),
	).toBe("Safari 18.1");
	expect(fnv1a("hello")).toBe(fnv1a("hello"));
	expect(fnv1a("hello")).toMatch(/^[0-9A-F]{8}$/);
	expect(fnv1a("hello")).not.toBe(fnv1a("hellp"));
});

it("overall verdict never approves without a Claude exit and follows worst card", () => {
	const base = {
		claudeCountry: "US",
		browserTimezone: "America/New_York",
		languages: ["en-US"],
		lookup: lookup(),
		dns: {
			resolver: "1.1.1.1",
			resolverGeo: "United States - Cloudflare",
			subnet: null,
			subnetGeo: null,
		},
		webrtc: null,
		knownExits: ["161.77.8.204"],
		chinaIp: "125.83.245.226",
		environment: env(),
		findings: [],
	};
	expect(overallVerdict("161.77.8.204", buildCards(base))).toBe("good");
	expect(overallVerdict(null, buildCards(base))).toBe("unknown");
	expect(
		overallVerdict(
			"161.77.8.204",
			buildCards({ ...base, browserTimezone: "Asia/Shanghai" }),
		),
	).toBe("warn");
	expect(
		overallVerdict(
			"161.77.8.204",
			buildCards({ ...base, claudeCountry: "CN" }),
		),
	).toBe("bad");
	// Missing network intelligence can never be shown as fully clear.
	expect(
		overallVerdict("161.77.8.204", buildCards({ ...base, lookup: null })),
	).toBe("warn");
	expect(
		overallVerdict(
			"161.77.8.204",
			buildCards({ ...base, webrtc: ["125.83.245.226"] }),
		),
	).toBe("bad");
});

it("WebRTC switched off entirely counts as protected, not as a failure", () => {
	expect(webrtcCard("disabled", [], "125.83.245.226")).toMatchObject({
		level: "good",
		status: "disabled",
		advice: "webrtc_disabled",
	});
});
