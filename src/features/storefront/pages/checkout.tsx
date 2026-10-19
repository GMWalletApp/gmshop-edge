"use client";

import { useMutation, useQueries, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import {
	AlertTriangle,
	ArrowLeft,
	Boxes,
	LogIn,
	ShoppingCart,
} from "lucide-react";
import {
	type ReactNode,
	type SyntheticEvent,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import {
	CheckboxControl,
	Checkbox as ProCheckbox,
} from "#/components/pro/base/fields/checkbox";
import { PaymentProviderLogo } from "#/components/provider-logo";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Skeleton } from "#/components/ui/skeleton";
import { Switch } from "#/components/ui/switch";
import {
	AgentAccessCheckout,
	agentEligibilityOptions,
} from "#/features/agent-access/components/access";
import { agentAccessErrorMessage } from "#/features/agent-access/error-message";
import {
	agentAccessKind,
	agentAccessRefundPolicy,
} from "#/features/agent-access/products";
import { authClient } from "#/features/auth/auth-client";
import { isInternalIdentityEmail } from "#/features/auth/identity-email";
import {
	StoreMoney,
	useCurrency,
} from "#/features/exchange-rates/currency-context";
import { readReferral } from "#/features/promotions/referral-storage";
import { quotePromotionFn } from "#/features/promotions/server/functions";
import { paymentSurchargeAmount } from "#/features/shop-payments/fees";
import {
	useLocalCart,
	writeLocalCart,
} from "#/features/storefront/cart-storage";
import {
	commerceSessionId,
	trackCommerceEvent,
} from "#/features/storefront/commerce-events";
import {
	ClaudePurchaseGuide,
	claudeRechargeProductId,
} from "#/features/storefront/components/claude-purchase-guide";
import { writeGuestOrderEmail } from "#/features/storefront/order-access-storage";
import { paymentChannelLabel } from "#/features/storefront/payment-channel-label";
import { safeStorePaymentUrl } from "#/features/storefront/payment-url";
import {
	getStoreCartFn,
	previewStoreCartFn,
} from "#/features/storefront/server/cart";
import { getStorefrontProductFn } from "#/features/storefront/server/catalog";
import {
	checkoutStoreOrderFn,
	quoteCheckoutPaymentChannelsFn,
} from "#/features/storefront/server/functions";
import { getWalletFn } from "#/features/wallet/server/functions";
import { m } from "#/paraglide/messages";
import { getLocale } from "#/paraglide/runtime";

type InputValue = string | number | boolean | string[];

function CheckoutState({
	action,
	description,
	icon,
	title,
}: {
	action?: ReactNode;
	description?: string;
	icon: ReactNode;
	title: string;
}) {
	return (
		<div className="container grid min-h-[60vh] place-items-center px-4 py-12">
			<div className="grid w-full max-w-lg place-items-center gap-4 rounded-3xl bg-muted/30 p-10 text-center">
				<div className="[&>svg]:size-12">{icon}</div>
				<h1 className="font-semibold text-3xl tracking-tight">{title}</h1>
				{description ? (
					<p className="max-w-sm text-muted-foreground text-sm">
						{description}
					</p>
				) : null}
				{action}
			</div>
		</div>
	);
}

export function StorefrontCheckoutPage() {
	const locale = getLocale();
	const navigate = useNavigate();
	const { currency: paymentCurrency } = useCurrency();
	const session = authClient.useSession();
	const accountHasPublicEmail =
		Boolean(session.data?.user.email) &&
		!isInternalIdentityEmail(session.data?.user.email);
	const local = useLocalCart();
	const search = useSearch({ from: "/(public)/checkout/" });
	const buyNow =
		search.mode === "buy-now" && search.sellableItemId
			? {
					sellableItemId: search.sellableItemId,
					quantity: search.quantity,
				}
			: null;
	const requestedItems = buyNow ? [buyNow] : local.items;
	const checkoutItemsKey = requestedItems
		.map((item) => `${item.sellableItemId}:${item.quantity}`)
		.join("|");
	const [email, setEmail] = useState("");
	const [enteredCouponCode, setCouponCode] = useState("");
	const [useBalance, setUseBalance] = useState(true);
	useEffect(() => {
		setCouponCode(readReferral());
	}, []);
	const [paymentChannelId, setPaymentChannelId] = useState("");
	const [termsAccepted, setTermsAccepted] = useState(true);
	const [acceptedAgentTermsScope, setAcceptedAgentTermsScope] = useState<
		string | null
	>(null);
	const [inputValues, setInputValues] = useState<
		Record<string, Record<string, InputValue>>
	>({});
	const idempotencyKeys = useRef(new Map<string, string>());
	const cloud = useQuery({
		queryKey: ["storefront", "cart", session.data?.user.id],
		queryFn: () => getStoreCartFn(),
		enabled: Boolean(session.data?.user && !buyNow),
	});
	const preview = useQuery({
		queryKey: ["storefront", "cart-preview", requestedItems],
		queryFn: () =>
			previewStoreCartFn({
				data: { items: requestedItems, expectedVersion: null },
			}),
		enabled: Boolean(
			buyNow || (!session.data?.user && requestedItems.length > 0),
		),
	});
	const cart = buyNow
		? preview.data
		: session.data?.user
			? cloud.data
			: preview.data;
	const items = useMemo(() => cart?.items ?? [], [cart?.items]);
	const accessItem = items.find((item) => agentAccessKind(item.sellableItemId));
	const hasAgentAccess = Boolean(accessItem);
	const useOrderBalance = hasAgentAccess
		? paymentChannelId === "wallet"
		: useBalance;
	const eligibility = useQuery(
		agentEligibilityOptions(
			accessItem?.sellableItemId ?? "",
			session.data?.user,
		),
	);
	const agentBlocked =
		hasAgentAccess &&
		(items.length !== 1 ||
			accessItem?.quantity !== 1 ||
			eligibility.status !== "success" ||
			eligibility.isFetching ||
			eligibility.data?.state !== "eligible");
	const couponCode = hasAgentAccess ? "" : enteredCouponCode;
	const agentTermsScope = `${session.data?.user.id ?? "guest"}:${items.map((item) => `${item.sellableItemId}:${item.quantity}`).join("|")}`;
	const agentAccessTermsAccepted = acceptedAgentTermsScope === agentTermsScope;
	const currencies = new Set(
		items.flatMap((item) =>
			"currency" in item ? [`${item.currency}:${item.currencyDecimals}`] : [],
		),
	);
	const hasItemIssues = items.some((item) => item.issues.length > 0);
	const blocked = currencies.size > 1 || hasItemIssues;
	const signInRequired =
		!session.data?.user &&
		items.some(
			(item) => "deliveryType" in item && item.deliveryType === "automation",
		);
	const checkoutPath = buyNow
		? `/checkout?mode=buy-now&sellableItemId=${encodeURIComponent(buyNow.sellableItemId)}&quantity=${buyNow.quantity}`
		: "/checkout";
	const products = useQueries({
		queries: items.map((item) => ({
			queryKey: [
				"storefront",
				"product",
				locale,
				item.productId ?? item.sellableItemId,
			],
			queryFn: () =>
				getStorefrontProductFn({
					data: { locale, productId: item.productId ?? "" },
				}),
			enabled: Boolean(item.productId),
			staleTime: 30_000,
		})),
	});
	const currencyItem = items.find((item) => "currency" in item);
	const baseTotal = items.reduce(
		(sum, item) =>
			"priceMinor" in item
				? sum + BigInt(item.priceMinor ?? "0") * BigInt(item.quantity)
				: sum,
		0n,
	);
	const channels = useQuery({
		queryKey: [
			"storefront",
			"payment-channels",
			items.map((item) => item.sellableItemId),
		],
		queryFn: () =>
			quoteCheckoutPaymentChannelsFn({
				data: {
					sellableItemIds: items.map((item) => item.sellableItemId),
				},
			}),
		enabled: Boolean(currencyItem && baseTotal > 0n && !signInRequired),
	});
	const selectedChannel = channels.data?.find(
		(channel) => channel.id === paymentChannelId,
	);
	const selectedChannelHasFixedPrices = Boolean(
		selectedChannel &&
			items.every((item) => selectedChannel.itemPrices[item.sellableItemId]),
	);
	const selectedPrice = (sellableItemId: string, fallback: string) =>
		selectedChannel?.itemPrices[sellableItemId] ?? fallback;
	const total = items.reduce(
		(sum, item) =>
			"priceMinor" in item
				? sum +
					BigInt(selectedPrice(item.sellableItemId, item.priceMinor ?? "0")) *
						BigInt(item.quantity)
				: sum,
		0n,
	);
	const promotion = useQuery({
		queryKey: [
			"promotion-quote",
			couponCode,
			email,
			session.data?.user.id,
			checkoutItemsKey,
			paymentChannelId,
		],
		queryFn: () =>
			quotePromotionFn({
				data: {
					code: couponCode,
					email: email.includes("@") ? email : null,
					channelId:
						paymentChannelId && paymentChannelId !== "wallet"
							? paymentChannelId
							: null,
					items: items.map((item) => ({
						id: item.sellableItemId,
						quantity: item.quantity,
					})),
				},
			}),
		enabled: Boolean(couponCode.trim() && items.length),
		retry: false,
	});
	const couponBlocked = Boolean(
		couponCode.trim() && (promotion.isPending || promotion.isError),
	);
	const discount = BigInt(promotion.data?.discountMinor ?? "0");
	const orderDue = total > discount ? total - discount : 0n;
	const channelAmountDue = (
		channel: NonNullable<typeof channels.data>[number],
	) => {
		const channelSubtotal = items.reduce(
			(sum, item) =>
				"priceMinor" in item
					? sum +
						BigInt(
							channel.itemPrices[item.sellableItemId] ?? item.priceMinor ?? "0",
						) *
							BigInt(item.quantity)
					: sum,
			0n,
		);
		const fixedPrices = items.every(
			(item) => channel.itemPrices[item.sellableItemId],
		);
		const afterDiscount =
			channelSubtotal > discount ? channelSubtotal - discount : 0n;
		const used =
			!hasAgentAccess &&
			session.data?.user &&
			mixedBalanceSupported &&
			useBalance
				? balanceAvailable < afterDiscount
					? balanceAvailable
					: afterDiscount
				: 0n;
		const remainder = afterDiscount - used;
		return fixedPrices || remainder === 0n
			? remainder
			: remainder +
					BigInt(
						paymentSurchargeAmount(
							remainder.toString(),
							channel.feeBps,
							channel.fixedFeeMinor,
						),
					);
	};
	const wallet = useQuery({
		queryKey: ["wallet", session.data?.user.id],
		queryFn: () => getWalletFn(),
		enabled: Boolean(session.data?.user && currencyItem && total > 0n),
	});
	const balanceCurrencyMatches = Boolean(
		wallet.data &&
			currencyItem &&
			wallet.data.currency === currencyItem.currency,
	);
	const mixedBalanceSupported =
		wallet.data?.currency === "CNY" && wallet.data?.currencyDecimals === 2;
	const rewards = BigInt(wallet.data?.rewardBalanceMinor ?? "0");
	const balanceAvailable = balanceCurrencyMatches
		? BigInt(wallet.data?.balanceMinor ?? "0") + (rewards > 0n ? rewards : 0n)
		: 0n;
	const balanceUsed =
		session.data?.user && mixedBalanceSupported && useOrderBalance
			? balanceAvailable < orderDue
				? balanceAvailable
				: orderDue
			: 0n;
	const externalDue = orderDue - balanceUsed;
	const surcharge =
		selectedChannel && !selectedChannelHasFixedPrices && externalDue > 0n
			? BigInt(
					paymentSurchargeAmount(
						externalDue.toString(),
						selectedChannel.feeBps,
						selectedChannel.fixedFeeMinor,
					),
				)
			: 0n;
	const payableTotal = externalDue + surcharge;
	const accessWalletPending = Boolean(
		hasAgentAccess &&
			session.data?.user &&
			paymentChannelId === "wallet" &&
			(wallet.isFetching || wallet.isError || !wallet.data),
	);
	const checkoutIdempotencyScope = `${checkoutItemsKey}:${paymentChannelId || "unselected"}:${couponCode.trim().toUpperCase()}:${useOrderBalance}:${email}:${JSON.stringify(inputValues)}`;
	const idempotencyKey =
		idempotencyKeys.current.get(checkoutIdempotencyScope) ??
		(() => {
			const key = crypto.randomUUID();
			idempotencyKeys.current.set(checkoutIdempotencyScope, key);
			return key;
		})();
	const walletAvailable =
		balanceCurrencyMatches &&
		(hasAgentAccess || useBalance
			? balanceAvailable
			: BigInt(wallet.data?.balanceMinor ?? "0")) >= orderDue;
	const cartPending =
		(session.isPending && !cart) ||
		(!buyNow && Boolean(session.data?.user) && cloud.isPending) ||
		(Boolean(buyNow || !session.data?.user) &&
			requestedItems.length > 0 &&
			preview.isPending);
	const cartError = buyNow
		? preview.isError
		: session.data?.user
			? cloud.isError
			: preview.isError;
	const paymentUnavailable =
		!(paymentChannelId === "wallet" && walletAvailable) &&
		!signInRequired &&
		baseTotal > 0n &&
		!channels.isPending &&
		(channels.isError || (!channels.data?.length && !walletAvailable));
	useEffect(() => {
		if (items.length) trackCommerceEvent({ eventType: "checkout_started" });
	}, [items.length]);
	useEffect(() => {
		const accountEmail = session.data?.user.email;
		if (accountEmail && !isInternalIdentityEmail(accountEmail))
			setEmail(accountEmail);
	}, [session.data?.user.email]);
	useEffect(() => {
		const first = channels.data?.[0];
		if (hasAgentAccess && !paymentChannelId) {
			if (wallet.isPending) return;
			if (walletAvailable) {
				setPaymentChannelId("wallet");
				return;
			}
		}
		if (
			first &&
			paymentChannelId !== "wallet" &&
			!channels.data?.some((channel) => channel.id === paymentChannelId)
		)
			setPaymentChannelId(first.id);
	}, [
		channels.data,
		paymentChannelId,
		hasAgentAccess,
		wallet.isPending,
		walletAvailable,
	]);

	const checkout = useMutation({
		mutationFn: checkoutStoreOrderFn,
		onSuccess: ({ accountOrder, order, payment }) => {
			if (!buyNow && !session.data?.user) writeLocalCart([]);
			const selectedProvider = channels.data?.find(
				(channel) => channel.id === paymentChannelId,
			)?.provider;
			const hostedCheckoutUrl =
				selectedProvider === "gmpay"
					? safeStorePaymentUrl(payment?.checkoutUrl ?? null)
					: null;
			if (hostedCheckoutUrl) {
				window.location.assign(hostedCheckoutUrl);
				return;
			}
			if (accountOrder) {
				void navigate({
					to: "/account/orders/$orderNumber",
					params: { orderNumber: order.orderNumber },
					search: {},
				});
				return;
			}
			writeGuestOrderEmail(order.orderNumber, email);
			void navigate({
				to: "/orders/$orderNumber",
				params: { orderNumber: order.orderNumber },
			});
		},
		onError: (error) =>
			toast.error(
				hasAgentAccess
					? agentAccessErrorMessage(error)
					: m.store_checkout_failed(),
			),
	});

	function submit(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
		event.preventDefault();
		if (
			blocked ||
			agentBlocked ||
			accessWalletPending ||
			couponBlocked ||
			signInRequired ||
			(!hasAgentAccess && !termsAccepted) ||
			(hasAgentAccess && !agentAccessTermsAccepted) ||
			!items.length ||
			paymentUnavailable ||
			(total > 0n &&
				(!paymentChannelId ||
					(hasAgentAccess &&
						paymentChannelId === "wallet" &&
						!walletAvailable)))
		)
			return;
		checkout.mutate({
			data: {
				email,
				couponCode,
				idempotencyKey,
				customerNote: "",
				commerceSessionId: commerceSessionId(),
				locale: getLocale(),
				walletPayment:
					paymentChannelId === "wallet" &&
					!(mixedBalanceSupported && useOrderBalance),
				useBalance: Boolean(
					session.data?.user &&
						mixedBalanceSupported &&
						useOrderBalance &&
						balanceAvailable > 0n,
				),
				paymentChannelId:
					paymentChannelId && paymentChannelId !== "wallet"
						? paymentChannelId
						: null,
				paymentCurrency,
				termsAccepted: true,
				...(hasAgentAccess ? { agentAccessTermsAccepted } : {}),
				items: items.map((item) => ({
					sellableItemId: item.sellableItemId,
					quantity: item.quantity,
					inputValues: inputValues[item.sellableItemId] ?? {},
					renewedFromEntitlementId:
						sessionStorage.getItem(`gmshop-renewal:${item.sellableItemId}`) ??
						null,
				})),
			},
		});
	}

	if (cartPending)
		return (
			<CheckoutLoadingSkeleton
				itemCount={requestedItems.length > 0 ? requestedItems.length : 1}
			/>
		);
	if (cartError)
		return (
			<CheckoutState
				action={
					<Button
						onClick={() =>
							void (buyNow || !session.data?.user
								? preview.refetch()
								: cloud.refetch())
						}
					>
						{m.common_retry()}
					</Button>
				}
				icon={<AlertTriangle className="text-destructive" />}
				title={m.store_checkout_failed()}
			/>
		);
	if (!items.length)
		return (
			<CheckoutState
				action={
					<Button asChild>
						<Link to="/">{m.store_continue_shopping()}</Link>
					</Button>
				}
				description={m.store_cart_empty_description()}
				icon={<ShoppingCart />}
				title={m.store_cart_empty()}
			/>
		);

	return (
		<div className="container px-4 py-8 sm:py-12">
			{buyNow && items[0]?.productId ? (
				<Link
					className="mb-6 inline-flex items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground"
					params={{ productId: items[0].productId }}
					to="/products/$productId"
				>
					<ArrowLeft className="size-4" />
					{m.store_back_to_product()}
				</Link>
			) : (
				<Link
					className="mb-6 inline-flex items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground"
					to="/cart"
				>
					<ArrowLeft className="size-4" />
					{m.store_back_to_cart()}
				</Link>
			)}
			<div className="mb-8 max-w-2xl">
				<h1 className="font-semibold text-3xl tracking-[-0.035em] sm:text-4xl">
					{m.store_checkout_title()}
				</h1>
				<p className="mt-2 text-muted-foreground">
					{m.store_checkout_description()}
				</p>
			</div>
			{items.some((item) => item.productId === claudeRechargeProductId) ? (
				<div className="my-10 grid gap-10">
					<ClaudePurchaseGuide />
				</div>
			) : null}
			<form
				className="grid overflow-hidden rounded-3xl border bg-card shadow-sm lg:grid-cols-2"
				onSubmit={submit}
			>
				<div className="min-w-0 p-5 sm:p-8 lg:p-10">
					<section>
						<h2 className="mb-6 font-semibold text-xl">
							{m.store_checkout_items()}
						</h2>
						<div className="divide-y">
							{items.map((item, index) => {
								const product = products[index]?.data;
								return (
									<div
										className="grid gap-5 py-5 first:pt-0 last:pb-0"
										key={item.sellableItemId}
									>
										<div className="flex items-center gap-4">
											{"coverUrl" in item && item.coverUrl ? (
												<img
													alt={item.productName}
													className="aspect-video w-18 shrink-0 rounded-md object-cover"
													src={item.coverUrl}
												/>
											) : (
												<div className="grid aspect-video w-18 shrink-0 place-items-center rounded-md bg-muted">
													<Boxes className="size-6 text-muted-foreground" />
												</div>
											)}
											<div className="min-w-0 flex-1">
												<strong>{item.productName}</strong>
												{item.sellableItemName !== item.productName ? (
													<p className="text-muted-foreground text-sm">
														{item.sellableItemName}
													</p>
												) : null}
												{item.quantity > 1 ? (
													<p className="text-muted-foreground text-sm">
														{m.store_quantity()} × {item.quantity}
													</p>
												) : null}
											</div>
											{"priceMinor" in item ? (
												<strong>
													<StoreMoney
														amountMinor={(
															BigInt(
																selectedPrice(
																	item.sellableItemId,
																	item.priceMinor ?? "0",
																),
															) * BigInt(item.quantity)
														).toString()}
														currency={item.currency ?? "USD"}
														decimals={item.currencyDecimals ?? 2}
													/>
												</strong>
											) : null}
										</div>
										{item.issues.length ? (
											<div className="grid gap-2">
												{item.issues.map((issue) => (
													<p
														className="flex items-start gap-2 text-destructive text-sm"
														key={issue}
													>
														<AlertTriangle className="mt-0.5 size-4 shrink-0" />
														{checkoutIssueMessage(issue)}
													</p>
												))}
											</div>
										) : null}
										{product?.inputs
											.filter(
												(input) =>
													input.deliveryComponentId ===
														item.deliveryComponentId && input.scope === "order",
											)
											.map((input) => (
												<CheckoutInputField
													input={input}
													key={input.id}
													onChange={(value) =>
														setInputValues((current) => ({
															...current,
															[item.sellableItemId]: {
																...current[item.sellableItemId],
																[input.key]: value,
															},
														}))
													}
													value={inputValues[item.sellableItemId]?.[input.key]}
												/>
											))}
									</div>
								);
							})}
						</div>
					</section>
					{!hasAgentAccess ? (
						<section className="mt-8 border-t pt-8">
							<div className="mb-4">
								<h2 className="font-semibold text-base">
									{m.store_checkout_contact_title()}
								</h2>
								<p className="mt-1 text-muted-foreground text-sm">
									{m.store_checkout_contact_description()}
								</p>
							</div>
							<div className="grid gap-2">
								<Label htmlFor="checkout-email">
									{m.store_contact_email()}
								</Label>
								<Input
									id="checkout-email"
									onChange={(event) => setEmail(event.target.value)}
									placeholder={m.store_email_placeholder()}
									readOnly={accountHasPublicEmail}
									required
									type="email"
									value={email}
								/>
							</div>
							<div className="mt-5 grid gap-2">
								<Label htmlFor="checkout-coupon">{m.store_coupon()}</Label>
								<Input
									id="checkout-coupon"
									aria-invalid={promotion.isError}
									onChange={(event) => setCouponCode(event.target.value)}
									placeholder={m.store_checkout_coupon_placeholder()}
									value={couponCode}
								/>
							</div>
						</section>
					) : null}
				</div>
				<aside className="min-w-0 border-t bg-muted/35 p-5 sm:p-8 lg:border-t-0 lg:border-l lg:p-10">
					<div className="flex h-full flex-col gap-7 lg:sticky lg:top-26">
						<div>
							<p className="font-medium text-muted-foreground text-sm">
								{m.store_order_total()}
							</p>
							{currencyItem && "currency" in currencyItem ? (
								<strong className="mt-2 block text-4xl text-primary tracking-tight">
									<StoreMoney
										amountMinor={(payableTotal + balanceUsed).toString()}
										currency={currencyItem.currency ?? "USD"}
										decimals={currencyItem.currencyDecimals ?? 2}
									/>
								</strong>
							) : null}
							{surcharge > 0n && currencyItem && "currency" in currencyItem ? (
								<div className="mt-4 grid gap-2 text-sm">
									<div className="flex items-center justify-between text-muted-foreground">
										<span>{m.store_payment_channel_fee()}</span>
										<StoreMoney
											amountMinor={surcharge.toString()}
											currency={currencyItem.currency ?? "USD"}
											decimals={currencyItem.currencyDecimals ?? 2}
										/>
									</div>
								</div>
							) : null}
						</div>
						{couponCode.trim() ? (
							<output className="text-sm">
								{promotion.isError
									? m.promotion_coupon_error()
									: promotion.isPending
										? m.common_loading()
										: promotion.data?.purpose === "recall"
											? m.promotion_recall_exclusive()
											: promotion.data?.purpose === "referral"
												? m.promotion_invitation_applied()
												: null}
							</output>
						) : null}
						{currencyItem ? (
							<div className="grid gap-2 text-sm" aria-live="polite">
								{discount > 0n ? (
									<p>
										{m.promotion_discount()}:{" "}
										<StoreMoney
											amountMinor={discount.toString()}
											currency={currencyItem.currency ?? "CNY"}
											decimals={currencyItem.currencyDecimals ?? 2}
										/>
									</p>
								) : null}
								{!hasAgentAccess &&
								session.data?.user &&
								balanceCurrencyMatches &&
								mixedBalanceSupported &&
								balanceAvailable > 0n ? (
									<label
										htmlFor="checkout-use-balance"
										className="flex items-center justify-between gap-3 rounded-lg bg-background/60 p-3"
									>
										<span>
											{m.promotion_use_balance()}{" "}
											<StoreMoney
												amountMinor={balanceUsed.toString()}
												currency="CNY"
												decimals={2}
											/>
										</span>
										<Switch
											id="checkout-use-balance"
											checked={useBalance}
											onCheckedChange={setUseBalance}
											aria-label={m.promotion_use_balance()}
										/>
									</label>
								) : null}
								{!hasAgentAccess && balanceUsed > 0n ? (
									<p>
										{m.promotion_external_due()}:{" "}
										<StoreMoney
											amountMinor={payableTotal.toString()}
											currency={currencyItem.currency ?? "CNY"}
											decimals={currencyItem.currencyDecimals ?? 2}
										/>
									</p>
								) : null}
							</div>
						) : null}
						{total > 0n && !signInRequired ? (
							<fieldset
								className="grid gap-3"
								disabled={
									!hasAgentAccess && (channels.isPending || paymentUnavailable)
								}
							>
								<legend className="mb-4 font-medium text-muted-foreground text-sm">
									{m.store_payment_method()}
								</legend>
								{channels.isPending ? (
									<section
										aria-busy="true"
										aria-label={m.common_loading()}
										className={
											hasAgentAccess
												? "grid grid-cols-2 gap-3"
												: "grid grid-cols-[repeat(auto-fill,minmax(7.5rem,10rem))] gap-3"
										}
									>
										<Skeleton className="h-16 w-full rounded-lg" />
										<Skeleton className="h-16 w-full rounded-lg" />
									</section>
								) : null}
								<div
									className={
										hasAgentAccess
											? "grid grid-cols-2 gap-3"
											: "grid grid-cols-[repeat(auto-fill,minmax(7.5rem,10rem))] gap-3"
									}
								>
									{hasAgentAccess || (wallet.data && balanceAvailable > 0n) ? (
										<label className="grid min-h-16 cursor-pointer place-items-center content-center gap-1.5 rounded-lg bg-background/70 px-3 py-2.5 text-center text-sm ring-offset-background transition hover:bg-background has-checked:bg-primary/10 has-checked:ring-2 has-checked:ring-primary has-checked:ring-offset-2 has-focus-visible:ring-2 has-focus-visible:ring-ring">
											<input
												checked={paymentChannelId === "wallet"}
												className="sr-only"
												disabled={
													!walletAvailable ||
													(hasAgentAccess &&
														(wallet.isFetching || wallet.isError))
												}
												name="payment-channel"
												onChange={() => setPaymentChannelId("wallet")}
												type="radio"
												value="wallet"
											/>
											<span className="font-medium">{m.wallet_payment()}</span>
											{hasAgentAccess && !walletAvailable ? (
												<span className="text-muted-foreground text-xs">
													{wallet.isPending
														? m.common_loading()
														: wallet.isError
															? m.common_operation_failed()
															: m.wallet_payment_insufficient()}
												</span>
											) : null}
											<span className="text-muted-foreground text-xs">
												{m.wallet_balance()}:{" "}
												{wallet.data ? (
													<StoreMoney
														amountMinor={balanceAvailable.toString()}
														currency={wallet.data.currency}
														decimals={wallet.data.currencyDecimals}
													/>
												) : (
													"—"
												)}
											</span>
										</label>
									) : null}
									{channels.data?.map((channel) => (
										<label
											className="grid min-h-16 cursor-pointer place-items-center content-center gap-1.5 rounded-lg bg-background/70 px-3 py-2.5 text-center text-sm ring-offset-background transition hover:bg-background has-checked:bg-primary/10 has-checked:ring-2 has-checked:ring-primary has-checked:ring-offset-2 has-focus-visible:ring-2 has-focus-visible:ring-ring"
											key={channel.id}
										>
											<input
												checked={paymentChannelId === channel.id}
												className="sr-only"
												name="payment-channel"
												onChange={() => setPaymentChannelId(channel.id)}
												required
												type="radio"
												value={channel.id}
											/>
											<PaymentProviderLogo
												className="size-6 rounded-md"
												logoUrl={channel.logoUrl}
												providerId={channel.provider}
											/>
											<span className="font-medium leading-snug">
												{paymentChannelLabel(channel.name)}
											</span>
											{currencyItem && "currency" in currencyItem ? (
												<span className="font-medium text-primary text-xs">
													<StoreMoney
														amountMinor={channelAmountDue(channel).toString()}
														currency={currencyItem.currency ?? "USD"}
														decimals={currencyItem.currencyDecimals ?? 2}
													/>
												</span>
											) : null}
											{channel.feeBps > 0 &&
											!items.every(
												(item) => channel.itemPrices[item.sellableItemId],
											) ? (
												<span className="text-muted-foreground text-xs">
													{m.store_payment_fee_rate({
														rate: (channel.feeBps / 100).toFixed(2),
													})}
												</span>
											) : null}
										</label>
									))}
								</div>
								{paymentUnavailable ? (
									<p className="text-destructive text-sm">
										{m.store_checkout_payment_unavailable()}
									</p>
								) : null}
							</fieldset>
						) : null}
						{hasItemIssues ? (
							<div className="grid gap-3">
								<p className="text-destructive text-sm">
									{m.store_checkout_item_changed()}
								</p>
								{buyNow && items[0]?.productId ? (
									<Button asChild size="sm" variant="outline">
										<Link
											params={{ productId: items[0].productId }}
											to="/products/$productId"
										>
											{m.store_checkout_review_product()}
										</Link>
									</Button>
								) : (
									<Button asChild size="sm" variant="outline">
										<Link to="/cart">{m.store_checkout_review_cart()}</Link>
									</Button>
								)}
							</div>
						) : null}
						{currencies.size > 1 ? (
							<p className="text-destructive text-sm">
								{m.store_cart_currency_conflict()}
							</p>
						) : null}
						{hasAgentAccess &&
						(!session.data?.user || !session.data.user.emailVerified) ? (
							<AgentAccessCheckout
								itemId={accessItem?.sellableItemId ?? ""}
								compact
							/>
						) : signInRequired ? (
							<div className="mt-auto grid gap-4">
								<div>
									<p className="font-medium">
										{m.store_account_required_title()}
									</p>
									<p className="mt-1 text-muted-foreground text-sm">
										{m.store_account_required_description()}
									</p>
								</div>
								<Button asChild className="h-12">
									<Link search={{ redirect: checkoutPath }} to="/sign-in">
										<LogIn />
										{m.store_sign_in_to_purchase()}
									</Link>
								</Button>
							</div>
						) : (
							<div className="mt-auto grid gap-4">
								{hasAgentAccess ? (
									<AgentAccessCheckout
										compact
										itemId={accessItem?.sellableItemId ?? ""}
									/>
								) : null}
								{hasAgentAccess ? (
									<label
										htmlFor="checkout-purchase-consent"
										className="flex items-start gap-3 text-sm leading-6"
									>
										<CheckboxControl
											id="checkout-purchase-consent"
											className="mt-1"
											checked={agentAccessTermsAccepted}
											onCheckedChange={(checked) =>
												setAcceptedAgentTermsScope(
													checked === true ? agentTermsScope : null,
												)
											}
											required
										/>
										<span>
											{m.agent_access_accept_policy({
												policy: agentAccessRefundPolicy[locale],
											})}
										</span>
									</label>
								) : (
									<label
										htmlFor="checkout-purchase-consent"
										className="flex items-start gap-3 text-sm leading-6"
									>
										<CheckboxControl
											id="checkout-purchase-consent"
											className="mt-1"
											checked={termsAccepted}
											onCheckedChange={(checked) =>
												setTermsAccepted(checked === true)
											}
											required
										/>
										<span>{m.store_accept_terms()}</span>
									</label>
								)}

								<Button
									className="h-12"
									disabled={
										blocked ||
										agentBlocked ||
										accessWalletPending ||
										couponBlocked ||
										checkout.isPending ||
										(!hasAgentAccess && !termsAccepted) ||
										(hasAgentAccess && !agentAccessTermsAccepted) ||
										paymentUnavailable ||
										(total > 0n &&
											(paymentChannelId === "wallet"
												? !walletAvailable
												: channels.isPending || !paymentChannelId))
									}
									type="submit"
								>
									{checkout.isPending
										? m.store_checkout_submitting()
										: total > 0n
											? m.store_checkout_submit_paid()
											: m.store_checkout_submit_free()}
								</Button>
							</div>
						)}
					</div>
				</aside>
			</form>
		</div>
	);
}

export function CheckoutLoadingSkeleton({
	itemCount = 1,
}: {
	itemCount?: number;
}) {
	return (
		<section
			aria-busy="true"
			aria-label={m.common_loading()}
			className="container px-4 py-8 sm:py-12"
			data-skeleton-layout="checkout"
		>
			<Skeleton
				className="mb-6 h-5 w-32"
				data-skeleton-region="checkout-back"
			/>
			<div
				className="mb-8 grid max-w-2xl gap-2"
				data-skeleton-region="checkout-heading"
			>
				<Skeleton className="h-9 w-48 sm:h-10" />
				<Skeleton className="h-6 w-full max-w-xl" />
			</div>
			<div
				className="grid overflow-hidden rounded-3xl border bg-card shadow-sm lg:grid-cols-2"
				data-skeleton-region="checkout-form"
			>
				<div className="min-w-0 p-5 sm:p-8 lg:p-10">
					<section>
						<Skeleton className="mb-6 h-7 w-32" />
						<div className="divide-y" data-skeleton-region="checkout-items">
							{Array.from(
								{ length: Math.min(Math.max(itemCount, 1), 6) },
								(_, index) => `checkout-item-${index}`,
							).map((key) => (
								<div
									className="grid gap-5 py-5 first:pt-0 last:pb-0"
									data-skeleton-item="checkout"
									key={key}
								>
									<div className="flex items-center gap-4">
										<Skeleton className="aspect-video w-18 shrink-0 rounded-md" />
										<div className="grid min-w-0 flex-1 gap-2">
											<Skeleton className="h-5 w-3/4" />
											<Skeleton className="h-5 w-1/2" />
										</div>
										<Skeleton className="h-5 w-16" />
									</div>
								</div>
							))}
						</div>
					</section>
					<section className="mt-8 border-t pt-8">
						<div className="mb-4 grid gap-2">
							<Skeleton className="h-6 w-36" />
							<Skeleton className="h-5 w-80 max-w-full" />
						</div>
						<div className="grid gap-5">
							<div className="grid gap-2">
								<Skeleton className="h-5 w-24" />
								<Skeleton className="h-9 w-full" />
							</div>
							<div className="grid gap-2">
								<Skeleton className="h-5 w-20" />
								<Skeleton className="h-9 w-full" />
							</div>
						</div>
					</section>
				</div>
				<aside
					className="min-w-0 border-t bg-muted/35 p-5 sm:p-8 lg:border-t-0 lg:border-l lg:p-10"
					data-skeleton-region="checkout-summary"
				>
					<div className="flex h-full flex-col gap-7 lg:sticky lg:top-26">
						<div className="grid gap-2">
							<Skeleton className="h-5 w-24" />
							<Skeleton className="h-10 w-36" />
						</div>
						<div>
							<Skeleton className="mb-4 h-5 w-28" />
							<div className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,10rem))] gap-3">
								<Skeleton className="h-16 rounded-lg" />
								<Skeleton className="h-16 rounded-lg" />
							</div>
						</div>
						<div className="mt-auto grid gap-4">
							<div className="flex items-start gap-3">
								<Skeleton className="size-4 shrink-0 rounded-sm" />
								<Skeleton className="h-5 w-4/5" />
							</div>
							<Skeleton className="h-12 w-full" />
						</div>
					</div>
				</aside>
			</div>
		</section>
	);
}

type CheckoutInput = NonNullable<
	Awaited<ReturnType<typeof getStorefrontProductFn>>
>["inputs"][number];

function CheckoutInputField({
	input,
	value,
	onChange,
}: {
	input: CheckoutInput;
	value: InputValue | undefined;
	onChange: (value: InputValue) => void;
}) {
	const id = `checkout-${input.id}`;
	const hint = (
		<span className="block text-muted-foreground text-xs">
			{input.required ? m.store_input_required() : null}
			{input.sensitive ? ` · ${m.store_input_sensitive()}` : null}
		</span>
	);
	if (input.inputType === "boolean")
		return (
			<div className="flex items-center justify-between gap-4 rounded-lg border p-3">
				<div>
					<Label htmlFor={id}>{input.name}</Label>
					{hint}
				</div>
				<Switch checked={Boolean(value)} id={id} onCheckedChange={onChange} />
			</div>
		);
	if (input.inputType === "multiselect")
		return (
			<div className="grid gap-2">
				<div>
					<Label>{input.name}</Label>
					{hint}
				</div>
				<ProCheckbox
					id={id}
					onChange={onChange}
					options={input.options}
					optionsClassName="grid gap-3 sm:grid-cols-2"
					value={Array.isArray(value) ? value : []}
				/>
			</div>
		);
	if (input.inputType === "select")
		return (
			<div className="grid gap-2">
				<div>
					<Label htmlFor={id}>{input.name}</Label>
					{hint}
				</div>
				<select
					className="min-h-9 rounded-md border bg-transparent px-3 py-2 text-sm"
					id={id}
					onChange={(event) => onChange(event.currentTarget.value)}
					required={input.required}
					value={String(value ?? "")}
				>
					<option value="">{m.store_checkout_select_option()}</option>
					{input.options.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</select>
			</div>
		);
	return (
		<div className="grid gap-2">
			<div>
				<Label htmlFor={id}>{input.name}</Label>
				{hint}
			</div>
			<Input
				id={id}
				onChange={(event) => onChange(event.target.value)}
				required={input.required}
				placeholder={input.exampleValue ?? undefined}
				type={
					input.sensitive
						? "password"
						: input.inputType === "number"
							? "number"
							: "text"
				}
				value={String(value ?? input.defaultValue ?? "")}
			/>
		</div>
	);
}

function checkoutIssueMessage(issue: string) {
	if (issue === "unavailable") return m.store_cart_issue_unavailable();
	if (issue === "sale_disabled") return m.store_cart_issue_sale_disabled();
	if (issue === "sold_out") return m.store_cart_issue_sold_out();
	if (issue === "quantity_unavailable") return m.store_cart_issue_quantity();
	if (issue === "price_changed") return m.store_cart_issue_price_changed();
	return m.store_cart_item_issue();
}
