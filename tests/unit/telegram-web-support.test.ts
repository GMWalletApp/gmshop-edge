import { describe, expect, it } from "vitest";
import {
	describeDevice,
	parseDevice,
	webSupportConversationSchema,
} from "#/features/telegram/web-support-contract";

const desktop =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/142.0.0.0 Safari/537.36";
const phone =
	"Mozilla/5.0 (Linux; Android 15; Pixel 8 Build/AP3A) AppleWebKit/537.36 Chrome/142.0 Mobile Safari/537.36";
const tablet =
	"Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";

describe("Telegram web support", () => {
	it("classifies common desktop, phone, and tablet user agents", () => {
		expect(parseDevice(desktop)).toMatchObject({
			deviceType: "desktop",
			deviceDetails: "Windows",
			browser: "Chrome 142.0",
		});
		expect(parseDevice(phone)).toMatchObject({
			deviceType: "phone",
			deviceDetails: null,
		});
		expect(parseDevice(tablet)).toMatchObject({
			deviceType: "tablet",
			deviceDetails: "Apple iPad",
		});
		expect(parseDevice(null)).toEqual({
			browser: null,
			system: null,
			deviceType: "unknown",
			deviceDetails: null,
		});
	});

	it("describes devices in the requested locale", () => {
		expect(describeDevice(parseDevice(desktop), "en-US")).toBe(
			"Desktop · Windows",
		);
		expect(describeDevice(parseDevice(phone), "en-US")).toBe("Phone");
		expect(describeDevice(parseDevice(tablet), "en-US")).toBe(
			"Tablet · Apple iPad",
		);
		expect(describeDevice(parseDevice(desktop), "zh-CN")).toBe(
			"电脑 · Windows",
		);
		expect(describeDevice(parseDevice(phone), "zh-CN")).toBe("手机");
		expect(describeDevice(parseDevice(null), "zh-CN")).toBe("未知设备");
	});

	it("accepts only bounded public keys and fingerprint identifiers", () => {
		const valid = {
			email: "customer@example.com",
			visitorId: "2ee02db9-c7b7-4728-8399-537d4e6c1e9c",
			publicKeyJwk: { kty: "RSA", n: "a".repeat(342), e: "AQAB" },
			fingerprint: { visitorId: "a".repeat(32), version: "5.2.0" },
			diagnostics: { locale: "en-US", timeZone: "Asia/Shanghai" },
		};
		expect(webSupportConversationSchema.safeParse(valid).success).toBe(true);
		expect(
			webSupportConversationSchema.safeParse({
				...valid,
				fingerprint: { visitorId: "raw components", version: "5.2.0" },
			}).success,
		).toBe(false);
	});
});
