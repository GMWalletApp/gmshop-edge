import { createFileRoute, redirect } from "@tanstack/react-router";
import { AgentProgramPage } from "#/features/agent-program/page";
import {
	agentsQuery,
	beijingMonth,
	leaderboardQuery,
	rulesQuery,
	withdrawalsQuery,
} from "#/features/agent-program/queries";
import { canManageAgentProgram } from "#/features/agent-program/schema";

export const Route = createFileRoute("/admin/agents")({
	loader: async ({ parentMatchPromise, context }) => {
		const parent = await parentMatchPromise;
		if (!parent.loaderData || !canManageAgentProgram(parent.loaderData.user))
			throw redirect({ to: "/403" });
		const month = beijingMonth();
		// Do not gate the table/SSR on any secondary endpoint.
		void context.queryClient.prefetchQuery(leaderboardQuery(month));
		void context.queryClient.prefetchQuery(withdrawalsQuery());
		void context.queryClient.prefetchQuery(rulesQuery());
		await context.queryClient.prefetchQuery(agentsQuery(month));
	},
	component: AgentProgramPage,
});
