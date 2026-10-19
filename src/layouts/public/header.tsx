"use client";

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
	ChevronRight,
	ExternalLink,
	Headphones,
	Languages,
	Menu,
	MessageCircle,
	Send,
	Settings,
	ShoppingCart,
	Users,
	Zap,
} from "lucide-react";
import { type ComponentProps, useEffect, useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "#/components/ui/avatar";
import { Button } from "#/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "#/components/ui/popover";
import { authClient } from "#/features/auth/auth-client";
import { isInternalIdentityEmail } from "#/features/auth/identity-email";
import { getStorefrontAdminEntryFn } from "#/features/auth/server/session";
import { useCurrency } from "#/features/exchange-rates/currency-context";
import { useLocalCart } from "#/features/storefront/cart-storage";
import { webSupportOpenEvent } from "#/features/telegram/web-support-contract";
import useDialogState from "#/hooks/use-dialog-state";
import { AppTitle } from "#/layouts/components/app-title";
import { SignOutDialog } from "#/layouts/components/sign-out-dialog";
import { localeLabels } from "#/lib/locales";
import { cn } from "#/lib/utils";
import { m } from "#/paraglide/messages";
import { getLocale, locales, setLocale } from "#/paraglide/runtime";
import {
	AccountSettingsPanel,
	type HeaderUser,
	type SettingsCurrency,
	type SettingsPanelPage,
} from "./account-settings-panel";

export function PublicHeader() {
	const session = authClient.useSession();
	const currencySelection = useCurrency();
	const user = session.data?.user;
	const adminEntry = useQuery({
		enabled: Boolean(user),
		queryFn: () => getStorefrontAdminEntryFn(),
		queryKey: ["auth", "storefront-admin-entry", user?.id],
		retry: false,
		staleTime: 60_000,
	});
	const signedIn = Boolean(user);
	const navigation = publicNavigation({ signedIn });
	const [stuck, setStuck] = useState(false);
	useEffect(() => {
		const update = () => setStuck(window.scrollY > 0);
		update();
		window.addEventListener("scroll", update, { passive: true });
		return () => window.removeEventListener("scroll", update);
	}, []);
	const headerUser = user
		? {
				email: isInternalIdentityEmail(user.email) ? "" : user.email,
				image: user.image,
				name: user.name,
			}
		: null;
	return (
		<header
			className={cn(
				"sticky inset-x-0 top-0 z-50 border-transparent border-b bg-background/90 pt-safe transition-[border-color,backdrop-filter]",
				stuck && "border-border/70 backdrop-blur-xl",
			)}
		>
			<div className="container flex h-14 items-center px-3 lg:h-18 lg:px-4">
				<Link className="min-w-0 max-w-[40%] lg:max-w-none" to="/">
					<AppTitle />
				</Link>
				{/* Phones: one-tap language switch plus a menu; the full bar does not fit. */}
				<div className="ms-auto flex shrink-0 items-center gap-1 lg:hidden">
					<QuickLocaleToggle />
					<MobileMenu navigation={navigation} />
				</div>
				<div className="ms-auto hidden shrink-0 items-center lg:flex">
					<nav className="me-6 flex items-center gap-6 text-muted-foreground text-sm">
						{navigation.map(([label, href]) => (
							<a
								className={cn(
									"whitespace-nowrap py-2 transition-colors hover:text-foreground",
									href === "/account" &&
										"rounded-full bg-primary px-2 font-semibold text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground",
								)}
								href={href}
								key={href}
							>
								{label}
							</a>
						))}
					</nav>
					<div className="flex items-center gap-1 ps-1">
						<CustomerSupport />
						<CartAction />
						<DesktopSettings
							currencySelection={currencySelection}
							root={adminEntry.data?.root}
							user={headerUser}
						/>
						{user ? null : <SignInAction />}
					</div>
				</div>
			</div>
		</header>
	);
}

/** Switches straight to the other language; the label names the target in its own script. */
function QuickLocaleToggle() {
	const current = getLocale();
	const target = locales.find((locale) => locale !== current) ?? current;
	return (
		<Button
			aria-label={m.switch_language()}
			className="h-8 gap-1.5 rounded-full px-3 text-xs"
			onClick={() => setLocale(target)}
			variant="outline"
		>
			<Languages className="size-3.5" />
			{target === "zh-CN" ? "中文" : "EN"}
		</Button>
	);
}

function MobileMenu({
	navigation,
}: {
	navigation: Array<readonly [string, string]>;
}) {
	const [open, setOpen] = useState(false);
	const current = getLocale();
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					aria-label={m.store_menu()}
					className="rounded-full"
					size="icon"
					variant="ghost"
				>
					<Menu />
				</Button>
			</PopoverTrigger>
			<PopoverContent
				align="end"
				className="w-80 max-w-[calc(100vw-1.5rem)] p-2"
			>
				<nav className="grid">
					{navigation
						.filter(([, href]) => href !== "/")
						.map(([label, href]) => (
							<a
								className={cn(
									"flex items-center justify-between rounded-xl px-3 py-3 font-medium text-sm transition-colors hover:bg-muted",
									href === "/account" && "text-primary",
								)}
								href={href}
								key={href}
							>
								{label}
								<ChevronRight className="size-4 text-muted-foreground" />
							</a>
						))}
				</nav>
				<div className="my-2 border-border/70 border-t" />
				<p className="px-3 pt-1 pb-1 font-medium text-muted-foreground text-xs">
					{m.store_support()}
				</p>
				<SupportAction
					description={m.store_support_online_description()}
					icon={MessageCircle}
					label={m.store_support_online()}
					onClick={() => {
						setOpen(false);
						window.dispatchEvent(new Event(webSupportOpenEvent));
					}}
				/>
				<SupportLink
					description="@laoshirengroup"
					href={telegramGroupUrl}
					icon={Users}
					label={m.store_support_group()}
				/>
				<SupportLink
					description="@laoshirenai_support_bot"
					href={telegramSupportUrl}
					icon={Send}
					label={m.store_support_private()}
				/>
				<div className="my-2 border-border/70 border-t" />
				<div className="flex items-center justify-between gap-3 px-3 py-2">
					<span className="flex items-center gap-2 font-medium text-sm">
						<Languages className="size-4 text-primary" />
						{m.switch_language()}
					</span>
					<div className="flex rounded-full bg-muted p-0.5">
						{locales.map((locale) => (
							<button
								aria-pressed={locale === current}
								className="rounded-full px-3 py-1 text-xs transition-colors aria-pressed:bg-background aria-pressed:font-semibold aria-pressed:shadow-sm"
								key={locale}
								onClick={() => {
									if (locale !== current) setLocale(locale);
								}}
								type="button"
							>
								{localeLabels[locale]}
							</button>
						))}
					</div>
				</div>
			</PopoverContent>
		</Popover>
	);
}

export function DeliveryTicker() {
	const message = m.store_delivery_ticker();
	return (
		<div className="group overflow-hidden border-border/60 border-y bg-primary/[0.07] text-primary">
			<p className="sr-only">{message}</p>
			<div
				aria-hidden="true"
				className="store-delivery-ticker-track flex w-max min-w-full items-center whitespace-nowrap py-1.5 font-medium text-[11px] tracking-[0.04em] group-hover:[animation-play-state:paused] sm:text-xs"
			>
				{[0, 1].map((copy) => (
					<span className="flex min-w-max items-center gap-3 px-7" key={copy}>
						<Zap className="size-3 fill-current" />
						{message}
						<span className="text-primary/45">●</span>
					</span>
				))}
			</div>
		</div>
	);
}

const telegramSupportUrl = "https://t.me/laoshirenai_support_bot";
const telegramGroupUrl = "https://t.me/laoshirengroup";

function CustomerSupport() {
	const [open, setOpen] = useState(false);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button className="gap-2 rounded-full" variant="ghost">
					<Headphones className="size-4" />
					{m.store_support()}
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-80 max-w-[calc(100vw-2rem)] p-2">
				<div className="px-3 pt-2 pb-3">
					<p className="font-medium">{m.store_support_title()}</p>
					<p className="mt-1 text-muted-foreground text-sm leading-5">
						{m.store_support_description()}
					</p>
				</div>
				<SupportAction
					description={m.store_support_online_description()}
					icon={MessageCircle}
					label={m.store_support_online()}
					onClick={() => {
						setOpen(false);
						window.dispatchEvent(new Event(webSupportOpenEvent));
					}}
				/>
				<SupportLink
					description="@laoshirengroup"
					href={telegramGroupUrl}
					icon={Users}
					label={m.store_support_group()}
				/>
				<SupportLink
					description="@laoshirenai_support_bot"
					href={telegramSupportUrl}
					icon={Send}
					label={m.store_support_private()}
				/>
			</PopoverContent>
		</Popover>
	);
}

function SupportAction({
	description,
	icon: Icon,
	label,
	onClick,
}: {
	description: string;
	icon: typeof MessageCircle;
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-start transition-colors hover:bg-muted"
			onClick={onClick}
			type="button"
		>
			<span className="grid size-9 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
				<Icon className="size-4" />
			</span>
			<span className="min-w-0 flex-1">
				<span className="block font-medium text-sm">{label}</span>
				<span className="block text-muted-foreground text-xs">
					{description}
				</span>
			</span>
			<ChevronRight className="size-4 text-muted-foreground" />
		</button>
	);
}

function SupportLink({
	description,
	href,
	icon: Icon,
	label,
}: {
	description: string;
	href: string;
	icon: typeof Send;
	label: string;
}) {
	return (
		<a
			className="flex items-center gap-3 rounded-xl px-3 py-3 transition-colors hover:bg-muted"
			href={href}
			rel="noreferrer"
			target="_blank"
		>
			<span className="grid size-9 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
				<Icon className="size-4" />
			</span>
			<span className="min-w-0 flex-1">
				<span className="block font-medium text-sm">{label}</span>
				<span className="block truncate text-muted-foreground text-xs">
					{description}
				</span>
			</span>
			<ExternalLink className="size-4 text-muted-foreground" />
		</a>
	);
}

function DesktopSettings({
	currencySelection,
	root,
	user,
}: {
	currencySelection: SettingsCurrency;
	root?: boolean;
	user?: HeaderUser | null;
}) {
	const [open, setOpen] = useState(false);
	const [page, setPage] = useState<SettingsPanelPage>("main");
	const [signOutOpen, setSignOutOpen] = useDialogState();
	const handleOpenChange = (nextOpen: boolean) => {
		setOpen(nextOpen);
		if (!nextOpen) setPage("main");
	};
	return (
		<>
			<Popover open={open} onOpenChange={handleOpenChange}>
				<PopoverTrigger asChild>
					<SettingsTrigger user={user} />
				</PopoverTrigger>
				<PopoverContent align="end" className="w-72 overflow-hidden p-0">
					<AccountSettingsPanel
						currencySelection={currencySelection}
						onClose={() => handleOpenChange(false)}
						onPageChange={setPage}
						onSignOut={() => {
							handleOpenChange(false);
							setSignOutOpen(true);
						}}
						page={page}
						root={root}
						user={user}
					/>
				</PopoverContent>
			</Popover>
			<SignOutDialog
				open={Boolean(signOutOpen)}
				onOpenChange={setSignOutOpen}
			/>
		</>
	);
}

function SettingsTrigger({
	user,
	...triggerProps
}: { user?: HeaderUser | null } & ComponentProps<typeof Button>) {
	if (!user)
		return (
			<Button
				{...triggerProps}
				aria-label={m.store_header_settings()}
				className={cn("rounded-full", triggerProps.className)}
				size="icon"
				variant="ghost"
			>
				<Settings />
			</Button>
		);
	const email = user.email || "";
	const name = user.name || email || m.store_account_title();
	return (
		<Button
			{...triggerProps}
			aria-label={m.store_account_title()}
			className={cn("rounded-full", triggerProps.className)}
			size="icon"
			variant="ghost"
		>
			<Avatar className="size-7">
				<AvatarImage alt={name} src={user.image || ""} />
				<AvatarFallback>{getUserFallback(name, email)}</AvatarFallback>
			</Avatar>
		</Button>
	);
}

function SignInAction() {
	return (
		<Button asChild>
			<Link search={{ redirect: undefined }} to="/sign-in">
				{m.public_sign_in()}
			</Link>
		</Button>
	);
}

function getUserFallback(name: string, email: string) {
	const source = name || email || "U";
	return source
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((part) => part[0]?.toUpperCase())
		.join("");
}

function CartAction() {
	const cart = useLocalCart();
	const count = cart.items.reduce((sum, item) => sum + item.quantity, 0);
	return (
		<Button asChild className="rounded-full" size="icon" variant="ghost">
			<Link aria-label={m.store_cart_title()} to="/cart">
				<ShoppingCart />
				{count ? (
					<span className="absolute translate-x-3 -translate-y-3 rounded-full bg-primary px-1 text-[10px] text-primary-foreground">
						{count > 99 ? "99+" : count}
					</span>
				) : null}
			</Link>
		</Button>
	);
}

function publicNavigation({ signedIn }: { signedIn: boolean }) {
	const navigation: Array<readonly [string, string]> = [
		[m.store_nav_shop(), "/"],
		[m.store_nav_invoice(), "/invoice"],
		[m.store_nav_rewards(), "/account"],
	];
	navigation.push(
		signedIn
			? [m.store_account_orders(), "/account/orders"]
			: [m.store_nav_orders(), "/orders"],
	);
	return navigation;
}
