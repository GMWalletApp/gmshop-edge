import { afterEach, expect, it, vi } from "vitest";
import { checkIp, ipCheckSchema } from "#/features/ip-check/check";
import { applyIpQuery, handleIpCheck } from "#/features/ip-check/server/lookup";
import { claimFixedWindowRateLimit } from "#/server/rate-limit";
import type { RuntimeEnv } from "#/server/runtime/types";

vi.mock("#/server/rate-limit", () => ({
	claimFixedWindowRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
}));
afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
	vi.mocked(claimFixedWindowRateLimit).mockResolvedValue({
		allowed: true,
		count: 1,
		windowStart: 0,
	});
});
function request(query = "") {
	const req = new Request(`https://shop.example/api/ip-check${query}`, {
		headers: { "cf-connecting-ip": "203.0.113.10" },
	});
	Object.defineProperty(req, "cf", {
		value: { country: "US", asn: 12345, asOrganization: "Example ISP" },
	});
	return req;
}
function env() {
	const statement = {
		bind: vi.fn().mockReturnThis(),
		run: vi.fn().mockResolvedValue({ success: true }),
		first: vi.fn().mockResolvedValue({ total: 1, lower: 0 }),
	};
	return {
		runtime: "cloudflare",
		DB: { prepare: () => statement },
		CACHE: {
			get: vi.fn().mockResolvedValue(null),
			put: vi.fn().mockResolvedValue(undefined),
		},
	} as unknown as RuntimeEnv;
}
const primary = {
	ip: "203.0.113.10",
	isp: { asn: "AS12345", org: "Example ISP" },
	location: {
		country_code: "US",
		city: "Example",
		timezone: "America/New_York",
	},
	risk: {
		is_proxy: false,
		is_vpn: false,
		is_tor: false,
		is_datacenter: false,
		is_mobile: false,
		risk_score: 0,
	},
};
const backup = {
	status: "ok",
	"203.0.113.10": {
		network: {
			asn: "AS12345",
			organisation: "Example ISP",
			type: "Residential",
		},
		location: { country_code: "US", city_name: "Example" },
		detections: {
			proxy: false,
			vpn: false,
			tor: false,
			hosting: false,
			risk: 0,
		},
	},
};
it("uses primary intelligence and caches no raw IP", async () => {
	vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(primary)));
	const runtime = env();
	const response = await handleIpCheck(request(), runtime);
	expect(await response?.json()).toMatchObject({
		score: 100,
		source: "ipquery.io",
		mode: "intelligence",
		status: "clear",
		ranking: { total: 1 },
	});
	expect(fetch).toHaveBeenCalledOnce();
	expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
		"https://api.ipquery.io/203.0.113.10",
	);
	const put = runtime.CACHE?.put;
	if (!put) throw new Error("cache mock missing");
	const cache = vi.mocked(put).mock.calls[0];
	expect(cache?.[1]).not.toContain("203.0.113.10");
	expect(cache?.[1]).toContain('"ip":null');
	expect(
		vi
			.mocked(claimFixedWindowRateLimit)
			.mock.calls.some((c) => c[1].bucketKey === "ip-check:proxycheck:daily"),
	).toBe(false);
});
it("uses one fallback on primary failure", async () => {
	vi.stubGlobal(
		"fetch",
		vi
			.fn()
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValueOnce(Response.json(backup)),
	);
	const response = await handleIpCheck(request(), env());
	expect(await response?.json()).toMatchObject({
		score: 100,
		source: "proxycheck.io",
	});
	expect(fetch).toHaveBeenCalledTimes(2);
});
it("fallback quota exhaustion avoids that provider and never invents 100", async () => {
	vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
	vi.mocked(claimFixedWindowRateLimit)
		.mockResolvedValueOnce({ allowed: true, count: 1, windowStart: 0 })
		.mockResolvedValueOnce({ allowed: false, count: 80, windowStart: 0 });
	const response = await handleIpCheck(request(), env());
	expect(await response?.json()).toMatchObject({
		mode: "edge",
		score: null,
		warning: "quota",
	});
	expect(fetch).toHaveBeenCalledOnce();
});
it("two 429s produce bounded degradation without looping", async () => {
	vi.stubGlobal(
		"fetch",
		vi
			.fn()
			.mockImplementation(() =>
				Promise.resolve(new Response("", { status: 429 })),
			),
	);
	const response = await handleIpCheck(request(), env());
	expect(await response?.json()).toMatchObject({
		mode: "edge",
		score: null,
		warning: "quota",
	});
	expect(fetch).toHaveBeenCalledTimes(2);
});
it("another IP never inherits the caller location on failure", async () => {
	vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
	const response = await handleIpCheck(request("?ip=1.1.1.1"), env());
	expect(await response?.json()).toMatchObject({
		ip: "1.1.1.1",
		country: null,
		asn: null,
		score: null,
		edgeCountry: null,
		warning: "provider",
	});
});
it.each([
	"127.0.0.1",
	"10.0.0.1",
	"::1",
	"fc00::1",
	"169.254.1.1",
	"192.0.2.1",
	"198.18.0.1",
	"203.0.113.1",
	"example.com",
	"https://example.com",
])("rejects invalid/nonpublic target %s before fetching", async (ip) => {
	vi.stubGlobal("fetch", vi.fn());
	expect(
		(await handleIpCheck(request(`?ip=${encodeURIComponent(ip)}`), env()))
			?.status,
	).toBe(400);
	expect(fetch).not.toHaveBeenCalled();
});
it("supports explicit JSON accept on the public page route", async () => {
	const req = new Request("https://shop.example/ip-check", {
		headers: { accept: "application/json" },
	});
	expect(
		(await handleIpCheck(req, { runtime: "bun" }))?.headers.get("content-type"),
	).toContain("application/json");
});
it("validates returned IP rather than scoring another address", () => {
	expect(() =>
		applyIpQuery(checkIp(request(), "cloudflare"), {
			...primary,
			ip: "8.8.8.8",
		}),
	).toThrow("mismatch");
});
it("missing primary fields invoke fallback, never false booleans", async () => {
	vi.stubGlobal(
		"fetch",
		vi
			.fn()
			.mockResolvedValueOnce(Response.json({ ...primary, risk: {} }))
			.mockResolvedValueOnce(Response.json(backup)),
	);
	expect(await (await handleIpCheck(request(), env()))?.json()).toMatchObject({
		source: "proxycheck.io",
	});
});
it("honors cache without another upstream request", async () => {
	const runtime = env();
	const get = runtime.CACHE?.get;
	if (!get) throw new Error("cache mock missing");
	vi.mocked(get).mockResolvedValue(
		JSON.stringify({
			...applyIpQuery(checkIp(request(), "cloudflare"), primary),
			ip: null,
			edgeCountry: null,
		}),
	);
	vi.stubGlobal("fetch", vi.fn());
	expect(await (await handleIpCheck(request(), runtime))?.json()).toMatchObject(
		{ ip: "203.0.113.10", score: 100, edgeCountry: "US" },
	);
	expect(fetch).not.toHaveBeenCalled();
});
it("distinguishes dangerous intelligence from a clear result", () => {
	const result = applyIpQuery(checkIp(request(), "cloudflare"), {
		...primary,
		risk: { ...primary.risk, is_vpn: true },
	});
	expect(result).toMatchObject({ status: "risk", score: 40 });
});
it("cannot approve a region that conflicts with the trusted ingress", () => {
	const base = { ...checkIp(request(), "cloudflare"), edgeCountry: "CN" };
	expect(applyIpQuery(base, primary)).toMatchObject({
		status: "region",
		region: "unlisted",
		score: 40,
	});
});
it("retains unknown when ownership data is missing", () => {
	expect(
		applyIpQuery(
			{ ...checkIp(request(), "cloudflare"), asn: null, organization: null },
			{
				...primary,
				isp: { asn: null, org: null },
			},
		),
	).toMatchObject({ status: "incomplete", score: null });
});
it("schema retains every required negative flag rather than omitting it", () => {
	const result = ipCheckSchema.parse(
		applyIpQuery(checkIp(request(), "cloudflare"), primary),
	);
	expect(result.flags).toMatchObject({
		vpn: false,
		proxy: false,
		tor: false,
		mobile: false,
		datacenter: false,
		anycast: null,
	});
});
it("preserves a territorial-exception warning from the edge", () => {
	expect(
		applyIpQuery(
			{ ...checkIp(request(), "cloudflare"), edgeCountry: "UA" },
			primary,
		),
	).toMatchObject({ status: "region", region: "review", score: 40 });
	expect(
		applyIpQuery(
			{ ...checkIp(request(), "cloudflare"), edgeCountry: "RU" },
			primary,
		).score,
	).toBe(5);
});
it("a known VPN warning survives incomplete ownership metadata", () => {
	expect(
		applyIpQuery(checkIp(request(), "cloudflare"), {
			...primary,
			isp: { asn: null, org: null },
			risk: { ...primary.risk, is_vpn: true },
		}),
	).toMatchObject({ status: "risk", score: 40 });
});
it("fills missing primary identity only from the same checked connection", () => {
	const result = applyIpQuery(checkIp(request(), "cloudflare"), {
		...primary,
		isp: { asn: "AS0", org: "", isp: "Example ISP" },
		risk: { ...primary.risk, is_datacenter: true },
	});
	expect(result).toMatchObject({
		asn: 12345,
		organization: "Example ISP",
		score: 60,
		status: "hosting",
		source: "ipquery.io",
	});
});
it("retains a positive risk score for an arbitrary IP with unknown ASN", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue(
			Response.json({
				...primary,
				ip: "1.1.1.1",
				isp: { asn: "AS0", org: "", isp: "Example host" },
				risk: { ...primary.risk, is_datacenter: true },
			}),
		),
	);
	const response = await handleIpCheck(request("?ip=1.1.1.1"), env());
	expect(await response?.json()).toMatchObject({
		asn: null,
		organization: "Example host",
		score: 60,
		status: "hosting",
		edgeCountry: null,
	});
	expect(fetch).toHaveBeenCalledOnce();
});
it("never invents 100 when all identity sources are empty and no positive risk is known", () => {
	const empty = {
		...checkIp(request(), "cloudflare"),
		asn: null,
		organization: null,
	};
	expect(
		applyIpQuery(empty, { ...primary, isp: { asn: "AS0", org: "", isp: "" } })
			.score,
	).toBeNull();
});
it("requires a human check before spending provider quota when Turnstile is on", async () => {
	const fetcher = vi.fn().mockResolvedValue(Response.json(primary));
	vi.stubGlobal("fetch", fetcher);
	const runtime = {
		...env(),
		TURNSTILE_SITE_KEY: "site",
		TURNSTILE_SECRET_KEY: "secret",
	} as RuntimeEnv;
	const response = await handleIpCheck(request(), runtime);
	expect(response?.status).toBe(403);
	const body = ipCheckSchema.parse(await response?.json());
	expect(body.warning).toBe("verify");
	expect(body.score).toBeNull();
	expect(fetcher).not.toHaveBeenCalled();
});
it("a verified ipcheck token unlocks the lookup; a token for another action does not", async () => {
	const runtime = {
		...env(),
		TURNSTILE_SITE_KEY: "site",
		TURNSTILE_SECRET_KEY: "secret",
	} as RuntimeEnv;
	const signed = (action: string) =>
		vi.fn(async (url: string | URL | Request) =>
			String(url).includes("siteverify")
				? Response.json({ success: true, action, hostname: "shop.example" })
				: Response.json(primary),
		);
	const withToken = () => {
		const req = request();
		const copy = new Request(req, {
			headers: {
				"cf-connecting-ip": "203.0.113.10",
				"cf-turnstile-response": "token",
			},
		});
		Object.defineProperty(copy, "cf", { value: (req as { cf?: unknown }).cf });
		return copy;
	};
	vi.stubGlobal("fetch", signed("register"));
	expect((await handleIpCheck(withToken(), runtime))?.status).toBe(403);
	vi.stubGlobal("fetch", signed("ipcheck"));
	const response = await handleIpCheck(withToken(), runtime);
	expect(response?.status).toBe(200);
	expect(ipCheckSchema.parse(await response?.json()).score).toBe(100);
});
