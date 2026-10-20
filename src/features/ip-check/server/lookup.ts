import { z } from "zod";
import { claimFixedWindowRateLimit } from "#/server/rate-limit";
import type { RuntimeEnv } from "#/server/runtime/types";
import { verifyTurnstileAction } from "#/server/turnstile";
import { canonicalIp, knownAnycast, publicIpSchema } from "../address";
import {
	checkIp,
	type IpCheck,
	ipCheckSchema,
	supportedCountries,
} from "../check";
import { scoreIp } from "../score";
import { fetchProvider, readProviderJson } from "./provider-transport";

const providerSchema = z.object({
	network: z.object({
		asn: z.string().nullable(),
		organisation: z.string().nullable(),
		type: z.string().nullable(),
	}),
	location: z.object({
		country_code: z
			.string()
			.regex(/^[A-Z]{2}$/)
			.nullable(),
		city_name: z.string().nullable(),
		timezone: z.string().nullable().optional(),
	}),
	detections: z.object({
		proxy: z.boolean(),
		vpn: z.boolean(),
		tor: z.boolean(),
		hosting: z.boolean(),
		risk: z.number().int().min(0).max(100),
	}),
});

const ipquerySchema = z.object({
	ip: z.union([z.ipv4(), z.ipv6()]),
	isp: z.object({
		asn: z.string().nullable(),
		org: z.string().nullable(),
		isp: z.string().nullable().optional(),
	}),
	location: z.object({
		country_code: z
			.string()
			.regex(/^[A-Z]{2}$/)
			.nullable(),
		city: z.string().nullable(),
		timezone: z.string().nullable(),
	}),
	risk: z.object({
		is_datacenter: z.boolean(),
		is_vpn: z.boolean(),
		is_proxy: z.boolean(),
		is_tor: z.boolean(),
		is_mobile: z.boolean(),
		risk_score: z.number().int().min(0).max(100),
	}),
});
type Intelligence = {
	country: string | null;
	city: string | null;
	asn: number | null;
	org: string | null;
	timezone: string | null;
	datacenter: boolean;
	vpn: boolean;
	proxy: boolean;
	tor: boolean;
	mobile: boolean | null;
	risk: number;
	source: "ipquery.io" | "proxycheck.io";
};
function assess(base: IpCheck, data: Intelligence): IpCheck {
	const { country, asn, org, datacenter, vpn, proxy, tor } = data;
	const local = scoreIp({ datacenter, vpn, proxy, tor, org, asn }, country);
	const cc =
		base.edgeCountry &&
		(!supportedCountries.has(base.edgeCountry) || base.edgeCountry === "UA")
			? base.edgeCountry
			: country;
	const region =
		!cc || ["XX", "T1"].includes(cc)
			? "unknown"
			: cc === "UA"
				? "review"
				: supportedCountries.has(cc)
					? "listed"
					: "unlisted";
	const risk = Math.max(local.risk, data.risk);
	const complete = Boolean(
		country &&
			region !== "unknown" &&
			((asn && org) || datacenter || vpn || proxy || tor || local.chinaCloud),
	);
	const regionCap = ["KP", "IR", "CU", "SY", "RU", "BY"].includes(cc ?? "")
		? 5
		: region === "unlisted" || region === "review"
			? 40
			: 100;
	return {
		...base,
		country,
		city: data.city,
		asn,
		organization: org,
		networkTimezone: data.timezone,
		source: data.source,
		region,
		hosting: datacenter || local.chinaCloud ? "suspected" : "unknown",
		status:
			region === "unlisted" || region === "review"
				? "region"
				: risk >= 70 || vpn || proxy || tor
					? "risk"
					: !complete
						? "incomplete"
						: datacenter || local.chinaCloud
							? "hosting"
							: "clear",
		score: complete ? Math.min(local.score, 100 - risk, regionCap) : null,
		risk,
		type: local.type,
		mode: "intelligence",
		providerRisk: data.risk,
		warning: null,
		checkedAt: new Date().toISOString(),
		flags: {
			datacenter: datacenter || local.chinaCloud,
			chinaCloud: local.chinaCloud,
			vpn,
			proxy,
			tor,
			residentialProxy: local.residentialProxy,
			mobile: data.mobile,
			anycast: base.ip ? knownAnycast(base.ip) : null,
		},
	};
}
export function applyIntelligence(base: IpCheck, raw: unknown): IpCheck {
	const data = providerSchema.parse(raw);
	return assess(base, {
		country: data.location.country_code,
		city: data.location.city_name,
		asn: Number(data.network.asn?.replace(/^AS/, "")) || null,
		org: data.network.organisation,
		timezone: data.location.timezone ?? null,
		datacenter: data.detections.hosting,
		vpn: data.detections.vpn,
		proxy: data.detections.proxy,
		tor: data.detections.tor,
		mobile: data.network.type === "Wireless" ? true : null,
		risk: data.detections.risk,
		source: "proxycheck.io",
	});
}
export function applyIpQuery(base: IpCheck, raw: unknown): IpCheck {
	const data = ipquerySchema.parse(raw);
	if (!base.ip || canonicalIp(data.ip) !== canonicalIp(base.ip))
		throw new Error("IP response mismatch");
	return assess(base, {
		country: data.location.country_code || base.country,
		city: data.location.city || base.city,
		asn: Number(data.isp.asn?.replace(/^AS/, "")) || base.asn,
		org: data.isp.org?.trim() || data.isp.isp?.trim() || base.organization,
		timezone: data.location.timezone,
		datacenter: data.risk.is_datacenter || base.hosting === "suspected",
		vpn: data.risk.is_vpn,
		proxy: data.risk.is_proxy,
		tor: data.risk.is_tor,
		mobile: data.risk.is_mobile,
		risk: data.risk.risk_score,
		source: "ipquery.io",
	});
}
function providerFailure(source: string, error: unknown) {
	console.warn(
		JSON.stringify({
			event: "ip_check_provider_failure",
			source,
			kind:
				error instanceof z.ZodError
					? "schema"
					: typeof error === "number"
						? `http_${error}`
						: error instanceof Error
							? error.name
							: typeof error === "string"
								? error
								: "unknown",
			field:
				error instanceof z.ZodError
					? error.issues[0]?.path.join(".")
					: undefined,
		}),
	);
}
async function hash(value: string) {
	return [
		...new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
		),
	]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}
export async function handleIpCheck(
	request: Request,
	env: RuntimeEnv,
): Promise<Response | null> {
	const url = new URL(request.url);
	if (
		url.pathname !== "/api/ip-check" &&
		!(
			url.pathname === "/ip-check" &&
			request.headers.get("accept")?.includes("application/json")
		)
	)
		return null;
	const headers = {
		"cache-control": "private, no-store",
		"cdn-cache-control": "no-store",
		"referrer-policy": "no-referrer",
	};
	const respond = (data: unknown, status = 200) =>
		Response.json(data, { status, headers });
	if (request.method !== "GET")
		return Response.json(
			{ error: "method_not_allowed" },
			{ status: 405, headers: { ...headers, allow: "GET" } },
		);
	if (
		[...url.searchParams.keys()].some((k) => k !== "ip") ||
		url.searchParams.getAll("ip").length > 1
	)
		return respond({ error: "invalid_query" }, 400);
	const query = url.searchParams.get("ip");
	if (query !== null && !publicIpSchema.safeParse(query).success)
		return respond({ error: "public_ip_required" }, 400);
	let base = checkIp(request, env.runtime);
	const caller = base.ip;
	if (query)
		base = {
			...checkIp(new Request("http://localhost"), "bun"),
			ip: canonicalIp(query),
			colo: null,
		};
	const ip = base.ip ? canonicalIp(base.ip) : null;
	if (!ip || !env.DB || env.runtime !== "cloudflare") return respond(base);
	// Provider lookups spend shared quota: require a fresh human check first.
	// Without one, the caller still gets the free edge facts, never a score.
	const challenge = await verifyTurnstileAction(
		request,
		env,
		env.DB as D1Database,
		"ipcheck",
	);
	if (challenge)
		return respond({ ...base, warning: "verify" }, challenge.status);
	const digest = await hash(ip);
	const cacheKey = `ip-check:v2:${await hash(`${ip}|${base.edgeCountry ?? "lookup"}`)}`;
	let cached: IpCheck | null = null;
	try {
		const raw = await env.CACHE?.get(cacheKey);
		if (raw) cached = ipCheckSchema.parse(JSON.parse(raw));
	} catch {
		/* Cache is optional. */
	}
	if (cached)
		return respond({
			...cached,
			ip,
			colo: query ? null : base.colo,
			edgeCountry: base.edgeCountry,
		});
	const db = env.DB as D1Database;
	// Never route around the anonymous allowance or retry a provider 429.
	try {
		const perCaller = await claimFixedWindowRateLimit(db, {
			bucketKey: `ip-check:caller:${await hash(caller ?? "unknown")}`,
			limit: 6,
			windowMs: 60000,
		});
		if (!perCaller.allowed)
			return Response.json(
				{ ...base, warning: "quota" },
				{ status: 429, headers: { ...headers, "retry-after": "60" } },
			);

		let result: IpCheck | null = null;
		let failure: "quota" | "provider" = "provider";
		try {
			const response = await fetchProvider(
				`https://api.ipquery.io/${encodeURIComponent(ip)}`,
			);
			if (response.ok)
				result = applyIpQuery(base, await readProviderJson(response));
			else {
				failure = response.status === 429 ? "quota" : "provider";
				providerFailure("ipquery", response.status);
			}
		} catch (error) {
			providerFailure("ipquery", error);
			/* One bounded fallback, never retry the same provider. */
		}
		if (!result || result.score === null) {
			if (result) providerFailure("ipquery", "incomplete_metadata");
			const budget = await claimFixedWindowRateLimit(db, {
				bucketKey: "ip-check:proxycheck:daily",
				limit: 80,
				windowMs: 86400000,
			});
			if (!budget.allowed) return respond({ ...base, warning: "quota" });
			try {
				const response = await fetchProvider(
					`https://proxycheck.io/v3/${encodeURIComponent(ip)}?ver=24-June-2026`,
				);
				if (!response.ok) {
					providerFailure("proxycheck", response.status);
					return respond({
						...base,
						warning: response.status === 429 ? "quota" : failure,
					});
				}
				const raw = (await readProviderJson(response)) as Record<
					string,
					unknown
				>;
				if (raw.status !== "ok" && raw.status !== "warning") {
					providerFailure(
						"proxycheck",
						/limit|quota|queries/i.test(String(raw.message ?? ""))
							? "provider_quota"
							: "provider_status",
					);
					return respond({ ...base, warning: failure });
				}
				result = applyIntelligence(base, raw[ip]);
			} catch (error) {
				providerFailure("proxycheck", error);
				return respond({ ...base, warning: failure });
			}
		}

		try {
			if (result.score !== null) {
				const day = Math.floor(Date.now() / 86400000);
				const sample = await claimFixedWindowRateLimit(db, {
					bucketKey: `ip-check:sample:${digest}`,
					limit: 1,
					windowMs: 86400000,
				});
				if (sample.allowed)
					await db
						.prepare(
							"INSERT INTO ip_check_score_buckets (day, score, count) VALUES (?, ?, 1) ON CONFLICT(day,score) DO UPDATE SET count=count+1",
						)
						.bind(day, result.score)
						.run();
				const rank = await db
					.prepare(
						"SELECT COALESCE(SUM(count),0) AS total, COALESCE(SUM(CASE WHEN score < ? THEN count ELSE 0 END),0) AS lower FROM ip_check_score_buckets WHERE day >= ? AND day <= ?",
					)
					.bind(result.score, day - 29, day)
					.first<{ total: number; lower: number }>();
				if (rank)
					result.ranking = {
						total: rank.total,
						percentile: rank.total
							? Math.round((rank.lower / rank.total) * 100)
							: 0,
					};
			}
		} catch {
			/* Ranking is optional and cannot block diagnosis. */
		}
		// Cache only normalized facts, never provider bodies, cookies or credentials.
		try {
			await env.CACHE?.put(
				cacheKey,
				JSON.stringify({ ...result, ip: null, edgeCountry: null }),
				{
					expirationTtl: 600,
				},
			);
		} catch {
			/* Return the result even when cache writes fail. */
		}
		return respond(result);
	} catch (error) {
		providerFailure("storage", error);
		return respond({ ...base, warning: "provider" });
	}
}
