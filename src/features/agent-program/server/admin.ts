import { createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import { AccessDeniedError } from "#/features/access/server/access-cache";
import { requireAdmin } from "#/features/access/server/require-admin";
import { systemPermission } from "#/features/access/system-rbac";
import {
	agentsSchema,
	canManageAgentProgram,
	detailSchema,
	feeInputSchema,
	feeSourceSchema,
	leaderboardSchema,
	monthQuerySchema,
	payoutInputSchema,
	reviewInputSchema,
	rulesSchema,
	withdrawalsSchema,
} from "#/features/agent-program/schema";
import { requestProgram } from "#/features/agent-program/server/client";
import {
	panelMutation,
	requestPanel,
} from "#/features/agent-program/server/panel-cache";
import { DomainError } from "#/lib/domain-error";
import { getCloudflareEnv } from "#/server/db.server";

async function context(action: "read" | "update") {
	const request = getRequest();
	setResponseHeader("Cache-Control", "no-store");
	if (
		action === "update" &&
		request.headers.get("origin") !== new URL(request.url).origin
	)
		throw new DomainError("origin_invalid", 403, "Origin is not allowed");
	const user = await requireAdmin(
		request,
		systemPermission("operations", action),
	);
	if (!canManageAgentProgram(user)) throw new AccessDeniedError(403);
	const env = getCloudflareEnv(request);
	return {
		env,
		token: env.AGENT_SHOP_PROGRAM_TOKEN,
		operator: `gmshop:${user.id}`,
	};
}
function monthPath(path: string, month?: string) {
	return month ? `${path}?month=${encodeURIComponent(month)}` : path;
}
export const listAgentsFn = createServerFn({ method: "GET" })
	.validator((input: z.input<typeof monthQuerySchema>) =>
		monthQuerySchema.parse(input),
	)
	.handler(async ({ data }) => {
		const { token, env } = await context("read");
		return requestPanel(
			env,
			token,
			monthPath("agents", data.month),
			agentsSchema,
			data.refresh,
		);
	});
export const getAgentFn = createServerFn({ method: "GET" })
	.validator((input: { id: number; month?: string; refresh?: boolean }) =>
		monthQuerySchema.extend({ id: z.number().int().positive() }).parse(input),
	)
	.handler(async ({ data }) => {
		const { token, env } = await context("read");
		return requestPanel(
			env,
			token,
			monthPath(`agents/${data.id}`, data.month),
			detailSchema,
			data.refresh,
		);
	});
export const updateOpeningFeeFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof feeInputSchema>) =>
		feeInputSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const { token, operator, env } = await context("update");
		const { id, ...body } = data;
		return panelMutation(env, () =>
			requestProgram(
				token,
				`agents/${id}/opening-fee`,
				z.object({
					opening_fee_paid: z.string(),
					opening_fee_source: feeSourceSchema,
				}),
				"PATCH",
				{ ...body, operator },
			),
		);
	});
export const getLeaderboardFn = createServerFn({ method: "GET" })
	.validator((input: z.input<typeof monthQuerySchema>) =>
		monthQuerySchema.parse(input),
	)
	.handler(async ({ data }) => {
		const { token, env } = await context("read");
		return requestPanel(
			env,
			token,
			monthPath("leaderboard", data.month),
			leaderboardSchema,
			data.refresh,
		);
	});
export const reviewLeaderboardFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof reviewInputSchema>) =>
		reviewInputSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const { token, operator, env } = await context("update");
		return panelMutation(env, () =>
			requestProgram(
				token,
				`leaderboard/${data.id}/${data.action}`,
				z.object({ id: z.number(), status: z.string() }),
				"POST",
				{ operator, reason: data.reason },
			),
		);
	});
export const getWithdrawalsFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const { token } = await context("read");
		return requestProgram(
			token,
			"withdrawals?status=pending",
			withdrawalsSchema,
		);
	},
);
export const markWithdrawalPaidFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof payoutInputSchema>) =>
		payoutInputSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const { token, operator, env } = await context("update");
		return panelMutation(env, () =>
			requestProgram(
				token,
				`withdrawals/${data.id}/mark-paid`,
				z.object({ id: z.number(), status: z.string() }),
				"POST",
				{ alipay_trade_no: data.alipay_trade_no, operator },
			),
		);
	});

export const getProgramRulesFn = createServerFn({ method: "GET" })
	.validator((input: { refresh?: boolean }) =>
		z.object({ refresh: z.boolean().optional() }).parse(input),
	)
	.handler(async ({ data }) => {
		const { token, env } = await context("read");
		return requestPanel(env, token, "rules", rulesSchema, data.refresh);
	});
