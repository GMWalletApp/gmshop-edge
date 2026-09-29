import { describe, expect, it } from "vitest";
import {
	CLIENT_IP_HEADER,
	clientIp,
	isValidIpAddress,
	parseClientIpSource,
	requestPeerAddress,
	resolveClientIp,
	withTrustedClientIp,
} from "#/server/client-ip";

describe("trusted client IP resolution", () => {
	it("uses the Cloudflare header on Workers and ignores forwarded headers", () => {
		const headers = new Headers({
			"cf-connecting-ip": "203.0.113.7",
			"x-forwarded-for": "198.51.100.9, 203.0.113.7",
			"x-real-ip": "198.51.100.9",
		});
		expect(resolveClientIp(headers, "cloudflare")).toBe("203.0.113.7");
	});

	it("trusts proxy headers on Bun only when the connection comes from a private proxy", () => {
		const headers = new Headers({
			"x-forwarded-for": "10.0.0.1, 198.51.100.9",
			"x-real-ip": "198.51.100.9",
			"cf-connecting-ip": "203.0.113.250",
		});
		// Behind a Docker/nginx proxy the peer is a private address.
		expect(resolveClientIp(headers, "bun", "auto", "172.18.0.2")).toBe(
			"198.51.100.9",
		);
		// Directly exposed: the peer is the client and forged headers are ignored.
		expect(resolveClientIp(headers, "bun", "auto", "93.184.216.34")).toBe(
			"93.184.216.34",
		);
		expect(resolveClientIp(headers, "bun", "none", "93.184.216.34")).toBe(
			"93.184.216.34",
		);
	});

	it("takes the right-most forwarded address so clients cannot prepend a fake one", () => {
		const headers = new Headers({
			"x-forwarded-for": "10.0.0.1, 198.51.100.9",
		});
		expect(
			resolveClientIp(headers, "bun", "x-forwarded-for", "127.0.0.1"),
		).toBe("198.51.100.9");
		expect(resolveClientIp(headers, "bun", "auto", "127.0.0.1")).toBe(
			"198.51.100.9",
		);
	});

	it("honours an explicitly configured header and falls back to the peer", () => {
		const headers = new Headers({ "cf-connecting-ip": "203.0.113.7" });
		expect(resolveClientIp(headers, "bun", "auto", "8.8.4.4")).toBe("8.8.4.4");
		expect(resolveClientIp(headers, "bun", "cf-connecting-ip", "8.8.4.4")).toBe(
			"203.0.113.7",
		);
		expect(
			resolveClientIp(new Headers(), "bun", "x-real-ip", "[2001:db8::1]"),
		).toBe("2001:db8::1");
		expect(resolveClientIp(new Headers(), "bun", "auto", null)).toBeNull();
	});

	it("rejects malformed addresses, including IP:port pairs", () => {
		expect(isValidIpAddress("203.0.113.7")).toBe(true);
		expect(isValidIpAddress("::1")).toBe(true);
		expect(isValidIpAddress("999.1.1.1")).toBe(false);
		expect(isValidIpAddress("not-an-ip")).toBe(false);
		expect(isValidIpAddress("1:2:3")).toBe(false);
		expect(isValidIpAddress("203.0.113.5:51234")).toBe(false);
		expect(
			resolveClientIp(
				new Headers({ "x-forwarded-for": "203.0.113.5:51234" }),
				"bun",
				"x-forwarded-for",
				"10.0.0.1",
			),
		).toBe("10.0.0.1");
	});

	it("strips client-supplied trusted headers and stamps the derived address", () => {
		const request = new Request("https://shop.example/", {
			headers: { [CLIENT_IP_HEADER]: "1.1.1.1" },
		});
		const trusted = withTrustedClientIp(request, "203.0.113.7");
		expect(clientIp(trusted)).toBe("203.0.113.7");
		expect(clientIp(withTrustedClientIp(request, null))).toBeNull();
		expect(clientIp(undefined)).toBeNull();
	});

	it("reads the runtime peer address when the server exposes it", () => {
		const request = new Request("https://shop.example/");
		expect(requestPeerAddress(request)).toBeNull();
		Object.defineProperty(request, "ip", { value: "198.51.100.4" });
		expect(requestPeerAddress(request)).toBe("198.51.100.4");
	});

	it("falls back to auto for unknown configured sources", () => {
		expect(parseClientIpSource("x-real-ip")).toBe("x-real-ip");
		expect(parseClientIpSource("bogus")).toBe("auto");
		expect(parseClientIpSource(undefined)).toBe("auto");
	});
});
