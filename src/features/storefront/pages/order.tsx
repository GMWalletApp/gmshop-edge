"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
	ArrowLeft,
	Boxes,
	Clock3,
	CreditCard,
	Download,
	LifeBuoy,
	LoaderCircle,
	QrCode,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import {
	type ReactNode,
	type SyntheticEvent,
	useEffect,
	useState,
} from "react";
import { toast } from "sonner";
import { ModalForm } from "#/components/pro/form";
import { statusLabel } from "#/components/status-badge";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Skeleton } from "#/components/ui/skeleton";
import { AgentAccessDelivery } from "#/features/agent-access/components/access";
import { agentAccessProducts } from "#/features/agent-access/products";
import { shopOrderStatusLabel } from "#/features/shop-orders/labels";
import type { ShopOrderStatus } from "#/features/shop-orders/schema";
import { DeliveryRevealContent } from "#/features/storefront/components/delivery-reveal-content";
import { OrderDeliveryNotice } from "#/features/storefront/components/order-delivery-notice";
import { OrderGrowthBlocks } from "#/features/storefront/components/order-growth";
import {
	readGuestOrderEmail,
	writeGuestOrderEmail,
} from "#/features/storefront/order-access-storage";
import {
	formatPaymentRemaining,
	usePaymentClock,
} from "#/features/storefront/payment-clock";
import { safeStorePaymentUrl } from "#/features/storefront/payment-url";
import { storeOrderLookupSchema } from "#/features/storefront/schema";
import { openAccountAfterSaleCaseFn } from "#/features/storefront/server/account-functions";
import {
	type getStoreOrderFn,
	refreshStoreOrderFn,
	retryStorePaymentFn,
} from "#/features/storefront/server/functions";
import { formatDateTime, formatMinorAmountWithSymbol } from "#/lib/format";
import { m } from "#/paraglide/messages";

type StoreOrderData = Awaited<ReturnType<typeof getStoreOrderFn>>;

export function StorefrontOrderPage({
	orderNumber,
	accountOrder,
	backToEntitlements = false,
	paymentReturning = false,
}: {
	orderNumber: string;
	accountOrder?: Awaited<ReturnType<typeof getStoreOrderFn>>;
	backToEntitlements?: boolean;
	paymentReturning?: boolean;
}) {
	const [afterSaleOpen, setAfterSaleOpen] = useState(false);
	const [guestEmail, setGuestEmail] = useState("");
	const [guestAccessReady, setGuestAccessReady] = useState(
		Boolean(accountOrder),
	);
	useEffect(() => {
		if (accountOrder) {
			setGuestAccessReady(true);
			return;
		}
		setGuestEmail(readGuestOrderEmail(orderNumber));
		setGuestAccessReady(true);
	}, [accountOrder, orderNumber]);
	const now = usePaymentClock();
	const order = useQuery({
		queryKey: ["storefront", "order", orderNumber, guestEmail],
		queryFn: () =>
			refreshStoreOrderFn({
				data: {
					orderNumber,
					email: accountOrder ? undefined : guestEmail,
				},
			}),
		enabled:
			Boolean(accountOrder) ||
			(guestAccessReady &&
				storeOrderLookupSchema.safeParse({
					orderNumber,
					email: guestEmail,
				}).success),
		initialData: accountOrder,
		refetchOnMount: paymentReturning ? "always" : true,
		refetchInterval: (query) =>
			typeof document !== "undefined" && document.visibilityState === "visible"
				? paymentReturning && query.state.data?.status === "pending_payment"
					? 1_000
					: 5_000
				: false,
	});
	const openAfterSale = useMutation({
		mutationFn: openAccountAfterSaleCaseFn,
		onSuccess: async () => {
			setAfterSaleOpen(false);
			await order.refetch();
			toast.success(m.store_after_sale_opened());
		},
		onError: () => toast.error(m.store_after_sale_failed()),
	});
	const retryPayment = useMutation({
		mutationFn: retryStorePaymentFn,
		onSuccess: async () => {
			await order.refetch();
		},
		onError: () => toast.error(m.store_payment_retry_failed()),
	});
	if (!accountOrder && !guestAccessReady) return <OrderLoadingSkeleton />;
	if (!order.data) {
		if (guestEmail && order.isPending) return <OrderLoadingSkeleton />;
		if (!accountOrder)
			return (
				<GuestOrderAccess
					defaultEmail={guestEmail}
					invalid={order.isError}
					onAccess={(email) => {
						const normalizedEmail = writeGuestOrderEmail(orderNumber, email);
						if (!normalizedEmail) return;
						if (normalizedEmail === guestEmail) {
							void order.refetch();
							return;
						}
						setGuestEmail(normalizedEmail);
					}}
					orderNumber={orderNumber}
				/>
			);
		return <OrderLoadingSkeleton />;
	}
	const data = order.data;
	const paymentReturnPending =
		paymentReturning && data.status === "pending_payment";
	const latestPayment = data.payments[0];
	const paymentUrl = safeStorePaymentUrl(latestPayment?.checkoutUrl ?? null);
	const paymentExpiresAt = Math.min(
		data.expiresAt,
		latestPayment?.providerExpiresAt ?? Number.MAX_SAFE_INTEGER,
	);
	const paymentRemaining =
		data.status !== "pending_payment" || now === 0
			? null
			: Math.max(0, Math.ceil((paymentExpiresAt - now) / 1_000));
	const paymentExpired = paymentRemaining === 0;
	const paymentCanResume = Boolean(
		paymentUrl &&
			latestPayment &&
			!paymentExpired &&
			!["failed", "cancelled", "expired"].includes(latestPayment.status),
	);
	const paymentUsesQr = latestPayment?.checkoutPresentation === "qr";
	const claimableDeliveries = data.deliveries.filter(
		(delivery) =>
			delivery.status === "delivered" &&
			delivery.hasContent &&
			delivery.showOnOrderPage,
	);
	const downloadableAssets = data.downloads.filter(
		(asset) =>
			asset.accessLimit === null || asset.accessCount < asset.accessLimit,
	);
	const isAgentAccessOrder = data.items.some((item) =>
		Object.values(agentAccessProducts).some(
			(product) => product.productId === item.productId,
		),
	);
	const afterSaleOptions = isAgentAccessOrder
		? ([
				{ value: "dispute", label: m.agent_access_exception_support() },
			] as const)
		: ([
				{ value: "refund", label: m.store_after_sale_refund() },
				{ value: "redelivery", label: m.store_after_sale_redelivery() },
				...(data.items.some((item) => item.deliveryType === "automation")
					? [
							{
								value: "rebuild" as const,
								label: m.store_after_sale_rebuild(),
							},
						]
					: []),
				{ value: "dispute", label: m.store_after_sale_dispute() },
			] as const);
	async function downloadAsset(asset: (typeof data.downloads)[number]) {
		const response = await fetch(
			`/api/shop/orders/${encodeURIComponent(orderNumber)}/downloads/${encodeURIComponent(asset.id)}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					email: accountOrder ? undefined : guestEmail,
				}),
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
		void order.refetch();
	}
	return (
		<>
			<div className="container px-4 py-8 sm:py-12">
				<div>
					<Link
						className="mb-6 inline-flex items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground"
						to={
							accountOrder
								? backToEntitlements
									? "/account/entitlements"
									: "/account/orders"
								: "/"
						}
					>
						<ArrowLeft className="size-4" />
						{accountOrder
							? backToEntitlements
								? m.store_order_back_to_entitlements()
								: m.store_order_back_to_orders()
							: m.store_continue_shopping()}
					</Link>
					<div className="mb-8 max-w-2xl">
						<h1 className="font-semibold text-3xl tracking-[-0.035em] sm:text-4xl">
							{m.store_order_details()}
						</h1>
						<p className="mt-2 break-all font-mono text-muted-foreground text-sm">
							{m.store_order_number()} · {data.orderNumber}
						</p>
					</div>
					<div className="grid overflow-hidden rounded-3xl border bg-card shadow-sm lg:grid-cols-2">
						<div className="grid min-w-0 content-start gap-8 p-5 sm:p-8 lg:p-10">
							<h2 className="font-semibold text-xl tracking-tight">
								{m.store_order_information()}
							</h2>
							<header className="text-center">
								<h3 className="font-semibold text-3xl tracking-[-0.035em]">
									{paymentReturnPending
										? m.store_payment_return_processing()
										: shopOrderStatusLabel(data.status as ShopOrderStatus)}
								</h3>
								{paymentReturnPending ? (
									<p className="mt-2 text-muted-foreground text-sm">
										{m.store_payment_return_processing_description()}
									</p>
								) : (
									<OrderProgress
										completedAt={data.completedAt}
										compact
										createdAt={data.createdAt}
										events={data.events}
										paidAt={data.paidAt}
										status={data.status as ShopOrderStatus}
									/>
								)}
							</header>
							<div>
								<OrderSection title={m.store_checkout_items()}>
									<div className="divide-y">
										{data.items.map((item) => (
											<div
												className="flex items-center gap-4 py-5 first:pt-0 last:pb-0"
												key={item.id}
											>
												{item.coverUrl ? (
													<img
														alt={item.productName}
														className="aspect-video w-18 shrink-0 rounded-2xl object-cover"
														src={item.coverUrl}
													/>
												) : (
													<div className="grid aspect-video w-18 shrink-0 place-items-center rounded-2xl bg-muted">
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
												<strong>
													{formatMinorAmountWithSymbol(
														item.subtotalMinor,
														data.currency,
														data.currencyDecimals,
													)}
												</strong>
											</div>
										))}
									</div>
								</OrderSection>
								<div className="mt-8 grid gap-3 border-t pt-8 text-sm sm:grid-cols-2">
									{data.contactEmail ? (
										<div>
											<p className="text-muted-foreground">
												{m.store_contact_email()}
											</p>
											<p className="mt-1 font-medium">{data.contactEmail}</p>
										</div>
									) : null}
									<div>
										<p className="text-muted-foreground">
											{m.store_ordered_at()}
										</p>
										<p className="mt-1 font-medium">
											{formatDateTime(data.createdAt)}
										</p>
									</div>
								</div>
							</div>
						</div>
						<aside className="min-w-0 border-t bg-muted/35 p-5 sm:p-8 lg:border-t-0 lg:border-l lg:p-10">
							<div className="flex h-full flex-col gap-7 lg:sticky lg:top-26">
								<div>
									<p className="font-medium text-muted-foreground text-sm">
										{m.store_order_total()}
									</p>
									<strong className="mt-2 block text-4xl text-primary tracking-tight">
										{formatMinorAmountWithSymbol(
											data.totalMinor,
											data.currency,
											data.currencyDecimals,
										)}
									</strong>
								</div>
								{BigInt(data.discountMinor) > 0n ? (
									<div className="grid gap-2 text-sm">
										<div className="flex justify-between gap-4">
											<span className="text-muted-foreground">
												{m.shop_orders_total()}
											</span>
											<span>
												{formatMinorAmountWithSymbol(
													data.subtotalMinor,
													data.currency,
													data.currencyDecimals,
												)}
											</span>
										</div>
										<div className="flex justify-between gap-4">
											<span className="text-muted-foreground">
												{m.coupons_value()}
											</span>
											<span>
												-
												{formatMinorAmountWithSymbol(
													data.discountMinor,
													data.currency,
													data.currencyDecimals,
												)}
											</span>
										</div>
									</div>
								) : null}
								{paymentReturnPending ? (
									<div className="grid flex-1 place-content-center justify-items-center gap-4 py-10 text-center">
										<LoaderCircle className="size-10 animate-spin text-primary" />
										<strong>{m.store_payment_return_processing()}</strong>
										<p className="max-w-sm text-muted-foreground text-sm">
											{m.store_payment_return_processing_description()}
										</p>
									</div>
								) : data.status === "pending_payment" ? (
									<div className="flex flex-1 flex-col gap-5 pt-2">
										<p className="font-medium text-muted-foreground text-sm">
											{m.store_payment_information()}
										</p>
										<div className="grid flex-1 place-content-center justify-items-center gap-5 text-center">
											{paymentRemaining !== null ? (
												<p
													className={
														paymentExpired
															? "flex items-center justify-center gap-2 font-semibold text-xl text-destructive tabular-nums"
															: "flex items-center justify-center gap-2 font-semibold text-xl text-primary tabular-nums"
													}
												>
													<Clock3 className="size-5" />
													{paymentExpired
														? m.store_order_payment_expired()
														: m.store_order_payment_remaining({
																time: formatPaymentRemaining(paymentRemaining),
															})}
												</p>
											) : null}
											{paymentUsesQr ? (
												<div className="grid justify-items-center gap-4 text-center">
													<div className="grid size-56 place-items-center rounded-3xl bg-white p-4 shadow-sm ring-1 ring-black/5">
														{paymentCanResume && paymentUrl ? (
															<QRCodeSVG
																level="M"
																size={192}
																value={paymentUrl}
															/>
														) : (
															<QrCode className="size-20 text-black/20" />
														)}
													</div>
													<strong>{latestPayment?.channelName}</strong>
												</div>
											) : paymentCanResume && paymentUrl ? (
												<div className="grid gap-2">
													<strong className="text-lg">
														{latestPayment?.channelName}
													</strong>
													<p className="text-muted-foreground text-sm">
														{m.store_external_payment_description()}
													</p>
												</div>
											) : null}
										</div>
										{paymentCanResume && paymentUrl && !paymentUsesQr ? (
											<Button asChild className="h-12 w-full">
												<a
													href={paymentUrl}
													rel="noopener noreferrer"
													target="_blank"
												>
													<CreditCard />
													{m.store_resume_payment()}
												</a>
											</Button>
										) : !paymentCanResume && !paymentExpired ? (
											<Button
												className="h-12 w-full"
												disabled={retryPayment.isPending}
												onClick={() =>
													retryPayment.mutate({
														data: {
															orderNumber,
															email: accountOrder ? undefined : guestEmail,
														},
													})
												}
											>
												<CreditCard />
												{paymentUsesQr
													? m.store_refresh_payment_qr()
													: m.store_resume_payment()}
											</Button>
										) : null}
									</div>
								) : null}
								{data.status !== "pending_payment" ? (
									<OrderDeliveryNotice
										deliveries={data.deliveries}
										orderNumber={orderNumber}
									/>
								) : null}
								{["paid", "fulfilling", "completed"].includes(data.status) &&
								data.refundedAt == null ? (
									<Button asChild className="w-full" variant="secondary">
										<a
											href={`/invoice?order_no=${encodeURIComponent(orderNumber)}`}
											rel="noopener noreferrer"
										>
											申请开票
										</a>
									</Button>
								) : null}
								{data.status !== "pending_payment" &&
								(claimableDeliveries.length || downloadableAssets.length) ? (
									<section className="grid gap-4 border-t pt-6">
										<h2 className="font-medium text-muted-foreground text-sm">
											{m.store_purchased_content()}
										</h2>
										<div className="divide-y">
											{claimableDeliveries.map((delivery) => (
												<DirectDeliveryContent
													accountOrder={Boolean(accountOrder)}
													delivery={delivery}
													guestEmail={guestEmail}
													key={delivery.id}
													orderNumber={orderNumber}
												/>
											))}
											{downloadableAssets.map((asset) => (
												<div
													className="flex items-center justify-between gap-3 py-4 first:pt-0 last:pb-0"
													key={asset.id}
												>
													<div className="min-w-0">
														<strong className="block truncate text-sm">
															{asset.fileName}
														</strong>
														<p className="truncate text-muted-foreground text-xs">
															{asset.productName} · v{asset.version}
														</p>
													</div>
													<Button
														onClick={() => void downloadAsset(asset)}
														size="sm"
													>
														<Download />
														{m.store_download()}
													</Button>
												</div>
											))}
										</div>
									</section>
								) : null}
								<OrderGrowthBlocks
									growth={data.growth}
									redirectPath={`/account/orders/${encodeURIComponent(orderNumber)}`}
								/>
								{data.items.some((item) =>
									Object.values(agentAccessProducts).some(
										(p) => p.productId === item.productId,
									),
								) ? (
									<AgentAccessDelivery orderNumber={orderNumber} />
								) : null}
								{data.items.some(
									(item) =>
										item.deliveryType === "automation" &&
										!Object.values(agentAccessProducts).some(
											(p) => p.productId === item.productId,
										),
								) ? (
									<OrderSection title={m.store_account_entitlements()}>
										<p className="text-muted-foreground text-sm leading-6">
											{m.store_order_manage_entitlements_description()}
										</p>
										<Button asChild className="mt-4 w-full">
											<Link to="/account/entitlements">
												<Boxes />
												{m.store_order_manage_entitlements()}
											</Link>
										</Button>
									</OrderSection>
								) : null}
								{accountOrder ? (
									<section className="grid gap-4 border-t pt-6">
										<div className="flex items-center justify-between gap-3">
											<h2 className="flex items-center gap-2 font-medium text-muted-foreground text-sm">
												<LifeBuoy className="size-4" />
												{m.store_after_sales()}
											</h2>
											<Button
												onClick={() => setAfterSaleOpen(true)}
												size="sm"
												variant="ghost"
											>
												{m.store_after_sale_open()}
											</Button>
										</div>
										{data.afterSales.length ? (
											<div className="divide-y">
												{data.afterSales.map((afterSale) => (
													<div className="py-3 text-sm" key={afterSale.id}>
														<div className="flex items-center justify-between gap-3">
															<strong className="font-mono text-xs">
																{afterSale.caseNumber}
															</strong>
															<Badge variant="outline">
																{statusLabel(afterSale.status)}
															</Badge>
														</div>
														<p className="mt-2">{afterSale.reason}</p>
														{afterSale.resolution ? (
															<p className="mt-2 text-muted-foreground">
																{afterSale.resolution}
															</p>
														) : null}
													</div>
												))}
											</div>
										) : null}
									</section>
								) : null}
							</div>
						</aside>
					</div>
				</div>
			</div>
			{accountOrder ? (
				<ModalForm
					description={m.store_after_sale_reason()}
					onFinish={async (values) => {
						await openAfterSale.mutateAsync({
							data: {
								orderNumber,
								orderItemId: null,
								type:
									values.type === "redelivery" ||
									values.type === "rebuild" ||
									values.type === "dispute"
										? values.type
										: "refund",
								reason: String(values.reason ?? ""),
							},
						});
					}}
					onOpenChange={setAfterSaleOpen}
					open={afterSaleOpen}
					schema={[
						{
							name: "type",
							label: m.store_after_sale_type(),
							valueType: "select",
							required: true,
							initialValue: isAgentAccessOrder ? "dispute" : "refund",
							fieldProps: { options: afterSaleOptions },
						},
						{
							name: "reason",
							label: m.store_after_sale_reason(),
							valueType: "textarea",
							required: true,
							fieldProps: { minLength: 5, maxLength: 2000 },
						},
					]}
					title={m.store_after_sale_open()}
				/>
			) : null}
		</>
	);
}

function DirectDeliveryContent({
	accountOrder,
	delivery,
	guestEmail,
	orderNumber,
}: {
	accountOrder: boolean;
	delivery: StoreOrderData["deliveries"][number];
	guestEmail: string;
	orderNumber: string;
}) {
	return (
		<div className="grid gap-3 py-4 first:pt-0 last:pb-0">
			<div>
				<strong className="text-sm">{delivery.productName}</strong>
				<p className="text-muted-foreground text-xs">
					{delivery.sellableItemName}
				</p>
			</div>
			<DeliveryRevealContent
				className="bg-background/60"
				deliveryId={delivery.id}
				email={accountOrder ? undefined : guestEmail}
				orderNumber={orderNumber}
				skeletonClassName="h-20"
			/>
		</div>
	);
}

function GuestOrderAccess({
	orderNumber,
	defaultEmail,
	invalid,
	onAccess,
}: {
	orderNumber: string;
	defaultEmail: string;
	invalid: boolean;
	onAccess: (email: string) => void;
}) {
	const [email, setEmail] = useState(defaultEmail);
	const access = storeOrderLookupSchema.safeParse({ orderNumber, email });
	function submit(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
		event.preventDefault();
		if (access.success) onAccess(access.data.email);
	}
	return (
		<div className="container grid min-h-[60vh] place-items-center px-4 py-12">
			<form
				className="w-full max-w-lg rounded-3xl bg-muted/30 p-6 sm:p-8"
				onSubmit={submit}
			>
				<p className="break-all font-mono text-muted-foreground text-sm">
					{orderNumber}
				</p>
				<h1 className="mt-2 font-semibold text-3xl tracking-tight">
					{m.store_order_guest_access_title()}
				</h1>
				<p className="mt-4 text-muted-foreground text-sm leading-6">
					{invalid
						? m.store_order_guest_access_error()
						: m.store_order_guest_access_description()}
				</p>
				<div className="mt-6 grid gap-2">
					<Label htmlFor="guest-order-email">{m.store_contact_email()}</Label>
					<Input
						autoComplete="email"
						id="guest-order-email"
						maxLength={320}
						placeholder="name@example.com"
						required
						type="email"
						value={email}
						onChange={(event) => setEmail(event.target.value)}
					/>
				</div>
				<div className="mt-6 flex flex-wrap gap-2">
					<Button disabled={!access.success} type="submit">
						{m.store_find_order()}
					</Button>
					<Button asChild variant="ghost">
						<Link to="/orders">
							<ArrowLeft />
							{m.store_order_back_to_lookup()}
						</Link>
					</Button>
				</div>
			</form>
		</div>
	);
}

function OrderSection({
	title,
	action,
	children,
}: {
	title: ReactNode;
	action?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section>
			<div className="flex items-center justify-between gap-4">
				<h2 className="font-semibold text-lg">{title}</h2>
				{action}
			</div>
			<div className="mt-4">{children}</div>
		</section>
	);
}

function OrderProgress({
	status,
	createdAt,
	paidAt,
	completedAt,
	events,
	compact = false,
}: {
	status: ShopOrderStatus;
	createdAt: number;
	paidAt: number | null;
	completedAt: number | null;
	events: Array<{ toStatus: string | null; createdAt: number }>;
	compact?: boolean;
}) {
	const fulfillmentAt =
		events.find((event) => event.toStatus === "fulfilling")?.createdAt ?? null;
	const currentStep =
		status === "pending_payment" ||
		status === "cancelled" ||
		status === "expired"
			? 0
			: status === "paid"
				? 1
				: status === "fulfilling" || status === "failed"
					? 2
					: 3;
	const terminal = ["cancelled", "expired", "failed"].includes(status);
	const steps = [
		{ label: m.store_order_progress_created(), time: createdAt },
		{ label: m.store_order_progress_paid(), time: paidAt },
		{ label: m.store_order_progress_fulfilling(), time: fulfillmentAt },
		{ label: m.store_order_progress_completed(), time: completedAt },
	];
	return (
		<ol aria-label={m.shop_orders_timeline()} className="mt-8 grid grid-cols-4">
			{steps.map((step, index) => {
				const reached = index <= currentStep;
				const active = index === currentStep && status !== "completed";
				const destructive = active && terminal;
				return (
					<li className="relative min-w-0" key={step.label}>
						{index > 0 ? (
							<div
								className={`absolute top-2.5 right-1/2 h-0.5 w-full ${
									index <= currentStep
										? terminal && index === currentStep
											? "bg-destructive"
											: "bg-primary"
										: "bg-border"
								}`}
							/>
						) : null}
						<div className="relative z-10 grid justify-items-center text-center">
							<span
								className={`size-5 rounded-full border-4 ${
									destructive
										? "border-destructive bg-background"
										: reached
											? "border-primary bg-background"
											: "border-border bg-background"
								}`}
							/>
							<p
								className={`mt-3 truncate px-1 font-medium text-xs sm:text-sm ${
									destructive
										? "text-destructive"
										: reached
											? "text-foreground"
											: "text-muted-foreground"
								}`}
							>
								{step.label}
							</p>
							{step.time && !compact ? (
								<p className="mt-1 hidden text-muted-foreground text-xs md:block">
									{formatDateTime(step.time)}
								</p>
							) : null}
						</div>
					</li>
				);
			})}
		</ol>
	);
}

export function OrderLoadingSkeleton() {
	return (
		<section
			aria-busy="true"
			aria-label={m.common_loading()}
			className="container px-4 py-8 sm:py-12"
			data-skeleton-layout="order"
		>
			<Skeleton className="mb-6 h-5 w-36" />
			<div className="mb-8 grid max-w-2xl gap-2">
				<Skeleton className="h-10 w-48" />
				<Skeleton className="h-4 w-72 max-w-full" />
			</div>
			<div
				className="grid overflow-hidden rounded-3xl border bg-card shadow-sm lg:grid-cols-2"
				data-skeleton-region="order-card"
			>
				<div className="grid min-w-0 content-start gap-8 p-5 sm:p-8 lg:p-10">
					<Skeleton className="h-7 w-32" />
					<header className="grid justify-items-center gap-5 text-center">
						<Skeleton className="h-9 w-36" />
						<div className="grid w-full grid-cols-4 gap-3">
							{["progress-1", "progress-2", "progress-3", "progress-4"].map(
								(key) => (
									<div className="grid justify-items-center gap-3" key={key}>
										<Skeleton className="size-5 rounded-full" />
										<Skeleton className="h-4 w-full max-w-20" />
									</div>
								),
							)}
						</div>
					</header>
					<div>
						<Skeleton className="mb-4 h-5 w-28" />
						<div className="flex items-center gap-4">
							<Skeleton className="aspect-video w-18 shrink-0 rounded-2xl" />
							<div className="grid min-w-0 flex-1 gap-2">
								<Skeleton className="h-5 w-3/4" />
								<Skeleton className="h-4 w-1/2" />
							</div>
							<Skeleton className="h-5 w-16" />
						</div>
						<div className="mt-8 grid gap-3 border-t pt-8 sm:grid-cols-2">
							{["contact", "created"].map((key) => (
								<div className="grid gap-2" key={key}>
									<Skeleton className="h-4 w-24" />
									<Skeleton className="h-5 w-36" />
								</div>
							))}
						</div>
					</div>
				</div>
				<aside className="min-w-0 border-t bg-muted/35 p-5 sm:p-8 lg:border-t-0 lg:border-l lg:p-10">
					<div className="flex min-h-[30rem] flex-col gap-7">
						<div className="grid gap-2">
							<Skeleton className="h-4 w-24" />
							<Skeleton className="h-10 w-36" />
						</div>
						<Skeleton className="h-4 w-28" />
						<div className="grid flex-1 place-content-center justify-items-center gap-5">
							<Skeleton className="h-7 w-44" />
							<Skeleton className="size-56 rounded-3xl" />
							<Skeleton className="h-5 w-28" />
						</div>
						<Skeleton className="h-12 w-full" />
					</div>
				</aside>
			</div>
		</section>
	);
}
