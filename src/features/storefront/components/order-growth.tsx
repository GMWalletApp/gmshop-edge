import { Link } from "@tanstack/react-router";
import { Boxes, Gift } from "lucide-react";
import { ReferralInvite } from "#/features/promotions/referral-invite";
import type { OrderGrowth } from "#/features/storefront/server/order-growth";
import { formatMinorAmountWithSymbol } from "#/lib/format";
import { m } from "#/paraglide/messages";

/** Cross-sell and invitation blocks; the server returns `growth: null` when an order must not show them. */
export function OrderGrowthBlocks({
	growth,
	redirectPath,
}: {
	growth: OrderGrowth | null | undefined;
	redirectPath: string;
}) {
	if (!growth) return null;
	return (
		<>
			<OrderReferralBlock growth={growth} redirectPath={redirectPath} />
			<CrossSellBlock items={growth.crossSell} />
		</>
	);
}

export function OrderReferralBlock({
	growth,
	redirectPath,
}: {
	growth: OrderGrowth;
	redirectPath: string;
}) {
	return (
		<section
			aria-label={m.promotion_invite_title()}
			className="grid gap-3 border-t pt-6"
		>
			<h2 className="flex items-center gap-2 font-medium text-muted-foreground text-sm">
				<Gift className="size-4" />
				{m.promotion_invite_title()}
			</h2>
			{growth.signedIn ? (
				<ReferralInvite rewardMinor={growth.referralRewardMinor} />
			) : (
				<div className="grid gap-2 text-sm" data-testid="referral-guest">
					<p className="font-medium">{m.promotion_invite_pitch()}</p>
					<p className="text-muted-foreground">
						{m.promotion_invite_guest()}{" "}
						<Link
							className="font-medium text-primary underline-offset-4 hover:underline"
							search={{ redirect: redirectPath }}
							to="/sign-in"
						>
							{m.promotion_invite_sign_in()}
						</Link>
					</p>
				</div>
			)}
		</section>
	);
}

export function CrossSellBlock({ items }: { items: OrderGrowth["crossSell"] }) {
	if (!items.length) return null;
	return (
		<section
			aria-label={m.store_cross_sell_title()}
			className="grid gap-3 border-t pt-6"
			data-testid="cross-sell"
		>
			<h2 className="font-medium text-muted-foreground text-sm">
				{m.store_cross_sell_title()}
			</h2>
			<ul className="grid gap-3">
				{items.map((item) => (
					<li key={item.sellableItemId}>
						<a
							className="flex items-center gap-3 rounded-2xl border bg-card p-3 transition-colors hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring"
							href={item.href}
						>
							{item.coverUrl ? (
								<img
									alt=""
									className="aspect-video w-16 shrink-0 rounded-xl object-cover"
									loading="lazy"
									src={item.coverUrl}
								/>
							) : (
								<div className="grid aspect-video w-16 shrink-0 place-items-center rounded-xl bg-muted">
									<Boxes className="size-5 text-muted-foreground" />
								</div>
							)}
							<div className="min-w-0 flex-1">
								<strong className="block truncate text-sm">
									{item.productName}
								</strong>
								{item.sellableItemName !== item.productName ? (
									<p className="truncate text-muted-foreground text-xs">
										{item.sellableItemName}
									</p>
								) : null}
							</div>
							<div className="grid shrink-0 justify-items-end gap-1">
								<strong className="text-sm">
									{formatMinorAmountWithSymbol(
										item.priceMinor,
										item.currency,
										item.currencyDecimals,
									)}
								</strong>
								<span className="text-primary text-xs">
									{m.store_cross_sell_view()}
								</span>
							</div>
						</a>
					</li>
				))}
			</ul>
		</section>
	);
}
