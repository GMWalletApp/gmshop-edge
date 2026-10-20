import { z } from "zod";
import { canonicalIp } from "./address";

// Browser-side exit probes. Every request goes straight from the visitor's
// browser to the named service, so it measures the route that service sees.
// Nothing here is sent to our server.

// Cloudflare trace endpoints answer with `Access-Control-Allow-Origin: *`.
export const aiServices = [
	{ id: "claude", name: "Claude", host: "claude.ai" },
	{ id: "anthropic", name: "Anthropic", host: "anthropic.com" },
	{ id: "chatgpt", name: "ChatGPT", host: "chatgpt.com" },
	{ id: "grok", name: "Grok", host: "grok.com" },
] as const;
export type AiServiceId = (typeof aiServices)[number]["id"];

export type TraceExit = {
	ip: string;
	country: string | null;
	colo: string | null;
	ms: number;
};
export type Probe<T> = { state: "ok"; value: T } | { state: "error" };

const ipSchema = z.union([z.ipv4(), z.ipv6()]);

export function parseTrace(text: string): Omit<TraceExit, "ms"> | null {
	const fields = new Map<string, string>();
	for (const line of text.split("\n")) {
		const at = line.indexOf("=");
		if (at > 0) fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
	}
	const ip = ipSchema.safeParse(fields.get("ip"));
	if (!ip.success) return null;
	const loc = fields.get("loc")?.toUpperCase();
	const colo = fields.get("colo")?.toUpperCase();
	return {
		ip: canonicalIp(ip.data),
		country: loc && /^[A-Z]{2}$/.test(loc) ? loc : null,
		colo: colo && /^[A-Z]{3}$/.test(colo) ? colo : null,
	};
}

async function timed(url: string, signal: AbortSignal) {
	// AbortSignal.any is missing on older Safari; combine by hand.
	const controller = new AbortController();
	const abort = () => controller.abort();
	const timer = setTimeout(abort, 8000);
	signal.addEventListener("abort", abort, { once: true });
	if (signal.aborted) abort();
	const started = performance.now();
	try {
		const response = await fetch(url, {
			cache: "no-store",
			credentials: "omit",
			referrerPolicy: "no-referrer",
			signal: controller.signal,
		});
		if (!response.ok) throw new Error(`http_${response.status}`);
		const text = (await response.text()).slice(0, 4096);
		return { text, ms: Math.max(1, Math.round(performance.now() - started)) };
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", abort);
	}
}

export async function probeTrace(
	origin: string,
	signal: AbortSignal,
): Promise<Probe<TraceExit>> {
	try {
		const first = await timed(`${origin}/cdn-cgi/trace`, signal);
		const parsed = parseTrace(first.text);
		if (!parsed) return { state: "error" };
		// The first request pays DNS + TLS setup; time a warm second request.
		const ms = await timed(`${origin}/cdn-cgi/trace`, signal).then(
			(warm) => warm.ms,
			() => first.ms,
		);
		return { state: "ok", value: { ...parsed, ms } };
	} catch {
		return { state: "error" };
	}
}

export type ChinaExit = { ip: string; location: string };
const ipipSchema = z.object({
	ret: z.literal("ok"),
	data: z.object({ ip: ipSchema, location: z.array(z.string()).max(8) }),
});
// A domestic service: with split routing it shows the visitor's real exit.
export async function probeChina(
	signal: AbortSignal,
): Promise<Probe<ChinaExit>> {
	try {
		const { text } = await timed("https://myip.ipip.net/json", signal);
		const data = ipipSchema.parse(JSON.parse(text)).data;
		return {
			state: "ok",
			value: {
				ip: canonicalIp(data.ip),
				location: data.location
					.map((part) => part.trim())
					.filter(Boolean)
					.join(" ")
					.slice(0, 80),
			},
		};
	} catch {
		return { state: "error" };
	}
}

export type DnsExit = {
	resolver: string;
	resolverGeo: string;
	subnet: string | null;
	subnetGeo: string | null;
};
const ednsSchema = z.object({
	dns: z.object({ ip: ipSchema, geo: z.string().max(160) }),
	edns: z
		.object({ ip: z.string().max(64), geo: z.string().max(160) })
		.optional(),
});
// ip-api resolves a random subdomain through the visitor's DNS resolver and
// reports which resolver (and EDNS client subnet) asked its nameserver.
export async function probeDns(signal: AbortSignal): Promise<Probe<DnsExit>> {
	try {
		const label = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
			b.toString(16).padStart(2, "0"),
		).join("");
		const { text } = await timed(
			`https://${label}.edns.ip-api.com/json`,
			signal,
		);
		const data = ednsSchema.parse(JSON.parse(text));
		return {
			state: "ok",
			value: {
				resolver: canonicalIp(data.dns.ip),
				resolverGeo: data.dns.geo.trim(),
				subnet: data.edns?.ip.trim() || null,
				subnetGeo: data.edns?.geo.trim() || null,
			},
		};
	} catch {
		return { state: "error" };
	}
}

// ip-api geo strings look like "United States - Google LLC".
export function geoCountry(geo: string | null) {
	return geo?.split(" - ")[0]?.trim() || null;
}
export function isChinaGeo(geo: string | null) {
	return /^(china|hong kong|macao|macau)\b/i.test(geoCountry(geo) ?? "");
}
