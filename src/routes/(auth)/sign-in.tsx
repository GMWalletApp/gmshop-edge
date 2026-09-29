import { createFileRoute, redirect } from "@tanstack/react-router";
import { SignIn } from "#/features/auth/pages/sign-in";
import { safePostAuthRedirect } from "#/features/auth/post-auth-redirect";
import { getInstallStatus } from "#/features/installation/server/functions";
import { createDefaultSeoHead, siteNameFromMatches } from "#/lib/seo";
import { m } from "#/paraglide/messages";

export const Route = createFileRoute("/(auth)/sign-in")({
	head: ({ matches }) => {
		const siteName = siteNameFromMatches(matches);
		return createDefaultSeoHead({
			title: `${m.auth_signIn_title()} | ${siteName}`,
			description: m.auth_signIn_description(),
			path: "/sign-in",
			siteName,
		});
	},
	validateSearch: (search: Record<string, unknown>) => ({
		redirect: typeof search.redirect === "string" ? search.redirect : undefined,
	}),
	loader: async () => {
		const installStatus = await getInstallStatus();
		if (!installStatus.installed) throw redirect({ to: "/install" });
	},
	component: SignInRoute,
});

function SignInRoute() {
	const { redirect } = Route.useSearch();
	return <SignIn redirectTo={safePostAuthRedirect(redirect)} />;
}
