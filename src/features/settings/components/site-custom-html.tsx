import { useRouter } from "@tanstack/react-router";

/**
 * Operator-authored storefront HTML. Under the production CSP only scripts that
 * carry the request nonce run, so every `<script>` tag in the snippet is stamped
 * with it while rendering; inline event handlers stay blocked by design.
 */
export function SiteCustomHtml({ html }: { html: string }) {
	// The router is absent when the component renders in isolation (tests);
	// there is then no nonce policy to satisfy either.
	const router = useRouter({ warn: false });
	const nonce = router?.options.ssr?.nonce;
	if (!html) return null;
	return (
		<div
			data-site-custom-html
			// biome-ignore lint/security/noDangerouslySetInnerHtml: administrators explicitly configure trusted storefront integrations.
			dangerouslySetInnerHTML={{ __html: withScriptNonce(html, nonce) }}
			suppressHydrationWarning
		/>
	);
}

export function withScriptNonce(html: string, nonce: string | undefined) {
	if (!nonce || !/^[A-Za-z0-9+/=]+$/.test(nonce)) return html;
	return html.replace(
		/<script\b(?![^>]*\bnonce=)/gi,
		`<script nonce="${nonce}"`,
	);
}
