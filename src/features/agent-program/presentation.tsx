import { Button } from "#/components/ui/button";
import { type Agent, amountMinor } from "#/features/agent-program/schema";
import {
	formatMinorAmount,
	formatMinorAmountWithSymbol,
	formatNumber,
} from "#/lib/format";
import { m } from "#/paraglide/messages";
import { getLocale } from "#/paraglide/runtime";

export function money(value: string | bigint, currency = "CNY") {
	if (!/^[A-Z]{3}$/.test(currency))
		return formatMinorAmount(
			typeof value === "bigint" ? value : amountMinor(value),
			currency,
			2,
		);
	return formatMinorAmountWithSymbol(
		typeof value === "bigint" ? value : amountMinor(value),
		currency,
		2,
	);
}
export function statusLabel(status: string) {
	switch (status) {
		case "active":
			return m.agent_program_status_active();
		case "disabled":
		case "revoked":
			return m.agent_program_status_disabled();
		case "pending_review":
			return m.agent_program_domain_pending_review();
		case "provisioning":
			return m.agent_program_domain_provisioning();
		case "pending_approval":
		case "pending":
			return m.agent_program_status_pending();
		case "credited":
		case "approved":
			return m.agent_program_status_approved();
		case "rejected":
			return m.agent_program_status_rejected();
		case "paid":
			return m.agent_program_status_paid();
		default:
			return m.agent_program_status_unknown();
	}
}
export function ProgramError({ retry }: { retry: () => void }) {
	return (
		<div role="alert" className="space-y-2 p-4 text-sm">
			<p>{m.agent_program_error()}</p>
			<Button variant="outline" onClick={retry}>
				{m.agent_program_retry()}
			</Button>
		</div>
	);
}

export function tierGuardLabel(
	tier: { guard_state: string; profit_gap?: string },
	currency = "CNY",
) {
	switch (tier.guard_state) {
		case "credited":
			return m.agent_program_credited();
		case "not_reached":
			return m.agent_program_not_reached();
		case "waiting_profit":
			return m.agent_program_waiting_profit({
				gap: money(tier.profit_gap ?? "0", currency),
			});
		case "profit_unavailable":
			return m.agent_program_profit_unavailable();
		default:
			return m.agent_program_reached();
	}
}

export function AgentDomains({ domains }: { domains: Agent["domains"] }) {
	return domains.length ? (
		<ul className="space-y-1 text-xs text-muted-foreground">
			{domains.map((domain) => (
				<li key={domain.domain} className="break-all">
					{domain.domain} ·{" "}
					{domain.type === "subdomain"
						? m.agent_program_subdomain()
						: domain.type === "custom"
							? m.agent_program_custom_domain()
							: domain.type}
					{domain.status && <> · {statusLabel(domain.status)}</>}
				</li>
			))}
		</ul>
	) : (
		<span>—</span>
	);
}
export function PeriodProfit({
	value,
	currency,
}: {
	value: Agent["our_profit_month"];
	currency: string;
}) {
	return (
		<div>
			{value.profit === null
				? m.agent_program_profit_fetch_unavailable()
				: money(value.profit, currency)}
			{value.profit !== null && value.unknown_order_count > 0 && (
				<p className="text-xs text-muted-foreground">
					{m.agent_program_period_cost_unknown({
						count: formatNumber(value.unknown_order_count),
					})}
				</p>
			)}
		</div>
	);
}

export function PanelDataAge({
	updatedAt,
	month,
}: {
	updatedAt: number | undefined;
	month?: string;
}) {
	const time =
		updatedAt && Number.isFinite(updatedAt)
			? new Intl.DateTimeFormat(getLocale(), {
					timeZone: "Asia/Shanghai",
					hour: "2-digit",
					minute: "2-digit",
					hour12: false,
				}).format(updatedAt)
			: undefined;
	return (
		<span className="text-muted-foreground text-sm">
			{month && <>{m.agent_program_displayed_month({ month })} · </>}
			{time && m.agent_program_updated_at({ time })}
		</span>
	);
}
