import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { m } from "#/paraglide/messages";
import { checkAgentSubsitePrefixFn } from "../server/functions";
import {
	normalizeSubsitePrefix,
	subsiteDomain,
	subsitePrefixProblem,
} from "../subsite-prefix";

export type SubsitePrefixStatus =
	| "empty"
	| "checking"
	| "available"
	| "invalid"
	| "reserved"
	| "taken"
	| "rate_limited"
	| "error";

/**
 * Local rules answer instantly; a debounced lsrai.shop check confirms the
 * rest. Anything but empty or available blocks payment.
 */
export function useSubsitePrefixCheck(raw: string, enabled: boolean) {
	const label = normalizeSubsitePrefix(raw);
	const local = label ? subsitePrefixProblem(label) : null;
	const [settled, setSettled] = useState(label);
	useEffect(() => {
		const timer = setTimeout(() => setSettled(label), 400);
		return () => clearTimeout(timer);
	}, [label]);
	const remote = useQuery({
		queryKey: ["agent-subsite-prefix", settled],
		queryFn: () => checkAgentSubsitePrefixFn({ data: { prefix: settled } }),
		enabled: enabled && Boolean(settled) && !subsitePrefixProblem(settled),
		retry: false,
		refetchOnWindowFocus: false,
		staleTime: 15_000,
	});
	let status: SubsitePrefixStatus;
	if (!label) status = "empty";
	else if (local) status = local;
	else if (settled !== label || remote.isFetching || remote.isPending)
		status = "checking";
	else if (remote.isError)
		status =
			remote.error &&
			typeof remote.error === "object" &&
			"code" in remote.error &&
			remote.error.code === "agent_subsite_prefix_rate_limited"
				? "rate_limited"
				: "error";
	else status = remote.data?.state ?? "error";
	return {
		label,
		status,
		domain: label && local !== "invalid" ? subsiteDomain(label) : null,
		blocking: status !== "empty" && status !== "available",
	};
}

const messages: Record<
	Exclude<SubsitePrefixStatus, "empty" | "available">,
	() => string
> = {
	checking: m.agent_subsite_prefix_checking,
	invalid: m.agent_subsite_prefix_invalid,
	reserved: m.agent_subsite_prefix_reserved,
	taken: m.agent_subsite_prefix_taken,
	rate_limited: m.agent_subsite_prefix_rate_limited,
	error: m.agent_subsite_prefix_error,
};

export function AgentSubsitePrefixField({
	value,
	onChange,
	check,
}: {
	value: string;
	onChange: (value: string) => void;
	check: ReturnType<typeof useSubsitePrefixCheck>;
}) {
	const problem =
		check.status !== "empty" &&
		check.status !== "available" &&
		check.status !== "checking";
	return (
		<div className="grid gap-2">
			<Label htmlFor="agent-subsite-prefix">
				{m.agent_subsite_prefix_label()}
			</Label>
			<div className="flex items-center gap-2">
				<Input
					id="agent-subsite-prefix"
					value={value}
					onChange={(event) => onChange(event.target.value)}
					autoCapitalize="none"
					autoComplete="off"
					autoCorrect="off"
					spellCheck={false}
					inputMode="url"
					maxLength={32}
					placeholder="mystore"
					aria-invalid={problem}
					aria-describedby="agent-subsite-prefix-status"
				/>
				<span className="shrink-0 text-muted-foreground text-sm">
					.lsrai.shop
				</span>
			</div>
			<div id="agent-subsite-prefix-status" className="grid gap-1 text-sm">
				{check.status === "empty" ? (
					<p className="text-muted-foreground">
						{m.agent_subsite_prefix_hint()}
					</p>
				) : null}
				{check.domain && check.status !== "invalid" ? (
					<p className="break-all">
						{m.agent_subsite_prefix_preview({ domain: check.domain })}
					</p>
				) : null}
				{check.status === "available" ? (
					<output className="text-primary">
						{m.agent_subsite_prefix_available()}
					</output>
				) : check.status === "checking" ? (
					<output className="text-muted-foreground">
						{messages.checking()}
					</output>
				) : check.status !== "empty" ? (
					<p role="alert" className="text-destructive">
						{messages[check.status]()}
					</p>
				) : null}
			</div>
		</div>
	);
}
