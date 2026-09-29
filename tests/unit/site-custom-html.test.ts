import { describe, expect, it } from "vitest";
import { withScriptNonce } from "#/features/settings/components/site-custom-html";

describe("operator custom HTML under the nonce policy", () => {
	it("stamps the request nonce on every script tag so trusted snippets keep running", () => {
		const html =
			'<div id="x"></div><script src="https://analytics.example/a.js"></script>\n<SCRIPT>window.dataLayer=[]</SCRIPT>';
		expect(withScriptNonce(html, "abc123+/=")).toBe(
			'<div id="x"></div><script nonce="abc123+/=" src="https://analytics.example/a.js"></script>\n<script nonce="abc123+/=">window.dataLayer=[]</SCRIPT>',
		);
	});

	it("leaves existing nonces and non-script markup alone and ignores malformed nonces", () => {
		const html = '<script nonce="keep">1</script><p>scripted text</p>';
		expect(withScriptNonce(html, "abc")).toBe(html);
		expect(withScriptNonce("<script>1</script>", undefined)).toBe(
			"<script>1</script>",
		);
		expect(withScriptNonce("<script>1</script>", '"><img src=x>')).toBe(
			"<script>1</script>",
		);
	});
});
