import { describe, expect, it, vi } from "vitest";
import {
	assertPublicHostname,
	type DnsResolver,
	fetchOutbound,
} from "#/server/outbound-fetch";

const publicResolver: DnsResolver = async (_hostname, type) =>
	type === "A" ? ["93.184.216.34"] : ["2606:2800:220:1:248:1893:25c8:1946"];

describe("outbound fetch hardening", () => {
	it("rejects non-HTTPS, credentialed, and private-address URLs before fetching", async () => {
		const fetcher = vi.fn<typeof fetch>();
		for (const url of [
			"http://provider.example/api",
			"https://user:secret@provider.example/api",
			"https://10.0.0.8/api",
			"https://[::1]/api",
			"https://metadata.google.internal/computeMetadata/v1/",
		])
			await expect(
				fetchOutbound(url, {}, { fetcher, resolve: publicResolver }),
			).rejects.toMatchObject({ code: "outbound_url_rejected", status: 400 });
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("rejects hostnames that resolve to any non-public address", async () => {
		const fetcher = vi.fn<typeof fetch>();
		await expect(
			fetchOutbound(
				"https://provider.example/api",
				{},
				{
					fetcher,
					resolve: async (_hostname, type) =>
						type === "A" ? ["93.184.216.34", "192.168.1.20"] : [],
				},
			),
		).rejects.toMatchObject({
			code: "outbound_destination_rejected",
			status: 400,
		});
		await expect(
			assertPublicHostname("provider.example", async () => []),
		).rejects.toMatchObject({ code: "outbound_destination_rejected" });
		await expect(
			assertPublicHostname("93.184.216.34", async () => {
				throw new Error("literal addresses need no lookup");
			}),
		).resolves.toBeUndefined();
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("never follows redirects and forwards the request with a timeout", async () => {
		const fetcher = vi.fn<typeof fetch>(
			async () =>
				new Response(null, {
					status: 302,
					headers: { location: "https://169.254.169.254/latest/meta-data" },
				}),
		);
		await expect(
			fetchOutbound(
				"https://provider.example/api/dispatch",
				{
					method: "POST",
					headers: { Authorization: "Bearer token" },
					body: "{}",
				},
				{ fetcher, resolve: publicResolver, timeoutMs: 1_000 },
			),
		).rejects.toMatchObject({
			code: "outbound_redirect_rejected",
			status: 502,
		});
		const [url, init] = fetcher.mock.calls[0] ?? [];
		expect(url).toBe("https://provider.example/api/dispatch");
		expect(init).toMatchObject({ method: "POST", redirect: "manual" });
		expect(init?.signal).toBeInstanceOf(AbortSignal);
	});

	it("maps network failures to a structured error", async () => {
		await expect(
			fetchOutbound(
				"https://provider.example/api",
				{},
				{
					fetcher: async () => {
						throw new TypeError("fetch failed");
					},
					resolve: publicResolver,
				},
			),
		).rejects.toMatchObject({ code: "outbound_request_failed", status: 502 });
	});

	it("bounds the response body and keeps small responses readable", async () => {
		const cancel = vi.fn();
		await expect(
			fetchOutbound(
				"https://provider.example/api",
				{},
				{
					fetcher: async () =>
						new Response(
							new ReadableStream<Uint8Array>({
								start(controller) {
									controller.enqueue(new Uint8Array(40_000));
									controller.enqueue(new Uint8Array(40_000));
								},
								cancel,
							}),
						),
					resolve: publicResolver,
					maxResponseBytes: 64_000,
				},
			),
		).rejects.toMatchObject({
			code: "outbound_response_too_large",
			status: 502,
		});
		expect(cancel).toHaveBeenCalledWith("body_too_large");
		const bounded = await fetchOutbound(
			"https://provider.example/api",
			{},
			{
				fetcher: async () => Response.json({ id: 7 }, { status: 201 }),
				resolve: publicResolver,
				maxResponseBytes: 64_000,
			},
		);
		expect(bounded.status).toBe(201);
		await expect(bounded.json()).resolves.toEqual({ id: 7 });
		const empty = await fetchOutbound(
			"https://provider.example/api",
			{},
			{
				fetcher: async () => new Response(null, { status: 204 }),
				resolve: publicResolver,
				maxResponseBytes: 64_000,
			},
		);
		expect(empty.status).toBe(204);
	});

	it("skips the DNS proof only when explicitly disabled", async () => {
		const resolve = vi.fn<DnsResolver>(async () => ["93.184.216.34"]);
		const fetcher: typeof fetch = async () => new Response("ok");
		await fetchOutbound(
			"https://provider.example/api",
			{},
			{ fetcher, resolve },
		);
		expect(resolve).toHaveBeenCalledTimes(2);
		await fetchOutbound(
			"https://provider.example/api",
			{},
			{ fetcher, resolve, validateDestination: false },
		);
		expect(resolve).toHaveBeenCalledTimes(2);
	});
});
