"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
	Ban,
	ChevronLeft,
	ChevronRight,
	Copy,
	Info,
	Save,
	Send,
	ShoppingCart,
	Star,
	Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ProButton } from "#/components/pro/base/button";
import { Switch as ProSwitch } from "#/components/pro/base/fields/checkbox";
import { Input, Textarea } from "#/components/pro/base/fields/input";
import { Select as ProSelect } from "#/components/pro/base/fields/select";
import { Upload, UploadTrigger } from "#/components/pro/base/fields/upload";
import { ProEditor } from "#/components/pro/editor/client";
import { FormItem, ProForm } from "#/components/pro/form";
import { ProArrayField } from "#/components/pro/form/array-field";
import { Badge } from "#/components/ui/badge";
import {
	type ConfigurationDraft,
	createBuildConfigurationDraft,
} from "#/features/builds/configuration-draft";
import { BuildConfigurationFields } from "#/features/builds/pages/configurations";
import { saveBuildConfigurationSchema } from "#/features/builds/schema";
import {
	getBuildConfigurationFn,
	listBuildConfigurationsFn,
	saveBuildConfigurationFn,
} from "#/features/builds/server/admin";
import {
	ProductCoverField,
	parseProductCoverUpload,
	readBrowserImageDimensions,
} from "#/features/catalog/components/product-cover-field";
import { catalogOperationErrorMessage } from "#/features/catalog/error-message";
import { ProductInventory } from "#/features/catalog/pages/inventory";
import {
	deleteProductMediaFn,
	importInventoryFn,
	listProductMediaFn,
	listProductTagOptionsFn,
	setProductCoverFn,
	sortProductMediaFn,
	switchStockFulfillmentModeFn,
	uploadProductMediaFn,
} from "#/features/catalog/server/admin";
import {
	createProductDraftFn,
	getProductEditorFn,
	publishProductFn,
	saveProductContentFn,
	saveProductSellableItemsFn,
	setProductSaleDisabledFn,
} from "#/features/catalog/server/editor";
import { getStoreCurrencyConfigurationFn } from "#/features/exchange-rates/server/public";
import { ProductDownloadAssets } from "#/features/fulfillment/pages/download-assets";
import { PageHeader } from "#/layouts/components/page-header";
import { formatDateTime, formatMinorAmount, formatNumber } from "#/lib/format";
import { formatMinorInput, parseMajorInput } from "#/lib/money-input";
import { m } from "#/paraglide/messages";

type Editor = Awaited<ReturnType<typeof getProductEditorFn>>;
type SellableItem = Editor["sellableItems"][number];
type Component = Editor["components"][number];
type Media = Awaited<ReturnType<typeof listProductMediaFn>>[number];
type GalleryUpload = {
	contentType:
		| "image/avif"
		| "image/gif"
		| "image/jpeg"
		| "image/png"
		| "image/webp";
	base64: string;
};
type PendingCardImport = { content: string; note: string };
type PendingDownload = { id: string; file: File };

export function ProductEditorPage({
	productId,
	initialProductType = "stock",
}: {
	productId?: string;
	initialProductType?: Component["type"];
}) {
	const client = useQueryClient();
	const navigate = useNavigate();
	const [draftId] = useState(() => crypto.randomUUID());
	const isNew = !productId;
	const editorProductId = productId ?? draftId;
	const query = useQuery({
		queryKey: ["admin", "catalog", "product-editor", editorProductId],
		queryFn: () => getProductEditorFn({ data: { productId: editorProductId } }),
		enabled: !isNew,
	});
	const currencyConfiguration = useQuery({
		queryKey: ["storefront", "currency-configuration"],
		queryFn: () => getStoreCurrencyConfigurationFn(),
	});
	const [sellableItems, setSellableItems] = useState<SellableItem[]>([]);
	const [components, setComponents] = useState<Component[]>([]);
	const [productType, setProductType] =
		useState<Component["type"]>(initialProductType);
	const [revision, setRevision] = useState(1);
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [tagNames, setTagNames] = useState<string[]>([]);
	const [pendingBuilds, setPendingBuilds] = useState<
		Record<string, ConfigurationDraft>
	>({});
	const [pendingCardImports, setPendingCardImports] = useState<
		Record<string, PendingCardImport>
	>({});
	const [pendingDownloads, setPendingDownloads] = useState<
		Record<string, PendingDownload[]>
	>({});
	const [coverUpload, setCoverUpload] = useState("");
	const [galleryUploads, setGalleryUploads] = useState<GalleryUpload[]>([]);
	const media = useQuery({
		queryKey: ["admin", "catalog", "media", editorProductId],
		queryFn: () => listProductMediaFn({ data: { productId: editorProductId } }),
		enabled: !isNew,
	});
	const tagOptions = useQuery({
		queryKey: ["admin", "catalog", "tag-options"],
		queryFn: () => listProductTagOptionsFn(),
	});
	const persistedBuilds = useQuery({
		queryKey: ["admin", "catalog", "product-editor-builds", editorProductId],
		queryFn: async () => {
			const configurations = await listBuildConfigurationsFn({
				data: { productId: editorProductId },
			});
			return Promise.all(
				configurations.map(async (configuration) => {
					const detail = await getBuildConfigurationFn({
						data: {
							productId: editorProductId,
							deliveryComponentId: configuration.deliveryComponentId,
							id: configuration.id,
						},
					});
					return {
						deliveryComponentId: configuration.deliveryComponentId,
						draft: buildDraftFromDetail(detail),
					};
				}),
			);
		},
		enabled:
			!isNew &&
			Boolean(
				query.data?.components.some(
					(component) => component.type === "automation",
				),
			),
	});
	useEffect(() => {
		if (!isNew || currencyConfiguration.isPending || sellableItems.length)
			return;
		const component = newComponent(productType);
		const item = defaultSellableItem(
			component.id,
			currencyConfiguration.data?.baseCurrency ?? "USD",
			currencyConfiguration.data?.baseCurrencyDecimals ?? 2,
		);
		setSellableItems([item]);
		setComponents([component]);
	}, [
		currencyConfiguration.data,
		currencyConfiguration.isPending,
		isNew,
		productType,
		sellableItems.length,
	]);
	useEffect(() => {
		if (!query.data) return;
		setSellableItems(query.data.sellableItems);
		setComponents(query.data.components);
		setProductType(query.data.product.productType);
		setRevision(query.data.product.revision);
		setName(query.data.product.name);
		setDescription(query.data.product.description ?? "");
		setTagNames(query.data.product.tagNames);
	}, [query.data]);
	useEffect(() => {
		const persistedIds = new Set(
			query.data?.components.map((component) => component.id) ?? [],
		);
		const boundIds = new Set(
			sellableItems.map((sellableItem) => sellableItem.deliveryComponentId),
		);
		const loadedBuilds = new Map(
			(persistedBuilds.data ?? []).map((item) => [
				item.deliveryComponentId,
				item.draft,
			]),
		);
		setPendingBuilds((current) => {
			let changed = false;
			const next = { ...current };
			for (const component of components)
				if (
					component.type === "automation" &&
					boundIds.has(component.id) &&
					!next[component.id]
				) {
					const loaded = loadedBuilds.get(component.id);
					if (loaded) {
						next[component.id] = loaded;
						changed = true;
					} else if (
						!persistedIds.has(component.id) ||
						persistedBuilds.isSuccess
					) {
						next[component.id] = createBuildConfigurationDraft();
						changed = true;
					}
				}
			for (const id of Object.keys(next))
				if (!boundIds.has(id)) {
					delete next[id];
					changed = true;
				}
			return changed ? next : current;
		});
	}, [
		components,
		persistedBuilds.data,
		persistedBuilds.isSuccess,
		query.data?.components,
		sellableItems,
	]);
	useEffect(() => {
		const boundIds = new Set(
			sellableItems.map((sellableItem) => sellableItem.deliveryComponentId),
		);
		const componentTypes = new Map(
			components.map((component) => [component.id, component.type]),
		);
		setPendingCardImports((current) =>
			prunePendingRecord(
				current,
				(id) =>
					boundIds.has(id) &&
					componentTypes.get(id) === "stock" &&
					sellableItems.some(
						(item) =>
							item.deliveryComponentId === id &&
							item.fulfillmentSource === "local",
					),
			),
		);
		setPendingDownloads((current) =>
			prunePendingRecord(
				current,
				(id) => boundIds.has(id) && componentTypes.get(id) === "download",
			),
		);
	}, [components, sellableItems]);
	const save = useMutation({
		mutationFn: async () => {
			let savedProductId = productId;
			let savedRevision = revision;
			const boundComponentIds = new Set(
				sellableItems.map((sellableItem) => sellableItem.deliveryComponentId),
			);
			const pendingBuildEntries = Object.entries(pendingBuilds).filter(([id]) =>
				boundComponentIds.has(id),
			);
			for (const [deliveryComponentId, draft] of pendingBuildEntries)
				saveBuildConfigurationSchema.parse({
					...draft,
					productId: editorProductId,
					deliveryComponentId,
					enabled:
						sellableItems.find(
							(item) => item.deliveryComponentId === deliveryComponentId,
						)?.enabled ?? false,
					credential: draft.credential.trim(),
				});
			if (!savedProductId) {
				const created = await createProductDraftFn({
					data: {
						name,
						description: description.trim() || null,
						productType,
						tagNames,
					},
				});
				savedProductId = created.id;
				savedRevision = created.revision;
			}
			const pendingCover = parseProductCoverUpload(coverUpload);
			const uploadedCover = pendingCover
				? await uploadProductMediaFn({
						data: {
							productId: savedProductId,
							...pendingCover,
							altText: name,
							setAsCover: false,
						},
					})
				: null;
			await Promise.all(
				galleryUploads.map((upload) =>
					uploadProductMediaFn({
						data: {
							productId: savedProductId,
							...upload,
							altText: "",
							setAsCover: false,
						},
					}),
				),
			);
			const content = await saveProductContentFn({
				data: {
					productId: savedProductId,
					expectedRevision: savedRevision,
					name,
					description: description.trim() || null,
					productType,
					tagNames,
					coverObjectKey:
						uploadedCover?.objectKey ??
						query.data?.product.coverObjectKey ??
						null,
				},
			});
			const boundComponents = components
				.filter((component) => boundComponentIds.has(component.id))
				.map((component) => ({
					...component,
					enabled:
						sellableItems.find(
							(item) => item.deliveryComponentId === component.id,
						)?.enabled ?? false,
				}));
			const sellableItemResult = await saveProductSellableItemsFn({
				data: {
					productId: savedProductId,
					expectedRevision: content.revision,
					sellableItems: sellableItems.map((sellableItem) => {
						const component = boundComponents.find(
							(item) => item.id === sellableItem.deliveryComponentId,
						);
						if (!component)
							throw new Error("Sellable item delivery settings are missing");
						return {
							...sellableItem,
							delivery: {
								type: component.type,
								durationMs: component.durationMs,
								usageLimit: component.usageLimit,
								accessLimit: component.accessLimit,
								renewalMode: component.renewalMode,
								emailMode: component.emailMode,
								showOnOrderPage: component.showOnOrderPage,
								allowResend: component.allowResend,
								lowStockThreshold: component.lowStockThreshold,
							},
						};
					}),
				},
			});
			const componentIdMap = Object.fromEntries(
				sellableItems.map((sellableItem) => [
					sellableItem.deliveryComponentId,
					sellableItemResult.itemIdMap[sellableItem.id] ?? sellableItem.id,
				]),
			);
			const savedComponents = boundComponents.map((component) => ({
				...component,
				id: componentIdMap[component.id] ?? component.id,
			}));
			const savedSellableItems = sellableItems.map((sellableItem) => ({
				...sellableItem,
				id: sellableItemResult.itemIdMap[sellableItem.id] ?? sellableItem.id,
				deliveryComponentId:
					componentIdMap[sellableItem.deliveryComponentId] ??
					sellableItem.deliveryComponentId,
			}));
			for (const [temporaryId, pendingImport] of Object.entries(
				pendingCardImports,
			)) {
				if (!boundComponentIds.has(temporaryId)) continue;
				if (
					sellableItems.find((item) => item.deliveryComponentId === temporaryId)
						?.fulfillmentSource !== "local"
				)
					continue;
				const content = pendingImport.content.trim();
				if (!content) continue;
				await importInventoryFn({
					data: {
						componentId: componentIdMap[temporaryId] ?? temporaryId,
						content,
						note: pendingImport.note.trim(),
					},
				});
			}
			for (const [temporaryId, downloads] of Object.entries(pendingDownloads)) {
				if (!boundComponentIds.has(temporaryId)) continue;
				const componentId = componentIdMap[temporaryId] ?? temporaryId;
				for (const pending of downloads) {
					await uploadPendingDownload(
						savedProductId,
						componentId,
						pending.file,
					);
					setPendingDownloads((current) => ({
						...current,
						[temporaryId]: (current[temporaryId] ?? []).filter(
							(item) => item.id !== pending.id,
						),
					}));
				}
			}
			const savedBuilds: Record<string, ConfigurationDraft> = {};
			for (const [temporaryId, draft] of pendingBuildEntries) {
				const deliveryComponentId = componentIdMap[temporaryId] ?? temporaryId;
				const savedBuild = await saveBuildConfigurationFn({
					data: {
						...draft,
						productId: savedProductId,
						deliveryComponentId,
						enabled:
							sellableItems.find(
								(item) => item.deliveryComponentId === temporaryId,
							)?.enabled ?? false,
						credential: draft.credential.trim(),
					},
				});
				savedBuilds[deliveryComponentId] = {
					...draft,
					id: savedBuild.id,
					credential: "",
					configured: true,
				};
			}
			return {
				productId: savedProductId,
				revision: sellableItemResult.revision,
				components: savedComponents,
				sellableItems: savedSellableItems,
				savedBuilds,
			};
		},
		onSuccess: async (result) => {
			setRevision(result.revision);
			setComponents(result.components);
			setSellableItems(result.sellableItems);
			setCoverUpload("");
			setGalleryUploads([]);
			setPendingBuilds(result.savedBuilds);
			setPendingCardImports({});
			setPendingDownloads({});
			toast.success(m.catalog_editor_saved());
			await client.invalidateQueries({ queryKey: ["admin", "catalog"] });
			await client.invalidateQueries({ queryKey: ["admin", "build-configs"] });
			if (isNew)
				await navigate({
					to: "/admin/products/$productId/edit",
					params: { productId: result.productId },
					replace: true,
				});
			else await query.refetch();
		},
	});
	const publish = useMutation({
		mutationFn: (publishValue: boolean) => {
			if (!productId) throw new Error("Save the product before publishing");
			return publishProductFn({
				data: { productId, expectedRevision: revision, publish: publishValue },
			});
		},
		onSuccess: async (result) => {
			setRevision(result.revision);
			await query.refetch();
			toast.success(
				result.status === "active"
					? m.catalog_editor_published()
					: m.catalog_editor_unpublished(),
			);
		},
		onError: showError,
	});
	const saleDisabled = useMutation({
		mutationFn: (disabled: boolean) => {
			if (!productId) throw new Error("Save the product before changing sales");
			return setProductSaleDisabledFn({
				data: { productId, expectedRevision: revision, disabled },
			});
		},
		onSuccess: async (result) => {
			setRevision(result.revision);
			await query.refetch();
			toast.success(
				result.saleDisabled
					? m.catalog_sale_disabled_success()
					: m.catalog_sale_enabled_success(),
			);
		},
		onError: showError,
	});
	if (!isNew && query.isError)
		return (
			<div className="grid min-h-80 place-items-center">
				<div className="grid justify-items-center gap-3 text-center">
					<p className="text-destructive">{m.catalog_operation_failed()}</p>
					<ProButton onClick={() => query.refetch()} type="button">
						{m.common_retry()}
					</ProButton>
				</div>
			</div>
		);
	if ((!isNew && !query.data) || (isNew && currencyConfiguration.isPending))
		return <div className="h-96 animate-pulse bg-muted" />;
	const current = query.data;
	const availableTagNames = (tagOptions.data ?? []).map((tag) => tag.name);
	const cover = media.data?.find((item) => item.cover);
	return (
		<ProForm
			className="mx-auto flex min-h-0 w-full max-w-[1360px] flex-1 flex-col [&>div:first-child]:mb-0 [&>div:first-child]:flex [&>div:first-child]:min-h-0 [&>div:first-child]:flex-1 [&>div:first-child]:flex-col"
			onFinish={async () => {
				await save.mutateAsync();
			}}
			onFinishFailed={showError}
			submitter={false}
		>
			<div className="z-20 -mx-4 shrink-0 border-b bg-background px-4 pb-4">
				<PageHeader
					actions={
						<div className="flex flex-wrap justify-end gap-2">
							<ProButton disabled={save.isPending} type="submit">
								<Save />
								{m.catalog_editor_save()}
							</ProButton>
							{current ? (
								<ProButton
									disabled={
										saleDisabled.isPending ||
										current.product.status !== "active"
									}
									onClick={() =>
										saleDisabled.mutate(!current.product.saleDisabled)
									}
									tooltip={m.catalog_sale_disabled_tooltip()}
									type="button"
									variant={
										current.product.saleDisabled ? "outline" : "destructive"
									}
								>
									{current.product.saleDisabled ? <ShoppingCart /> : <Ban />}
									{current.product.saleDisabled
										? m.catalog_sale_enable()
										: m.catalog_sale_disable()}
								</ProButton>
							) : null}
							{current ? (
								<ProButton
									disabled={
										publish.isPending ||
										(current.product.status !== "active" &&
											!current.publishCheck.canPublish)
									}
									onClick={() =>
										publish.mutate(current.product.status !== "active")
									}
									type="button"
									variant={
										current.product.status === "active" ? "outline" : "default"
									}
								>
									<Send />
									{current.product.status === "active"
										? m.catalog_editor_unpublish()
										: m.catalog_editor_publish()}
								</ProButton>
							) : null}
						</div>
					}
					description={m.catalog_editor_revision({ revision })}
					title={name || m.catalog_editor_title()}
				/>
			</div>
			<div className="-mx-1 min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 pt-6 pb-2">
				<div className="grid min-w-0 items-start gap-8 xl:grid-cols-[minmax(280px,2fr)_minmax(0,3fr)]">
					<div className="grid min-w-0 gap-6">
						<ProductCoverField
							currentUrl={cover?.url}
							onChange={(value) => setCoverUpload(String(value ?? ""))}
							value={coverUpload}
						/>
						<GalleryEditor
							media={media.data ?? []}
							onPendingChange={setGalleryUploads}
							pendingCount={galleryUploads.length}
							productId={editorProductId}
						/>
					</div>
					<div className="grid min-w-0 grid-cols-1 gap-6">
						<div className="grid gap-4 sm:grid-cols-2">
							<FormItem label={m.common_name()} required>
								<Input
									maxLength={160}
									onChange={(event) => setName(event.target.value)}
									required
									value={name}
								/>
							</FormItem>
							<FormItem
								label={m.catalog_tags()}
								tooltip={m.catalog_tags_tooltip()}
							>
								<ProSelect
									allowCreate
									caseSensitiveValues
									createControl="input"
									multiple
									onChange={(value) =>
										setTagNames(Array.isArray(value) ? value : [])
									}
									options={[
										...new Set([...availableTagNames, ...tagNames]),
									].map((tag) => ({ label: tag, value: tag }))}
									searchable
									value={tagNames}
								/>
							</FormItem>
						</div>
						<FormItem label={m.catalog_description()}>
							<ProEditor
								height={240}
								language="plaintext"
								onChange={setDescription}
								toolbarFormat={false}
								toolbarTitle={m.catalog_description()}
								value={description}
							/>
						</FormItem>
						<SellableItemsEditor
							components={components}
							onComponentsChange={setComponents}
							onPendingCardImportChange={(id, pendingImport) =>
								setPendingCardImports((current) => ({
									...current,
									[id]: pendingImport,
								}))
							}
							onPendingBuildChange={(id, draft) =>
								setPendingBuilds((current) => ({
									...current,
									[id]: draft,
								}))
							}
							onPendingDownloadsChange={(id, downloads) =>
								setPendingDownloads((current) => ({
									...current,
									[id]: downloads,
								}))
							}
							onSellableItemsChange={setSellableItems}
							pendingCardImports={pendingCardImports}
							pendingBuilds={pendingBuilds}
							pendingDownloads={pendingDownloads}
							persistedIds={
								new Set(
									current?.components.map((component) => component.id) ?? [],
								)
							}
							productId={editorProductId}
							productType={productType}
							sellableItems={sellableItems}
							baseCurrency={currencyConfiguration.data?.baseCurrency ?? "USD"}
							currencySymbol={
								currencyConfiguration.data?.baseCurrencySymbol ?? "$"
							}
						/>
						{current ? (
							<PublishCheck check={current.publishCheck} />
						) : (
							<p className="text-muted-foreground text-sm">
								{m.catalog_editor_publish_after_save()}
							</p>
						)}
					</div>
				</div>
			</div>
		</ProForm>
	);
}

function GalleryEditor({
	media,
	productId,
	pendingCount,
	onPendingChange,
}: {
	media: Media[];
	productId: string;
	pendingCount: number;
	onPendingChange: React.Dispatch<React.SetStateAction<GalleryUpload[]>>;
}) {
	const client = useQueryClient();
	const refresh = () =>
		client.invalidateQueries({
			queryKey: ["admin", "catalog", "media", productId],
		});
	const remove = useMutation({
		mutationFn: deleteProductMediaFn,
		onSuccess: refresh,
		onError: showError,
	});
	const setCover = useMutation({
		mutationFn: setProductCoverFn,
		onSuccess: refresh,
		onError: showError,
	});
	const sort = useMutation({
		mutationFn: (ids: string[]) =>
			sortProductMediaFn({ data: { productId, ids } }),
		onSuccess: refresh,
		onError: showError,
	});
	return (
		<FormItem label={m.catalog_gallery()}>
			<div className="grid gap-3">
				{media.length ? (
					<div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
						{media.map((item, index) => (
							<div
								className="group relative aspect-video overflow-hidden rounded-xl bg-muted"
								key={item.id}
							>
								<img
									alt={item.altText ?? m.catalog_gallery_image()}
									className="size-full object-cover"
									src={item.url}
								/>
								<div className="absolute inset-x-0 bottom-0 flex justify-end gap-1 bg-background/85 p-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
									<ProButton
										disabled={index === 0 || sort.isPending}
										onClick={() =>
											sort.mutate(moveItem(media, index, index - 1))
										}
										size="icon-sm"
										tooltip={m.catalog_gallery_move_earlier()}
										type="button"
										variant="ghost"
									>
										<ChevronLeft />
									</ProButton>
									<ProButton
										disabled={index === media.length - 1 || sort.isPending}
										onClick={() =>
											sort.mutate(moveItem(media, index, index + 1))
										}
										size="icon-sm"
										tooltip={m.catalog_gallery_move_later()}
										type="button"
										variant="ghost"
									>
										<ChevronRight />
									</ProButton>
									<ProButton
										disabled={item.cover || setCover.isPending}
										onClick={() => setCover.mutate({ data: { id: item.id } })}
										size="icon-sm"
										tooltip={m.catalog_gallery_set_cover()}
										type="button"
										variant="ghost"
									>
										<Star />
									</ProButton>
									<ProButton
										disabled={remove.isPending}
										onClick={() => remove.mutate({ data: { id: item.id } })}
										size="icon-sm"
										tooltip={m.common_delete()}
										type="button"
										variant="ghost"
									>
										<Trash2 />
									</ProButton>
								</div>
							</div>
						))}
					</div>
				) : null}
				{media.length + pendingCount < 12 ? (
					<Upload
						accept="image/avif,image/gif,image/jpeg,image/png,image/webp"
						maxCount={12 - media.length - pendingCount}
						upload={async (files) => {
							const results = await Promise.all(
								files.map((file) =>
									file.size > 0 &&
									file.size <= 5_000_000 &&
									isGalleryContentType(file.type)
										? readGalleryUpload(file)
										: null,
								),
							);
							const payloads = results.filter((item) => item != null);
							onPendingChange((current) => [
								...current,
								...payloads.map((item) => item.upload),
							]);
							return results.map((item) => item?.preview ?? false);
						}}
					>
						<UploadTrigger />
					</Upload>
				) : null}
				{pendingCount ? (
					<p className="text-muted-foreground text-xs">
						{pendingCount} {m.catalog_gallery_upload()}
					</p>
				) : null}
			</div>
		</FormItem>
	);
}

function moveItem(media: Media[], from: number, to: number) {
	const ids = media.map((item) => item.id);
	const [moved] = ids.splice(from, 1);
	if (moved) ids.splice(to, 0, moved);
	return ids;
}

function SellableItemsEditor({
	components,
	onComponentsChange,
	onPendingCardImportChange,
	onPendingBuildChange,
	onPendingDownloadsChange,
	onSellableItemsChange,
	pendingCardImports,
	pendingBuilds,
	pendingDownloads,
	persistedIds,
	productId,
	productType,
	sellableItems,
	baseCurrency,
	currencySymbol,
}: {
	components: Component[];
	onComponentsChange: (components: Component[]) => void;
	onPendingCardImportChange: (
		id: string,
		pendingImport: PendingCardImport,
	) => void;
	onPendingBuildChange: (id: string, draft: ConfigurationDraft) => void;
	onPendingDownloadsChange: (id: string, downloads: PendingDownload[]) => void;
	onSellableItemsChange: (sellableItems: SellableItem[]) => void;
	pendingCardImports: Record<string, PendingCardImport>;
	pendingBuilds: Record<string, ConfigurationDraft>;
	pendingDownloads: Record<string, PendingDownload[]>;
	persistedIds: Set<string>;
	productId: string;
	productType: Component["type"];
	sellableItems: SellableItem[];
	baseCurrency: string;
	currencySymbol: string;
}) {
	const createItem = () => {
		const first = sellableItems[0];
		const component = newComponent(productType);
		const item = newSellableItem(
			sellableItems.length,
			component.id,
			first?.currency ?? "USD",
			first?.currencyDecimals ?? 2,
		);
		onComponentsChange([...components, component]);
		return item;
	};
	const duplicateItem = (index: number) => {
		const source = sellableItems[index];
		if (!source || sellableItems.length >= 100) return;
		const sourceComponent = deliveryComponentForItem(source, components);
		const copyName = uniqueSellableItemCopyName(source.name, sellableItems);
		const component = sourceComponent
			? {
					...structuredClone(sourceComponent),
					id: crypto.randomUUID(),
					version: 1,
				}
			: newComponent(productType);
		const copy = {
			...source,
			id: crypto.randomUUID(),
			name: copyName,
			deliveryComponentId: component.id,
		};
		onComponentsChange([...components, component]);
		onSellableItemsChange([
			...sellableItems.slice(0, index + 1),
			copy,
			...sellableItems.slice(index + 1),
		]);
		const buildDraft = pendingBuilds[sourceComponent?.id ?? ""];
		if (buildDraft)
			onPendingBuildChange(component.id, duplicateBuildDraft(buildDraft));
	};
	return (
		<ProArrayField
			className="min-w-0 grid-cols-1"
			addLabel={m.catalog_sellable_item_add()}
			canRemoveItem={(sellableItem) =>
				sellableItem.fulfillmentSource === "local"
			}
			create={createItem}
			getKey={(sellableItem) => sellableItem.id}
			itemLabel={(sellableItem, index) => (
				<span className="inline-flex items-center gap-2">
					{index + 1}. {sellableItem.name || m.catalog_sellable_item_unnamed()}
					{sellableItem.saleDisabled ? (
						<Badge variant="destructive">{m.catalog_sale_disabled()}</Badge>
					) : null}
					{sellableItem.fulfillmentSource === "supplier" ? (
						<Badge variant="outline">{m.catalog_supplier_fulfillment()}</Badge>
					) : null}
				</span>
			)}
			itemExtra={(sellableItem, index) => {
				const component = deliveryComponentForItem(sellableItem, components);
				return (
					<>
						<Toggle
							checked={sellableItem.enabled}
							label={m.common_enabled()}
							tooltip={m.catalog_sellable_item_enabled_tooltip()}
							onChange={(enabled) =>
								updateSellableItem(
									sellableItems,
									index,
									{ enabled },
									onSellableItemsChange,
								)
							}
						/>
						<Toggle
							checked={sellableItem.saleDisabled}
							label={m.catalog_sale_disabled()}
							tooltip={m.catalog_sku_sale_disabled_tooltip()}
							onChange={(disabled) =>
								updateSellableItem(
									sellableItems,
									index,
									{ saleDisabled: disabled },
									onSellableItemsChange,
								)
							}
						/>
						{component ? (
							<div className="w-36">
								<EntitlementPresetSelect
									component={component}
									components={components}
									onChange={onComponentsChange}
								/>
							</div>
						) : null}
						{sellableItem.fulfillmentSource === "local" ? (
							<ProButton
								onClick={() => duplicateItem(index)}
								size="icon-sm"
								tooltip={m.common_copy()}
								type="button"
								variant="ghost"
							>
								<Copy />
							</ProButton>
						) : null}
					</>
				);
			}}
			max={100}
			min={1}
			onChange={onSellableItemsChange}
			removeLabel={m.catalog_sellable_item_remove()}
			reorderLabel={m.pro_action_dragToReorder()}
			value={sellableItems}
		>
			{(sellableItem, { index }) => {
				const component = deliveryComponentForItem(sellableItem, components);
				const componentIndex = component
					? components.findIndex((item) => item.id === component.id)
					: -1;
				const moneySymbol =
					sellableItem.currency === baseCurrency ? currencySymbol : "";
				return (
					<div className="grid min-w-0 grid-cols-1 gap-4">
						<div className="grid gap-4 sm:grid-cols-3">
							<FormItem label={m.common_name()} required>
								<Input
									maxLength={120}
									onChange={(event) =>
										updateSellableItem(
											sellableItems,
											index,
											{ name: event.target.value },
											onSellableItemsChange,
										)
									}
									required
									value={sellableItem.name}
								/>
							</FormItem>
							<FormItem
								label={m.catalog_price_minor()}
								required
								tooltip={m.catalog_price_minor_tooltip()}
							>
								<MoneyField
									currency={sellableItem.currency}
									decimals={sellableItem.currencyDecimals}
									minor={sellableItem.priceMinor}
									onChange={(priceMinor) =>
										updateSellableItem(
											sellableItems,
											index,
											{ priceMinor: priceMinor ?? "" },
											onSellableItemsChange,
										)
									}
									required
									symbol={moneySymbol}
								/>
							</FormItem>
							<FormItem
								label={m.catalog_list_price_minor()}
								tooltip={m.catalog_list_price_minor_tooltip()}
							>
								<MoneyField
									currency={sellableItem.currency}
									decimals={sellableItem.currencyDecimals}
									minor={sellableItem.listPriceMinor}
									onChange={(listPriceMinor) =>
										updateSellableItem(
											sellableItems,
											index,
											{ listPriceMinor },
											onSellableItemsChange,
										)
									}
									symbol={moneySymbol}
								/>
							</FormItem>
							{sellableItem.fulfillmentSource === "local" ? (
								<FormItem
									label={m.catalog_cost_minor()}
									tooltip={m.catalog_cost_minor_tooltip()}
								>
									<MoneyField
										currency={sellableItem.currency}
										decimals={sellableItem.currencyDecimals}
										minor={sellableItem.costMinor}
										onChange={(costMinor) =>
											updateSellableItem(
												sellableItems,
												index,
												{ costMinor },
												onSellableItemsChange,
											)
										}
										symbol={moneySymbol}
									/>
								</FormItem>
							) : null}
							<FormItem
								label={m.catalog_minimum_quantity()}
								tooltip={m.catalog_minimum_quantity_tooltip()}
							>
								<Input
									min={1}
									onChange={(event) =>
										updateSellableItem(
											sellableItems,
											index,
											{ minimumQuantity: Number(event.target.value) },
											onSellableItemsChange,
										)
									}
									type="number"
									value={sellableItem.minimumQuantity}
								/>
							</FormItem>
							<FormItem
								label={m.catalog_maximum_quantity()}
								tooltip={m.catalog_maximum_quantity_tooltip()}
							>
								<Input
									min={1}
									onChange={(event) =>
										updateSellableItem(
											sellableItems,
											index,
											{ maximumQuantity: Number(event.target.value) },
											onSellableItemsChange,
										)
									}
									type="number"
									value={sellableItem.maximumQuantity}
								/>
							</FormItem>
							<FormItem
								label={m.catalog_maximum_per_customer()}
								tooltip={m.catalog_maximum_per_customer_tooltip()}
							>
								<Input
									min={1}
									onChange={(event) =>
										updateSellableItem(
											sellableItems,
											index,
											{
												maximumPerCustomer: nullableInt(event.target.value),
											},
											onSellableItemsChange,
										)
									}
									type="number"
									value={sellableItem.maximumPerCustomer ?? ""}
								/>
							</FormItem>
							<FormItem
								label={m.catalog_reminder_cycle_days()}
								tooltip={m.catalog_reminder_cycle_days_tooltip()}
							>
								<Input
									min={1}
									onChange={(event) =>
										updateSellableItem(
											sellableItems,
											index,
											{
												reminderCycleDays: nullableInt(event.target.value),
											},
											onSellableItemsChange,
										)
									}
									type="number"
									value={sellableItem.reminderCycleDays ?? ""}
								/>
							</FormItem>
							{component ? (
								<FormItem
									label={m.catalog_duration_ms()}
									tooltip={m.catalog_duration_ms_tooltip()}
								>
									<DurationField
										onChange={(durationMs) =>
											updateComponent(
												components,
												componentIndex,
												{ durationMs },
												onComponentsChange,
											)
										}
										value={component.durationMs}
									/>
								</FormItem>
							) : null}
							{component?.type === "stock" &&
							sellableItem.fulfillmentSource === "local" ? (
								<FormItem
									label={m.catalog_low_stock_threshold()}
									tooltip={m.catalog_low_stock_threshold_tooltip()}
								>
									<Input
										min={0}
										onChange={(event) =>
											updateComponent(
												components,
												componentIndex,
												{ lowStockThreshold: Number(event.target.value) },
												onComponentsChange,
											)
										}
										type="number"
										value={component.lowStockThreshold}
									/>
								</FormItem>
							) : null}
							{component?.type === "download" ? (
								<FormItem
									label={accessLimitLabel(component.type)}
									tooltip={m.catalog_access_limit_tooltip()}
								>
									<Input
										min={1}
										onChange={(event) =>
											updateComponent(
												components,
												componentIndex,
												{ accessLimit: nullableInt(event.target.value) },
												onComponentsChange,
											)
										}
										type="number"
										value={component.accessLimit ?? ""}
									/>
								</FormItem>
							) : null}
							{component?.type === "automation" ? (
								<FormItem
									label={usageLimitLabel(component.type)}
									tooltip={m.catalog_usage_limit_tooltip()}
								>
									<Input
										min={1}
										onChange={(event) =>
											updateComponent(
												components,
												componentIndex,
												{ usageLimit: nullableInt(event.target.value) },
												onComponentsChange,
											)
										}
										type="number"
										value={component.usageLimit ?? ""}
									/>
								</FormItem>
							) : null}
						</div>
						{component ? (
							<ComponentEditor
								components={components}
								onChange={onComponentsChange}
								onPendingCardImportChange={onPendingCardImportChange}
								onPendingBuildChange={onPendingBuildChange}
								onPendingDownloadsChange={onPendingDownloadsChange}
								pendingCardImports={pendingCardImports}
								pendingBuilds={pendingBuilds}
								pendingDownloads={pendingDownloads}
								persistedIds={persistedIds}
								productId={productId}
								sellableItem={sellableItem}
							/>
						) : null}
					</div>
				);
			}}
		</ProArrayField>
	);
}

function ComponentEditor({
	components,
	onChange,
	onPendingCardImportChange,
	onPendingBuildChange,
	onPendingDownloadsChange,
	pendingCardImports,
	pendingBuilds,
	pendingDownloads,
	productId,
	persistedIds,
	sellableItem,
}: {
	components: Component[];
	onChange: (components: Component[]) => void;
	onPendingCardImportChange: (
		id: string,
		pendingImport: PendingCardImport,
	) => void;
	onPendingBuildChange: (id: string, draft: ConfigurationDraft) => void;
	onPendingDownloadsChange: (id: string, downloads: PendingDownload[]) => void;
	pendingCardImports: Record<string, PendingCardImport>;
	pendingBuilds: Record<string, ConfigurationDraft>;
	pendingDownloads: Record<string, PendingDownload[]>;
	productId: string;
	persistedIds: Set<string>;
	sellableItem: SellableItem;
}) {
	const component = deliveryComponentForItem(sellableItem, components);
	if (!component) return null;
	const index = components.findIndex((item) => item.id === component.id);
	const pendingBuild = pendingBuilds[component.id];
	return (
		<div className="grid min-w-0 grid-cols-1 gap-4">
			<div className="grid gap-3 sm:grid-cols-3">
				<Toggle
					label={m.catalog_email_delivery_mode()}
					tooltip={m.catalog_email_delivery_mode_tooltip()}
					checked={component.emailMode !== "none"}
					onChange={(emailEnabled) =>
						updateComponent(
							components,
							index,
							{
								emailMode: emailEnabled
									? preferredEmailMode(component)
									: "none",
							},
							onChange,
						)
					}
				/>
				<Toggle
					label={m.catalog_show_on_order_page()}
					tooltip={m.catalog_show_on_order_page_tooltip()}
					checked={component.showOnOrderPage}
					onChange={(showOnOrderPage) =>
						updateComponent(components, index, { showOnOrderPage }, onChange)
					}
				/>
				<Toggle
					label={m.catalog_allow_resend()}
					tooltip={m.catalog_allow_resend_tooltip()}
					checked={component.allowResend}
					onChange={(allowResend) =>
						updateComponent(components, index, { allowResend }, onChange)
					}
				/>
			</div>
			{component.type === "automation" && pendingBuild ? (
				<div className="grid gap-4 border-t pt-4">
					<div>
						<p className="font-medium text-sm">
							{m.catalog_automation_configuration()}
						</p>
						<p className="text-muted-foreground text-sm">
							{m.catalog_automation_configuration_description()}
						</p>
					</div>
					<BuildConfigurationFields
						draft={pendingBuild}
						onChange={(draft) => onPendingBuildChange(component.id, draft)}
						showEnabled={false}
					/>
				</div>
			) : null}
			{sellableItem.supplierBinding ? (
				<SupplierFulfillmentPanel
					productId={productId}
					sellableItem={sellableItem}
				/>
			) : null}
			{persistedIds.has(component.id) && component.type === "stock" ? (
				<ComponentOperations component={component} productId={productId} />
			) : !persistedIds.has(component.id) ? (
				<PendingComponentOperations
					component={component}
					onPendingCardImportChange={onPendingCardImportChange}
					onPendingDownloadsChange={onPendingDownloadsChange}
					pendingCardImport={pendingCardImports[component.id]}
					pendingDownloads={pendingDownloads[component.id] ?? []}
				/>
			) : component.type !== "stock" ? (
				<ComponentOperations component={component} productId={productId} />
			) : null}
		</div>
	);
}

function SupplierFulfillmentPanel({
	productId,
	sellableItem,
}: {
	productId: string;
	sellableItem: SellableItem;
}) {
	const client = useQueryClient();
	const binding = sellableItem.supplierBinding;
	const switchMode = useMutation({
		mutationFn: switchStockFulfillmentModeFn,
		onSuccess: async () => {
			toast.success(m.catalog_supply_mode_switch_success());
			await Promise.all([
				client.invalidateQueries({
					queryKey: ["admin", "catalog", "product-editor", productId],
				}),
				client.invalidateQueries({
					queryKey: ["admin", "catalog", "inventory"],
				}),
			]);
		},
		onError: (error) => toast.error(catalogOperationErrorMessage(error)),
	});
	const localMode = sellableItem.fulfillmentSource === "local";
	return (
		<div className="grid min-w-0 grid-cols-1 gap-3 border-t pt-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div>
					<p className="font-medium text-sm">
						{m.catalog_supplier_fulfillment()}
					</p>
					<p className="text-muted-foreground text-sm">
						{m.catalog_supplier_fulfillment_description()}
					</p>
				</div>
				<div className="flex flex-wrap gap-2">
					<ProButton
						disabled={switchMode.isPending || !binding}
						onClick={() =>
							switchMode.mutate({
								data: {
									sellableItemId: sellableItem.id,
									mode: localMode ? "supplier" : "local",
								},
							})
						}
						size="sm"
						variant={localMode ? "default" : "outline"}
					>
						{localMode
							? m.catalog_supply_mode_restore_supplier()
							: m.catalog_supply_mode_use_local()}
					</ProButton>
					<ProButton asChild size="sm" variant="outline">
						<Link
							search={
								binding
									? {
											q: binding.upstreamSkuId,
											source: `${binding.provider}:${binding.normalizedApiOrigin}`,
										}
									: {}
							}
							to="/admin/suppliers/products"
						>
							{m.catalog_supplier_manage_binding()}
							<ChevronRight />
						</Link>
					</ProButton>
				</div>
			</div>
			<p className="text-muted-foreground text-sm">
				{localMode
					? sellableItem.supplierFallbackEnabled
						? m.catalog_supply_mode_fallback_description()
						: m.catalog_supply_mode_local_description()
					: m.catalog_supply_mode_supplier_description()}
			</p>
			{binding ? (
				<div className="grid gap-3 rounded-md bg-muted/40 p-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
					<ReadOnlyDetail
						label={m.supplier_upstream_details()}
						value={`${binding.upstreamProductName} · ${binding.upstreamSkuName}`}
					/>
					<ReadOnlyDetail
						label={m.supplier_cost()}
						value={formatMinorAmount(
							binding.referenceCostMinor,
							sellableItem.currency,
							sellableItem.currencyDecimals,
						)}
					/>
					<ReadOnlyDetail
						label={m.supplier_stock()}
						value={formatNumber(binding.stockQuantity)}
					/>
					<ReadOnlyDetail
						label={m.common_status()}
						value={supplierFulfillmentStatusLabel(sellableItem.supplierStatus)}
					/>
					{binding.lastSyncedAt ? (
						<ReadOnlyDetail
							label={m.catalog_supplier_last_synced()}
							value={formatDateTime(binding.lastSyncedAt)}
						/>
					) : null}
				</div>
			) : (
				<p className="text-destructive text-sm">
					{m.catalog_supplier_binding_missing()}
				</p>
			)}
		</div>
	);
}

function ReadOnlyDetail({ label, value }: { label: string; value: string }) {
	return (
		<div className="grid min-w-0 gap-1">
			<span className="text-muted-foreground text-xs">{label}</span>
			<span className="truncate font-medium" title={value}>
				{value}
			</span>
		</div>
	);
}

function PendingComponentOperations({
	component,
	onPendingCardImportChange,
	onPendingDownloadsChange,
	pendingCardImport,
	pendingDownloads,
}: {
	component: Component;
	onPendingCardImportChange: (
		id: string,
		pendingImport: PendingCardImport,
	) => void;
	onPendingDownloadsChange: (id: string, downloads: PendingDownload[]) => void;
	pendingCardImport: PendingCardImport | undefined;
	pendingDownloads: PendingDownload[];
}) {
	if (component.type === "stock") {
		const pendingImport = pendingCardImport ?? { content: "", note: "" };
		return (
			<div className="grid gap-4 border-t pt-4">
				<FormItem
					label={m.inventory_content()}
					tooltip={m.inventory_content_description()}
				>
					<Textarea
						onChange={(event) =>
							onPendingCardImportChange(component.id, {
								...pendingImport,
								content: event.target.value,
							})
						}
						rows={8}
						value={pendingImport.content}
					/>
				</FormItem>
				<FormItem label={m.inventory_note()}>
					<Textarea
						onChange={(event) =>
							onPendingCardImportChange(component.id, {
								...pendingImport,
								note: event.target.value,
							})
						}
						rows={2}
						value={pendingImport.note}
					/>
				</FormItem>
			</div>
		);
	}
	if (component.type === "download")
		return (
			<div className="grid gap-3 border-t pt-4">
				<FormItem label={m.download_assets_file()}>
					<Input
						multiple
						onChange={(event) => {
							const additions = Array.from(event.target.files ?? []).map(
								(file) => ({ id: crypto.randomUUID(), file }),
							);
							onPendingDownloadsChange(component.id, [
								...pendingDownloads,
								...additions,
							]);
							event.target.value = "";
						}}
						type="file"
					/>
				</FormItem>
				{pendingDownloads.map((pending) => (
					<div
						className="flex min-w-0 items-center justify-between gap-3 border-b py-2 text-sm"
						key={pending.id}
					>
						<span className="truncate">{pending.file.name}</span>
						<ProButton
							aria-label={m.common_delete()}
							className="text-destructive-foreground"
							onClick={() =>
								onPendingDownloadsChange(
									component.id,
									pendingDownloads.filter((item) => item.id !== pending.id),
								)
							}
							size="icon-sm"
							tooltip={m.common_delete()}
							type="button"
							variant="ghost"
						>
							<Trash2 />
						</ProButton>
					</div>
				))}
			</div>
		);
	return null;
}

function ComponentOperations({
	component,
	productId,
}: {
	component: Component;
	productId: string;
}) {
	if (component.type === "stock")
		return (
			<ProductInventory componentId={component.id} productId={productId} />
		);
	if (component.type === "download")
		return (
			<ProductDownloadAssets componentId={component.id} productId={productId} />
		);
	return null;
}

function Toggle({
	label,
	checked,
	onChange,
	tooltip,
}: {
	label: string;
	checked: boolean;
	onChange: (checked: boolean) => void;
	tooltip?: string;
}) {
	return (
		<div className="flex items-center gap-2 text-sm">
			<ProSwitch aria-label={label} onChange={onChange} value={checked} />
			<span>{label}</span>
			{tooltip ? (
				<ProButton
					aria-label={tooltip}
					className="size-6"
					size="icon-sm"
					tooltip={tooltip}
					type="button"
					variant="ghost"
				>
					<Info />
				</ProButton>
			) : null}
		</div>
	);
}

function EntitlementPresetSelect({
	component,
	components,
	onChange,
}: {
	component: Component;
	components: Component[];
	onChange: (components: Component[]) => void;
}) {
	const index = components.findIndex((item) => item.id === component.id);
	return (
		<ProSelect
			ariaLabel={m.catalog_entitlement_preset()}
			onChange={(value) => {
				if (typeof value !== "string") return;
				updateComponent(
					components,
					index,
					presetPolicy(value, component.type),
					onChange,
				);
			}}
			options={entitlementPresetOptions(component.type)}
			value={entitlementPreset(component)}
		/>
	);
}

function PublishCheck({ check }: { check: Editor["publishCheck"] }) {
	const items = [
		...check.blockers.map((item) => ({
			...item,
			level: m.catalog_editor_blocker(),
			blocking: true,
		})),
		...check.warnings.map((item) => ({
			...item,
			level: m.catalog_editor_warning(),
			blocking: false,
		})),
	];
	if (!items.length)
		return (
			<p className="text-sm text-emerald-600">
				{m.catalog_editor_publish_ready()}
			</p>
		);
	return (
		<div className="grid gap-2">
			{items.map((item) => (
				<a
					className="flex items-center justify-between border-b py-3"
					href={`#${publishTargetSection(item.target)}`}
					key={`${item.code}:${item.target}`}
				>
					<span>{publishIssueMessage(item.code, item.message)}</span>
					<Badge variant={item.blocking ? "destructive" : "secondary"}>
						{item.level}
					</Badge>
				</a>
			))}
		</div>
	);
}

function publishTargetSection(target: string) {
	const domain = target.split(":")[0];
	return domain === "sellableItem" || domain === "component"
		? "sellableItems"
		: domain;
}

function MoneyField({
	currency,
	decimals,
	minor,
	onChange,
	required,
	symbol,
}: {
	currency: string;
	decimals: number;
	minor: string | null;
	onChange: (minor: string | null) => void;
	required?: boolean;
	symbol: string;
}) {
	const inputRef = useRef<HTMLInputElement>(null);
	const [display, setDisplay] = useState(() =>
		formatMinorInput(minor, decimals),
	);
	useEffect(() => {
		if (document.activeElement !== inputRef.current)
			setDisplay(formatMinorInput(minor, decimals));
	}, [decimals, minor]);
	const pattern = decimals === 0 ? "\\d+" : `\\d+(?:\\.\\d{0,${decimals}})?`;
	return (
		<Input
			inputMode="decimal"
			onBlur={() => {
				const parsed = parseMajorInput(display, decimals);
				if (parsed !== undefined)
					setDisplay(formatMinorInput(parsed, decimals));
			}}
			onChange={(event) => {
				const value = event.target.value;
				setDisplay(value);
				const parsed = parseMajorInput(value, decimals);
				if (parsed !== undefined) onChange(parsed);
			}}
			pattern={pattern}
			prefix={
				symbol ? (
					<span className="px-3 text-muted-foreground text-sm">{symbol}</span>
				) : undefined
			}
			ref={inputRef}
			required={required}
			suffix={currency}
			value={display}
		/>
	);
}

type DurationUnit = "hours" | "days" | "months" | "years";

function DurationField({
	value,
	onChange,
}: {
	value: number | null;
	onChange: (value: number | null) => void;
}) {
	const [unit, setUnit] = useState<DurationUnit>("days");
	const multiplier = durationUnitMultiplier(unit);
	const displayValue = value == null ? "" : value / multiplier;
	return (
		<Input
			inputMode="decimal"
			min={0}
			onChange={(event) => {
				const raw = event.target.value.trim();
				if (!raw) {
					onChange(null);
					return;
				}
				const parsed = Number(raw);
				if (Number.isFinite(parsed) && parsed > 0)
					onChange(Math.round(parsed * multiplier));
			}}
			step="any"
			suffix={
				<ProSelect
					ariaLabel={m.catalog_duration_ms()}
					className="h-full w-24 rounded-none border-0 border-l shadow-none"
					onChange={(next) => {
						if (typeof next !== "string") return;
						setUnit(next as DurationUnit);
					}}
					options={[
						{ label: m.catalog_duration_hours(), value: "hours" },
						{ label: m.catalog_duration_days(), value: "days" },
						{ label: m.catalog_duration_months(), value: "months" },
						{ label: m.catalog_duration_years(), value: "years" },
					]}
					value={unit}
				/>
			}
			type="number"
			value={displayValue}
		/>
	);
}

function durationUnitMultiplier(unit: DurationUnit) {
	if (unit === "hours") return 3_600_000;
	if (unit === "months") return 30 * 86_400_000;
	if (unit === "years") return 365 * 86_400_000;
	return 86_400_000;
}

function updateSellableItem(
	sellableItems: SellableItem[],
	index: number,
	patch: Partial<SellableItem>,
	onChange: (sellableItems: SellableItem[]) => void,
) {
	onChange(
		sellableItems.map((sellableItem, itemIndex) =>
			itemIndex === index ? { ...sellableItem, ...patch } : sellableItem,
		),
	);
}
function deliveryComponentForItem(
	sellableItem: SellableItem,
	components: Component[],
) {
	return components.find(
		(component) => component.id === sellableItem.deliveryComponentId,
	);
}
function updateComponent(
	components: Component[],
	index: number,
	patch: Partial<Component>,
	onChange: (components: Component[]) => void,
) {
	onChange(
		components.map((component, itemIndex) => {
			if (itemIndex !== index) return component;
			const next = { ...component, ...patch };
			if (
				"durationMs" in patch ||
				"usageLimit" in patch ||
				"accessLimit" in patch
			) {
				next.renewalMode =
					next.durationMs != null ||
					next.usageLimit != null ||
					next.accessLimit != null
						? "stack"
						: "disabled";
				if (next.emailMode !== "none")
					next.emailMode = preferredEmailMode(next);
			}
			return next;
		}),
	);
}
function newComponent(type: Component["type"]): Component {
	return {
		id: crypto.randomUUID(),
		type,
		durationMs: null,
		usageLimit: null,
		accessLimit: null,
		renewalMode: "stack",
		emailMode: "none",
		showOnOrderPage: true,
		allowResend: true,
		lowStockThreshold: 5,
		version: 1,
		enabled: true,
	};
}
function defaultSellableItem(
	deliveryComponentId: string,
	currency = "USD",
	currencyDecimals = 2,
): SellableItem {
	return {
		id: crypto.randomUUID(),
		name: m.catalog_sellable_item_default({ number: 1 }),
		listPriceMinor: null,
		priceMinor: "0",
		costMinor: null,
		currency,
		currencyDecimals,
		minimumQuantity: 1,
		maximumQuantity: 1,
		maximumPerCustomer: null,
		reminderCycleDays: null,
		deliveryComponentId,
		enabled: true,
		saleDisabled: false,
		fulfillmentSource: "local",
		supplierStatus: null,
		supplierFallbackEnabled: false,
		supplierBinding: null,
	};
}
function newSellableItem(
	index: number,
	deliveryComponentId: string,
	currency: string,
	currencyDecimals: number,
): SellableItem {
	const item = defaultSellableItem(
		deliveryComponentId,
		currency,
		currencyDecimals,
	);
	return {
		...item,
		name: m.catalog_sellable_item_default({ number: index + 1 }),
	};
}

function uniqueSellableItemCopyName(
	sourceName: string,
	sellableItems: SellableItem[],
) {
	const names = new Set(sellableItems.map((item) => item.name));
	const base = `${sourceName} ${m.common_copy()}`.slice(0, 116).trim();
	if (!names.has(base)) return base;
	for (let number = 2; number <= 100; number += 1) {
		const suffix = ` ${number}`;
		const candidate = `${base.slice(0, 120 - suffix.length)}${suffix}`;
		if (!names.has(candidate)) return candidate;
	}
	return `${sourceName.slice(0, 110)} ${crypto.randomUUID().slice(0, 8)}`;
}

function buildDraftFromDetail(
	detail: Awaited<ReturnType<typeof getBuildConfigurationFn>>,
): ConfigurationDraft {
	if (!detail.configured) return createBuildConfigurationDraft();
	return {
		id: detail.id,
		provider: detail.provider,
		baseUrl: detail.baseUrl,
		repositoryOwner: detail.repositoryOwner,
		repositoryName: detail.repositoryName,
		defaultBranch: detail.defaultBranch,
		workflowFile: detail.workflowFile,
		credential: "",
		enabled: detail.enabled,
		configured: true,
		methods: detail.methods.map((method) => ({
			...method,
			uiId: crypto.randomUUID(),
		})),
		definitions: detail.definitions.map((definition) => ({
			...definition,
			uiId: crypto.randomUUID(),
			options: definition.options.map((option) => ({
				...option,
				uiId: crypto.randomUUID(),
			})),
		})) as ConfigurationDraft["definitions"],
	};
}

function duplicateBuildDraft(draft: ConfigurationDraft): ConfigurationDraft {
	return {
		...structuredClone(draft),
		id: undefined,
		credential: "",
		configured: false,
		methods: draft.methods.map((method) => ({
			...method,
			uiId: crypto.randomUUID(),
		})),
		definitions: draft.definitions.map((definition) => ({
			...definition,
			uiId: crypto.randomUUID(),
			options: definition.options.map((option) => ({
				...option,
				uiId: crypto.randomUUID(),
			})),
		})),
	};
}

function nullableInt(value: string) {
	return value.trim() ? Number(value) : null;
}
function prunePendingRecord<T>(
	current: Record<string, T>,
	keep: (id: string) => boolean,
) {
	const entries = Object.entries(current).filter(([id]) => keep(id));
	return entries.length === Object.keys(current).length
		? current
		: Object.fromEntries(entries);
}
async function uploadPendingDownload(
	productId: string,
	componentId: string,
	file: File,
) {
	const form = new FormData();
	form.set("productId", productId);
	form.set("componentId", componentId);
	form.set("file", file);
	const response = await fetch("/api/admin/download-assets", {
		method: "POST",
		body: form,
		credentials: "same-origin",
	});
	if (!response.ok) throw new Error("download_asset_upload_failed");
}
function isGalleryContentType(
	value: string,
): value is GalleryUpload["contentType"] {
	return [
		"image/avif",
		"image/gif",
		"image/jpeg",
		"image/png",
		"image/webp",
	].includes(value);
}
async function readGalleryUpload(file: File) {
	const preview = await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});
	const dimensions = await readBrowserImageDimensions(preview);
	if (!dimensions) {
		toast.error(m.catalog_cover_image_invalid());
		return null;
	}
	return {
		preview,
		upload: {
			contentType: file.type as GalleryUpload["contentType"],
			base64: preview.slice(preview.indexOf(",") + 1),
		},
	};
}
function entitlementPreset(component: Component) {
	const usesBusinessQuota = component.type === "automation";
	const relevantLimit = usesBusinessQuota
		? component.usageLimit
		: component.accessLimit;
	const irrelevantLimit = usesBusinessQuota
		? component.accessLimit
		: component.usageLimit;
	if (
		component.durationMs == null &&
		relevantLimit == null &&
		irrelevantLimit == null &&
		component.renewalMode === "disabled"
	)
		return "permanent_unlimited";
	if (
		component.durationMs != null &&
		relevantLimit == null &&
		irrelevantLimit == null
	)
		return "time_unlimited";
	if (
		component.durationMs == null &&
		relevantLimit != null &&
		irrelevantLimit == null &&
		component.renewalMode === "stack"
	)
		return component.type === "automation" ? "build_pack" : "permanent_limited";
	if (
		component.durationMs != null &&
		relevantLimit != null &&
		irrelevantLimit == null &&
		component.renewalMode === "stack"
	)
		return "time_limited";
	return "custom";
}
function presetPolicy(
	value: string,
	type: Component["type"],
): Partial<Component> {
	const thirtyDays = 30 * 86_400_000;
	const limited =
		type === "download"
			? { usageLimit: null, accessLimit: 10 }
			: { usageLimit: 10, accessLimit: null };
	if (value === "permanent_unlimited")
		return {
			durationMs: null,
			usageLimit: null,
			accessLimit: null,
			renewalMode: "stack",
		};
	if (value === "time_unlimited")
		return {
			durationMs: thirtyDays,
			usageLimit: null,
			accessLimit: null,
			renewalMode: "stack",
		};
	if (value === "permanent_limited" || value === "build_pack")
		return { durationMs: null, renewalMode: "stack", ...limited };
	if (value === "time_limited")
		return { durationMs: thirtyDays, renewalMode: "stack", ...limited };
	return {};
}
function entitlementPresetOptions(type: Component["type"]) {
	return [
		{
			label: m.catalog_preset_permanent_unlimited(),
			value: "permanent_unlimited",
		},
		{ label: m.catalog_preset_time_unlimited(), value: "time_unlimited" },
		...(type === "stock"
			? []
			: [
					{
						label: m.catalog_preset_permanent_limited(),
						value: "permanent_limited",
					},
					{ label: m.catalog_preset_time_limited(), value: "time_limited" },
				]),
		...(type === "automation"
			? [{ label: m.catalog_preset_automation_pack(), value: "build_pack" }]
			: []),
		{ label: m.catalog_preset_custom(), value: "custom" },
	];
}
function usageLimitLabel(type: Component["type"]) {
	return type === "automation"
		? m.catalog_automation_usage_limit()
		: m.catalog_download_access_limit();
}
function accessLimitLabel(_type: "download") {
	return m.catalog_download_access_limit();
}
function preferredEmailMode(component: Component): Component["emailMode"] {
	const contentSafe =
		component.type === "stock" &&
		component.durationMs == null &&
		component.usageLimit == null &&
		component.accessLimit == null;
	return contentSafe ? "content" : "link";
}
function publishIssueMessage(code: string, fallback: string) {
	const messages: Record<string, () => string> = {
		content_incomplete: m.catalog_publish_issue_content_incomplete,
		no_active_sellable_item: m.catalog_publish_issue_no_active_sellable_item,
		sellable_item_component_missing:
			m.catalog_publish_issue_sellable_item_component_missing,
		stock_out_of_stock: m.catalog_publish_issue_stock_out_of_stock,
		supplier_binding_missing: m.catalog_publish_issue_supplier_binding_missing,
		supplier_unavailable: m.catalog_publish_issue_supplier_unavailable,
		supplier_account_unavailable:
			m.catalog_publish_issue_supplier_account_unavailable,
		download_file_missing: m.catalog_publish_issue_download_file_missing,
		automation_configuration_missing:
			m.catalog_publish_issue_automation_configuration_missing,
	};
	return messages[code]?.() ?? fallback;
}
function supplierFulfillmentStatusLabel(
	status: SellableItem["supplierStatus"],
) {
	if (status === "available") return m.supplier_status_available();
	if (status === "unavailable") return m.supplier_status_unavailable();
	if (status === "sync_error") return m.supplier_filter_sync_error();
	return m.supplier_status_unknown();
}
function showError(error: unknown) {
	toast.error(catalogOperationErrorMessage(error));
}
