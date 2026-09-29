import {
	createHighlighterCore,
	type HighlighterCore,
	type LanguageInput,
} from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import { bundledLanguages } from "shiki/langs";

export type HighlightTheme = "light" | "dark";

const FALLBACK_LANGUAGE = "javascript";
// Languages shiki renders as unstyled text without a grammar.
const PLAIN_LANGUAGES = new Set(["text", "plaintext", "txt", "plain", "ansi"]);
const pendingLanguageLoads = new Map<string, Promise<void>>();

let highlighterPromise: Promise<HighlighterCore> | null = null;

/**
 * Shared fine-grained shiki highlighter for the Pro viewer and editor
 * components. The grammars the editor offers are preloaded; any other shiki
 * grammar (markdown fences in product content, for example) is fetched on
 * demand through `ensureHighlightLanguage`.
 */
export function getHighlighter(): Promise<HighlighterCore> {
	highlighterPromise ??= createHighlighterCore({
		themes: [
			import("@shikijs/themes/one-dark-pro"),
			import("@shikijs/themes/one-light"),
		],
		langs: [
			import("@shikijs/langs/tsx"),
			import("@shikijs/langs/jsx"),
			import("@shikijs/langs/css"),
			import("@shikijs/langs/go"),
			import("@shikijs/langs/html"),
			import("@shikijs/langs/java"),
			import("@shikijs/langs/json"),
			import("@shikijs/langs/markdown"),
			import("@shikijs/langs/python"),
			import("@shikijs/langs/rust"),
			import("@shikijs/langs/shell"),
			import("@shikijs/langs/sql"),
			import("@shikijs/langs/yaml"),
		],
		langAlias: { typescript: "tsx", ts: "tsx", javascript: "jsx", js: "jsx" },
		engine: createOnigurumaEngine(import("shiki/wasm")),
	}).catch((error: unknown) => {
		highlighterPromise = null;
		throw error;
	});
	return highlighterPromise;
}

export function getHighlightThemeName(theme: HighlightTheme) {
	return theme === "dark" ? "one-dark-pro" : "one-light";
}

/**
 * Resolve the grammar to tokenize `lang` with, loading it on demand when it is
 * one of shiki's bundled grammars. Plain-text identifiers render unstyled and
 * unknown identifiers fall back to JavaScript, as before.
 */
export async function ensureHighlightLanguage(
	highlighter: HighlighterCore,
	lang: string,
) {
	const normalized = lang.trim().toLowerCase();
	if (!normalized || PLAIN_LANGUAGES.has(normalized)) return "text";
	if (highlighter.getLoadedLanguages().includes(normalized)) return normalized;
	const loader = (
		bundledLanguages as Record<string, LanguageInput | undefined>
	)[normalized];
	if (!loader) return FALLBACK_LANGUAGE;
	let pending = pendingLanguageLoads.get(normalized);
	if (!pending) {
		pending = highlighter
			.loadLanguage(loader)
			.finally(() => pendingLanguageLoads.delete(normalized));
		pendingLanguageLoads.set(normalized, pending);
	}
	try {
		await pending;
	} catch {
		return FALLBACK_LANGUAGE;
	}
	return highlighter.getLoadedLanguages().includes(normalized)
		? normalized
		: FALLBACK_LANGUAGE;
}
