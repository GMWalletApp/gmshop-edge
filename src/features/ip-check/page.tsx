import {
	ArrowLeft,
	Fingerprint,
	Gauge,
	Network,
	RefreshCw,
	ScanSearch,
	ShieldCheck,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { useTurnstile } from "#/features/auth/components/turnstile";
import { m } from "#/paraglide/messages";
import { getLocale } from "#/paraglide/runtime";
import { publicIpSchema } from "./address";
import {
	advisoryCards,
	buildCards,
	type Card,
	type Level,
	overallVerdict,
	type Verdict,
} from "./assess";
import { type IpCheck, ipCheckSchema, maskIp, regionPolicyDate } from "./check";
import {
	assessEnvironment,
	collectEnvironment,
	type Environment,
} from "./environment";
import {
	type AiServiceId,
	aiServices,
	type ChinaExit,
	type DnsExit,
	type Probe,
	probeChina,
	probeDns,
	probeTrace,
	type TraceExit,
} from "./exits";
import { LocalChecks } from "./local-checks";
import { checkerShareUrl, createShareImage } from "./share";
import { checkWebRtc } from "./webrtc";

type Exits = {
	site: Probe<TraceExit> | null;
	china: Probe<ChinaExit> | null;
	dns: Probe<DnsExit> | null;
	services: Partial<Record<AiServiceId, Probe<TraceExit>>>;
};
const emptyExits: Exits = {
	site: null,
	china: null,
	dns: null,
	services: {},
};

function flag(country: string | null) {
	if (!country || !/^[A-Z]{2}$/.test(country)) return "";
	return String.fromCodePoint(
		...[...country].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65),
	);
}
function countryName(country: string | null) {
	if (!country) return null;
	try {
		return (
			new Intl.DisplayNames([getLocale()], { type: "region" }).of(country) ??
			country
		);
	} catch {
		return country;
	}
}
const okValue = <T,>(probe: Probe<T> | null | undefined) =>
	probe?.state === "ok" ? probe.value : null;

const levelStyles: Record<Level, string> = {
	good: "bg-primary/10 text-primary",
	warn: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
	bad: "bg-destructive/10 text-destructive",
	unknown: "bg-muted text-muted-foreground",
};
function Badge({ level, children }: { level: Level; children: string }) {
	return (
		<span
			className={`shrink-0 rounded-full px-2 py-0.5 font-medium text-xs ${levelStyles[level]}`}
		>
			{children}
		</span>
	);
}
function latencyLevel(ms: number): Level {
	return ms < 800 ? "good" : ms < 2500 ? "warn" : "bad";
}

const statusLabels: Record<string, () => string> = {
	unknown: m.ip_st_unknown,
	available: m.ip_st_available,
	unavailable: m.ip_st_unavailable,
	review: m.ip_st_review,
	match: m.ip_st_match,
	near: m.ip_st_near,
	mismatch: m.ip_st_mismatch,
	partial: m.ip_st_partial,
	risky: m.ip_st_risky,
	hosting: m.ip_st_hosting,
	clean: m.ip_st_clean,
	leak: m.ip_st_leak,
	subnet: m.ip_st_subnet,
	normal: m.ip_st_normal,
	untested: m.ip_st_untested,
	disabled: m.ip_st_disabled,
	extra: m.ip_st_extra,
	automation: m.ip_st_automation,
	virtual: m.ip_st_virtual,
};
const adviceLabels: Record<string, () => string> = {
	region_unknown: m.ip_adv_region_unknown,
	region_review: m.ip_adv_region_review,
	region_keep: m.ip_adv_region_keep,
	region_change: m.ip_adv_region_change,
	timezone_unknown: m.ip_adv_timezone_unknown,
	timezone_keep: m.ip_adv_timezone_keep,
	timezone_change: m.ip_adv_timezone_change,
	language_unknown: m.ip_adv_language_unknown,
	language_keep: m.ip_adv_language_keep,
	language_change: m.ip_adv_language_change,
	network_unknown: m.ip_adv_network_unknown,
	network_keep: m.ip_adv_network_keep,
	network_change: m.ip_adv_network_change,
	dns_unknown: m.ip_adv_dns_unknown,
	dns_keep: m.ip_adv_dns_keep,
	dns_change: m.ip_adv_dns_change,
	webrtc_start: m.ip_adv_webrtc_start,
	webrtc_keep: m.ip_adv_webrtc_keep,
	webrtc_review: m.ip_adv_webrtc_review,
	webrtc_change: m.ip_adv_webrtc_change,
	webrtc_disabled: m.ip_adv_webrtc_disabled,
	env_unknown: m.ip_adv_env_unknown,
	env_keep: m.ip_adv_env_keep,
	env_automation: m.ip_adv_env_automation,
	env_virtual: m.ip_adv_env_virtual,
	env_mismatch: m.ip_adv_env_mismatch,
};
const cardTitles: Record<Card["id"], () => string> = {
	region: m.ip_card_region,
	timezone: m.ip_card_timezone,
	language: m.ip_card_language,
	network: m.ip_card_network,
	dns: m.ip_card_dns,
	webrtc: m.ip_card_webrtc,
	environment: m.ip_card_environment,
};
const typeLabels: Record<string, () => string> = {
	residential: m.ip_type_residential,
	hosting: m.ip_type_hosting,
	vpn: m.ip_type_vpn,
	"vpn/hosting": m.ip_type_vpn,
	"residential-proxy": m.ip_type_proxy,
	proxy: m.ip_type_proxy,
	tor: m.ip_type_tor,
};
const verdictTitles: Record<Verdict, () => string> = {
	good: m.ip_verdict_good,
	warn: m.ip_verdict_warn,
	bad: m.ip_verdict_bad,
	unknown: m.ip_verdict_unknown,
};
const verdictBodies: Record<Verdict, () => string> = {
	good: m.ip_verdict_good_body,
	warn: m.ip_verdict_warn_body,
	bad: m.ip_verdict_bad_body,
	unknown: m.ip_verdict_unknown_body,
};

export function IpCheckPage() {
	const challenge = useTurnstile("ipcheck");
	const token = challenge.headers["cf-turnstile-response"];
	// Each requested run consumes exactly one verification token.
	const [request, setRequest] = useState<{ id: number; ip: string }>({
		id: 0,
		ip: "",
	});
	const handled = useRef(0);
	const [busy, setBusy] = useState(false);
	const [exits, setExits] = useState<Exits>(emptyExits);
	const [lookup, setLookup] = useState<IpCheck | null>(null);
	const [lookupFailed, setLookupFailed] = useState(false);
	const [target, setTarget] = useState("");
	const [query, setQuery] = useState("");
	const [queryError, setQueryError] = useState(false);
	const [hideIp, setHideIp] = useState(true);
	const [hideChina, setHideChina] = useState(true);
	const [hideFingerprint, setHideFingerprint] = useState(false);
	const [environment, setEnvironment] = useState<Environment | null>(null);
	const [rtc, setRtc] = useState<
		string[] | "busy" | "error" | "disabled" | null
	>(null);
	const rtcAbort = useRef<AbortController | null>(null);
	const runAbort = useRef<AbortController | null>(null);
	const [share, setShare] = useState<{ url: string; file: File } | null>(null);
	const [sharing, setSharing] = useState(false);
	const [shareMessage, setShareMessage] = useState("");
	const qr = useRef<HTMLDivElement>(null);
	const shareButtonRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		setEnvironment(collectEnvironment());
		const ip = new URLSearchParams(location.search).get("ip") ?? "";
		const valid = ip && publicIpSchema.safeParse(ip).success ? ip : "";
		setQuery(valid);
		setRequest({ id: 1, ip: valid });
		return () => {
			rtcAbort.current?.abort();
			runAbort.current?.abort();
		};
	}, []);
	useEffect(
		() => () => {
			if (share) URL.revokeObjectURL(share.url);
		},
		[share],
	);

	const run = useCallback(async (ip: string, headers: HeadersInit) => {
		runAbort.current?.abort();
		rtcAbort.current?.abort();
		const controller = new AbortController();
		runAbort.current = controller;
		const { signal } = controller;
		setBusy(true);
		setLookup(null);
		setLookupFailed(false);
		setTarget(ip);
		setRtc(null);
		setShareMessage("");
		setExits(emptyExits);
		const update = (patch: Partial<Exits>) => {
			if (!signal.aborted) setExits((prev) => ({ ...prev, ...patch }));
		};
		const services = aiServices.map(async (service) => {
			const probe = await probeTrace(`https://${service.host}`, signal);
			if (!signal.aborted)
				setExits((prev) => ({
					...prev,
					services: { ...prev.services, [service.id]: probe },
				}));
			return probe;
		});
		void probeTrace("", signal).then((site) => update({ site }));
		void probeChina(signal).then((china) => update({ china }));
		void probeDns(signal).then((dns) => update({ dns }));
		const claude = await services[0];
		const lookupIp = ip || okValue(claude)?.ip;
		if (!lookupIp) {
			await Promise.allSettled(services);
			if (!signal.aborted) setBusy(false);
			return;
		}
		try {
			const response = await fetch(
				`/api/ip-check?ip=${encodeURIComponent(lookupIp)}`,
				{ cache: "no-store", headers, signal },
			);
			if (!response.ok && ![403, 429].includes(response.status))
				throw new Error("check_failed");
			const data = ipCheckSchema.parse(await response.json());
			if (!signal.aborted) setLookup(data);
		} catch {
			if (!signal.aborted) setLookupFailed(true);
		}
		await Promise.allSettled(services);
		if (!signal.aborted) setBusy(false);
	}, []);

	useEffect(() => {
		if (!challenge.ready || request.id === 0 || handled.current === request.id)
			return;
		handled.current = request.id;
		void run(request.ip, token ? { "cf-turnstile-response": token } : {});
		// Tokens are single-use; prepare a fresh one for the next run.
		if (token) challenge.reset();
	}, [challenge.ready, challenge.reset, request, run, token]);

	const again = (ip: string) => setRequest((prev) => ({ id: prev.id + 1, ip }));

	async function probeRtc() {
		rtcAbort.current?.abort();
		const controller = new AbortController();
		rtcAbort.current = controller;
		setRtc("busy");
		try {
			const ips = await checkWebRtc(controller.signal);
			if (!controller.signal.aborted) setRtc(ips);
		} catch (error) {
			// No RTCPeerConnection at all means WebRTC is switched off (browser
			// setting or a leak-shield extension): nothing can leak.
			if (!controller.signal.aborted)
				setRtc(
					error instanceof Error && error.message === "unavailable"
						? "disabled"
						: "error",
				);
		}
	}
	async function makeShare() {
		if (!lookup || lookup.score === null || !qr.current) return;
		setSharing(true);
		setShareMessage("");
		try {
			const svg = qr.current.querySelector("svg");
			if (!svg) throw new Error("qr_missing");
			const file = await createShareImage(
				lookup,
				new XMLSerializer().serializeToString(svg),
				{
					title: m.ip_score_title(),
					source:
						lookup.mode === "intelligence"
							? `${m.ip_score_full()} · ${lookup.source}`
							: m.ip_score_edge(),
					note: m.ip_score_note(),
					cta: m.ip_share_cta(),
				},
			);
			setShare({ file, url: URL.createObjectURL(file) });
		} catch {
			setShareMessage(m.ip_share_error());
		} finally {
			setSharing(false);
		}
	}
	async function copyLink() {
		try {
			await navigator.clipboard.writeText(checkerShareUrl);
			setShareMessage(m.ip_share_done());
		} catch {
			setShareMessage(m.ip_share_error());
		}
	}
	async function nativeShare() {
		if (!share) return;
		try {
			if (navigator.canShare?.({ files: [share.file] }))
				await navigator.share({ files: [share.file], title: m.ip_title() });
			else if (navigator.share)
				await navigator.share({ title: m.ip_title(), url: checkerShareUrl });
			else setShareMessage(m.ip_share_error());
		} catch {
			setShareMessage(m.ip_share_error());
		}
	}

	const started = request.id > 0 && handled.current > 0;
	const claude = okValue(exits.services.claude);
	const site = okValue(exits.site);
	const china = okValue(exits.china);
	const dns = exits.dns === null ? null : (okValue(exits.dns) ?? "error");
	const deviceLookup = target ? null : lookup;
	const knownExits = [
		site?.ip,
		...aiServices.map((s) => okValue(exits.services[s.id])?.ip),
	].filter((ip): ip is string => Boolean(ip));
	const cards = buildCards({
		claudeCountry: claude?.country ?? null,
		browserTimezone: environment?.timezone ?? null,
		languages: environment?.languages ?? [],
		lookup: deviceLookup,
		dns,
		webrtc: Array.isArray(rtc) || rtc === "disabled" ? rtc : null,
		knownExits,
		chinaIp: china?.ip ?? null,
		environment,
		findings: environment ? assessEnvironment(environment) : [],
	});
	const verdict = overallVerdict(claude?.ip ?? null, cards);
	const showIp = (ip: string | null | undefined) =>
		ip ? (hideIp ? maskIp(ip) : ip) : "—";
	const verdictTone =
		verdict === "good"
			? "border-primary/30"
			: verdict === "bad"
				? "border-destructive/40"
				: verdict === "warn"
					? "border-amber-500/40"
					: "";
	const profileRows: [string, string | null][] = lookup
		? [
				[m.ip_country(), countryName(lookup.country)],
				[m.ip_city(), lookup.city],
				[
					m.ip_org(),
					[lookup.asn ? `AS${lookup.asn}` : null, lookup.organization]
						.filter(Boolean)
						.join(" · ") || null,
				],
				[
					m.ip_type(),
					lookup.mode === "intelligence"
						? (typeLabels[lookup.type] ?? m.ip_type_unknown)()
						: null,
				],
				[m.ip_network_timezone(), lookup.networkTimezone],
				[m.ip_risk(), lookup.risk === null ? null : `${lookup.risk}/100`],
				[
					m.ip_time(),
					lookup.checkedAt
						? new Date(lookup.checkedAt).toLocaleString(getLocale())
						: null,
				],
			]
		: [];
	const flagRows = lookup
		? (
				[
					["vpn", "VPN"],
					["proxy", m.ip_flag_proxy()],
					["tor", "Tor"],
					["datacenter", m.ip_flag_datacenter()],
					["chinaCloud", m.ip_flag_china()],
					["residentialProxy", m.ip_flag_residential()],
					["mobile", m.ip_flag_mobile()],
				] as const
			).map(([key, label]) => ({ label, value: lookup.flags[key] }))
		: [];
	const differentServices = aiServices.filter((s) => {
		const exit = okValue(exits.services[s.id]);
		return s.id !== "claude" && exit && claude && exit.ip !== claude.ip;
	});

	return (
		<div className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-6 sm:py-12">
			<header className="space-y-3">
				<p className="flex items-center gap-2 font-medium text-primary text-sm">
					<ScanSearch className="size-4" aria-hidden="true" />
					{m.ip_eyebrow()}
				</p>
				<h1 className="font-bold text-3xl tracking-tight sm:text-4xl">
					{m.ip_title()}
				</h1>
				<p className="max-w-3xl text-muted-foreground leading-7">
					{m.ip_intro()}
				</p>
			</header>

			<div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border bg-card px-4 py-3">
				<div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
					{(
						[
							[hideIp, setHideIp, m.ip_hide_ip()],
							[hideChina, setHideChina, m.ip_hide_china()],
							[hideFingerprint, setHideFingerprint, m.ip_hide_fingerprint()],
						] as const
					).map(([value, set, label]) => (
						<label key={label} className="flex items-center gap-2">
							<input
								type="checkbox"
								role="switch"
								aria-checked={value}
								className="size-4 accent-primary"
								checked={value}
								onChange={(event) => set(event.target.checked)}
							/>
							{label}
						</label>
					))}
				</div>
				<Button
					variant="outline"
					size="sm"
					disabled={busy || !started}
					onClick={() => again(target)}
				>
					<RefreshCw className="size-4" aria-hidden="true" />
					{m.ip_refresh()}
				</Button>
			</div>

			{challenge.widget && (
				<section className="space-y-3 rounded-2xl border bg-card p-5">
					<p className="font-medium text-sm">
						{started ? m.ip_verify_again() : m.ip_verify_first()}
					</p>
					{challenge.widget}
				</section>
			)}

			<section
				aria-busy={busy}
				aria-live="polite"
				className={`grid gap-5 rounded-2xl border bg-card p-5 sm:p-7 md:grid-cols-[1fr_auto] ${verdictTone}`}
			>
				<div className="min-w-0 space-y-3">
					<p className="flex items-center gap-2 text-muted-foreground text-sm">
						<ShieldCheck className="size-4" aria-hidden="true" />
						{m.ip_verdict_label()}
					</p>
					<p className="break-all font-mono font-semibold text-2xl sm:text-3xl">
						<span aria-hidden="true">{flag(claude?.country ?? null)} </span>
						{showIp(claude?.ip)}
					</p>
					<h2 className="font-semibold text-xl">
						{!started
							? m.ip_waiting()
							: busy && !claude
								? m.ip_loading()
								: verdictTitles[verdict]()}
					</h2>
					<p className="text-muted-foreground text-sm leading-6">
						{!started
							? m.ip_waiting_body()
							: busy && !claude
								? m.ip_loading_body()
								: verdictBodies[verdict]()}
					</p>
					<div className="flex flex-wrap gap-2">
						{claude?.country && (
							<Badge level="unknown">
								{countryName(claude.country) ?? claude.country}
							</Badge>
						)}
						{claude && (
							<Badge level="unknown">
								{claude.ip.includes(":") ? "IPv6" : "IPv4"}
							</Badge>
						)}
						{deviceLookup?.mode === "intelligence" && (
							<Badge level={cards[3]?.level ?? "unknown"}>
								{(typeLabels[deviceLookup.type] ?? m.ip_type_unknown)()}
							</Badge>
						)}
						{cards.map((card) =>
							!advisoryCards.has(card.id) &&
							(card.level === "bad" || card.level === "warn") ? (
								<Badge key={card.id} level={card.level}>
									{`${cardTitles[card.id]()} · ${statusLabels[card.status]?.() ?? card.status}`}
								</Badge>
							) : null,
						)}
					</div>
				</div>
				<div className="flex items-center gap-4 md:flex-col md:justify-center">
					<div
						className={`grid size-28 place-items-center rounded-full border-8 ${
							deviceLookup?.score == null
								? "border-muted"
								: deviceLookup.score >= 90
									? "border-primary"
									: deviceLookup.score >= 50
										? "border-amber-500"
										: "border-destructive"
						}`}
					>
						<div className="text-center">
							<p className="font-bold text-3xl">{deviceLookup?.score ?? "—"}</p>
							<p className="text-muted-foreground text-xs">/100</p>
						</div>
					</div>
					<p className="max-w-40 text-center text-muted-foreground text-xs">
						{m.ip_score_title()}
					</p>
				</div>
			</section>

			<section className="space-y-4 rounded-2xl border bg-card p-5 sm:p-7">
				<h2 className="flex items-center gap-2 font-semibold">
					<Network className="size-4" aria-hidden="true" />
					{m.ip_exits_title()}
				</h2>
				<div className="grid gap-3 md:grid-cols-3">
					{(
						[
							[
								m.ip_exit_china(),
								exits.china,
								hideChina ? null : china?.ip,
								hideChina ? m.ip_hidden() : china?.location,
								hideChina,
							],
							[
								m.ip_exit_site(),
								exits.site,
								site?.ip,
								site
									? [countryName(site.country), site.colo]
											.filter(Boolean)
											.join(" · ")
									: null,
								false,
							],
							[
								m.ip_exit_claude(),
								exits.services.claude ?? null,
								claude?.ip,
								claude
									? [countryName(claude.country), claude.colo]
											.filter(Boolean)
											.join(" · ")
									: null,
								false,
							],
						] as const
					).map(([label, probe, ip, detail, hidden]) => (
						<div key={label} className="space-y-1 rounded-xl bg-muted/40 p-4">
							<p className="text-muted-foreground text-xs">{label}</p>
							<p className="break-all font-mono font-semibold">
								{hidden
									? "••••"
									: probe === null
										? started
											? "…"
											: "—"
										: probe.state === "error"
											? m.ip_exit_failed()
											: showIp(ip)}
							</p>
							<p className="text-muted-foreground text-xs">{detail || "—"}</p>
						</div>
					))}
				</div>
				{site && claude && site.ip !== claude.ip && (
					<p className="rounded-lg bg-primary/5 p-3 text-sm">
						{m.ip_exit_split()}
					</p>
				)}
				<ul className="divide-y text-sm">
					<li className="hidden grid-cols-[7rem_1fr_1fr_5rem] gap-3 pb-2 text-muted-foreground text-xs sm:grid">
						<span>{m.ip_col_service()}</span>
						<span>{m.ip_col_ip()}</span>
						<span>{m.ip_col_location()}</span>
						<span className="text-right">{m.ip_col_latency()}</span>
					</li>
					{aiServices.map((service) => {
						const probe = exits.services[service.id];
						const exit = okValue(probe);
						return (
							<li
								key={service.id}
								className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 py-2.5 sm:grid-cols-[7rem_1fr_1fr_5rem]"
							>
								<span className="font-medium">{service.name}</span>
								<span className="text-right sm:order-last">
									{exit ? (
										<Badge
											level={latencyLevel(exit.ms)}
										>{`${exit.ms} ms`}</Badge>
									) : probe?.state === "error" ? (
										<Badge level="bad">{m.ip_unreachable()}</Badge>
									) : null}
								</span>
								<span className="break-all font-mono text-xs sm:text-sm">
									{exit
										? showIp(exit.ip)
										: probe?.state === "error"
											? m.ip_exit_failed()
											: started
												? "…"
												: "—"}
								</span>
								<span className="text-right text-muted-foreground text-xs sm:text-left sm:text-foreground sm:text-sm">
									{exit
										? `${flag(exit.country)} ${[countryName(exit.country), exit.colo].filter(Boolean).join(" · ")}`
										: "—"}
								</span>
							</li>
						);
					})}
				</ul>
				{differentServices.length > 0 && (
					<p className="text-muted-foreground text-xs leading-5">
						{m.ip_exit_differs({
							names: differentServices.map((s) => s.name).join(", "),
						})}
					</p>
				)}
			</section>

			<section className="space-y-4">
				<h2 className="flex items-center gap-2 font-semibold text-lg">
					<Gauge className="size-4" aria-hidden="true" />
					{m.ip_cards_title()}
				</h2>
				<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
					{cards.map((card) => (
						<article
							key={card.id}
							className="space-y-3 rounded-2xl border bg-card p-4"
						>
							<div className="flex items-start justify-between gap-2">
								<h3 className="font-medium">{cardTitles[card.id]()}</h3>
								<Badge level={card.level}>
									{statusLabels[card.status]?.() ?? card.status}
								</Badge>
							</div>
							<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
								<dt className="text-muted-foreground">{m.ip_current()}</dt>
								<dd className="break-words">
									{card.id === "region"
										? (countryName(card.current) ?? "—")
										: card.id === "network" && card.current
											? (typeLabels[card.current] ?? m.ip_type_unknown)()
											: card.id === "webrtc" && card.current
												? m.ip_webrtc_count({ count: card.current })
												: (card.current ?? "—")}
								</dd>
								<dt className="text-muted-foreground">{m.ip_advice()}</dt>
								<dd>{adviceLabels[card.advice]?.() ?? "—"}</dd>
							</dl>
							{card.id === "timezone" && deviceLookup?.networkTimezone && (
								<p className="text-muted-foreground text-xs">
									{m.ip_tz_exit({ zone: deviceLookup.networkTimezone })}
								</p>
							)}
							{card.id === "dns" && typeof dns === "object" && dns && (
								<p className="break-all text-muted-foreground text-xs">
									{m.ip_dns_resolver()}: {showIp(dns.resolver)}
								</p>
							)}
							{card.id === "webrtc" && (
								<div className="space-y-2">
									{rtc !== "disabled" && (
										<Button
											size="sm"
											variant="outline"
											className="h-auto whitespace-normal text-left"
											disabled={rtc === "busy"}
											onClick={probeRtc}
										>
											{rtc === "busy" ? m.ip_loading() : m.ip_webrtc_start()}
										</Button>
									)}
									{(card.level === "bad" || card.level === "warn") && (
										<a
											href="https://chromewebstore.google.com/detail/webrtc-leak-shield/bppamachkoflopbagkdoflbgfjflfnfl"
											target="_blank"
											rel="noopener noreferrer"
											className="block text-primary text-sm underline underline-offset-4"
										>
											{m.ip_webrtc_shield()} ↗
										</a>
									)}
									{rtc === "error" && (
										<p className="text-xs">{m.ip_webrtc_unavailable()}</p>
									)}
									{Array.isArray(rtc) &&
										rtc.map((ip) => (
											<p className="break-all font-mono text-xs" key={ip}>
												{showIp(ip)}
											</p>
										))}
									{rtc !== "disabled" && (
										<p className="text-muted-foreground text-xs leading-5">
											{m.ip_webrtc_note()}
										</p>
									)}
								</div>
							)}
						</article>
					))}
				</div>
			</section>

			<div className="grid items-start gap-6 lg:grid-cols-2">
				<section className="space-y-4 rounded-2xl border bg-card p-5 sm:p-7">
					<h2 className="font-semibold">
						{target ? m.ip_profile_other() : m.ip_profile_title()}
					</h2>
					{target && (
						<p className="rounded-lg bg-amber-500/10 p-3 text-sm">
							{m.ip_query_other()}
						</p>
					)}
					{lookup ? (
						<>
							<p className="break-all font-mono text-sm">{showIp(lookup.ip)}</p>
							<dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
								{profileRows.map(([label, value]) => (
									<div key={label} className="min-w-0">
										<dt className="text-muted-foreground text-xs">{label}</dt>
										<dd className="break-words">{value || "—"}</dd>
									</div>
								))}
							</dl>
							{lookup.mode === "intelligence" && (
								<ul className="divide-y text-sm">
									{flagRows.map(({ label, value }) => (
										<li
											key={label}
											className="flex items-center justify-between py-2"
										>
											<span>{label}</span>
											<Badge
												level={
													value === null ? "unknown" : value ? "warn" : "good"
												}
											>
												{value === null
													? m.ip_st_unknown()
													: value
														? m.ip_flag_yes()
														: m.ip_flag_no()}
											</Badge>
										</li>
									))}
								</ul>
							)}
							{lookup.warning && (
								<output className="block rounded-lg bg-amber-500/10 p-3 text-sm">
									{lookup.warning === "verify"
										? m.ip_verify_expired()
										: m.ip_provider_warning()}
								</output>
							)}
							{lookup.score !== null && (
								<p className="text-muted-foreground text-xs">
									{lookup.ranking && lookup.ranking.total >= 20
										? m.ip_rank({
												percent: lookup.ranking.percentile,
												count: lookup.ranking.total,
											})
										: m.ip_rank_wait({ count: lookup.ranking?.total ?? 0 })}
								</p>
							)}
							<div className="flex flex-wrap gap-2">
								<Button
									disabled={lookup.score === null || busy || sharing}
									ref={shareButtonRef}
									onClick={makeShare}
								>
									{sharing ? m.ip_share_busy() : m.ip_share()}
								</Button>
								<Button variant="outline" onClick={copyLink}>
									{m.ip_share_copy()}
								</Button>
							</div>
							<output className="block text-sm">{shareMessage}</output>
						</>
					) : (
						<p
							className="text-muted-foreground text-sm"
							role={lookupFailed ? "alert" : undefined}
						>
							{lookupFailed
								? m.ip_error()
								: busy
									? m.ip_loading()
									: started && !claude && !target
										? m.ip_no_claude_exit()
										: m.ip_waiting()}
						</p>
					)}
					<p className="text-muted-foreground text-xs">
						{m.ip_policy_date({ date: regionPolicyDate })}
					</p>
				</section>

				<section className="space-y-4 rounded-2xl border bg-card p-5 sm:p-7">
					<h2 className="flex items-center gap-2 font-semibold">
						<Fingerprint className="size-4" aria-hidden="true" />
						{m.ip_env_title()}
					</h2>
					{environment ? (
						<dl className="divide-y text-sm">
							{(
								[
									[m.ip_env_canvas(), environment.canvasHash, true],
									[m.ip_env_webgl(), environment.webglHash, true],
									[m.ip_env_gpu(), environment.gpuRenderer, false],
									[m.ip_env_os(), environment.os, false],
									[m.ip_env_platform(), environment.platform, false],
									[m.ip_env_browser(), environment.browser, false],
									[m.ip_env_screen(), environment.screen, false],
									[
										m.ip_env_hardware(),
										[
											environment.cores
												? m.ip_env_cores({ count: environment.cores })
												: null,
											environment.memory ? `${environment.memory} GB` : null,
										]
											.filter(Boolean)
											.join(" · ") || null,
										false,
									],
									[
										m.ip_env_language(),
										environment.languages.join(", "),
										false,
									],
									[m.ip_env_timezone(), environment.timezone, false],
									[
										m.ip_env_automation(),
										environment.webdriver ? m.ip_flag_yes() : m.ip_flag_no(),
										false,
									],
								] as const
							).map(([label, value, code]) => (
								<div
									key={label}
									className="flex items-start justify-between gap-4 py-2"
								>
									<dt className="shrink-0 text-muted-foreground">{label}</dt>
									<dd
										className={`break-all text-right ${code ? "font-mono" : ""}`}
									>
										{code && hideFingerprint ? "••••••••" : value || "—"}
									</dd>
								</div>
							))}
						</dl>
					) : (
						<p className="text-muted-foreground text-sm">{m.ip_loading()}</p>
					)}
					<p className="text-muted-foreground text-xs leading-5">
						{m.ip_env_note()}
					</p>
				</section>
			</div>

			<form
				className="space-y-3 rounded-2xl border p-5"
				onSubmit={(event) => {
					event.preventDefault();
					if (query.trim() && !publicIpSchema.safeParse(query.trim()).success) {
						setQueryError(true);
						return;
					}
					setQueryError(false);
					again(query.trim());
				}}
			>
				<label className="block font-medium text-sm" htmlFor="query-ip">
					{m.ip_query_label()}
				</label>
				<div className="flex flex-wrap gap-2">
					<input
						id="query-ip"
						aria-invalid={queryError}
						aria-describedby={queryError ? "query-error" : undefined}
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						maxLength={45}
						placeholder={m.ip_query_placeholder()}
						className="min-w-0 flex-1 rounded-lg border bg-background px-3 py-2 text-sm"
					/>
					<Button disabled={busy} type="submit">
						{m.ip_query_button()}
					</Button>
					<Button
						disabled={busy}
						variant="outline"
						type="button"
						onClick={() => {
							setQuery("");
							setQueryError(false);
							again("");
						}}
					>
						{m.ip_query_current()}
					</Button>
				</div>
				{queryError && (
					<p id="query-error" role="alert" className="text-destructive text-sm">
						{m.ip_query_invalid()}
					</p>
				)}
				<p className="text-muted-foreground text-xs leading-5">
					{m.ip_query_notice()}
				</p>
			</form>

			<details id="guide" className="rounded-2xl border p-5">
				<summary className="cursor-pointer rounded font-semibold focus-visible:outline-2">
					{m.ip_guide()}
				</summary>
				<div className="mt-4 space-y-6">
					{(
						[
							[m.ip_g1_title, m.ip_g1_body],
							[m.ip_g2_title, m.ip_g2_body],
							[m.ip_g3_title, m.ip_g3_body],
							[m.ip_g4_title, m.ip_g4_body],
							[m.ip_g5_title, m.ip_g5_body],
						] as const
					).map(([title, body], index) => (
						<article key={title()} className="space-y-3 border-t pt-5">
							<h3 className="font-semibold">{title()}</h3>
							<p className="max-w-3xl text-muted-foreground text-sm leading-7">
								{body()}
							</p>
							{index === 3 && <LocalChecks />}
						</article>
					))}
					<div className="space-y-2 border-t pt-5">
						<h3 className="font-semibold">{m.ip_coverage_title()}</h3>
						<p className="text-muted-foreground text-sm leading-7">
							{m.ip_coverage_body()}
						</p>
					</div>
					<a
						href="/guides/claude-network-check"
						className="block text-primary text-sm underline"
					>
						{m.ip_read_guide()} →
					</a>
					<a
						href="https://www.anthropic.com/supported-countries"
						target="_blank"
						rel="noopener noreferrer"
						className="block text-primary text-sm underline underline-offset-4"
					>
						{m.ip_policy()} ↗
					</a>
				</div>
			</details>

			<div ref={qr} className="hidden" aria-hidden="true">
				<QRCodeSVG value={checkerShareUrl} size={230} marginSize={4} />
			</div>
			<Dialog
				open={Boolean(share)}
				onOpenChange={(open) => {
					if (!open) setShare(null);
				}}
			>
				<DialogContent
					className="max-h-[90dvh] overflow-y-auto"
					onCloseAutoFocus={(event) => {
						event.preventDefault();
						shareButtonRef.current?.focus();
					}}
				>
					<DialogHeader>
						<DialogTitle>{m.ip_share_title()}</DialogTitle>
						<DialogDescription>{m.ip_share_description()}</DialogDescription>
					</DialogHeader>
					{share && (
						<>
							<img
								src={share.url}
								alt={m.ip_share_title()}
								className="mx-auto max-h-[55vh] w-auto rounded-xl"
							/>
							<div className="flex flex-wrap gap-3">
								<a
									href={share.url}
									download="laoshirenvip-ip-check.png"
									className="rounded-lg bg-primary px-4 py-2 text-primary-foreground text-sm"
								>
									{m.ip_share_download()}
								</a>
								<Button variant="outline" onClick={nativeShare}>
									{m.ip_share_native()}
								</Button>
							</div>
							<output>{shareMessage}</output>
						</>
					)}
				</DialogContent>
			</Dialog>
			<footer className="space-y-5 border-t pt-6">
				<a
					href="/products/ba540b83-388d-45d1-9dcb-25c3da3f9956#claude-purchase-guide"
					className="inline-flex items-center gap-2 text-primary text-sm underline underline-offset-4"
				>
					<ArrowLeft className="size-4" aria-hidden="true" />
					{m.ip_return()}
				</a>
				<p className="text-muted-foreground text-xs">{m.ip_footnote()}</p>
			</footer>
		</div>
	);
}
