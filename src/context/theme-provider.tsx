import { useSelector } from "@tanstack/react-store";
import { createContext, useContext, useEffect } from "react";
import {
	defaultFont,
	defaultTheme,
	type Font,
	preferencesStore,
	type ResolvedTheme,
	type Theme,
} from "#/stores/preferences-store";

const FONT_VARIABLES: Record<Font, string> = {
	inter: "var(--font-inter)",
	manrope: "var(--font-manrope)",
	noto: "var(--font-noto)",
};

type ThemeProviderProps = {
	children: React.ReactNode;
};

type ThemeProviderState = {
	defaultTheme: Theme;
	resolvedTheme: ResolvedTheme;
	theme: Theme;
	setTheme: (theme: Theme) => void;
	resetTheme: () => void;
	defaultFont: Font;
	font: Font;
	setFont: (font: Font) => void;
	resetFont: () => void;
};

const ThemeContext = createContext<ThemeProviderState | null>(null);

export function ThemeProvider({ children }: ThemeProviderProps) {
	const theme = useSelector(preferencesStore, (state) => state.theme);
	const font = useSelector(preferencesStore, (state) => state.font);
	const systemTheme = useSelector(
		preferencesStore,
		(state) => state.systemTheme,
	);

	const resolvedTheme: ResolvedTheme = theme === "auto" ? systemTheme : theme;

	useEffect(() => preferencesStore.actions.hydrate(), []);

	useEffect(() => {
		if (typeof window.matchMedia !== "function") return;
		const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

		const handleChange = () =>
			preferencesStore.actions.setSystemTheme(
				mediaQuery.matches ? "dark" : "light",
			);

		mediaQuery.addEventListener("change", handleChange);

		return () => mediaQuery.removeEventListener("change", handleChange);
	}, []);

	useEffect(() => applyTheme(theme, resolvedTheme), [resolvedTheme, theme]);

	useEffect(() => {
		applyFont(font);
	}, [font]);

	const contextValue: ThemeProviderState = {
		defaultTheme,
		resolvedTheme,
		resetTheme: preferencesStore.actions.resetTheme,
		theme,
		setTheme: preferencesStore.actions.setTheme,
		defaultFont,
		font,
		setFont: preferencesStore.actions.setFont,
		resetFont: preferencesStore.actions.resetFont,
	};

	return <ThemeContext value={contextValue}>{children}</ThemeContext>;
}

function applyTheme(theme: Theme, resolvedTheme: ResolvedTheme) {
	const root = window.document.documentElement;

	root.classList.remove("light", "dark");
	root.classList.add(resolvedTheme);

	if (theme === "auto") {
		root.removeAttribute("data-theme");
	} else {
		root.setAttribute("data-theme", theme);
	}

	root.style.colorScheme = resolvedTheme;
}

function applyFont(font: Font) {
	const root = window.document.documentElement;
	root.style.setProperty("--font-sans", FONT_VARIABLES[font]);
	root.setAttribute("data-font", font);
}

export const useTheme = () => {
	const context = useContext(ThemeContext);

	if (!context) throw new Error("useTheme must be used within a ThemeProvider");

	return context;
};
