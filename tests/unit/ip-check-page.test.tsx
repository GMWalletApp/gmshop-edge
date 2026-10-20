// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IpCheckPage } from "#/features/ip-check/page";
import { overwriteGetLocale } from "#/paraglide/runtime";

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
const lookup = {
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
};
const trace = (ip: string, colo = "BOS") =>
	new Response(`fl=1\nip=${ip}\nloc=US\ncolo=${colo}\n`);
type Routes = Partial<Record<string, () => Response | Promise<Response>>>;
function stubFetch(routes: Routes = {}) {
	const defaults: Routes = {
		"claude.ai": () => trace("161.77.8.204"),
		"anthropic.com": () => trace("161.77.8.204"),
		"chatgpt.com": () => trace("161.77.8.204"),
		"grok.com": () => trace("64.186.226.85", "LAX"),
		"/cdn-cgi/trace": () => trace("64.186.226.85", "LAX"),
		"ipip.net": () =>
			Response.json({
				ret: "ok",
				data: { ip: "125.83.245.226", location: ["中国", "重庆", "电信"] },
			}),
		"edns.ip-api.com": () =>
			Response.json({
				dns: { ip: "172.253.0.23", geo: "United States - Google LLC" },
			}),
		"/api/ip-check": () => Response.json(lookup),
	};
	const all = { ...defaults, ...routes };
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => {
			// Most specific first: "/cdn-cgi/trace" must not swallow claude.ai.
			const key = Object.keys(all)
				.filter((k) => url.includes(k))
				.sort((a, b) => b.length - a.length)
				.find((k) => !(k === "/cdn-cgi/trace" && url.startsWith("https://")));
			const handler = key ? all[key] : undefined;
			if (!handler) throw new Error(`unexpected ${url}`);
			return handler();
		}),
	);
}
const calls = () => vi.mocked(fetch).mock.calls.map(([url]) => String(url));
async function render() {
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<IpCheckPage />
			</QueryClientProvider>,
		),
	);
	// Let the probe promises settle.
	for (let i = 0; i < 5; i++) await act(async () => {});
}
beforeEach(() => {
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
	overwriteGetLocale(() => "zh-CN");
	client = new QueryClient();
	client.setQueryData(["public", "turnstile"], { enabled: false, siteKey: "" });
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	stubFetch();
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

it.each([
	"zh-CN",
	"en-US",
] as const)("%s: measures the Claude exit, scores it, and masks IPs by default", async (locale) => {
	overwriteGetLocale(() => locale);
	await render();
	expect(calls()).toContain("https://claude.ai/cdn-cgi/trace");
	expect(calls()).toContain("/api/ip-check?ip=161.77.8.204");
	// Never scores the site-facing exit when Claude sees another one.
	expect(calls()).not.toContain("/api/ip-check?ip=64.186.226.85");
	expect(container.textContent).toContain("161.•••.•••.204");
	expect(container.textContent).not.toContain("161.77.8.204");
	expect(container.textContent).not.toContain("125.83.245.226");
	expect(container.querySelectorAll("section article")).toHaveLength(7);
	const hideIp = container.querySelector<HTMLInputElement>(
		'input[role="switch"]',
	);
	await act(async () => hideIp?.click());
	expect(container.textContent).toContain("161.77.8.204");
	// Domestic exit has its own switch and stays hidden.
	expect(container.textContent).not.toContain("125.83.245.226");
});

it("shows the split-routing notice and the overall verdict", async () => {
	await render();
	expect(container.textContent).toContain("你开了分流");
	expect(container.textContent).toContain("可以正常使用");
	expect(container.textContent).toContain("Grok 和 Claude 走的出口不同");
});

it("without a Claude exit there is no lookup and no verdict", async () => {
	stubFetch({ "claude.ai": () => new Response("blocked", { status: 403 }) });
	await render();
	expect(calls().some((u) => u.startsWith("/api/ip-check"))).toBe(false);
	expect(container.textContent).toContain("没有测到 Claude 出口");
	expect(container.textContent).not.toContain("可以正常使用");
});

it("invalid lookup JSON becomes a visible error, never a fabricated score", async () => {
	stubFetch({
		"/api/ip-check": () => Response.json({ status: "safe", score: 100 }),
	});
	await render();
	expect(container.querySelector('[role="alert"]')?.textContent).toContain(
		"检测未完成",
	);
	expect(container.textContent).not.toContain("可以正常使用");
});

it("waits for the human check and sends the token with the lookup", async () => {
	client.setQueryData(["public", "turnstile"], {
		enabled: true,
		siteKey: "public-test",
	});
	let callbacks: Record<string, (token?: string) => void> = {};
	Object.assign(window, {
		turnstile: {
			render: vi.fn((_element, options) => {
				callbacks = options;
				return "widget";
			}),
			remove: vi.fn(),
		},
	});
	await render();
	expect(fetch).not.toHaveBeenCalled();
	expect(container.textContent).toContain("请先完成人机验证");
	await act(async () => {
		document
			.querySelector<HTMLScriptElement>(
				'script[src*="challenges.cloudflare.com"]',
			)
			?.dispatchEvent(new Event("load"));
	});
	expect(callbacks.action).toBe("ipcheck");
	await act(async () => callbacks.callback?.("one-time-token"));
	for (let i = 0; i < 5; i++) await act(async () => {});
	const lookupCall = vi
		.mocked(fetch)
		.mock.calls.find(([url]) => String(url).startsWith("/api/ip-check"));
	expect(lookupCall?.[1]).toMatchObject({
		headers: { "cf-turnstile-response": "one-time-token" },
	});
	// Exactly one lookup per token.
	expect(calls().filter((u) => u.startsWith("/api/ip-check"))).toHaveLength(1);
});

it("fingerprint codes are shown with conclusions and can be hidden", async () => {
	await render();
	const text = () => container.textContent ?? "";
	expect(text()).toContain("浏览器环境与指纹");
	expect(text()).toContain("不上传、不保存");
	const toggle = [
		...container.querySelectorAll<HTMLInputElement>('input[role="switch"]'),
	][2];
	await act(async () => toggle?.click());
	expect(toggle?.checked).toBe(true);
	expect(text()).toContain("••••••••");
});
