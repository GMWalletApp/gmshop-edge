import {
	CreditCard,
	type LucideIcon,
	RotateCw,
	Route,
	Smartphone,
} from "lucide-react";
import { cn } from "#/lib/utils";
import { m } from "#/paraglide/messages";

export const chatGptRechargeProductId = "2a794b89-3bb9-49d4-8691-0d13a1606869";

type Tone = "replace" | "free" | "renewal";

const toneClass: Record<Tone, string> = {
	replace:
		"border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
	free: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
	renewal: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
};

export function ChatGptRegionGuide() {
	const channels: {
		icon: LucideIcon;
		title: string;
		badge: string;
		tone: Tone;
		rule: string;
		plans: string;
	}[] = [
		{
			icon: Smartphone,
			title: m.store_chatgpt_region_ios_title(),
			badge: m.store_chatgpt_region_badge_replace(),
			tone: "replace",
			rule: m.store_chatgpt_region_ios_rule(),
			plans: m.store_chatgpt_region_ios_plans(),
		},
		{
			icon: CreditCard,
			title: m.store_chatgpt_region_card_title(),
			badge: m.store_chatgpt_region_badge_free(),
			tone: "free",
			rule: m.store_chatgpt_region_card_rule(),
			plans: m.store_chatgpt_region_card_plans(),
		},
		{
			icon: RotateCw,
			title: m.store_chatgpt_region_renewal_title(),
			badge: m.store_chatgpt_region_badge_renewal(),
			tone: "renewal",
			rule: m.store_chatgpt_region_renewal_rule(),
			plans: m.store_chatgpt_region_renewal_plans(),
		},
	];
	return (
		<section
			aria-labelledby="chatgpt-region-guide-title"
			className="mt-3 scroll-mt-24 rounded-2xl border border-border/70 bg-card/55 p-5 shadow-sm"
			data-chatgpt-region-guide
			id="chatgpt-region-guide"
		>
			<div className="flex items-start gap-3">
				<span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
					<Route aria-hidden="true" className="size-5" />
				</span>
				<div className="min-w-0">
					<h2
						className="font-semibold text-lg leading-snug"
						id="chatgpt-region-guide-title"
					>
						{m.store_chatgpt_region_title()}
					</h2>
					<p className="mt-1 text-muted-foreground text-sm leading-6">
						{m.store_chatgpt_region_intro()}
					</p>
				</div>
			</div>

			<ul className="mt-4 grid gap-2.5">
				{channels.map(({ icon: Icon, title, badge, tone, rule, plans }) => (
					<li
						className="rounded-xl border border-border/60 bg-background/50 p-4"
						key={title}
					>
						<div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
							<Icon aria-hidden="true" className="size-4 text-foreground/80" />
							<h3 className="font-semibold text-sm">{title}</h3>
							<span
								className={cn(
									"rounded-full border px-2 py-px font-medium text-[11px] leading-5",
									toneClass[tone],
								)}
							>
								{badge}
							</span>
						</div>
						<p className="mt-2 text-sm leading-6">{rule}</p>
						<p className="mt-1.5 text-muted-foreground text-xs leading-5">
							{m.store_chatgpt_region_plans_label()}
							{plans}
						</p>
					</li>
				))}
			</ul>

			<p className="mt-4 text-muted-foreground text-xs leading-5">
				{m.store_chatgpt_region_common()}
			</p>
		</section>
	);
}
