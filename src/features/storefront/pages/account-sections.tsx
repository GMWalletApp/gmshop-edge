import { PromotionAccount } from "#/features/promotions/account";
import { paymentChannelLabel } from "#/features/storefront/payment-channel-label";

("use client");

import { useMutation, useQuery } from "@tanstack/react-query";
import {
	Link,
	useHydrated,
	useNavigate,
	useRouter,
} from "@tanstack/react-router";
import {
	ArrowRight,
	Boxes,
	CalendarDays,
	Download,
	Eye,
	FileDown,
	KeyRound,
	PackageOpen,
	ReceiptText,
	RefreshCw,
	ShoppingBag,
	WalletCards,
	WandSparkles,
} from "lucide-react";
import { type ComponentProps, forwardRef, useState } from "react";
import { toast } from "sonner";
import { CopyButton, ProButton } from "#/components/pro/base/button";
import { ModalForm, ProSchemaForm } from "#/components/pro/form";
import { ProModal } from "#/components/pro/overlay";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { authClient } from "#/features/auth/auth-client";
import { listPublicAuthProvidersFn } from "#/features/auth/server/provider-admin";
import { entitlementStatusLabel } from "#/features/entitlements/labels";
import { shopOrderStatusLabel } from "#/features/shop-orders/labels";
import { AutomationEntitlementCard } from "#/features/storefront/components/build-entitlement";
import { DeliveryRevealContent } from "#/features/storefront/components/delivery-reveal-content";
import {
	AccountLoginMethods,
	AccountNotificationPreferences,
	AccountSessions,
} from "#/features/storefront/pages/account";
import type { getStoreAccountFn } from "#/features/storefront/server/account-functions";
import {
	getAccountOrderFn,
	prepareEntitlementRenewalFn,
	setAccountPasswordFn,
	updateStoreProfileFn,
} from "#/features/storefront/server/account-functions";
import { listCheckoutPaymentChannelsFn } from "#/features/storefront/server/functions";
import {
	createSupplierApiKeyFn,
	listSupplierApiKeysFn,
	revokeSupplierApiKeyFn,
} from "#/features/supplier-api/server/keys";
import {
	createWalletTopupFn,
	getWalletFn,
} from "#/features/wallet/server/functions";
import { ChangePasswordForm } from "#/layouts/components/change-password-dialog";
import {
	formatBytes,
	formatDate,
	formatDateTime,
	formatMinorAmountWithSymbol,
} from "#/lib/format";
import { localeLabels, supportedLocales } from "#/lib/locales";
import { parseMajorInput } from "#/lib/money-input";
import { m } from "#/paraglide/messages";

type Account = Awaited<ReturnType<typeof getStoreAccountFn>>;

export function AccountOverviewPage({ account }: { account: Account }) {
	const actionNeeded = account.orders.filter(
		(order) => order.status === "pending_payment",
	).length;
	const activeEntitlements = account.entitlements.filter(
		(entitlement) => entitlement.status === "active",
	).length;
	return (
		<>
			<PromotionAccount />
			<PageTitle
				title={m.store_account_title()}
				description={m.store_account_overview_description()}
			/>
			<div className="grid gap-3 sm:grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]">
				<Summary
					icon={<ReceiptText />}
					label={m.store_account_orders()}
					value={account.orders.length}
				/>
				<Summary
					icon={<PackageOpen />}
					label={m.store_account_action_needed()}
					value={actionNeeded}
				/>
				<Summary
					icon={<Boxes />}
					label={m.store_account_active_entitlements()}
					value={activeEntitlements}
				/>
				<WalletSummaryCard />
				<ApiKeysDialog />
			</div>
			<section>
				<div className="flex items-center justify-between gap-4">
					<h2 className="font-semibold text-xl">
						{m.store_account_recent_orders()}
					</h2>
					{account.orders.length > 0 ? (
						<Button asChild size="sm" variant="ghost">
							<Link to="/account/orders">
								{m.store_account_view_all_orders()}
								<ArrowRight />
							</Link>
						</Button>
					) : null}
				</div>
				<div className="mt-3 grid gap-4 lg:grid-cols-2">
					{account.orders.slice(0, 5).map((order) => (
						<OrderLink key={order.orderNumber} order={order} />
					))}
					{account.orders.length === 0 ? (
						<Empty
							action={
								<Button asChild>
									<Link to="/">
										<ShoppingBag />
										{m.store_account_start_shopping()}
									</Link>
								</Button>
							}
							description={m.store_account_empty_orders_description()}
							title={m.store_account_no_orders()}
						/>
					) : null}
				</div>
			</section>
		</>
	);
}

function WalletSummaryCard() {
	const wallet = useQuery({
		queryKey: ["wallet"],
		queryFn: () => getWalletFn(),
	});
	const channels = useQuery({
		queryKey: ["storefront", "payment-channels"],
		queryFn: () => listCheckoutPaymentChannelsFn(),
	});
	const topup = useMutation({
		mutationFn: createWalletTopupFn,
		onSuccess: (payment) => {
			if (payment.checkoutUrl) window.location.assign(payment.checkoutUrl);
		},
		onError: () => toast.error(m.web_support_failed()),
	});
	return (
		<ModalForm
			description={m.wallet_top_up_description()}
			initialValues={{ channelId: channels.data?.[0]?.id }}
			key={channels.data?.[0]?.id ?? "topup-payment-loading"}
			trigger={
				<DashboardAction
					icon={<WalletCards />}
					label={m.wallet_balance()}
					value={
						wallet.data
							? formatMinorAmountWithSymbol(
									wallet.data.balanceMinor,
									wallet.data.currency,
									wallet.data.currencyDecimals,
								)
							: "…"
					}
				/>
			}
			title={m.wallet_top_up()}
			schema={[
				{
					name: "amountMinor",
					label: m.wallet_top_up_amount(),
					required: true,
					render: (field) => (
						<TopupAmountField
							currency={wallet.data?.currency ?? "USD"}
							decimals={wallet.data?.currencyDecimals ?? 2}
							onChange={field.onChange}
							value={typeof field.value === "string" ? field.value : ""}
						/>
					),
				},
				{
					name: "channelId",
					label: m.store_payment_method(),
					valueType: "select",
					required: true,
					fieldProps: {
						options:
							channels.data?.map((channel) => ({
								label: paymentChannelLabel(channel.name),
								value: channel.id,
							})) ?? [],
					},
				},
			]}
			validate={(values) => {
				const errors: Record<string, string[]> = {};
				if (!isPositiveMinor(values.amountMinor))
					errors.amountMinor = [m.store_input_required()];
				return errors;
			}}
			onFinish={async (values) => {
				await topup.mutateAsync({
					data: {
						amountMinor: String(values.amountMinor ?? ""),
						channelId: String(values.channelId ?? ""),
						idempotencyKey: crypto.randomUUID(),
					},
				});
			}}
			onFinishFailed={() => toast.error(m.web_support_failed())}
		/>
	);
}

const topupPresetAmounts = [10, 20, 50, 100] as const;

function isPositiveMinor(value: unknown) {
	return typeof value === "string" && /^\d+$/.test(value) && BigInt(value) > 0n;
}

function TopupAmountField({
	value,
	onChange,
	currency,
	decimals,
}: {
	value: string;
	onChange: (value: string) => void;
	currency: string;
	decimals: number;
}) {
	const [display, setDisplay] = useState("");
	const presets = topupPresetAmounts.map((major) => ({
		major,
		minor: parseMajorInput(String(major), decimals) ?? "",
	}));
	return (
		<div className="grid gap-3">
			<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
				{presets.map((preset) => (
					<Button
						key={preset.major}
						onClick={() => {
							setDisplay(String(preset.major));
							onChange(preset.minor);
						}}
						type="button"
						variant={value === preset.minor ? "default" : "outline"}
					>
						{formatMinorAmountWithSymbol(preset.minor, currency, decimals)}
					</Button>
				))}
			</div>
			<div className="relative">
				<Input
					aria-label={m.wallet_custom_amount()}
					className="pr-16"
					inputMode="decimal"
					onChange={(event) => {
						const nextDisplay = event.target.value;
						setDisplay(nextDisplay);
						const parsed = parseMajorInput(nextDisplay, decimals);
						onChange(parsed === undefined ? "" : (parsed ?? ""));
					}}
					placeholder={m.wallet_custom_amount()}
					value={display}
				/>
				<span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-muted-foreground text-sm">
					{currency}
				</span>
			</div>
		</div>
	);
}

function ApiKeysDialog() {
	const api = useQuery({
		queryKey: ["supplier-api-keys"],
		queryFn: () => listSupplierApiKeysFn(),
	});
	const [createdKey, setCreatedKey] = useState<{
		apiKey: string;
		apiSecret: string;
	} | null>(null);
	const [keyName, setKeyName] = useState("");
	const [password, setPassword] = useState("");
	const createKey = useMutation({
		mutationFn: createSupplierApiKeyFn,
		onSuccess: (key) => {
			setCreatedKey(key);
			setKeyName("");
			setPassword("");
			void api.refetch();
		},
		onError: () => toast.error(m.web_support_failed()),
	});
	const revokeKey = useMutation({
		mutationFn: revokeSupplierApiKeyFn,
		onSuccess: () => api.refetch(),
		onError: () => toast.error(m.web_support_failed()),
	});
	if (!api.data?.enabled) return null;
	const activeKeys = api.data.keys.filter((key) => !key.revoked_at);
	return (
		<ProModal
			description={m.supplier_api_purchase_description()}
			trigger={
				<DashboardAction
					icon={<KeyRound />}
					label={m.supplier_api_purchase()}
					value={m.supplier_api_key_count({ count: activeKeys.length })}
				/>
			}
			title={m.supplier_api_purchase()}
		>
			<div className="flex min-h-0 flex-col gap-4">
				<div className="grid gap-5 overflow-y-auto px-1">
					{createdKey ? (
						<section className="rounded-xl bg-primary/8 p-4 ring-1 ring-primary/20">
							<div className="flex items-start gap-3">
								<span className="grid size-9 shrink-0 place-items-center rounded-full bg-primary/15 text-primary">
									<KeyRound className="size-4" />
								</span>
								<div>
									<p className="font-medium">{m.supplier_api_key_created()}</p>
									<p className="mt-1 text-muted-foreground text-sm">
										{m.supplier_api_key_created_notice()}
									</p>
								</div>
							</div>
							<div className="mt-4 grid gap-2">
								<ApiCredential
									label={m.supplier_api_key()}
									value={createdKey.apiKey}
								/>
								<ApiCredential
									label={m.supplier_api_secret()}
									value={createdKey.apiSecret}
								/>
							</div>
						</section>
					) : null}
					<section>
						<h3 className="mb-2 font-medium text-sm">
							{m.supplier_api_existing_keys()}
						</h3>
						<div className="grid gap-2">
							{api.data.keys.length ? (
								api.data.keys.map((key) => (
									<div
										className="flex min-w-0 items-center gap-3 rounded-xl bg-muted/35 p-3"
										key={key.id}
									>
										<span className="grid size-9 shrink-0 place-items-center rounded-full bg-background text-primary">
											<KeyRound className="size-4" />
										</span>
										<div className="min-w-0 flex-1">
											<p className="truncate font-medium text-sm">{key.name}</p>
											<p className="text-muted-foreground text-xs">
												{m.supplier_api_key()}
											</p>
											<code className="block truncate text-xs">
												{key.key_id}
											</code>
										</div>
										<Badge variant={key.revoked_at ? "outline" : "secondary"}>
											{key.revoked_at
												? m.supplier_api_revoked()
												: m.common_enabled()}
										</Badge>
										<Button
											disabled={Boolean(key.revoked_at) || revokeKey.isPending}
											onClick={() => revokeKey.mutate({ data: { id: key.id } })}
											size="sm"
											variant="ghost"
										>
											{m.supplier_api_revoke()}
										</Button>
									</div>
								))
							) : (
								<p className="rounded-xl bg-muted/35 p-4 text-center text-muted-foreground text-sm">
									{m.supplier_api_no_keys()}
								</p>
							)}
						</div>
					</section>
				</div>
				<div className="grid shrink-0 gap-3 border-t pt-4">
					<label className="grid gap-1.5" htmlFor="supplier-api-key-name">
						<span className="font-medium text-sm">
							{m.supplier_api_key_name()}
						</span>
						<Input
							id="supplier-api-key-name"
							maxLength={100}
							onChange={(event) => setKeyName(event.target.value)}
							placeholder={m.supplier_api_key_name_placeholder()}
							value={keyName}
						/>
					</label>
					<label
						className="grid gap-1.5"
						htmlFor="supplier-api-current-password"
					>
						<span className="font-medium text-sm">
							{m.supplier_api_current_password()}
						</span>
						<Input
							autoComplete="current-password"
							id="supplier-api-current-password"
							maxLength={500}
							onChange={(event) => setPassword(event.target.value)}
							type="password"
							value={password}
						/>
					</label>
					{activeKeys.length >= 10 ? (
						<p className="text-destructive text-sm">
							{m.supplier_api_key_limit_reached()}
						</p>
					) : null}
					<div className="flex justify-end">
						<Button
							disabled={
								createKey.isPending ||
								activeKeys.length >= 10 ||
								!keyName.trim() ||
								!password
							}
							onClick={() =>
								createKey.mutate({
									data: { name: keyName, password },
								})
							}
						>
							<KeyRound />
							{m.supplier_create_new_api_key()}
						</Button>
					</div>
				</div>
			</div>
		</ProModal>
	);
}

function ApiCredential({ label, value }: { label: string; value: string }) {
	return (
		<div className="grid min-w-0 gap-1 rounded-lg bg-background/75 p-3">
			<span className="text-muted-foreground text-xs">{label}</span>
			<div className="flex min-w-0 items-center gap-2">
				<code className="min-w-0 flex-1 truncate text-xs">{value}</code>
				<CopyButton
					aria-label={`${m.common_copy()} ${label}`}
					copy={value}
					size="icon-sm"
				/>
			</div>
		</div>
	);
}

export function AccountOrdersPage({ account }: { account: Account }) {
	return (
		<>
			<PageTitle
				title={m.store_account_orders()}
				description={m.store_account_orders_description()}
			/>
			<div className="grid gap-4 lg:grid-cols-2">
				{account.orders.map((order) => (
					<OrderLink key={order.orderNumber} order={order} />
				))}
				{account.orders.length === 0 ? (
					<Empty
						action={
							<Button asChild>
								<Link to="/">
									<ShoppingBag />
									{m.store_account_start_shopping()}
								</Link>
							</Button>
						}
						description={m.store_account_empty_orders_description()}
						title={m.store_account_no_orders()}
					/>
				) : null}
			</div>
		</>
	);
}

export function AccountEntitlementsPage({ account }: { account: Account }) {
	const navigate = useNavigate();
	const entitlements = account.entitlements.filter(
		(entitlement) => entitlement.status !== "exhausted",
	);
	const renew = useMutation({
		mutationFn: prepareEntitlementRenewalFn,
		onSuccess: (result) => {
			sessionStorage.setItem(
				`gmshop-renewal:${result.sellableItemId}`,
				result.entitlementId,
			);
			void navigate({ to: "/checkout" });
		},
		onError: () => toast.error(m.store_checkout_failed()),
	});
	return (
		<>
			<PageTitle
				title={m.store_account_entitlements()}
				description={m.store_account_entitlements_description()}
			/>
			<div className="grid gap-4 lg:grid-cols-2">
				{entitlements.map((entitlement) => (
					<EntitlementCard
						entitlement={entitlement}
						key={entitlement.id}
						onRenew={() =>
							renew.mutate({
								data: { entitlementId: entitlement.id },
							})
						}
						renewing={renew.isPending}
					/>
				))}
				{entitlements.length === 0 ? (
					<Empty
						action={
							<Button asChild>
								<Link to="/">
									<ShoppingBag />
									{m.store_account_start_shopping()}
								</Link>
							</Button>
						}
						description={m.store_account_empty_entitlements_description()}
						title={m.store_account_no_entitlements()}
					/>
				) : null}
			</div>
		</>
	);
}

function EntitlementCard({
	entitlement,
	onRenew,
	renewing,
}: {
	entitlement: Account["entitlements"][number];
	onRenew: () => void;
	renewing: boolean;
}) {
	const navigate = useNavigate();
	const EntitlementIcon =
		entitlement.type === "stock"
			? KeyRound
			: entitlement.type === "download"
				? FileDown
				: WandSparkles;
	const remaining =
		entitlement.usageLimit !== null
			? m.store_account_entitlement_times({
					count: Math.max(0, entitlement.usageLimit - entitlement.usageCount),
				})
			: entitlement.accessLimit !== null
				? m.store_account_entitlement_times({
						count: Math.max(
							0,
							entitlement.accessLimit - entitlement.accessCount,
						),
					})
				: m.store_account_entitlement_unlimited();
	const expired = entitlement.status === "expired";
	return (
		<article
			className="group flex min-w-0 flex-col rounded-3xl border bg-card p-5 transition-colors hover:border-primary/35 sm:p-6"
			data-status={entitlement.status}
		>
			<header className="flex items-start justify-between gap-4">
				<div className="flex min-w-0 items-start gap-3">
					<span
						className={`grid size-10 shrink-0 place-items-center rounded-xl ${
							expired
								? "bg-muted text-muted-foreground"
								: "bg-primary/10 text-primary"
						}`}
					>
						<EntitlementIcon className="size-5" />
					</span>
					<div className="min-w-0">
						<strong className="block truncate text-base">
							{entitlement.productName}
						</strong>
						{entitlement.sellableItemName !== entitlement.productName ? (
							<p className="mt-1 truncate text-muted-foreground text-sm">
								{entitlement.sellableItemName}
							</p>
						) : null}
						<Badge className="mt-2" variant={expired ? "secondary" : "outline"}>
							{entitlementStatusLabel(entitlement.status)}
						</Badge>
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-1">
					{entitlement.renewable ? (
						<ProButton
							disabled={renewing}
							onClick={onRenew}
							size="sm"
							variant="outline"
						>
							<RefreshCw />
							{m.store_entitlement_renew()}
						</ProButton>
					) : null}
					<ProButton
						onClick={() =>
							void navigate({
								to: "/account/orders/$orderNumber",
								params: { orderNumber: entitlement.orderNumber },
								search: { from: "entitlements" },
							})
						}
						size="sm"
						variant="outline"
					>
						<ReceiptText />
						{m.store_account_entitlement_details()}
					</ProButton>
				</div>
			</header>
			<div className="mt-7 flex flex-1 items-end justify-between gap-6">
				<div>
					<p className="text-muted-foreground text-xs">
						{m.store_account_entitlement_quota()}
					</p>
					<p className="mt-1 font-semibold text-2xl tracking-tight">
						{remaining}
					</p>
				</div>
				<div className="min-w-0 text-right">
					<p className="text-muted-foreground text-xs">
						{m.store_account_entitlement_validity()}
					</p>
					<p className="mt-1 flex items-center justify-end gap-1.5 font-medium text-sm">
						<CalendarDays className="size-4 text-primary" />
						{entitlement.expiresAt ? (
							<time
								dateTime={new Date(entitlement.expiresAt).toISOString()}
								suppressHydrationWarning
							>
								{formatDate(entitlement.expiresAt)}
							</time>
						) : (
							m.store_account_entitlement_available()
						)}
					</p>
				</div>
			</div>
			<AccountEntitlementActions entitlement={entitlement} />
		</article>
	);
}

function AccountEntitlementActions({
	entitlement,
}: {
	entitlement: Account["entitlements"][number];
}) {
	const router = useRouter();
	const supportsAccountActions = ["stock", "download", "automation"].includes(
		entitlement.type,
	);
	const order = useQuery({
		queryKey: ["storefront", "account", "order", entitlement.orderNumber],
		queryFn: () =>
			getAccountOrderFn({
				data: { orderNumber: entitlement.orderNumber },
			}),
		enabled: supportsAccountActions,
	});
	if (!supportsAccountActions) return null;
	if (order.isPending) {
		return (
			<p className="min-h-9 text-muted-foreground text-sm">
				{m.common_loading()}
			</p>
		);
	}
	if (!order.data) {
		return (
			<div className="flex min-h-9 items-center justify-between gap-3">
				<p className="text-muted-foreground text-sm">
					{m.store_account_entitlement_actions_failed()}
				</p>
				<Button
					size="sm"
					variant="outline"
					onClick={() => void order.refetch()}
				>
					{m.common_retry()}
				</Button>
			</div>
		);
	}
	const data = order.data;
	const downloads =
		entitlement.type === "download"
			? data.downloads.filter(
					(asset) =>
						asset.entitlementId === entitlement.id &&
						(asset.accessLimit === null ||
							asset.accessCount < asset.accessLimit),
				)
			: [];
	const stockDelivery =
		entitlement.type === "stock"
			? data.deliveries.find(
					(delivery) =>
						delivery.entitlementId === entitlement.id &&
						delivery.status === "delivered" &&
						delivery.hasContent,
				)
			: undefined;
	const automation =
		entitlement.type === "automation"
			? data.automationRuns.find((run) => run.id === entitlement.id)
			: undefined;
	async function downloadAsset(asset: (typeof data.downloads)[number]) {
		const response = await fetch(
			`/api/shop/orders/${encodeURIComponent(entitlement.orderNumber)}/downloads/${encodeURIComponent(asset.id)}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
				credentials: "same-origin",
			},
		);
		if (!response.ok) {
			toast.error(m.store_download_failed());
			return;
		}
		const url = URL.createObjectURL(await response.blob());
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = asset.fileName;
		anchor.click();
		URL.revokeObjectURL(url);
		void refreshEntitlement();
	}
	async function refreshEntitlement() {
		await Promise.all([
			order.refetch(),
			router.invalidate({
				filter: (match) => match.routeId === "/(public)/account",
			}),
		]);
	}
	if (!stockDelivery && !downloads.length && !automation) return null;
	return (
		<div className="mt-6 flex min-h-9 flex-wrap items-end gap-2">
			{stockDelivery ? (
				<Dialog>
					<DialogTrigger asChild>
						<Button size="sm">
							<Eye />
							{m.store_reveal_delivery()}
						</Button>
					</DialogTrigger>
					<DialogContent className="sm:max-w-lg">
						<DialogHeader>
							<DialogTitle>{m.store_reveal_delivery()}</DialogTitle>
							<DialogDescription>
								{entitlement.productName} · {entitlement.sellableItemName}
							</DialogDescription>
						</DialogHeader>
						<DeliveryRevealContent
							deliveryId={stockDelivery.id}
							orderNumber={entitlement.orderNumber}
						/>
					</DialogContent>
				</Dialog>
			) : null}
			{downloads.length ? (
				<Dialog>
					<DialogTrigger asChild>
						<Button size="sm">
							<Download />
							{m.store_downloads()}
						</Button>
					</DialogTrigger>
					<DialogContent className="sm:max-w-lg">
						<DialogHeader>
							<DialogTitle>{m.store_downloads()}</DialogTitle>
							<DialogDescription>
								{entitlement.productName} · {entitlement.sellableItemName}
							</DialogDescription>
						</DialogHeader>
						<div className="divide-y">
							{downloads.map((asset) => (
								<div
									className="flex items-center justify-between gap-3 py-4 first:pt-0 last:pb-0"
									key={asset.id}
								>
									<div className="min-w-0">
										<strong className="block truncate text-sm">
											{asset.fileName}
										</strong>
										<span className="text-muted-foreground text-xs">
											v{asset.version} · {formatBytes(asset.sizeBytes)}
										</span>
									</div>
									<Button onClick={() => void downloadAsset(asset)} size="sm">
										<Download />
										{m.store_download()}
									</Button>
								</div>
							))}
						</div>
					</DialogContent>
				</Dialog>
			) : null}
			{automation ? (
				<AutomationEntitlementCard
					automation={automation}
					notificationChannels={data.automationNotificationChannels}
					onChanged={() => void refreshEntitlement()}
					orderNumber={entitlement.orderNumber}
				/>
			) : null}
		</div>
	);
}

export function AccountSettingsPage({ account }: { account: Account }) {
	const session = authClient.useSession();
	const update = useMutation({
		mutationFn: updateStoreProfileFn,
		onSuccess: async () => {
			await session.refetch();
			toast.success(m.store_account_profile_saved());
		},
		onError: () => toast.error(m.store_account_operation_failed()),
	});
	return (
		<>
			<PageTitle
				title={m.store_account_settings()}
				description={m.store_account_settings_description()}
			/>
			<div className="grid gap-5 lg:grid-cols-2">
				<section className="grid content-start gap-5 rounded-3xl border bg-card p-5 sm:p-6">
					<div className="flex items-start justify-between gap-4">
						<div>
							<h2 className="font-semibold text-xl">
								{m.store_account_profile()}
							</h2>
							<p className="mt-1 text-muted-foreground text-sm">
								{m.store_account_profile_description()}
							</p>
						</div>
						<Button form="account-profile-form" size="sm" type="submit">
							{m.store_account_save()}
						</Button>
					</div>
					<ProSchemaForm
						className="grid gap-3"
						id="account-profile-form"
						initialValues={{
							name: account.user.name,
							preferredLocale: account.user.preferredLocale,
						}}
						onFinish={async (values) => {
							await update.mutateAsync({
								data: {
									name: String(values.name ?? ""),
									preferredLocale:
										values.preferredLocale === "zh-CN" ? "zh-CN" : "en-US",
								},
							});
						}}
						schema={[
							{
								name: "name",
								label: m.common_name(),
								required: true,
								fieldProps: { maxLength: 120 },
							},
							{
								name: "preferredLocale",
								label: m.store_account_preferred_language(),
								valueType: "select",
								required: true,
								tooltip: m.store_account_preferred_language_description(),
								fieldProps: {
									options: supportedLocales.map((locale) => ({
										label: localeLabels[locale],
										value: locale,
									})),
								},
							},
						]}
						submitter={false}
					/>
				</section>
				<AccountEmailSettings account={account} />
				<section className="grid content-start gap-5 rounded-3xl border bg-card p-5 sm:p-6">
					<div className="flex items-start justify-between gap-4">
						<div>
							<h2 className="font-semibold text-xl">
								{m.store_account_security()}
							</h2>
							<p className="mt-1 text-muted-foreground text-sm">
								{m.store_account_security_description()}
							</p>
						</div>
						{account.hasPassword || account.user.email ? (
							<Button form="account-password-form" size="sm" type="submit">
								{m.store_account_save()}
							</Button>
						) : null}
					</div>
					{account.hasPassword ? (
						<ChangePasswordForm formId="account-password-form" />
					) : account.user.email ? (
						<>
							<p className="text-muted-foreground text-sm">
								{m.store_account_set_password_description()}
							</p>
							<SetPasswordForm formId="account-password-form" />
						</>
					) : (
						<p className="text-muted-foreground text-sm">
							{m.store_account_password_bind_email_first()}
						</p>
					)}
				</section>
				<section className="grid content-start gap-5 rounded-3xl border bg-card p-5 sm:p-6">
					<div>
						<h2 className="font-semibold text-xl">
							{m.store_account_login_methods()}
						</h2>
						<p className="mt-1 text-muted-foreground text-sm">
							{m.store_account_connections_description()}
						</p>
					</div>
					<AccountLoginMethods />
				</section>
			</div>
		</>
	);
}

function AccountEmailSettings({ account }: { account: Account }) {
	const providers = useQuery({
		queryKey: ["public", "auth-providers"],
		queryFn: () => listPublicAuthProvidersFn(),
		staleTime: 30_000,
	});
	const emailDeliveryEnabled =
		providers.data?.some((provider) => provider.emailDeliveryEnabled) === true;
	const changeEmail = useMutation({
		mutationFn: async ({
			newEmail,
			newPassword,
		}: {
			newEmail: string;
			newPassword?: string;
		}) => {
			if (newPassword) await setAccountPasswordFn({ data: { newPassword } });
			const result = await authClient.changeEmail({
				newEmail,
				callbackURL: "/account/settings",
			});
			if (result.error) throw result.error;
			return result.data;
		},
		onSuccess: () =>
			toast.success(
				account.user.emailVerified
					? m.store_account_email_change_sent()
					: m.store_account_email_bind_sent(),
			),
		onError: () => toast.error(m.store_account_email_change_failed()),
	});
	const formId = "account-email-form";
	return (
		<section className="grid content-start gap-5 rounded-3xl border bg-card p-5 sm:p-6">
			<div className="flex items-start justify-between gap-4">
				<div>
					<h2 className="font-semibold text-xl">{m.store_account_email()}</h2>
					<p className="mt-1 text-muted-foreground text-sm">
						{m.store_account_email_description()}
					</p>
				</div>
				<Button
					disabled={
						providers.isPending ||
						!emailDeliveryEnabled ||
						changeEmail.isPending
					}
					form={formId}
					size="sm"
					type="submit"
				>
					{account.user.email
						? m.store_account_email_change()
						: m.store_account_email_bind()}
				</Button>
			</div>
			{account.user.email ? (
				<div className="rounded-xl border bg-muted/20 p-3">
					<div className="flex items-center gap-2">
						<span className="font-medium text-sm">
							{m.store_account_email_bound()}
						</span>
						<Badge variant="secondary">
							{account.user.emailVerified
								? m.store_account_email_verified()
								: m.store_account_email_pending()}
						</Badge>
					</div>
					<p className="mt-1 text-muted-foreground text-sm">
						{account.user.email}
					</p>
				</div>
			) : (
				<p className="text-muted-foreground text-sm">
					{m.store_account_email_unbound()}
				</p>
			)}
			{!providers.isPending && !emailDeliveryEnabled ? (
				<p className="text-muted-foreground text-sm">
					{m.store_account_email_delivery_unavailable()}
				</p>
			) : (
				<ProSchemaForm
					className="grid gap-3"
					id={formId}
					onFinish={async (values) => {
						const newPassword = String(values.newPassword ?? "");
						if (
							!account.hasPassword &&
							newPassword !== String(values.confirmPassword ?? "")
						)
							throw new Error("passwords_do_not_match");
						await changeEmail.mutateAsync({
							newEmail: String(values.email ?? "")
								.trim()
								.toLowerCase(),
							...(account.hasPassword ? {} : { newPassword }),
						});
					}}
					schema={[
						{
							name: "email",
							label: m.store_account_email_new(),
							required: true,
							fieldProps: {
								autoComplete: "email",
								maxLength: 320,
								type: "email",
							},
						},
						...(!account.hasPassword
							? [
									{
										name: "newPassword",
										label: m.account_change_password_new_password_label(),
										valueType: "password" as const,
										required: true,
										fieldProps: { minLength: 12, maxLength: 200 },
									},
									{
										name: "confirmPassword",
										label: m.account_change_password_confirm_password_label(),
										valueType: "password" as const,
										required: true,
										fieldProps: { minLength: 12, maxLength: 200 },
									},
								]
							: []),
					]}
					submitter={false}
				/>
			)}
		</section>
	);
}

function SetPasswordForm({ formId }: { formId: string }) {
	const setup = useMutation({
		mutationFn: setAccountPasswordFn,
		onSuccess: () => {
			toast.success(m.store_account_set_password_success());
			window.location.reload();
		},
		onError: () => toast.error(m.store_account_set_password_failed()),
	});
	return (
		<ProSchemaForm
			className="grid gap-3"
			id={formId}
			schema={[
				{
					name: "newPassword",
					label: m.account_change_password_new_password_label(),
					valueType: "password",
					required: true,
					fieldProps: { minLength: 12, maxLength: 200 },
				},
				{
					name: "confirmPassword",
					label: m.account_change_password_confirm_password_label(),
					valueType: "password",
					required: true,
					fieldProps: { minLength: 12, maxLength: 200 },
				},
			]}
			onFinish={async (values) => {
				const newPassword = String(values.newPassword ?? "");
				if (newPassword !== String(values.confirmPassword ?? ""))
					throw new Error("passwords_do_not_match");
				await setup.mutateAsync({ data: { newPassword } });
			}}
			submitter={false}
		/>
	);
}

export function AccountSessionsPage() {
	return (
		<>
			<PageTitle
				title={m.store_account_sessions()}
				description={m.store_account_sessions_description()}
			/>
			<AccountSessions />
		</>
	);
}

export function AccountNotificationsPage({ account }: { account: Account }) {
	return (
		<>
			<PageTitle
				title={m.store_account_notifications()}
				description={m.store_account_notifications_description()}
			/>
			<AccountNotificationPreferences account={account} />
		</>
	);
}

function PageTitle({
	title,
	description,
}: {
	title: string;
	description: string;
}) {
	return (
		<div className="max-w-3xl pb-1">
			<h1 className="text-balance font-semibold text-3xl tracking-[-0.035em] sm:text-4xl">
				{title}
			</h1>
			<p className="mt-2 text-pretty text-muted-foreground leading-6">
				{description}
			</p>
		</div>
	);
}
function Summary({
	icon,
	label,
	value,
}: {
	icon: React.ReactNode;
	label: string;
	value: number;
}) {
	return (
		<div className="flex items-center gap-4 rounded-2xl bg-muted/30 p-4 sm:p-5">
			<span className="grid size-10 place-items-center rounded-full bg-background text-primary">
				{icon}
			</span>
			<div>
				<p className="text-muted-foreground text-sm">{label}</p>
				<strong className="text-2xl">{value}</strong>
			</div>
		</div>
	);
}

const DashboardAction = forwardRef<
	HTMLButtonElement,
	Omit<ComponentProps<"button">, "children"> & {
		icon: React.ReactNode;
		label: string;
		value: React.ReactNode;
	}
>(function DashboardAction({ icon, label, value, className, ...props }, ref) {
	return (
		<button
			className={`flex items-center gap-4 rounded-2xl bg-muted/30 p-4 text-start transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:p-5 ${className ?? ""}`}
			ref={ref}
			type="button"
			{...props}
		>
			<span className="grid size-10 shrink-0 place-items-center rounded-full bg-background text-primary">
				{icon}
			</span>
			<span className="min-w-0">
				<span className="block truncate text-muted-foreground text-sm">
					{label}
				</span>
				<strong className="block truncate text-2xl">{value}</strong>
			</span>
		</button>
	);
});
function Empty({
	title,
	description,
	action,
}: {
	title: string;
	description: string;
	action?: React.ReactNode;
}) {
	return (
		<div className="grid min-h-64 justify-items-center content-center gap-3 rounded-3xl bg-muted/25 px-6 py-12 text-center">
			<span className="grid size-12 place-items-center rounded-full bg-background text-primary">
				<PackageOpen className="size-6" />
			</span>
			<div>
				<p className="font-medium">{title}</p>
				<p className="mt-1 max-w-md text-muted-foreground text-sm leading-6">
					{description}
				</p>
			</div>
			{action ? <div className="mt-1">{action}</div> : null}
		</div>
	);
}

function OrderLink({ order }: { order: Account["orders"][number] }) {
	const hydrated = useHydrated();
	return (
		<Link
			className="group flex min-h-40 flex-col rounded-3xl border bg-card p-5 transition-colors hover:border-primary/35 sm:p-6"
			params={{ orderNumber: order.orderNumber }}
			search={{}}
			to="/account/orders/$orderNumber"
		>
			<div className="flex items-start justify-between gap-4">
				<div className="flex min-w-0 items-start gap-3">
					<span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
						<ReceiptText className="size-5" />
					</span>
					<div className="min-w-0">
						<strong className="block truncate font-medium">
							{order.productName ?? m.store_account_order()}
						</strong>
						<p className="mt-1 text-muted-foreground text-xs">
							{m.shop_orders_items()} {order.itemCount}
						</p>
					</div>
				</div>
				<Badge
					className={orderStatusBadgeClass(order.status)}
					variant="outline"
				>
					{shopOrderStatusLabel(order.status)}
				</Badge>
			</div>
			<div className="mt-5 flex flex-1 items-end justify-between gap-6">
				<div className="min-w-0">
					<p className="truncate font-mono text-muted-foreground text-xs">
						{order.orderNumber}
					</p>
					<p className="mt-1 text-muted-foreground text-xs">
						{formatDateTime(
							order.createdAt,
							undefined,
							hydrated ? undefined : "UTC",
						)}
					</p>
				</div>
				<p className="shrink-0 font-semibold text-primary text-xl">
					{formatMinorAmountWithSymbol(
						order.totalMinor,
						order.currency,
						order.currencyDecimals,
					)}
				</p>
			</div>
		</Link>
	);
}

function orderStatusBadgeClass(status: string) {
	if (["paid", "completed"].includes(status)) {
		return "border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
	}
	if (["cancelled", "expired", "failed"].includes(status)) {
		return "border-destructive/20 bg-destructive/10 text-destructive-foreground";
	}
	if (["refunding", "refunded"].includes(status)) {
		return "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-400";
	}
	return "border-primary/20 bg-primary/10 text-primary";
}
