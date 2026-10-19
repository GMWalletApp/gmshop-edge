import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import {
	getLeaderboardFn,
	getProgramRulesFn,
	getWithdrawalsFn,
	listAgentsFn,
} from "#/features/agent-program/server/admin";

export function beijingMonth() {
	return new Intl.DateTimeFormat("sv-SE", {
		year: "numeric",
		month: "2-digit",
		timeZone: "Asia/Shanghai",
	}).format(new Date());
}
export const panelQueryPolicy = {
	staleTime: 60_000,
	gcTime: 30 * 60_000,
	placeholderData: keepPreviousData,
};
export const agentsQuery = (month: string, refresh = false) =>
	queryOptions({
		...panelQueryPolicy,
		queryKey: ["agent-program", "agents", month],
		queryFn: () => listAgentsFn({ data: { month, refresh } }),
	});
export const leaderboardQuery = (month: string, refresh = false) =>
	queryOptions({
		...panelQueryPolicy,
		queryKey: ["agent-program", "leaderboard", month],
		queryFn: () => getLeaderboardFn({ data: { month, refresh } }),
	});
export const withdrawalsQuery = () =>
	queryOptions({
		...panelQueryPolicy,
		queryKey: ["agent-program", "withdrawals"],
		queryFn: () => getWithdrawalsFn(),
	});
export const rulesQuery = (refresh = false) =>
	queryOptions({
		...panelQueryPolicy,
		queryKey: ["agent-program", "rules"],
		queryFn: () => getProgramRulesFn({ data: { refresh } }),
	});
