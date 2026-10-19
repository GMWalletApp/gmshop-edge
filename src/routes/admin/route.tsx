import {
	createFileRoute,
	Outlet,
	redirect,
	useRouterState,
} from "@tanstack/react-router";
import { getAdminBootstrapFn } from "#/features/auth/server/session";
import {
	canAccessAdminPath,
	systemSidebarData,
} from "#/layouts/components/data/sidebar-data";
import { Main } from "#/layouts/components/main";
import { DashboardLayout } from "#/layouts/dashboard";

export const Route = createFileRoute("/admin")({
	gcTime: 0,
	loader: async ({ location }) => {
		let bootstrap: Awaited<ReturnType<typeof getAdminBootstrapFn>>;
		try {
			bootstrap = await getAdminBootstrapFn();
		} catch {
			throw redirect({ to: "/403" });
		}
		if (!bootstrap.installed) {
			throw redirect({
				to: "/install",
			});
		}

		const systemAccess = bootstrap.access;
		if (!systemAccess) {
			throw redirect({
				to: "/sign-in",
				search: {
					redirect: location.href,
				},
			});
		}

		const user = systemAccess;
		if (user.enabled === false) throw redirect({ to: "/403" });
		if (
			location.pathname !== "/admin" &&
			location.pathname !== "/admin/" &&
			!canAccessAdminPath(location.pathname, systemAccess.permissions)
		) {
			throw redirect({ to: "/403" });
		}
		return { systemAccess, user };
	},
	component: AdminLayoutRoute,
});

function AdminLayoutRoute() {
	const { systemAccess, user } = Route.useLoaderData();
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});
	const pageScroll = pathname === "/admin" || pathname === "/admin/";
	return (
		<DashboardLayout
			navigation={systemSidebarData(systemAccess.permissions, user.roles)}
			permissions={systemAccess.permissions}
			pageScroll={pageScroll}
			user={user}
		>
			<Main fixed={!pageScroll}>
				<Outlet />
			</Main>
		</DashboardLayout>
	);
}
