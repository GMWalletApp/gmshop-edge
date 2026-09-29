import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	decimalToMinor,
	markupMinor,
	multiplyMinor,
} from "#/features/suppliers/money";
import { AcgAdapter } from "#/features/suppliers/providers/acg";
import { DujiaoNextAdapter } from "#/features/suppliers/providers/dujiao-next";
import { GmshopEdgeAdapter } from "#/features/suppliers/providers/gmshop-edge";
import {
	providerRequestNumber,
	signAcgForm,
	signDujiaoNextRequest,
} from "#/features/suppliers/providers/signatures";
import {
	createSupplierCredentialVault,
	readSupplierCredentials,
	rotateSupplierCredentialVault,
	supplierCredentialFingerprint,
} from "#/features/suppliers/secrets";
import { assertPublicSupplierHostname } from "#/features/suppliers/server/destination-security";
import {
	normalizeSupplierSource,
	sameSupplierSource,
} from "#/features/suppliers/server/source-url";
import { createSecretKeyring } from "#/lib/secrets";

describe("supplier source identity", () => {
	it("normalizes equivalent HTTPS origins without a persisted source key", () => {
		const left = normalizeSupplierSource("acg", "https://SHOP.example.com/");
		const right = normalizeSupplierSource(
			"acg",
			"https://shop.example.com:443",
		);
		expect(left).toEqual({
			provider: "acg",
			baseUrl: "https://shop.example.com",
			normalizedApiOrigin: "https://shop.example.com",
			protocolVersion: "3.5.5-v4",
		});
		expect(sameSupplierSource(left, right)).toBe(true);
	});

	it.each([
		"http://shop.example.com",
		"https://user:secret@shop.example.com",
		"https://shop.example.com/path",
		"https://shop.example.com?query=1",
		"https://127.0.0.1",
		"https://localhost",
		"https://shop.example.com:8443",
	])("rejects unsafe or non-origin URL %s", (value) => {
		expect(() => normalizeSupplierSource("dujiao_next", value)).toThrow(
			"Supplier API URL must be a public HTTPS origin",
		);
	});
});

describe("supplier destination DNS", () => {
	it("accepts a hostname only when every answer is public", async () => {
		await expect(
			assertPublicSupplierHostname("supplier.example", async (_host, type) =>
				type === "A" ? ["8.8.8.8"] : ["2606:4700:4700::1111"],
			),
		).resolves.toBeUndefined();
	});

	it.each([
		"127.0.0.1",
		"10.0.0.1",
		"169.254.1.1",
		"192.168.1.1",
		"::1",
		"fd00::1",
	])("rejects a hostname resolving to private address %s", async (address) => {
		await expect(
			assertPublicSupplierHostname("supplier.example", async (_host, type) =>
				(type === "A") === address.includes(".") ? [address] : [],
			),
		).rejects.toMatchObject({ code: "supplier_destination_rejected" });
	});

	it("rejects DNS rebinding when any answer becomes private", async () => {
		await expect(
			assertPublicSupplierHostname("supplier.example", async (_host, type) =>
				type === "A" ? ["8.8.8.8", "10.0.0.8"] : [],
			),
		).rejects.toMatchObject({ code: "supplier_destination_rejected" });
	});
});

describe("supplier provider signatures", () => {
	it("connects to a native GMShop Edge supplier with signed requests", async () => {
		const adapter = new GmshopEdgeAdapter({
			baseUrl: "https://supplier.example",
			apiKey: "gme_test",
			apiSecret: "a".repeat(64),
			currency: "USD",
			currencyDecimals: 2,
			now: () => 1_700_000_000_000,
			nonce: () => "00000000-0000-4000-8000-000000000001",
			fetcher: async (input, init) => {
				const request = new Request(input, init);
				expect(request.headers.get("GMShop-Edge-Api-Key")).toBe("gme_test");
				expect(request.headers.get("GMShop-Edge-Signature")).toMatch(
					/^[a-f0-9]{64}$/,
				);
				return Response.json({
					site_name: "Upstream",
					balance_minor: "1234",
					currency: "USD",
				});
			},
		});
		expect(await adapter.testConnection()).toEqual({
			siteName: "Upstream",
			balance: { amountMinor: "1234", currency: "USD" },
		});
	});
	it("sorts non-empty ACG fields and appends the key", () => {
		const expected = createHash("md5")
			.update("quantity=2&sku_id=sku-1&trade_no=trade-1&key=secret")
			.digest("hex");
		expect(
			signAcgForm(
				{
					trade_no: "trade-1",
					ignored: "",
					sku_id: "sku-1",
					quantity: "2",
				},
				"secret",
			),
		).toBe(expected);
	});

	it("signs the exact Dujiao Next request payload", () => {
		const rawBody = '{"sku_id":"sku-1","quantity":2}';
		const timestamp = "1784935000";
		const bodyMd5 = createHash("md5").update(rawBody).digest("hex");
		const payload = `POST\n/api/v1/upstream/orders\n${timestamp}\n${bodyMd5}`;
		const expected = createHmac("sha256", "secret")
			.update(payload)
			.digest("hex");
		expect(
			signDujiaoNextRequest({
				method: "post",
				path: "/api/v1/upstream/orders",
				timestamp,
				rawBody,
				apiSecret: "secret",
			}),
		).toBe(expected);
	});

	it("derives stable account-scoped request numbers", () => {
		const acg = providerRequestNumber("acg", "order-1", "account-a");
		expect(acg).toHaveLength(24);
		expect(providerRequestNumber("acg", "order-1", "account-a")).toBe(acg);
		expect(providerRequestNumber("acg", "order-1", "account-b")).not.toBe(acg);
		expect(
			providerRequestNumber("dujiao_next", "order-1", "account-a"),
		).toMatch(/^gm_[a-f0-9]{40}$/);
	});
});

describe("supplier money", () => {
	it("converts decimal wire amounts without floating point", () => {
		expect(decimalToMinor("12.34", 2)).toBe("1234");
		expect(decimalToMinor("12", 2)).toBe("1200");
		expect(decimalToMinor("0.1", 2)).toBe("10");
		expect(multiplyMinor("900719925474099312345", 3)).toBe(
			"2702159776422297937035",
		);
		expect(markupMinor("101", "7", 500)).toBe("114");
	});

	it.each(["-1", "1.234", "1e2", "01", "NaN"])(
		"rejects invalid provider money %s",
		(value) => {
			expect(() => decimalToMinor(value, 2)).toThrow(
				"Supplier returned an invalid monetary value",
			);
		},
	);
});

describe("supplier credential vault", () => {
	it("keeps old revisions available for uncertain orders after rotation", async () => {
		const commerceSecret = createSecretKeyring();
		const encrypted = await createSupplierCredentialVault(
			"acg",
			{ apiId: "old-id", appKey: "old-key" },
			commerceSecret,
		);
		const rotated = await rotateSupplierCredentialVault(
			encrypted,
			"acg",
			{ apiId: "new-id", appKey: "new-key" },
			commerceSecret,
		);
		expect(rotated.revision).toBe(2);
		await expect(
			readSupplierCredentials(rotated.encrypted, 1, "acg", commerceSecret),
		).resolves.toEqual({ apiId: "old-id", appKey: "old-key" });
		await expect(
			readSupplierCredentials(rotated.encrypted, 2, "acg", commerceSecret),
		).resolves.toEqual({ apiId: "new-id", appKey: "new-key" });
	});

	it("derives deterministic purpose-separated fingerprints", async () => {
		const commerceSecret = createSecretKeyring();
		const credentials = { apiKey: "key", apiSecret: "secret" };
		const left = await supplierCredentialFingerprint(
			"dujiao_next",
			credentials,
			commerceSecret,
		);
		const right = await supplierCredentialFingerprint(
			"dujiao_next",
			{ apiSecret: "secret", apiKey: "key" },
			commerceSecret,
		);
		expect(left).toBe(right);
		expect(left).toMatch(/^[a-f0-9]{64}$/);
	});
});

describe("Dujiao Next adapter", () => {
	it("signs ping and normalizes its balance", async () => {
		let request: Request | undefined;
		const adapter = new DujiaoNextAdapter({
			baseUrl: "https://supplier.example",
			apiKey: "api-key",
			apiSecret: "api-secret",
			currency: "CNY",
			currencyDecimals: 2,
			now: () => 1_784_935_000_000,
			fetcher: async (input, init) => {
				request = new Request(input, init);
				return Response.json({
					ok: true,
					site_name: "Supplier",
					balance: "12.34",
					currency: "CNY",
				});
			},
		});
		await expect(adapter.testConnection()).resolves.toEqual({
			siteName: "Supplier",
			balance: { amountMinor: "1234", currency: "CNY" },
		});
		expect(request?.url).toBe("https://supplier.example/api/v1/upstream/ping");
		expect(request?.headers.get("Dujiao-Next-Api-Key")).toBe("api-key");
		expect(request?.headers.get("Dujiao-Next-Timestamp")).toBe("1784935000");
		expect(request?.headers.get("Dujiao-Next-Signature")).toBe(
			signDujiaoNextRequest({
				method: "POST",
				path: "/api/v1/upstream/ping",
				timestamp: "1784935000",
				rawBody: "",
				apiSecret: "api-secret",
			}),
		);
	});

	it("normalizes localized products and unlimited stock", async () => {
		const adapter = new DujiaoNextAdapter({
			baseUrl: "https://supplier.example",
			apiKey: "key",
			apiSecret: "secret",
			currency: "CNY",
			currencyDecimals: 2,
			fetcher: async (input) =>
				new URL(String(input)).pathname.endsWith("/categories")
					? Response.json({ ok: true, categories: [] })
					: Response.json({
							total: 1,
							items: [
								{
									id: 3,
									title: { "en-US": "English", "zh-CN": "中文" },
									description: { "en-US": "Description" },
									images: [],
									tags: ["Tag"],
									currency: "CNY",
									is_active: true,
									skus: [
										{
											id: 9,
											sku_code: "SKU",
											spec_values: {},
											price_amount: "8.50",
											stock_quantity: -1,
											is_active: true,
										},
									],
								},
							],
						}),
		});
		await expect(
			adapter.listProducts({ page: 1, pageSize: 20 }),
		).resolves.toEqual({
			total: 1,
			products: [
				{
					id: "3",
					name: "中文",
					description: "Description",
					imageUrls: [],
					categoryNames: ["Tag"],
					active: true,
					skus: [
						{
							id: "9",
							name: "SKU",
							costMinor: "850",
							stockQuantity: 2_147_483_647,
							active: true,
						},
					],
				},
			],
		});
	});
});

describe("ACG adapter", () => {
	it("uses V4 headers and normalizes its catalog", async () => {
		const requests: Request[] = [];
		const adapter = new AcgAdapter({
			baseUrl: "https://supplier.example",
			apiId: "api-id",
			appKey: "app-key",
			currency: "CNY",
			currencyDecimals: 2,
			fetcher: async (input, init) => {
				requests.push(new Request(input, init));
				return Response.json({
					code: 200,
					data: [
						{
							id: 1,
							name: "Product",
							introduce: "Description",
							picture_url: "https://supplier.example/image.png",
							category: { name: "Category" },
							sku: [
								{
									id: 2,
									name: "SKU",
									stock_price: "3.50",
									stock: "9",
								},
							],
						},
					],
				});
			},
		});
		await expect(
			adapter.listProducts({ page: 1, pageSize: 20 }),
		).resolves.toMatchObject({
			total: 1,
			products: [
				{
					id: "1",
					name: "Product",
					categoryNames: ["Category"],
					skus: [{ id: "2", costMinor: "350", stockQuantity: 9 }],
				},
			],
		});
		expect(requests[0]?.headers.get("Api-Id")).toBe("api-id");
		expect(requests[0]?.headers.get("Api-Signature")).toBe(
			signAcgForm({}, "app-key"),
		);
		expect(requests[0]?.redirect).toBe("manual");
	});

	it("reuses the trade number when reconciling", async () => {
		const bodies: string[] = [];
		const adapter = new AcgAdapter({
			baseUrl: "https://supplier.example",
			apiId: "api-id",
			appKey: "app-key",
			currency: "CNY",
			currencyDecimals: 2,
			fetcher: async (_input, init) => {
				bodies.push(String(init?.body));
				return Response.json({
					code: 200,
					data: { contents: "CARD-1\nCARD-2" },
				});
			},
		});
		await expect(
			adapter.reconcileOrder({
				upstreamOrderId: "trade-123",
				skuId: "2",
				quantity: 2,
				requestNo: "trade-123",
				callbackUrl: "",
				traceId: "",
			}),
		).resolves.toMatchObject({
			status: "supplied",
			upstreamOrderId: "trade-123",
			cards: ["CARD-1", "CARD-2"],
		});
		expect(bodies[0]).toContain("trade_no=trade-123");
	});
});
