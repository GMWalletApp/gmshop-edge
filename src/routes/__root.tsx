import type { QueryClient } from "@tanstack/react-query";
import {
	createRootRouteWithContext,
	HeadContent,
	Scripts,
	useRouter,
	useRouterState,
} from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useRef } from "react";
import { StartupSplash } from "#/components/startup-splash";
import { Toaster } from "#/components/ui/sonner";
import { TooltipProvider } from "#/components/ui/tooltip";
import { DirectionProvider } from "#/context/direction-provider";
import { SiteBrandProvider } from "#/context/site-brand-provider";
import { ThemeProvider } from "#/context/theme-provider";
import { TelegramMiniAppAutoSignIn } from "#/features/auth/components/telegram-mini-app-auto-sign-in";
import { TelegramMiniAppBackButton } from "#/features/auth/components/telegram-mini-app-back-button";
import { TelegramWidgetAutoSignIn } from "#/features/auth/components/telegram-widget-auto-sign-in";
import { GeneralError } from "#/features/errors/general-error";
import { NotFoundError } from "#/features/errors/not-found-error";
import { getSiteBrandFn } from "#/features/settings/server/site-brand-entry";
import { m } from "#/paraglide/messages";
import { getLocale } from "#/paraglide/runtime";
import appCss from "../styles/global.css?url";

const DevelopmentTools = import.meta.env.DEV
	? lazy(() => import("#/components/development-tools"))
	: null;

interface MyRouterContext {
	queryClient: QueryClient;
}

const THEME_INIT_SCRIPT = `(() => {
  try {
    const stored = localStorage.getItem("theme");
    const systemDark = matchMedia("(prefers-color-scheme: dark)").matches;
    const resolved = stored === "light" || stored === "dark"
      ? stored
      : systemDark ? "dark" : "light";
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(resolved);
    root.style.colorScheme = resolved;
    if (stored === "light" || stored === "dark") root.dataset.theme = stored;
    else root.removeAttribute("data-theme");
  } catch {
    document.documentElement.classList.add("light");
    document.documentElement.style.colorScheme = "light";
  }
})();`;

export const Route = createRootRouteWithContext<MyRouterContext>()({
	// Brand settings are low-volatility root data. Keeping the route match fresh
	// briefly avoids re-running the server function on every child navigation.
	staleTime: 5 * 60_000,
	loader: () => getSiteBrandFn(),
	head: ({ loaderData }) => {
		const title =
			loaderData?.title ??
			`${loaderData?.name ?? "GMShop Edge"} – ${m.app_title_description()}`;
		const logoUrl = loaderData?.logoUrl ?? "/favicon.png";
		return {
			meta: [
				{
					charSet: "utf-8",
				},
				{
					name: "viewport",
					content:
						"width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=overlays-content",
				},
				{
					title,
				},
				{
					name: "title",
					content: title,
				},
				{
					name: "description",
					content:
						loaderData?.seoDescription ??
						loaderData?.description ??
						m.common_seo_description(),
				},
				{
					name: "keywords",
					content: m.common_seo_keywords(),
				},
				{
					name: "theme-color",
					content: "#FFFFFF",
				},
			],
			links: [
				{
					rel: "stylesheet",
					href: appCss,
				},
				{
					rel: "icon",
					href: logoUrl,
				},
				{
					rel: "apple-touch-icon",
					href: logoUrl,
				},
				{
					rel: "manifest",
					href: "/site.webmanifest",
				},
			],
		};
	},
	notFoundComponent: NotFoundError,
	errorComponent: () => <GeneralError />,
	shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
	const brand = Route.useLoaderData();
	const locale = getLocale();
	const nonce = useRouter().options.ssr?.nonce;
	useEffect(() => {
		document.documentElement.lang = locale;
	}, [locale]);
	return (
		<html lang={locale} suppressHydrationWarning>
			<head>
				<script nonce={nonce} suppressHydrationWarning>
					{THEME_INIT_SCRIPT}
				</script>
				<HeadContent />
			</head>
			<body className="antialiased wrap-anywhere">
				<RouteFocusManager />
				<TelegramWidgetAutoSignIn />
				<TelegramMiniAppAutoSignIn />
				<TelegramMiniAppBackButton />
				<SiteBrandProvider brand={brand}>
					<StartupSplash />
					<ThemeProvider>
						<DirectionProvider>
							<TooltipProvider>{children}</TooltipProvider>
						</DirectionProvider>
						<Toaster duration={5000} position="top-center" />
					</ThemeProvider>
				</SiteBrandProvider>
				{DevelopmentTools ? (
					<Suspense fallback={null}>
						<DevelopmentTools />
					</Suspense>
				) : null}
				<Scripts />
			</body>
		</html>
	);
}

function RouteFocusManager() {
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});
	const initialPath = useRef(pathname);
	useEffect(() => {
		if (initialPath.current === pathname) return;
		initialPath.current = pathname;
		document.getElementById("content")?.focus({ preventScroll: true });
	}, [pathname]);
	return null;
}
