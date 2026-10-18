"use client";

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
	ArrowLeft,
	BadgePercent,
	Ban,
	BookOpen,
	BookOpenCheck,
	Boxes,
	ChevronLeft,
	ChevronRight,
	CircleCheck,
	Clock3,
	Globe2,
	LogIn,
	Minus,
	PackageCheck,
	PackageOpen,
	Plus,
	ShieldCheck,
	ShoppingCart,
	Zap,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Skeleton } from "#/components/ui/skeleton";
import { AgentAccessCheckout } from "#/features/agent-access/components/access";
import { agentAccessKind } from "#/features/agent-access/products";
import { authClient } from "#/features/auth/auth-client";
import { StoreMoney } from "#/features/exchange-rates/currency-context";
import { appleIdLoginGuidePath } from "#/features/guides/apple-id-login";
import { addLocalCartItem } from "#/features/storefront/cart-storage";
import { trackCommerceEvent } from "#/features/storefront/commerce-events";
import {
	ChatGptRegionGuide,
	chatGptRechargeProductId,
} from "#/features/storefront/components/chatgpt-region-guide";
import { ClaudeProductDescription } from "#/features/storefront/components/claude-product-description";
import {
	ClaudePurchaseGuide,
	claudeRechargeProductId,
} from "#/features/storefront/components/claude-purchase-guide";
import {
	StorefrontProductCard,
	StorefrontProductCardSkeleton,
} from "#/features/storefront/components/product-card";
import { purchaseMaximum } from "#/features/storefront/product-quantity";
import {
	getStorefrontProductFn,
	listStorefrontCatalogFn,
} from "#/features/storefront/server/catalog";
import { cn } from "#/lib/utils";
import { m } from "#/paraglide/messages";
import { getLocale } from "#/paraglide/runtime";

type Product = Awaited<ReturnType<typeof getStorefrontProductFn>>;
type SellableItem = Product["sellableItems"][number];

// Delivered content is an account or activation link, not a card plus redeem URL;
// the product description carries the real instructions.
const ownUsageGuideProductIds = new Set([
	"2ee356de-fe69-4641-94c3-1dfea19b6967", // Muse AI 成品号
	"64812c48-9026-4ef7-874d-b332d2a39b1a", // Gemini Pro 18个月 激活链接
	"c70d10e8-b781-4782-bc98-1f034bcd069a", // Apple ID 成品号
	"3e60e88d-a0bd-4723-bc9e-ff45f6dafa16", // X 订阅四合一（订单 CDK 换卡密）
]);
const appleIdProductId = "c70d10e8-b781-4782-bc98-1f034bcd069a";

export function StorefrontProductPage({
	productId,
	preferredItemId,
}: {
	productId: string;
	preferredItemId?: string;
}) {
	const locale = getLocale();
	const session = authClient.useSession();
	const product = useQuery({
		queryKey: ["storefront", "product", locale, productId],
		queryFn: () => getStorefrontProductFn({ data: { locale, productId } }),
		staleTime: 30_000,
	});
	const relatedProducts = useQuery({
		queryKey: [
			"storefront",
			"related-products",
			locale,
			productId,
			product.data?.tags[0] ?? "",
		],
		queryFn: () =>
			listStorefrontCatalogFn({
				data: {
					locale,
					search: "",
					tag: product.data?.tags[0] ?? "",
					sort: "featured",
				},
			}),
		enabled: Boolean(product.data),
		staleTime: 30_000,
	});
	const [selectedItemId, setSelectedItemId] = useState<string>();
	const [selectedMediaId, setSelectedMediaId] = useState<string>();
	const [quantity, setQuantity] = useState(1);
	useEffect(() => {
		if (product.data?.id)
			trackCommerceEvent({
				eventType: "product_viewed",
				productId: product.data.id,
			});
	}, [product.data?.id]);
	useEffect(() => {
		const first = preferredItemId
			? product.data?.sellableItems.find((item) => item.id === preferredItemId)
			: (product.data?.sellableItems.find(
					(item) => isAvailable(item) && !item.saleDisabled,
				) ?? product.data?.sellableItems.find(isAvailable));
		if (!selectedItemId && first) {
			setSelectedItemId(first.id);
			setQuantity(first.minimumQuantity);
		}
	}, [product.data, selectedItemId, preferredItemId]);
	useEffect(() => {
		if (product.data && preferredItemId)
			document
				.getElementById("purchase-options")
				?.scrollIntoView?.({ block: "start" });
	}, [product.data, preferredItemId]);
	if (product.isLoading) return <ProductLoadingSkeleton />;
	if (!product.data) return null;
	const data = product.data;
	const gallery = [
		...(data.coverUrl
			? [
					{
						id: "cover",
						altText: data.name,
						url: data.coverUrl,
					},
				]
			: []),
		...data.media.filter((media) => !media.cover),
	];
	const selectedMedia =
		gallery.find((media) => media.id === selectedMediaId) ?? gallery[0];
	const selectedMediaIndex = selectedMedia
		? gallery.findIndex((media) => media.id === selectedMedia.id)
		: -1;
	const selectedItem =
		data.sellableItems.find((item) => item.id === selectedItemId) ??
		(preferredItemId
			? data.sellableItems.find((item) => item.id === preferredItemId)
			: data.sellableItems[0]);
	const requiresSignIn =
		selectedItem?.deliveryType === "automation" &&
		!agentAccessKind(selectedItem.id) &&
		!session.isPending &&
		!session.data?.user;
	const checkoutPath = selectedItem
		? `/checkout?mode=buy-now&sellableItemId=${encodeURIComponent(selectedItem.id)}&quantity=${quantity}`
		: "/checkout";
	const maximumQuantity = selectedItem
		? purchaseMaximum(selectedItem)
		: undefined;
	const canPurchase =
		selectedItem != null &&
		!data.saleDisabled &&
		!selectedItem.saleDisabled &&
		isAvailable(selectedItem) &&
		Number.isInteger(quantity) &&
		quantity >= selectedItem.minimumQuantity &&
		maximumQuantity != null &&
		quantity <= maximumQuantity;
	const entitlement = selectedItem ? entitlementSummary(selectedItem) : null;
	const delivery = selectedItem
		? agentAccessKind(selectedItem.id)
			? m.agent_access_automatic_delivery()
			: deliveryPromise(selectedItem)
		: null;
	const purchaseLimit = selectedItem
		? purchaseLimitSummary(selectedItem)
		: null;
	const showPurchaseOptions =
		Boolean(preferredItemId) ||
		data.sellableItems.length > 1 ||
		data.id === "a48aeca2-90bf-4adf-8cfa-f18204373435";
	const recommendations =
		relatedProducts.data?.products
			.filter((relatedProduct) => relatedProduct.id !== data.id)
			.slice(0, 3) ?? [];
	return (
		<div className="container px-4 py-7 sm:py-10">
			<Link
				className="mb-6 inline-flex items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground"
				to="/"
			>
				<ArrowLeft className="size-4" />
				{m.store_continue_shopping()}
			</Link>
			<div className="grid gap-8 lg:grid-cols-[minmax(0,5fr)_minmax(420px,7fr)] lg:gap-12">
				<div className="grid content-start gap-3">
					<div className="relative aspect-video overflow-hidden rounded-2xl bg-muted">
						{selectedMedia ? (
							<img
								alt={selectedMedia.altText ?? data.name}
								className="size-full object-cover"
								src={selectedMedia.url}
							/>
						) : (
							<div className="grid size-full place-items-center">
								<Boxes className="size-20 text-primary/40" />
							</div>
						)}
						{gallery.length > 1 ? (
							<>
								<Button
									aria-label={m.pro_pagination_previousPage()}
									className="absolute start-3 top-1/2 size-9 -translate-y-1/2 rounded-full bg-background/85 shadow-sm backdrop-blur-sm hover:bg-background"
									onClick={() => {
										const previous =
											(selectedMediaIndex - 1 + gallery.length) %
											gallery.length;
										setSelectedMediaId(gallery[previous]?.id);
									}}
									size="icon"
									type="button"
									variant="ghost"
								>
									<ChevronLeft />
								</Button>
								<Button
									aria-label={m.pro_pagination_nextPage()}
									className="absolute end-3 top-1/2 size-9 -translate-y-1/2 rounded-full bg-background/85 shadow-sm backdrop-blur-sm hover:bg-background"
									onClick={() => {
										const next = (selectedMediaIndex + 1) % gallery.length;
										setSelectedMediaId(gallery[next]?.id);
									}}
									size="icon"
									type="button"
									variant="ghost"
								>
									<ChevronRight />
								</Button>
								<span className="absolute end-3 bottom-3 rounded-full bg-background/85 px-2.5 py-1 font-medium text-xs tabular-nums shadow-sm backdrop-blur-sm">
									{selectedMediaIndex + 1} / {gallery.length}
								</span>
							</>
						) : null}
					</div>
					{gallery.length > 1 ? (
						<div className="grid grid-cols-5 gap-2">
							{gallery.map((media) => (
								<button
									aria-label={media.altText ?? data.name}
									aria-pressed={media.id === selectedMedia?.id}
									className="aspect-video overflow-hidden rounded-xl bg-muted opacity-65 ring-offset-background transition enabled:hover:opacity-100 aria-pressed:opacity-100 aria-pressed:ring-2 aria-pressed:ring-primary aria-pressed:ring-offset-2"
									key={media.id}
									onClick={() => setSelectedMediaId(media.id)}
									type="button"
								>
									<img
										alt={media.altText ?? data.name}
										className="size-full object-cover"
										src={media.url}
									/>
								</button>
							))}
						</div>
					) : null}
					{selectedItem &&
					data.productType === "stock" &&
					!ownUsageGuideProductIds.has(data.id) ? (
						<UsageGuide
							isChatGpt={data.id === chatGptRechargeProductId}
							sellableItem={selectedItem}
						/>
					) : null}
				</div>
				<div className="min-w-0 lg:sticky lg:top-26 lg:h-fit">
					<div className="flex flex-wrap gap-2">
						{data.tags.map((tag) => (
							<Badge asChild key={tag} variant="secondary">
								<a
									href={`/?search=&tag=${encodeURIComponent(tag)}&sort=featured`}
								>
									{tag}
								</a>
							</Badge>
						))}
					</div>
					<h1 className="mt-3 text-balance font-semibold text-4xl tracking-[-0.035em] sm:text-5xl">
						{data.name}
					</h1>
					{data.id === appleIdProductId ? (
						<a
							className="mt-4 flex max-w-2xl items-center gap-2.5 rounded-xl border border-primary/30 bg-primary/10 px-3.5 py-3 font-semibold text-primary text-sm leading-6 transition-colors hover:bg-primary/15 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
							href={appleIdLoginGuidePath}
						>
							<BookOpen aria-hidden="true" className="size-4 shrink-0" />
							<p>查看图文教程：买到的 Apple ID 怎么登录 App Store</p>
						</a>
					) : null}
					{data.description && data.id === claudeRechargeProductId ? (
						<ClaudeProductDescription description={data.description} />
					) : data.description ? (
						<p className="mt-4 max-w-2xl whitespace-pre-wrap text-muted-foreground leading-7">
							{data.description}
						</p>
					) : null}
					{data.id === chatGptRechargeProductId ? (
						<a
							className="mt-4 flex max-w-2xl items-center gap-2.5 rounded-xl border border-primary/30 bg-primary/10 px-3.5 py-3 font-semibold text-primary text-sm leading-6 transition-colors hover:bg-primary/15 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
							href="#chatgpt-region-guide"
						>
							<Globe2 aria-hidden="true" className="size-4 shrink-0" />
							<p>{m.store_chatgpt_region_notice()}</p>
						</a>
					) : null}
					{data.id === claudeRechargeProductId ? (
						<div className="mt-4 flex max-w-2xl items-center gap-2.5 rounded-xl border border-primary/30 bg-primary/10 px-3.5 py-3 font-semibold text-primary text-sm leading-6">
							<ShieldCheck className="size-4 shrink-0" />
							<p>{m.store_claude_channel_notice()}</p>
						</div>
					) : null}
					<div className="mt-4 flex max-w-2xl items-start gap-2.5 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3.5 py-3 text-amber-700 text-sm leading-6 dark:text-amber-300">
						<BadgePercent className="mt-0.5 size-4 shrink-0" />
						<p>{m.store_alipay_fee_notice()}</p>
					</div>
					{data.saleDisabled ? (
						<div className="mt-4 flex max-w-2xl items-start gap-2.5 rounded-xl border border-destructive/25 bg-destructive/10 px-3.5 py-3 text-destructive text-sm leading-6">
							<Ban className="mt-0.5 size-4 shrink-0" />
							<p>{m.store_sale_disabled_description()}</p>
						</div>
					) : null}
					{showPurchaseOptions ? (
						<fieldset id="purchase-options" className="mt-7 scroll-mt-24">
							<legend className="mb-3 font-medium">
								{m.store_select_plan()}
							</legend>
							{preferredItemId && !selectedItem ? (
								<p role="alert" className="mb-3 text-destructive">
									{m.guide_unavailable()}
								</p>
							) : null}
							<div className="grid grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-2">
								{data.sellableItems.map((item) => {
									const selected = item.id === selectedItem?.id;
									return (
										<button
											aria-pressed={selected}
											className="relative grid min-h-24 content-between gap-4 overflow-hidden rounded-xl bg-muted/40 p-4 text-left ring-offset-background transition enabled:hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[selected]:bg-primary/10 data-[selected]:ring-2 data-[selected]:ring-primary data-[selected]:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-45"
											data-selected={selected || undefined}
											disabled={!isAvailable(item)}
											key={item.id}
											onClick={() => {
												setSelectedItemId(item.id);
												setQuantity(item.minimumQuantity);
											}}
											type="button"
										>
											<span className="flex items-start justify-between gap-2">
												<span className="font-medium leading-snug">
													{item.name}
												</span>
												{item.availableStock >= 0 ? (
													<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
														{m.store_stock({ count: item.availableStock })}
													</span>
												) : !isAvailable(item) ? (
													<span className="shrink-0 text-muted-foreground text-xs">
														{m.store_sold_out()}
													</span>
												) : null}
												{item.saleDisabled ? (
													<span className="shrink-0 text-destructive text-xs">
														{m.store_sale_disabled()}
													</span>
												) : null}
											</span>
											<span className="font-semibold text-base text-primary">
												<StoreMoney
													amountMinor={item.priceMinor}
													currency={item.currency}
													decimals={item.currencyDecimals}
												/>
											</span>
											<span
												aria-hidden="true"
												className={cn(
													"pointer-events-none absolute -right-9 bottom-3 w-28 -rotate-[32deg] border-y py-0.5 text-center font-semibold text-[9px] leading-none tracking-[0.08em]",
													item.fulfillmentSource === "supplier"
														? "border-emerald-400/35 bg-emerald-400/12 text-emerald-300"
														: item.fulfillmentSource === "manual"
															? "border-amber-300/35 bg-amber-300/12 text-amber-200"
															: "border-primary/35 bg-primary/12 text-primary",
												)}
											>
												{item.fulfillmentSource === "supplier"
													? m.store_auto_delivery()
													: item.fulfillmentSource === "manual"
														? m.store_manual_procurement()
														: m.store_local_delivery()}
											</span>
										</button>
									);
								})}
							</div>
						</fieldset>
					) : null}
					{data.id === claudeRechargeProductId ? (
						<div className="mt-5 grid gap-2">
							<a
								href="#claude-ip-check"
								className="block rounded-xl border border-primary/30 bg-primary/5 p-4 font-semibold text-sm underline underline-offset-4"
							>
								{m.store_claude_preflight_ip_title()}
							</a>
							<a
								href="#claude-purchase-guide"
								className="block rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 font-semibold text-sm underline underline-offset-4"
							>
								{m.store_claude_preflight_link()}
							</a>
						</div>
					) : null}
					<div className="mt-7">
						{selectedItem ? (
							<SellableItemSummary sellableItem={selectedItem} />
						) : (
							<p className="text-muted-foreground">{m.store_select_plan()}</p>
						)}
					</div>
					{selectedItem ? <SkuPolicyPanel sellableItem={selectedItem} /> : null}
					{selectedItem && agentAccessKind(selectedItem.id) ? (
						<AgentAccessCheckout
							key={selectedItem.id}
							itemId={selectedItem.id}
						/>
					) : null}
					{selectedItem ? (
						<div className="mt-5 grid gap-3">
							{delivery ? (
								<PurchaseHighlight icon={ShieldCheck}>
									{delivery}
								</PurchaseHighlight>
							) : null}
							{requiresSignIn ? (
								<PurchaseHighlight icon={LogIn}>
									{m.store_account_required_description()}
								</PurchaseHighlight>
							) : null}
							{entitlement ? (
								<PurchaseHighlight icon={Clock3}>
									{entitlement}
								</PurchaseHighlight>
							) : null}
							{purchaseLimit ? (
								<PurchaseHighlight icon={PackageCheck}>
									{purchaseLimit}
								</PurchaseHighlight>
							) : null}
							<PurchaseHighlight icon={CircleCheck}>
								{m.store_order_access_promise()}
							</PurchaseHighlight>
						</div>
					) : null}
					<div className="mt-7 grid gap-5">
						{selectedItem &&
							selectedItem.minimumQuantity !== selectedItem.maximumQuantity && (
								<div className="grid w-fit gap-2">
									<Label htmlFor="product-quantity">{m.store_quantity()}</Label>
									<div className="flex h-11 items-center rounded-xl bg-muted/50 p-1">
										<Button
											aria-label={m.store_quantity_decrease()}
											className="size-9 rounded-lg"
											disabled={quantity <= selectedItem.minimumQuantity}
											onClick={() =>
												setQuantity((current) =>
													Math.max(selectedItem.minimumQuantity, current - 1),
												)
											}
											size="icon"
											type="button"
											variant="ghost"
										>
											<Minus />
										</Button>
										<Input
											className="h-9 w-16 border-0 bg-transparent px-1 text-center shadow-none focus-visible:ring-0"
											id="product-quantity"
											max={maximumQuantity}
											min={selectedItem.minimumQuantity}
											onChange={(event) =>
												setQuantity(Number(event.target.value))
											}
											type="number"
											value={quantity}
										/>
										<Button
											aria-label={m.store_quantity_increase()}
											className="size-9 rounded-lg"
											disabled={
												maximumQuantity == null || quantity >= maximumQuantity
											}
											onClick={() =>
												setQuantity((current) =>
													Math.min(maximumQuantity ?? current, current + 1),
												)
											}
											size="icon"
											type="button"
											variant="ghost"
										>
											<Plus />
										</Button>
									</div>
								</div>
							)}
						<div className="grid gap-2 sm:grid-cols-2">
							{requiresSignIn && canPurchase ? (
								<Button asChild className="h-12 rounded-xl">
									<Link search={{ redirect: checkoutPath }} to="/sign-in">
										<LogIn />
										{m.store_sign_in_to_purchase()}
									</Link>
								</Button>
							) : requiresSignIn ? (
								<Button className="h-12 rounded-xl" disabled>
									<LogIn />
									{m.store_sign_in_to_purchase()}
								</Button>
							) : (
								<Button
									className="h-12 rounded-xl"
									disabled={!canPurchase}
									onClick={() => {
										if (!selectedItem) return;
										window.location.assign(checkoutPath);
									}}
								>
									<Zap />
									{data.saleDisabled || selectedItem?.saleDisabled
										? m.store_sale_disabled()
										: m.store_buy_now()}
								</Button>
							)}
							<Button
								className="h-12 rounded-xl"
								disabled={!canPurchase}
								onClick={() => {
									if (!selectedItem || maximumQuantity == null) return;
									const added = addLocalCartItem(
										selectedItem.id,
										quantity,
										maximumQuantity,
									);
									if (!added) {
										toast.error(m.store_cart_limit_reached());
										return;
									}
									trackCommerceEvent({
										eventType: "cart_item_added",
										productId: data.id,
										sellableItemId: selectedItem.id,
									});
									toast.success(m.store_cart_added());
								}}
								variant="outline"
							>
								<ShoppingCart />
								{m.store_add_to_cart()}
							</Button>
						</div>
					</div>
				</div>
			</div>
			{data.id === chatGptRechargeProductId ? <ChatGptRegionGuide /> : null}
			{data.id === claudeRechargeProductId ? <ClaudePurchaseGuide /> : null}
			{relatedProducts.isLoading ? (
				<RelatedProductsLoadingSkeleton />
			) : recommendations.length ? (
				<section className="mt-20 sm:mt-28">
					<div className="mb-6 flex items-end justify-between gap-5">
						<div>
							<h2 className="font-semibold text-2xl tracking-tight">
								{m.store_related_products()}
							</h2>
							<p className="mt-2 text-muted-foreground text-sm">
								{m.store_related_products_description()}
							</p>
						</div>
						<a
							className="shrink-0 text-primary text-sm transition-opacity hover:opacity-70"
							href={
								data.tags[0]
									? `/?search=&tag=${encodeURIComponent(data.tags[0])}&sort=featured`
									: "/?search=&tag=&sort=featured"
							}
						>
							{m.store_view_more_products()}
						</a>
					</div>
					<div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
						{recommendations.map((relatedProduct) => (
							<StorefrontProductCard
								key={relatedProduct.id}
								product={relatedProduct}
							/>
						))}
					</div>
				</section>
			) : null}
		</div>
	);
}

function UsageGuide({
	isChatGpt,
	sellableItem,
}: {
	isChatGpt: boolean;
	sellableItem: SellableItem;
}) {
	const automatic = sellableItem.fulfillmentSource !== "manual";
	const received = automatic
		? [
				m.store_usage_guide_auto_credential({ sku: sellableItem.name }),
				m.store_usage_guide_auto_redeem_url(),
			]
		: [
				m.store_usage_guide_manual_order_code(),
				m.store_usage_guide_manual_status(),
			];
	const steps = automatic
		? [
				m.store_usage_guide_auto_step_order(),
				m.store_usage_guide_auto_step_copy(),
				m.store_usage_guide_auto_step_open(),
				m.store_usage_guide_auto_step_submit(),
			]
		: [
				m.store_usage_guide_manual_step_order(),
				m.store_usage_guide_manual_step_copy(),
				m.store_usage_guide_manual_step_contact(),
				m.store_usage_guide_manual_step_wait(),
			];
	return (
		<section className="mt-3 rounded-2xl border border-border/70 bg-card/55 p-5 shadow-sm">
			<div className="flex items-start gap-3">
				<span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
					<BookOpenCheck className="size-5" />
				</span>
				<div className="min-w-0">
					<p className="font-semibold text-primary text-xs uppercase tracking-[0.16em]">
						{m.store_usage_guide_title()}
					</p>
					<h2 className="mt-1 text-balance font-semibold text-lg">
						{sellableItem.name}
					</h2>
				</div>
			</div>
			<p className="mt-4 text-muted-foreground text-sm leading-6">
				{automatic
					? m.store_usage_guide_auto_intro()
					: m.store_usage_guide_manual_intro()}
			</p>
			<GuideSection icon={PackageOpen} title={m.store_usage_guide_receive()}>
				<ul className="grid gap-1.5">
					{received.map((item) => (
						<li className="flex gap-2" key={item}>
							<span className="mt-2 size-1 shrink-0 rounded-full bg-primary" />
							<span>{item}</span>
						</li>
					))}
				</ul>
			</GuideSection>
			{isChatGpt ? (
				<GuideSection icon={ShieldCheck} title={m.store_usage_guide_account()}>
					<p>{m.store_usage_guide_account_description()}</p>
				</GuideSection>
			) : null}
			<GuideSection icon={CircleCheck} title={m.store_usage_guide_steps()}>
				<ol className="grid gap-2">
					{steps.map((step, index) => (
						<li className="flex gap-2.5" key={step}>
							<span className="grid size-5 shrink-0 place-items-center rounded-full bg-primary/10 font-semibold text-[10px] text-primary">
								{index + 1}
							</span>
							<span>{step}</span>
						</li>
					))}
				</ol>
			</GuideSection>
		</section>
	);
}

function GuideSection({
	children,
	icon: Icon,
	title,
}: {
	children: ReactNode;
	icon: typeof PackageOpen;
	title: string;
}) {
	return (
		<div className="mt-5 border-border/70 border-t pt-4">
			<h3 className="flex items-center gap-2 font-medium text-sm">
				<Icon className="size-4 text-primary" />
				{title}
			</h3>
			<div className="mt-2 text-muted-foreground text-sm leading-6">
				{children}
			</div>
		</div>
	);
}

function SkuPolicyPanel({ sellableItem }: { sellableItem: SellableItem }) {
	const delivery =
		sellableItem.fulfillmentSource === "supplier"
			? m.store_auto_delivery()
			: sellableItem.policy.delivery;
	const deliveryTime =
		sellableItem.fulfillmentSource === "supplier"
			? m.store_supplier_delivery_time()
			: sellableItem.policy.deliveryTime;
	const fields = [
		[m.store_sku_policy_delivery(), delivery],
		[m.store_sku_policy_delivery_time(), deliveryTime],
		[m.store_sku_policy_coverage(), sellableItem.policy.coverage],
		[m.store_sku_policy_warranty(), sellableItem.policy.warranty],
		[m.store_sku_policy_restrictions(), sellableItem.policy.restrictions],
	].filter((field): field is [string, string] => Boolean(field[1]));
	if (!fields.length) return null;
	return (
		<section className="mt-6 grid gap-3 sm:grid-cols-2">
			{fields.map(([label, value], index) => (
				<div
					className={cn(
						"rounded-xl border border-border/70 bg-muted/25 p-4",
						index === fields.length - 1 && fields.length % 2 === 1
							? "sm:col-span-2"
							: "",
					)}
					key={label}
				>
					<p className="font-medium text-foreground text-sm">{label}</p>
					<p className="mt-1.5 whitespace-pre-wrap text-muted-foreground text-sm leading-6">
						{value}
					</p>
				</div>
			))}
		</section>
	);
}

export function ProductLoadingSkeleton() {
	return (
		<section
			aria-busy="true"
			aria-label={m.common_loading()}
			className="container px-4 py-7 sm:py-10"
			data-skeleton-layout="product-detail"
		>
			<Skeleton className="mb-6 h-5 w-32" />
			<div className="grid gap-8 lg:grid-cols-[minmax(0,5fr)_minmax(420px,7fr)] lg:gap-12">
				<div
					className="grid content-start gap-3"
					data-skeleton-region="product-gallery"
				>
					<Skeleton className="aspect-video rounded-2xl" />
					<div
						className="grid grid-cols-5 gap-2"
						data-skeleton-region="product-thumbnails"
					>
						{["media-1", "media-2", "media-3", "media-4", "media-5"].map(
							(key) => (
								<Skeleton className="aspect-video rounded-xl" key={key} />
							),
						)}
					</div>
				</div>
				<div
					className="min-w-0 lg:sticky lg:top-26 lg:h-fit"
					data-skeleton-region="product-purchase"
				>
					<div className="flex min-h-5 gap-2">
						<Skeleton className="h-5 w-20 rounded-full" />
						<Skeleton className="h-5 w-16 rounded-full" />
					</div>
					<Skeleton className="mt-3 h-10 w-3/4 sm:h-12" />
					<div className="mt-4 grid gap-2">
						<Skeleton className="h-5 w-full" />
						<Skeleton className="h-5 w-5/6" />
					</div>
					<div className="mt-7">
						<Skeleton className="mb-3 h-5 w-28" />
						<div
							className="grid grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-2"
							data-skeleton-region="product-plans"
						>
							<Skeleton className="h-24 rounded-xl" />
							<Skeleton className="h-24 rounded-xl" />
						</div>
					</div>
					<Skeleton className="mt-7 h-10 w-36" />
					<div className="mt-5 grid gap-3">
						{["delivery", "entitlement", "limit", "access"].map((key) => (
							<div className="flex items-start gap-2.5" key={key}>
								<Skeleton className="mt-0.5 size-4 shrink-0 rounded-full" />
								<Skeleton className="h-4 w-3/4" />
							</div>
						))}
					</div>
					<div className="mt-7 grid gap-5">
						<div className="grid gap-2 sm:grid-cols-2">
							<Skeleton className="h-12 rounded-xl" />
							<Skeleton className="h-12 rounded-xl" />
						</div>
					</div>
				</div>
			</div>
		</section>
	);
}

function RelatedProductsLoadingSkeleton() {
	return (
		<section
			aria-busy="true"
			aria-label={m.common_loading()}
			className="mt-20 sm:mt-28"
		>
			<div className="mb-6 flex items-end justify-between gap-5">
				<div className="grid gap-2">
					<Skeleton className="h-8 w-44" />
					<Skeleton className="h-4 w-72 max-w-full" />
				</div>
				<Skeleton className="h-5 w-20" />
			</div>
			<div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
				{["related-1", "related-2", "related-3"].map((key) => (
					<StorefrontProductCardSkeleton key={key} />
				))}
			</div>
		</section>
	);
}

function SellableItemSummary({ sellableItem }: { sellableItem: SellableItem }) {
	const isFree = BigInt(sellableItem.priceMinor) === 0n;
	const hasDiscount =
		sellableItem.listPriceMinor != null &&
		BigInt(sellableItem.listPriceMinor) > BigInt(sellableItem.priceMinor);
	if (sellableItem.channelPrices.length > 0)
		return (
			<div>
				<p className="font-medium text-muted-foreground text-sm">
					{m.store_payment_prices_title()}
				</p>
				<div className="mt-2 grid gap-2 sm:grid-cols-2">
					{sellableItem.channelPrices.map((channel) => {
						const alipay =
							channel.provider === "epay" || channel.name.includes("支付宝");
						return (
							<div
								className={cn(
									"rounded-xl border border-primary/20 bg-primary/[0.07] px-4 py-3",
									alipay && "border-amber-500/25 bg-amber-500/10",
								)}
								key={channel.id}
							>
								<div className="flex items-center justify-between gap-3">
									<span
										className={cn(
											"font-semibold text-primary text-sm",
											alipay && "text-amber-700 dark:text-amber-300",
										)}
									>
										{channel.name}
									</span>
									{channel.feeBps > 0 ? (
										<span className="text-muted-foreground text-[11px]">
											{m.store_payment_price_fee_included()}
										</span>
									) : null}
								</div>
								<strong
									className={cn(
										"mt-1 block text-3xl text-primary tracking-tight",
										alipay && "text-amber-700 dark:text-amber-300",
									)}
								>
									<StoreMoney
										amountMinor={channel.priceMinor}
										currency={sellableItem.currency}
										decimals={sellableItem.currencyDecimals}
									/>
								</strong>
							</div>
						);
					})}
				</div>
			</div>
		);
	return (
		<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
			<strong className="text-4xl text-primary tracking-tight">
				{isFree ? (
					m.store_price_free()
				) : (
					<StoreMoney
						amountMinor={sellableItem.priceMinor}
						currency={sellableItem.currency}
						decimals={sellableItem.currencyDecimals}
					/>
				)}
			</strong>
			{hasDiscount && sellableItem.listPriceMinor ? (
				<span className="text-muted-foreground text-sm line-through">
					<StoreMoney
						amountMinor={sellableItem.listPriceMinor}
						currency={sellableItem.currency}
						decimals={sellableItem.currencyDecimals}
					/>
				</span>
			) : null}
			{sellableItem.availableStock === 0 ? (
				<span className="basis-full text-destructive text-sm">
					{m.store_sold_out()}
				</span>
			) : null}
		</div>
	);
}

function PurchaseHighlight({
	children,
	icon: Icon,
}: {
	children: ReactNode;
	icon: typeof ShieldCheck;
}) {
	return (
		<div className="flex items-start gap-2.5 text-muted-foreground text-sm">
			<Icon className="mt-0.5 size-4 shrink-0 text-primary" />
			<span>{children}</span>
		</div>
	);
}

function purchaseLimitSummary(sellableItem: SellableItem) {
	const orderLimit =
		sellableItem.minimumQuantity === sellableItem.maximumQuantity
			? sellableItem.minimumQuantity === 1
				? null
				: m.store_purchase_exact_quantity({
						quantity: sellableItem.minimumQuantity,
					})
			: sellableItem.minimumQuantity === 1
				? m.store_purchase_maximum_quantity({
						maximum: sellableItem.maximumQuantity,
					})
				: m.store_purchase_quantity_range({
						minimum: sellableItem.minimumQuantity,
						maximum: sellableItem.maximumQuantity,
					});
	const customerLimit =
		sellableItem.maximumPerCustomer == null
			? null
			: m.store_purchase_customer_limit({
					maximum: sellableItem.maximumPerCustomer,
				});
	return [orderLimit, customerLimit].filter(Boolean).join(" · ") || null;
}

function isAvailable(sellableItem: SellableItem) {
	return (
		sellableItem.availableStock < 0 ||
		sellableItem.availableStock >= sellableItem.minimumQuantity
	);
}
function deliveryPromise(sellableItem: SellableItem) {
	if (
		sellableItem.deliveryType === "stock" &&
		sellableItem.fulfillmentSource === "manual"
	)
		return sellableItem.policy.deliveryTime;
	switch (sellableItem.deliveryType) {
		case "stock":
			return m.store_delivery_promise_card();
		case "download":
			return m.store_delivery_promise_download();
		case "automation":
			return m.store_delivery_promise_build();
		default:
			return null;
	}
}
function entitlementSummary(sellableItem: SellableItem) {
	return [
		sellableItem.durationMs == null
			? null
			: m.store_entitlement_duration({
					days: Math.ceil(sellableItem.durationMs / 86_400_000),
				}),
		...(sellableItem.deliveryType === "automation"
			? [
					sellableItem.usageLimit == null
						? null
						: m.store_entitlement_automation_runs({
								count: sellableItem.usageLimit,
							}),
				]
			: []),
		...(sellableItem.deliveryType === "download"
			? [
					sellableItem.accessLimit == null
						? null
						: m.store_entitlement_downloads({
								count: sellableItem.accessLimit,
							}),
				]
			: []),
	]
		.filter(Boolean)
		.join(" · ");
}
