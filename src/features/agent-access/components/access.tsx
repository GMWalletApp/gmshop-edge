import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "#/components/ui/button";
import { authClient } from "#/features/auth/auth-client";
import { m } from "#/paraglide/messages";
import { getLocale } from "#/paraglide/runtime";
import { agentAccessErrorMessage } from "../error-message";
import {
	agentAccessKind,
	agentAccessProducts,
	agentAccessRefundPolicy,
	agentOwnerWeChat,
} from "../products";
import {
	listAgentAccessIssuesFn,
	prepareAgentProductsFn,
	retryAgentAccessFn,
} from "../server/admin";
import {
	checkAgentAccessFn,
	getAgentDeliveryFn,
	openAgentAccountFn,
} from "../server/functions";
import { AgentEmailVerification } from "./email-verification";

export function agentEligibilityOptions(
	itemId: string,
	user?: { id: string; emailVerified: boolean },
) {
	return {
		queryKey: ["agent-access-eligibility", itemId, user?.id],
		queryFn: () => checkAgentAccessFn({ data: { itemId } }),
		enabled: Boolean(agentAccessKind(itemId) && user?.emailVerified),
		retry: false,
		refetchOnWindowFocus: false,
	};
}
export function AgentAccessCheckout({
	itemId,
	compact = false,
}: {
	itemId: string;
	compact?: boolean;
}) {
	const session = authClient.useSession();
	const check = useQuery(agentEligibilityOptions(itemId, session.data?.user));
	if (!agentAccessKind(itemId)) return null;
	return (
		<section
			className={
				compact
					? "grid gap-3 border-t pt-5"
					: "my-4 grid gap-3 rounded-xl border p-4"
			}
		>
			<h3 className="text-sm font-medium">{m.agent_access_title()}</h3>
			{!compact ? (
				<p className="text-sm text-muted-foreground">
					{m.agent_access_purchase_notice()}{" "}
					{agentAccessRefundPolicy[getLocale()]}
				</p>
			) : null}
			{!session.data?.user || !session.data.user.emailVerified ? (
				<AgentEmailVerification itemId={itemId} />
			) : (
				<>
					<p className="break-words text-sm">
						{m.agent_access_verified_email({ email: session.data.user.email })}
					</p>
					{check.isFetching ? (
						<output className="text-sm text-muted-foreground">
							{m.agent_access_checking()}
						</output>
					) : null}
					{check.isError ? (
						<div
							role="alert"
							className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
						>
							{agentAccessErrorMessage(check.error)}
						</div>
					) : null}
					{!check.isFetching &&
					!check.isError &&
					check.data?.state === "eligible" ? (
						<output className="text-sm text-primary">
							{m.agent_access_eligible()}
						</output>
					) : null}
					{!check.isError && check.data?.state === "binding_required" ? (
						<a
							className="text-sm underline underline-offset-4"
							href={check.data.url}
							target="_blank"
							rel="noreferrer"
						>
							{m.agent_access_bind()}
						</a>
					) : null}
					{!check.isError && check.data?.state === "already_active" ? (
						<output className="text-sm">{m.agent_access_existing()}</output>
					) : null}
					{check.isError || check.data?.state === "binding_required" ? (
						<Button
							type="button"
							size="sm"
							variant="outline"
							className="w-fit"
							disabled={check.isFetching}
							onClick={() => void check.refetch()}
						>
							{m.agent_access_check()}
						</Button>
					) : null}
				</>
			)}
		</section>
	);
}
// Tap opens the full-size image so phones can zoom or long-press to scan.
export function AgentOwnerWeChat() {
	return (
		<div className="grid justify-items-start gap-2 border-t pt-3">
			<p className="font-medium text-sm">{m.agent_access_wechat()}</p>
			<a
				href={agentOwnerWeChat.imagePath}
				target="_blank"
				rel="noreferrer"
				aria-label={m.agent_access_wechat_enlarge()}
				className="rounded-lg border bg-white p-1 focus-visible:outline-2 focus-visible:outline-ring"
			>
				<img
					src={agentOwnerWeChat.imagePath}
					alt={m.agent_access_wechat_alt()}
					width={160}
					height={204}
					loading="lazy"
					className="h-auto w-40"
				/>
			</a>
		</div>
	);
}
export function AgentAccessDelivery({ orderNumber }: { orderNumber: string }) {
	const session = authClient.useSession();
	if (!session.data?.user) return <output>{m.agent_access_sign_in()}</output>;
	return (
		<OwnedAgentAccessDelivery
			key={`${session.data.user.id}:${orderNumber}`}
			orderNumber={orderNumber}
			userId={session.data.user.id}
		/>
	);
}
// Remount on account changes so an old session's revealed password cannot linger.
function OwnedAgentAccessDelivery({
	orderNumber,
	userId,
}: {
	orderNumber: string;
	userId: string;
}) {
	const query = useQuery({
		queryKey: ["agent-access", userId, orderNumber],
		queryFn: () => getAgentDeliveryFn({ data: { orderNumber } }),
		retry: false,
		refetchInterval: (q) =>
			q.state.data?.state === "pending" && !q.state.data.needsSupport
				? 15000
				: false,
	});
	const access = useMutation({
		mutationFn: () => openAgentAccountFn({ data: { orderNumber } }),
	});
	const data = query.data;
	return (
		<section className="grid gap-3 rounded-xl border p-4">
			<h3 className="font-semibold">{m.agent_access_title()}</h3>
			<p className="text-sm text-muted-foreground">
				{agentAccessRefundPolicy[getLocale()]}
			</p>
			{!data ? (
				<output>{m.agent_access_sign_in()}</output>
			) : (
				<>
					<output>
						{data.needsSupport
							? m.agent_access_support()
							: data.state === "active" && data.orderStatus === "completed"
								? m.agent_access_active()
								: data.state === "revoked"
									? m.agent_access_revoked()
									: m.agent_access_pending()}
					</output>
					{data.state === "active" && data.orderStatus === "completed" ? (
						<>
							<p className="break-all">
								{m.agent_access_verified_email({ email: data.email })}
							</p>
							<a
								className="underline"
								href="https://lsrai.shop/auth/login"
								target="_blank"
								rel="noreferrer"
							>
								https://lsrai.shop/auth/login
							</a>
							<Button
								disabled={access.isPending}
								onClick={() => access.mutate()}
							>
								{m.agent_access_open()}
							</Button>
							{access.data?.initialPassword ? (
								<div className="grid gap-2 rounded-lg border p-3">
									<p>{m.agent_access_initial_password()}</p>
									<code className="break-all select-all">
										{access.data.initialPassword}
									</code>
									<p className="text-sm text-muted-foreground">
										{m.agent_access_password_notice()}
									</p>
								</div>
							) : null}
							{access.data ? (
								<a
									className="underline"
									href={access.data.url}
									target="_blank"
									rel="noreferrer"
								>
									{m.agent_access_continue()}
								</a>
							) : null}
							{access.isError ? (
								<p role="alert">{m.agent_access_support()}</p>
							) : null}
							{data.domain && data.prefixFallback ? (
								<p className="text-sm">
									{m.agent_subsite_prefix_fallback({ domain: data.domain })}
								</p>
							) : null}
							{data.domain ? (
								<a
									className="break-all underline"
									href={`https://${data.domain}`}
									target="_blank"
									rel="noreferrer"
								>
									{data.domain}
								</a>
							) : null}
							<a
								className="underline"
								href="https://lsrai.shop/agent-access"
								target="_blank"
								rel="noreferrer"
							>
								{m.agent_access_guide()}
							</a>
							<p className="text-sm text-muted-foreground">
								{data.kind === "api"
									? m.agent_access_api_guide()
									: m.agent_access_subsite_guide()}
							</p>
						</>
					) : null}
					{data.state !== "revoked" ? <AgentOwnerWeChat /> : null}
				</>
			)}
		</section>
	);
}
export function AgentAccessDrafts() {
	const prepare = useMutation({ mutationFn: () => prepareAgentProductsFn() });
	const issues = useQuery({
		queryKey: ["agent-access-issues"],
		queryFn: () => listAgentAccessIssuesFn(),
		retry: false,
	});
	const retry = useMutation({
		mutationFn: (orderItemId: string) =>
			retryAgentAccessFn({ data: { orderItemId } }),
		onSuccess: () => {
			void issues.refetch();
		},
	});
	return (
		<section className="my-6 grid gap-3 rounded-xl border p-4">
			<h3 className="font-semibold">{m.agent_access_title()}</h3>
			<p>{m.agent_access_draft_notice()}</p>
			<Button
				variant="outline"
				disabled={prepare.isPending}
				onClick={() => prepare.mutate()}
			>
				{m.agent_access_prepare_drafts()}
			</Button>
			{prepare.isSuccess ? (
				<output>{m.agent_access_drafts_ready()}</output>
			) : null}
			{prepare.isError ? <p role="alert">{m.agent_access_support()}</p> : null}
			{issues.data?.map((row) => (
				<div
					key={row.orderItemId}
					className="flex flex-wrap items-center gap-3 border-t pt-3"
				>
					<span className="break-all">
						{row.orderNumber} · {row.kind} · {row.attempts}
					</span>
					<Button
						variant="outline"
						disabled={retry.isPending || row.orderStatus === "refunded"}
						onClick={() => retry.mutate(row.orderItemId)}
					>
						{m.agent_access_retry()}
					</Button>
				</div>
			))}
			{retry.isError ? <p role="alert">{m.agent_access_support()}</p> : null}
			{Object.values(agentAccessProducts).map((p) => (
				<a
					className="underline"
					key={p.productId}
					href={`/admin/products/${p.productId}`}
				>
					{p.priceMinor === agentAccessProducts.api.priceMinor
						? "API · ¥19.90"
						: "Subsite · ¥199"}
				</a>
			))}
		</section>
	);
}
