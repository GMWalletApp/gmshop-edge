import { buildDefinitionListSchema } from "#/features/builds/schema";
import { paymentCheckoutPresentation } from "#/features/shop-payments/providers";
import { storeOrderLookupSchema } from "#/features/storefront/schema";
import { DomainError } from "#/lib/domain-error";
import { clientIp } from "#/server/client-ip";
import {
	claimFixedWindowRateLimit,
	peekFixedWindowRateLimit,
} from "#/server/rate-limit";

const GUEST_LOOKUP_WINDOW_MS = 60_000;
const GUEST_FAILURES_PER_CLIENT = 40;
const GUEST_FAILURES_PER_ORDER = 15;

/**
 * Guest access proves ownership with order number + e-mail. Only failed proofs
 * count against the requesting client and the targeted order number, so the
 * e-mail cannot be enumerated for a leaked order number while a legitimate
 * guest polling their own order page never consumes a budget.
 */
function guestLookupBuckets(request: Request | undefined, orderNumber: string) {
	const ip = clientIp(request);
	return [
		{
			bucketKey: `store-lookup:order:${orderNumber}`,
			limit: GUEST_FAILURES_PER_ORDER,
			windowMs: GUEST_LOOKUP_WINDOW_MS,
		},
		...(ip
			? [
					{
						bucketKey: `store-lookup:ip:${ip}`,
						limit: GUEST_FAILURES_PER_CLIENT,
						windowMs: GUEST_LOOKUP_WINDOW_MS,
					},
				]
			: []),
	];
}

export async function assertGuestOrderLookupAllowed(
	db: D1Database,
	request: Request | undefined,
	orderNumber: string,
) {
	const peeks = await Promise.all(
		guestLookupBuckets(request, orderNumber).map((bucket) =>
			peekFixedWindowRateLimit(db, bucket),
		),
	);
	if (peeks.some((peek) => peek.exhausted)) throw lookupRateLimited();
}

export async function recordGuestOrderLookupFailure(
	db: D1Database,
	request: Request | undefined,
	orderNumber: string,
) {
	await Promise.all(
		guestLookupBuckets(request, orderNumber).map((bucket) =>
			claimFixedWindowRateLimit(db, bucket),
		),
	);
}

function lookupRateLimited() {
	return new DomainError(
		"order_lookup_rate_limited",
		429,
		"Too many order lookups; try again later",
	);
}

export async function getStoreOrder(
	db: D1Database,
	rawInput: unknown,
	access: { userId?: string; request?: Request } = {},
) {
	const orderNumber = storeOrderLookupSchema.shape.orderNumber.parse(
		(rawInput as { orderNumber?: unknown })?.orderNumber,
	);
	const guestEmail = access.userId
		? null
		: storeOrderLookupSchema.shape.email.parse(
				(rawInput as { email?: unknown })?.email,
			);
	if (guestEmail)
		await assertGuestOrderLookupAllowed(db, access.request, orderNumber);
	const orderSelection = `SELECT id, order_number, user_id, status, contact_email, normalized_contact_email, currency,
			 currency_decimals, subtotal_minor, discount_minor, total_minor, paid_minor,
			 expires_at, paid_at, completed_at, cancelled_at, refunded_at, created_at,
			 updated_at FROM shop_orders`;
	const order = guestEmail
		? await db
				.prepare(
					`${orderSelection}
					 WHERE order_number = ? AND normalized_contact_email = ? LIMIT 1`,
				)
				.bind(orderNumber, guestEmail)
				.first<Record<string, unknown>>()
		: await db
				.prepare(`${orderSelection} WHERE order_number = ? LIMIT 1`)
				.bind(orderNumber)
				.first<Record<string, unknown>>();
	if (!order) {
		if (guestEmail)
			await recordGuestOrderLookupFailure(db, access.request, orderNumber);
		throw new DomainError("order_not_found", 404, "Order not found");
	}
	if (access.userId) {
		if (String(order.user_id) !== access.userId)
			throw new DomainError("order_not_found", 404, "Order not found");
	}
	const [
		items,
		payments,
		deliveries,
		events,
		downloads,
		buildEntitlements,
		buildFields,
		buildMethods,
		automationJobs,
		automationArtifacts,
		afterSales,
		emailNotificationAvailability,
	] = await db.batch([
		db
			.prepare(
				`SELECT oi.id, oi.product_id, oi.product_name, oi.delivery_component_type,
				 oi.sellable_item_name, oi.quantity, oi.unit_price_minor, oi.discount_minor,
				 oi.subtotal_minor, product.cover_object_key, product.updated_at AS product_updated_at
				 FROM shop_order_items oi
				 LEFT JOIN products product ON product.id = oi.product_id
				 WHERE oi.order_id = ? ORDER BY oi.created_at, oi.id`,
			)
			.bind(order.id),
		db
			.prepare(
				`SELECT pa.id, pa.status, pa.amount_minor, pa.currency,
				 pa.currency_decimals, pa.exchange_rate, pa.exchange_rate_direction,
				 pa.exchange_rate_source, pa.exchange_rate_observed_at,
				 pa.checkout_url, pa.provider_expires_at, pa.succeeded_at,
				 pa.failure_code, pc.name AS channel_name, pc.provider
				 FROM payment_attempts pa JOIN payment_channels pc ON pc.id = pa.channel_id
				 WHERE pa.order_id = ? ORDER BY pa.created_at DESC, pa.id DESC`,
			)
			.bind(order.id),
		db
			.prepare(
				`SELECT dr.id, grant_row.entitlement_id, dr.delivery_type, dr.status,
				 dr.error_code, dr.delivered_at,
				 dr.content_encrypted IS NOT NULL AS has_content,
				 oi.show_on_order_page, oi.product_name, oi.sellable_item_name
				 FROM delivery_records dr
				 JOIN shop_order_items oi ON oi.id = dr.order_item_id
				 LEFT JOIN entitlement_grants grant_row
				  ON grant_row.source_order_item_id = oi.id
				 WHERE oi.order_id = ? ORDER BY dr.created_at, dr.id`,
			)
			.bind(order.id),
		db
			.prepare(
				"SELECT id, event_type, from_status, to_status, note, created_at FROM shop_order_events WHERE order_id = ? AND visibility = 'customer' ORDER BY created_at DESC, id DESC",
			)
			.bind(order.id),
		db
			.prepare(
				`SELECT snapshot.download_asset_id AS id, ce.id AS entitlement_id,
				 snapshot.asset_version, snapshot.file_name,
				 snapshot.content_type, snapshot.size_bytes, snapshot.checksum_sha256,
				 oi.product_name, oi.sellable_item_name,
				 ce.access_limit, ce.access_count
				 FROM shop_order_items oi
				 JOIN delivery_records dr ON dr.order_item_id = oi.id
				 JOIN entitlement_grants grant_row ON grant_row.source_order_item_id = oi.id
				 JOIN customer_entitlements ce ON ce.id = grant_row.entitlement_id
				 JOIN order_item_download_assets snapshot ON snapshot.order_item_id = oi.id
				 WHERE oi.order_id = ? AND dr.status = 'delivered'
				 AND ce.entitlement_type = 'download'
				 AND ce.status IN ('active', 'exhausted')
				 AND (ce.expires_at IS NULL OR ce.expires_at > ?)
				 ORDER BY snapshot.created_at, snapshot.id`,
			)
			.bind(order.id, Date.now()),
		db
			.prepare(
				`SELECT ce.id, ce.status, ce.usage_limit, ce.usage_count, ce.expires_at,
				 ce.definition_version_id, oi.product_name, oi.sellable_item_name
				 FROM customer_entitlements ce JOIN shop_order_items oi ON oi.id = ce.order_item_id
				 WHERE oi.order_id = ? AND ce.entitlement_type = 'automation'
				 ORDER BY ce.created_at, ce.id`,
			)
			.bind(order.id),
		db
			.prepare(
				`SELECT ce.id AS entitlement_id, version.id AS version_id,
				 version.schema_json,
				 COALESCE((SELECT json_group_object(value.definition_key, value.masked_value)
				  FROM entitlement_authorization_values value
				  WHERE value.entitlement_id = ce.id), '{}') AS masks_json
				 FROM customer_entitlements ce JOIN shop_order_items oi ON oi.id = ce.order_item_id
				 JOIN product_sellable_items item ON item.id = ce.sellable_item_id
				  AND item.product_id = ce.product_id
				 JOIN product_definition_versions version
				  ON version.id = item.active_definition_version_id
				 WHERE oi.order_id = ? AND ce.entitlement_type = 'automation'
				 ORDER BY ce.created_at, ce.id`,
			)
			.bind(order.id),
		db
			.prepare(
				`SELECT ce.id AS entitlement_id, bm.id, bm.key, bm.name, bm.description,
				 bm.runtime FROM customer_entitlements ce
				 JOIN shop_order_items oi ON oi.id = ce.order_item_id
				 JOIN product_sellable_items item ON item.id = ce.sellable_item_id
				  AND item.product_id = ce.product_id AND item.enabled = 1
				 JOIN product_automation_methods bm ON bm.sellable_item_id = item.id
				  AND bm.config_version = item.version AND bm.enabled = 1
				 WHERE oi.order_id = ? AND ce.entitlement_type = 'automation'
				 ORDER BY bm.sort_order, bm.id`,
			)
			.bind(order.id),
		db
			.prepare(
				`SELECT bj.id, bj.entitlement_id, bj.status, bj.method_key, bj.runtime,
				 bj.attempt_count, bj.timeout_at, bj.started_at, bj.completed_at,
				 bj.run_url, bj.failure_code, bj.notification_channel, bj.created_at
				 FROM automation_jobs bj
				 JOIN shop_order_items oi ON oi.id = bj.order_item_id WHERE oi.order_id = ?
				 ORDER BY bj.created_at DESC, bj.id DESC LIMIT 100`,
			)
			.bind(order.id),
		db
			.prepare(
				`SELECT ba.id, ba.automation_job_id, ba.file_name, ba.content_type, ba.size_bytes,
				 ba.checksum_sha256, ba.download_count, ba.delete_after
				 FROM automation_artifacts ba JOIN automation_jobs bj ON bj.id = ba.automation_job_id
				 JOIN shop_order_items oi ON oi.id = bj.order_item_id
				 WHERE oi.order_id = ? AND ba.download_enabled = 1 AND ba.deleted_at IS NULL
				 AND ba.delete_after > ? ORDER BY ba.created_at, ba.id`,
			)
			.bind(order.id, Date.now()),
		db
			.prepare(
				`SELECT id, case_number, type, status, reason, resolution, created_at,
				 updated_at FROM after_sale_cases WHERE order_id = ?
				 ORDER BY created_at DESC, id DESC`,
			)
			.bind(order.id),
		db.prepare(
			`SELECT 1 AS available FROM notification_channel_configs
			 WHERE channel = 'email' AND enabled = 1 LIMIT 1`,
		),
	]);
	return {
		id: String(order.id),
		orderNumber: String(order.order_number),
		status: String(order.status),
		contactEmail:
			order.contact_email == null
				? null
				: maskEmail(String(order.contact_email)),
		currency: String(order.currency),
		currencyDecimals: Number(order.currency_decimals),
		subtotalMinor: String(order.subtotal_minor),
		discountMinor: String(order.discount_minor),
		totalMinor: String(order.total_minor),
		paidMinor: String(order.paid_minor),
		expiresAt: Number(order.expires_at),
		paidAt: nullableNumber(order.paid_at),
		completedAt: nullableNumber(order.completed_at),
		cancelledAt: nullableNumber(order.cancelled_at),
		refundedAt: nullableNumber(order.refunded_at),
		createdAt: Number(order.created_at),
		updatedAt: Number(order.updated_at),
		items: rows(items).map(presentItem),
		payments: rows(payments).map(presentPayment),
		deliveries: rows(deliveries).map(presentDelivery),
		events: rows(events).map(presentEvent),
		downloads: rows(downloads).map(presentDownload),
		automationRuns: presentBuildEntitlements(
			rows(buildEntitlements),
			rows(buildFields),
			rows(buildMethods),
			rows(automationJobs),
			rows(automationArtifacts),
		),
		automationNotificationChannels: {
			email:
				Boolean(order.normalized_contact_email) &&
				rows(emailNotificationAvailability).some(
					(row) => Number(row.available) === 1,
				),
		},
		afterSales: rows(afterSales).map((row) => ({
			id: String(row.id),
			caseNumber: String(row.case_number),
			type: String(row.type),
			status: String(row.status),
			reason: String(row.reason),
			resolution: row.resolution == null ? null : String(row.resolution),
			createdAt: Number(row.created_at),
			updatedAt: Number(row.updated_at),
		})),
	};
}

function rows(result: D1Result<unknown> | undefined) {
	return (result?.results ?? []) as Record<string, unknown>[];
}
function nullableNumber(value: unknown) {
	return value == null ? null : Number(value);
}
function maskEmail(email: string) {
	const [name = "", domain = ""] = email.split("@", 2);
	return `${name.slice(0, 2)}${name.length > 2 ? "***" : ""}@${domain}`;
}
function presentItem(row: Record<string, unknown>) {
	return {
		id: String(row.id),
		productId: String(row.product_id),
		productName: String(row.product_name),
		deliveryType: String(row.delivery_component_type),
		sellableItemName: String(row.sellable_item_name),
		quantity: Number(row.quantity),
		unitPriceMinor: String(row.unit_price_minor),
		discountMinor: String(row.discount_minor),
		subtotalMinor: String(row.subtotal_minor),
		coverUrl: row.cover_object_key
			? `/api/shop/products/${row.product_id}/cover?v=${row.product_updated_at}`
			: null,
	};
}
function presentPayment(row: Record<string, unknown>) {
	return {
		id: String(row.id),
		status: String(row.status),
		amountMinor: String(row.amount_minor),
		currency: String(row.currency),
		currencyDecimals: Number(row.currency_decimals),
		exchangeRate: String(row.exchange_rate),
		exchangeRateDirection: String(row.exchange_rate_direction),
		exchangeRateSource: String(row.exchange_rate_source),
		exchangeRateObservedAt: Number(row.exchange_rate_observed_at),
		checkoutUrl: row.checkout_url == null ? null : String(row.checkout_url),
		providerExpiresAt: nullableNumber(row.provider_expires_at),
		succeededAt: nullableNumber(row.succeeded_at),
		failureCode: row.failure_code == null ? null : String(row.failure_code),
		channelName: String(row.channel_name),
		provider: String(row.provider),
		checkoutPresentation: paymentCheckoutPresentation(
			String(row.provider),
			row.checkout_url == null ? null : String(row.checkout_url),
		),
	};
}
function presentDelivery(row: Record<string, unknown>) {
	return {
		id: String(row.id),
		entitlementId:
			row.entitlement_id == null ? null : String(row.entitlement_id),
		type: String(row.delivery_type),
		status: String(row.status),
		errorCode: row.error_code == null ? null : String(row.error_code),
		deliveredAt: nullableNumber(row.delivered_at),
		hasContent: Boolean(row.has_content),
		showOnOrderPage: Boolean(row.show_on_order_page),
		productName: String(row.product_name),
		sellableItemName: String(row.sellable_item_name),
	};
}
function presentEvent(row: Record<string, unknown>) {
	return {
		id: String(row.id),
		type: String(row.event_type),
		fromStatus: row.from_status == null ? null : String(row.from_status),
		toStatus: row.to_status == null ? null : String(row.to_status),
		note: row.note == null ? null : String(row.note),
		createdAt: Number(row.created_at),
	};
}
function presentDownload(row: Record<string, unknown>) {
	return {
		id: String(row.id),
		entitlementId: String(row.entitlement_id),
		version: Number(row.asset_version),
		fileName: String(row.file_name),
		contentType: String(row.content_type),
		sizeBytes: Number(row.size_bytes),
		checksumSha256: String(row.checksum_sha256),
		productName: String(row.product_name),
		sellableItemName: String(row.sellable_item_name),
		accessLimit: row.access_limit == null ? null : Number(row.access_limit),
		accessCount: Number(row.access_count),
	};
}

function presentBuildEntitlements(
	entitlements: Record<string, unknown>[],
	fields: Record<string, unknown>[],
	methods: Record<string, unknown>[],
	jobs: Record<string, unknown>[],
	artifacts: Record<string, unknown>[],
) {
	return entitlements.map((entitlement) => ({
		id: String(entitlement.id),
		status: String(entitlement.status),
		productName: String(entitlement.product_name),
		sellableItemName: String(entitlement.sellable_item_name),
		usageLimit:
			entitlement.usage_limit == null ? null : Number(entitlement.usage_limit),
		usageCount: Number(entitlement.usage_count),
		expiresAt:
			entitlement.expires_at == null ? null : Number(entitlement.expires_at),
		definitions: presentDefinitions(
			fields.find((field) => field.entitlement_id === entitlement.id),
		),
		methods: methods
			.filter((method) => method.entitlement_id === entitlement.id)
			.map((method) => ({
				id: String(method.id),
				key: String(method.key),
				name: String(method.name),
				description:
					method.description == null ? null : String(method.description),
				runtime: String(method.runtime),
			})),
		jobs: jobs
			.filter((job) => job.entitlement_id === entitlement.id)
			.map((job) => ({
				id: String(job.id),
				status: String(job.status),
				methodKey: String(job.method_key),
				runtime: String(job.runtime),
				attemptCount: Number(job.attempt_count),
				timeoutAt: Number(job.timeout_at),
				startedAt: nullableNumber(job.started_at),
				completedAt: nullableNumber(job.completed_at),
				runUrl: job.run_url == null ? null : String(job.run_url),
				failureCode: job.failure_code == null ? null : String(job.failure_code),
				notificationChannel: String(job.notification_channel),
				createdAt: Number(job.created_at),
				artifacts: artifacts
					.filter((artifact) => artifact.automation_job_id === job.id)
					.map((artifact) => ({
						id: String(artifact.id),
						fileName: String(artifact.file_name),
						contentType: String(artifact.content_type),
						sizeBytes: Number(artifact.size_bytes),
						checksumSha256: String(artifact.checksum_sha256),
						downloadCount: Number(artifact.download_count),
						deleteAfter: Number(artifact.delete_after),
					})),
			})),
	}));
}

function presentDefinitions(row: Record<string, unknown> | undefined) {
	if (!row) return [];
	let rawDefinitions: unknown;
	try {
		rawDefinitions = JSON.parse(String(row.schema_json));
	} catch {
		rawDefinitions = null;
	}
	const parsedDefinitions = buildDefinitionListSchema.safeParse(rawDefinitions);
	const definitions = parsedDefinitions.success ? parsedDefinitions.data : [];
	const masks = parseJsonObject(String(row.masks_json));
	return definitions.map((definition) => ({
		key: definition.key,
		name: definition.name,
		description: definition.description || null,
		inputType: definition.inputType,
		scope: definition.scope,
		required: definition.required,
		sensitive: definition.sensitive,
		defaultValue: definition.defaultValue || null,
		exampleValue: definition.exampleValue || null,
		maskedValue:
			typeof masks[definition.key] === "string"
				? String(masks[definition.key])
				: null,
		options: definition.options,
	}));
}

function parseJsonObject(value: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}
