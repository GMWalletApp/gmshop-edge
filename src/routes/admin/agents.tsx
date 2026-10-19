import { createFileRoute, redirect } from "@tanstack/react-router";
import { AgentProgramPage } from "#/features/agent-program/page";
import { canManageAgentProgram } from "#/features/agent-program/schema";

export const Route = createFileRoute("/admin/agents")({
	loader: async ({ parentMatchPromise }) => {
		const parent = await parentMatchPromise;
		if (!parent.loaderData || !canManageAgentProgram(parent.loaderData.user))
			throw redirect({ to: "/403" });
	},
	component: AgentProgramPage,
});
