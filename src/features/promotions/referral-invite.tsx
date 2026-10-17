import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { formatMinorAmountWithSymbol } from "#/lib/format";
import { m } from "#/paraglide/messages";
import { getPromotionAccountFn, openReferralFn } from "./server/functions";

export const promotionAccountQueryKey = ["promotion-account"] as const;

/** The public link a friend opens; ReferralCapture stores its `ref` code for checkout. */
export function referralInviteUrl(code: string, origin: string) {
	const url = new URL("/", origin);
	url.searchParams.set("ref", code);
	return url.href;
}

/** Invitation pitch plus the customer's invite link (opened on demand). Requires a signed-in customer. */
export function ReferralInvite({
	rewardMinor = "0",
}: {
	/** Friend discount (= referrer reward) for one unit of a relevant item, CNY cents. */
	rewardMinor?: string;
}) {
	const client = useQueryClient();
	const [origin, setOrigin] = useState("");
	useEffect(() => setOrigin(window.location.origin), []);
	const query = useQuery({
		queryKey: promotionAccountQueryKey,
		queryFn: () => getPromotionAccountFn(),
	});
	const open = useMutation({
		mutationFn: () => openReferralFn(),
		onSuccess: () =>
			client.invalidateQueries({ queryKey: promotionAccountQueryKey }),
	});
	const referral = query.data?.referral ?? open.data ?? null;
	const link =
		referral && origin ? referralInviteUrl(referral.code, origin) : "";
	const amount =
		/^\d+$/.test(rewardMinor) && BigInt(rewardMinor) > 0n
			? formatMinorAmountWithSymbol(rewardMinor, "CNY", 2)
			: null;
	return (
		<div className="grid gap-3" data-testid="referral-invite">
			<p className="font-medium text-sm">{m.promotion_invite_pitch()}</p>
			{amount ? (
				<p className="text-primary text-sm">
					{m.promotion_invite_amount({ amount })}
				</p>
			) : null}
			{query.isPending ? (
				<p className="text-muted-foreground text-sm">{m.common_loading()}</p>
			) : query.isError ? (
				<p className="text-destructive text-sm" role="alert">
					{m.promotion_error()}
				</p>
			) : referral ? (
				<>
					<label className="grid gap-2 text-sm" htmlFor="referral-invite-link">
						{m.promotion_invite_link()}
						<div className="flex gap-2">
							<Input
								className="font-mono text-xs"
								id="referral-invite-link"
								onFocus={(event) => event.currentTarget.select()}
								readOnly
								value={link}
							/>
							<Button
								disabled={!referral.enabled || !link}
								onClick={async () => {
									try {
										await navigator.clipboard.writeText(link);
										toast.success(m.common_copy_success());
									} catch {
										toast.error(m.common_copy_failed());
									}
								}}
								type="button"
								variant="outline"
							>
								<Copy />
								{m.promotion_copy_link()}
							</Button>
						</div>
					</label>
					{!referral.enabled ? (
						<p className="text-muted-foreground text-sm">
							{m.promotion_disabled()}
						</p>
					) : null}
				</>
			) : (
				<Button
					className="w-full sm:w-auto"
					disabled={open.isPending}
					onClick={() => open.mutate()}
					type="button"
				>
					{m.promotion_open()}
				</Button>
			)}
			{open.isError ? (
				<p className="text-destructive text-sm" role="alert">
					{m.promotion_error()}
				</p>
			) : null}
		</div>
	);
}
