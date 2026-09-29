import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireAdmin } from "#/features/access/server/require-admin";
import { systemPermission } from "#/features/access/system-rbac";
import { sensitiveProofSchema } from "#/features/auth/reauthentication-schema";
import { verifySensitiveAdminAction } from "#/features/auth/server/reauthenticate";
import { decryptDeliveryContent } from "#/features/fulfillment/secrets";
import { publishPendingDeliveries } from "#/features/fulfillment/server/outbox";
import { DomainError } from "#/lib/domain-error";
import { clientIp } from "#/server/client-ip";
import { getCloudflareEnv } from "#/server/db.server";
import { loadRequestRuntimeConfig } from "#/server/runtime-config";

const deliveryStatuses = [
	"awaiting_supply",
	"pending",
	"processing",
	"delivered",
	"failed",
] as const;

const listInput = z.object({
	pageIndex: z.number().int().min(0).default(0),
	pageSize: z.number().int().min(1).max(100).default(20),
	search: z.string().trim().max(120).default(""),
	status: z.enum(deliveryStatuses).optional(),
});

const idInput = z.object({ id: z.uuid() });
const revealInput = sensitiveProofSchema.extend({ id: z.uuid() });

export const listDeliveriesFn = createServerFn({ method: "GET" })
	.validator((input: z.input<typeof listInput>) => listInput.parse(input))
	.handler(async ({ data }) => {
		const context = await deliveryContext("read");
		return queryDeliveryRecords(context.db, data);
	});

export async function queryDeliveryRecords(
	db: D1Database,
	data: z.infer<typeof listInput>,
) {
	const filters: string[] = [];
	const bindings: Array<string | number> = [];
	if (data.search) {
		const pattern = `%${data.search}%`;
		filters.push(
			"(o.order_number LIKE ? OR i.product_name LIKE ? OR i.sellable_item_name LIKE ?)",
		);
		bindings.push(pattern, pattern, pattern);
	}
	if (data.status) {
		filters.push("d.status = ?");
		bindings.push(data.status);
	}
	const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
	const [count, rows] = await db.batch([
		db
			.prepare(
				`SELECT COUNT(*) AS total FROM delivery_records d
				 JOIN shop_order_items i ON i.id = d.order_item_id
				 JOIN shop_orders o ON o.id = i.order_id ${where}`,
			)
			.bind(...bindings),
		db
			.prepare(
				`SELECT d.id, d.delivery_type, d.status, i.quantity, d.attempt_count,
				 d.error_code, d.content_encrypted IS NOT NULL AS has_content,
				 d.delivered_at, d.created_at, d.updated_at, o.order_number,
				 i.product_name, i.sellable_item_name,
				 i.input_values_json, i.sensitive_input_values_json,
				 COALESCE((SELECT version.schema_json FROM product_definition_versions version
				  WHERE version.id = i.definition_version_id), '[]') AS definition_schema_json
				 FROM delivery_records d
				 JOIN shop_order_items i ON i.id = d.order_item_id
				 JOIN shop_orders o ON o.id = i.order_id
				 ${where}
				 ORDER BY CASE d.status WHEN 'failed' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
				 d.updated_at DESC, d.id DESC LIMIT ? OFFSET ?`,
			)
			.bind(...bindings, data.pageSize, data.pageIndex * data.pageSize),
	]);
	const countResult = count as D1Result<{ total: number }> | undefined;
	const rowResult = rows as D1Result<Record<string, unknown>> | undefined;
	return {
		data: (rowResult?.results ?? []).map((row) => ({
			id: String(row.id),
			deliveryType: String(row.delivery_type) as
				| "stock"
				| "download"
				| "automation",
			status: String(row.status) as (typeof deliveryStatuses)[number],
			quantity: Number(row.quantity),
			attemptCount: Number(row.attempt_count),
			errorCode: row.error_code ? String(row.error_code) : null,
			hasContent: Boolean(row.has_content),
			deliveredAt: row.delivered_at ? Number(row.delivered_at) : null,
			createdAt: Number(row.created_at),
			updatedAt: Number(row.updated_at),
			orderNumber: String(row.order_number),
			productName: String(row.product_name),
			sellableItemName: String(row.sellable_item_name),
			inputs: presentOrderInputs(row),
		})),
		total: Number(countResult?.results[0]?.total ?? 0),
	};
}

function presentOrderInputs(row: Record<string, unknown>) {
	const values = parseObject(String(row.input_values_json));
	const sensitive = parseObject(String(row.sensitive_input_values_json));
	const definitions = parseDefinitions(String(row.definition_schema_json));
	const names = new Map(
		definitions.map((definition) => [definition.key, definition.name]),
	);
	return [
		...Object.entries(values).map(([key, value]) => ({
			key,
			name: names.get(key) ?? key,
			value: typeof value === "string" ? value : String(value),
			sensitive: false,
		})),
		...Object.keys(sensitive).map((key) => ({
			key,
			name: names.get(key) ?? key,
			value: "••••••",
			sensitive: true,
		})),
	];
}

function parseObject(value: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(value);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
			return parsed as Record<string, unknown>;
	} catch {
		// Corrupt snapshots fail closed.
	}
	return {};
}

function parseDefinitions(value: string): Array<{ key: string; name: string }> {
	try {
		const parsed: unknown = JSON.parse(value);
		if (Array.isArray(parsed))
			return parsed.filter(
				(item): item is { key: string; name: string } =>
					item != null &&
					typeof item === "object" &&
					typeof (item as { key?: unknown }).key === "string" &&
					typeof (item as { name?: unknown }).name === "string",
			);
	} catch {
		// Corrupt snapshots fail closed.
	}
	return [];
}

export const retryDeliveryFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof idInput>) => idInput.parse(input))
	.handler(async ({ data }) => {
		const context = await deliveryContext("update");
		const delivery = await context.db
			.prepare(
				"SELECT id, order_item_id, status, attempt_count FROM delivery_records WHERE id = ? LIMIT 1",
			)
			.bind(data.id)
			.first<{
				id: string;
				order_item_id: string;
				status: string;
				attempt_count: number;
			}>();
		if (!delivery)
			throw new DomainError("delivery_not_found", 404, "Delivery not found");
		if (delivery.status !== "failed")
			throw new DomainError(
				"delivery_not_retryable",
				409,
				"Only failed deliveries can be retried",
			);
		const now = Date.now();
		await context.db.batch([
			context.db
				.prepare(
					`UPDATE delivery_records SET status = 'pending', error_code = NULL,
					 next_attempt_at = ?, updated_at = ? WHERE id = ? AND status = 'failed'`,
				)
				.bind(now, now, data.id),
			context.db
				.prepare(
					`INSERT INTO outbox_events
					 (id, event_type, aggregate_type, aggregate_id, idempotency_key, payload,
					  status, attempt_count, next_attempt_at, created_at, updated_at)
					 VALUES (?, 'delivery.requested', 'delivery', ?, ?, ?, 'pending', 0, ?, ?, ?)`,
				)
				.bind(
					crypto.randomUUID(),
					data.id,
					`delivery-retry:${data.id}:${delivery.attempt_count}`,
					JSON.stringify({
						deliveryId: data.id,
						orderItemId: delivery.order_item_id,
					}),
					now,
					now,
					now,
				),
			auditStatement(
				context,
				"delivery.retried",
				data.id,
				{
					attemptCount: delivery.attempt_count,
				},
				now,
			),
		]);
		if (context.env.COMMERCE_QUEUE)
			await publishPendingDeliveries(context.db, context.env.COMMERCE_QUEUE, 1);
		return { id: data.id, status: "pending" as const };
	});

export const revealDeliveryContentFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof revealInput>) => revealInput.parse(input))
	.handler(async ({ data }) => {
		const context = await deliveryContext("update");
		await verifySensitiveAdminAction(context.request, context.user.id, data);
		const row = await context.db
			.prepare(
				`SELECT content_encrypted FROM delivery_records
				 WHERE id = ? AND status = 'delivered' LIMIT 1`,
			)
			.bind(data.id)
			.first<{ content_encrypted: string | null }>();
		if (!row?.content_encrypted)
			throw new DomainError(
				"delivery_content_unavailable",
				404,
				"Delivery content is unavailable",
			);
		const runtime = await loadRequestRuntimeConfig(
			context.request,
			context.db,
			new URL(context.request.url).origin,
		);
		const content = await decryptDeliveryContent(
			row.content_encrypted,
			runtime.commerceSecret,
		);
		const now = Date.now();
		await context.db.batch([
			auditStatement(context, "delivery.content_revealed", data.id, null, now),
		]);
		return { id: data.id, content };
	});

async function deliveryContext(permission: "read" | "update") {
	const request = getRequest();
	const user = await requireAdmin(
		request,
		systemPermission("delivery", permission),
	);
	const env = getCloudflareEnv(request);
	if (!env.DB) throw new Error("D1 binding DB is unavailable");
	return { request, user, env, db: env.DB };
}

function auditStatement(
	context: Awaited<ReturnType<typeof deliveryContext>>,
	action: string,
	targetId: string,
	after: unknown,
	now: number,
) {
	return context.db
		.prepare(
			`INSERT INTO audit_logs
			 (id, actor_user_id, action, target_type, target_id, request_id,
			  ip_address, after, created_at)
			 VALUES (?, ?, ?, 'delivery', ?, ?, ?, ?, ?)`,
		)
		.bind(
			crypto.randomUUID(),
			context.user.id,
			action,
			targetId,
			context.request.headers.get("x-request-id"),
			clientIp(context.request),
			after == null ? null : JSON.stringify(after),
			now,
		);
}
