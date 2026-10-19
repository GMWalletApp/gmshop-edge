import { Button } from "#/components/ui/button";
import { amountMinor } from "#/features/agent-program/schema";
import { formatMinorAmount, formatMinorAmountWithSymbol } from "#/lib/format";
import { m } from "#/paraglide/messages";

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
