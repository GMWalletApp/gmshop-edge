import {
	fingerprintInventorySecret,
	maskInventorySecret,
} from "#/features/catalog/server/inventory-secrets";
import {
	OperationTaskAlreadyRunningError,
	runTrackedTask,
} from "#/features/operations/server/task-runs";
import { DomainError } from "#/lib/domain-error";
import { encryptSecret } from "#/lib/secrets";
import { loadRuntimeConfig } from "#/server/runtime-config";
import { multiplyMinor } from "../money";
import { providerRequestNumber } from "../providers/signatures";
import type { SupplierPurchaseResult } from "../schema";
import {
	adapterForSupplierAccount,
	type SupplierAccountRuntimeRow,
} from "./account-runtime";
import { claimSupplierApiBudget } from "./rate-limit";

type SupplierOrderContext = {
	id: string;
	order_item_id: string;
	delivery_record_id: string;
	quantity: number;
	state:
		| "pending"
		| "selecting"
		| "submitting"
		| "uncertain"
		| "supplied"
		| "failed"
		| "refunded";
	selected_account_id: string | null;
	selected_credentials_revision: number | null;
	provider_request_no: string | null;
	upstream_order_id: string | null;
	binding_snapshot_json: string;
};

type BindingSnapshot = {
	provider: "acg" | "dujiao_next" | "gmshop_edge";
	normalizedApiOrigin: string;
	protocolVersion: string;
	upstreamProductId: string;
	upstreamSkuId: string;
	maxCostMinor: string;
};

type CandidateAccount = SupplierAccountRuntimeRow & {
	normalized_api_origin: string;
	protocol_version: string;
	balance_minor: string | null;
	reserve_balance_minor: string;
	max_order_cost_minor: string | null;
	consecutive_failures: number;
	last_selected_at: number | null;
};

export async function processSupplierOrder(
	db: D1Database,
	supplierOrderId: string,
	options: {
		fetcher?: typeof fetch;
		now?: number;
		callbackOrigin?: string;
	} = {},
) {
	return runTrackedTask(
		db,
		{
			task: `supplier.order.${supplierOrderId}`,
			trigger: "scheduled",
			now: options.now,
		},
		() => processSupplierOrderUnlocked(db, supplierOrderId, options),
	);
}

export async function completeSupplierOrderFromCallback(
	db: D1Database,
	supplierOrderId: string,
	result: Extract<SupplierPurchaseResult, { status: "supplied" }>,
) {
	const order = await loadOrder(db, supplierOrderId);
	if (!order)
		throw new DomainError(
			"supplier_order_not_found",
			404,
			"Supplier order not found",
		);
	if (order.state === "supplied")
		return { id: order.id, state: "supplied", duplicate: true };
	if (order.state !== "submitting" && order.state !== "uncertain")
		throw new DomainError(
			"supplier_order_callback_state_invalid",
			409,
			"Supplier order cannot accept this callback",
		);
	const runtime = await loadRuntimeConfig(db);
	if (!runtime.commerceSecret)
		throw new DomainError(
			"supplier_configuration_unavailable",
			503,
			"Supplier configuration unavailable",
		);
	return fulfillSupplierOrder(db, order, result, runtime.commerceSecret);
}

async function processSupplierOrderUnlocked(
	db: D1Database,
	supplierOrderId: string,
	options: { fetcher?: typeof fetch; now?: number; callbackOrigin?: string },
) {
	const order = await loadOrder(db, supplierOrderId);
	if (!order)
		throw new DomainError(
			"supplier_order_not_found",
			404,
			"Supplier order not found",
		);
	if (order.state === "supplied")
		return { id: order.id, state: "supplied", duplicate: true };
	if (order.state === "failed" || order.state === "refunded")
		throw new DomainError(
			"supplier_order_terminal",
			409,
			"Supplier order cannot be processed",
		);
	const runtime = await loadRuntimeConfig(db);
	if (!runtime.commerceSecret)
		throw new DomainError(
			"supplier_configuration_unavailable",
			503,
			"Supplier configuration unavailable",
		);
	const snapshot = parseBindingSnapshot(order.binding_snapshot_json);
	if (order.selected_account_id) {
		const account = await loadSelectedAccount(db, order.selected_account_id);
		if (!account || !order.selected_credentials_revision)
			throw new DomainError(
				"supplier_locked_account_unavailable",
				409,
				"Locked supplier account unavailable",
				{ retryable: true },
			);
		const adapter = await adapterForSupplierAccount(account, runtime, {
			revision: order.selected_credentials_revision,
			fetcher: options.fetcher,
		});
		await claimSupplierApiBudget(db, {
			provider: snapshot.provider,
			normalizedApiOrigin: snapshot.normalizedApiOrigin,
			protocolVersion: snapshot.protocolVersion,
			accountId: account.id,
		});
		const result = await adapter.reconcileOrder({
			upstreamOrderId: order.upstream_order_id,
			skuId: snapshot.upstreamSkuId,
			quantity: order.quantity,
			requestNo: order.provider_request_no ?? "",
			callbackUrl: callbackUrl(options.callbackOrigin, account.id),
			traceId: order.id,
		});
		return applyPurchaseResult(db, order, result, runtime.commerceSecret);
	}

	const now = options.now ?? Date.now();
	await db
		.prepare(
			`UPDATE supplier_orders SET state = 'selecting', updated_at = ?
			 WHERE id = ? AND state = 'pending' AND selected_account_id IS NULL`,
		)
		.bind(now, order.id)
		.run();
	const candidates = await candidateAccounts(db, snapshot, now);
	for (const candidate of candidates) {
		try {
			return await runTrackedTask(
				db,
				{
					task: `supplier.account.${candidate.id}`,
					trigger: "scheduled",
					now,
				},
				async () => {
					await claimSupplierApiBudget(db, {
						provider: snapshot.provider,
						normalizedApiOrigin: snapshot.normalizedApiOrigin,
						protocolVersion: snapshot.protocolVersion,
						accountId: candidate.id,
						now,
					});
					const adapter = await adapterForSupplierAccount(candidate, runtime, {
						fetcher: options.fetcher,
					});
					const [connection, sku] = await Promise.all([
						adapter.testConnection(),
						adapter.getSku(snapshot.upstreamProductId, snapshot.upstreamSkuId),
					]);
					const totalCostMinor = multiplyMinor(sku.costMinor, order.quantity);
					await assertCandidateBudget(
						db,
						candidate,
						connection.balance.amountMinor,
						totalCostMinor,
						sku.stockQuantity,
						order.quantity,
						sku.active,
						sku.costMinor,
						snapshot.maxCostMinor,
					);
					const requestNo = providerRequestNumber(
						snapshot.provider,
						order.id,
						candidate.id,
					);
					const claimed = await db
						.prepare(
							`UPDATE supplier_orders SET selected_account_id = ?,
							 selected_credentials_revision = ?, provider_request_no = ?,
							 quoted_unit_cost_minor = ?, total_cost_minor = ?,
							 state = 'submitting', attempt_count = attempt_count + 1,
							 selection_count = selection_count + 1, submitted_at = ?,
							 next_retry_at = NULL, last_error_code = NULL, updated_at = ?
							 WHERE id = ? AND selected_account_id IS NULL
							 AND state IN ('pending', 'selecting')`,
						)
						.bind(
							candidate.id,
							candidate.credentials_revision,
							requestNo,
							sku.costMinor,
							totalCostMinor,
							now,
							now,
							order.id,
						)
						.run();
					if (Number(claimed.meta.changes) !== 1)
						throw new DomainError(
							"supplier_order_claim_conflict",
							409,
							"Supplier order was claimed concurrently",
							{ retryable: true },
						);
					await db
						.prepare(
							`UPDATE supplier_accounts SET balance_minor = ?,
							 balance_synced_at = ?, health_status = 'healthy',
							 consecutive_failures = 0, last_selected_at = ?,
							 last_error_code = NULL, updated_at = ? WHERE id = ?`,
						)
						.bind(connection.balance.amountMinor, now, now, now, candidate.id)
						.run();
					const result = await adapter.submitOrder({
						skuId: snapshot.upstreamSkuId,
						quantity: order.quantity,
						requestNo,
						callbackUrl: callbackUrl(options.callbackOrigin, candidate.id),
						traceId: order.id,
					});
					return applyPurchaseResult(
						db,
						{
							...order,
							selected_account_id: candidate.id,
							selected_credentials_revision: candidate.credentials_revision,
							provider_request_no: requestNo,
							state: "submitting",
						},
						result,
						runtime.commerceSecret,
					);
				},
			);
		} catch (error) {
			if (error instanceof OperationTaskAlreadyRunningError) continue;
			const current = await loadOrder(db, order.id);
			if (current?.selected_account_id === candidate.id) {
				if (current.state === "uncertain") throw error;
				if (isUncertainError(error)) {
					await markUncertain(db, current, "supplier_request_uncertain");
					throw error;
				}
				await releaseDefinitiveFailure(
					db,
					current,
					candidate.id,
					errorCode(error),
					now,
				);
			}
		}
	}
	await db
		.prepare(
			`UPDATE supplier_orders SET state = 'failed',
			 last_error_code = 'supplier_accounts_exhausted',
			 next_retry_at = NULL, updated_at = ?
			 WHERE id = ? AND selected_account_id IS NULL
			 AND state IN ('pending', 'selecting')`,
		)
		.bind(now, order.id)
		.run();
	throw new DomainError(
		"supplier_accounts_exhausted",
		409,
		"No supplier account can fulfill this order",
	);
}

async function applyPurchaseResult(
	db: D1Database,
	order: SupplierOrderContext,
	result: SupplierPurchaseResult,
	commerceSecret: string,
) {
	if (result.status === "supplied")
		return fulfillSupplierOrder(db, order, result, commerceSecret);
	if (result.status === "processing" || result.status === "uncertain") {
		await db
			.prepare(
				`UPDATE supplier_orders SET state = 'uncertain',
				 upstream_order_id = COALESCE(?, upstream_order_id),
				 account_locked_at = COALESCE(account_locked_at, ?),
				 next_retry_at = ?, last_error_code = ?, updated_at = ?
				 WHERE id = ? AND selected_account_id IS NOT NULL
				 AND state IN ('submitting', 'uncertain')`,
			)
			.bind(
				result.upstreamOrderId,
				Date.now(),
				Date.now() + 15_000,
				result.status === "processing"
					? "supplier_order_processing"
					: result.errorCode,
				Date.now(),
				order.id,
			)
			.run();
		throw new DomainError(
			"supplier_order_pending",
			503,
			"Supplier order is still pending",
		);
	}
	await releaseDefinitiveFailure(
		db,
		order,
		order.selected_account_id ?? "",
		result.errorCode,
		Date.now(),
	);
	throw new DomainError(
		result.errorCode,
		409,
		"Supplier definitively rejected the order",
	);
}

async function fulfillSupplierOrder(
	db: D1Database,
	order: SupplierOrderContext,
	result: Extract<SupplierPurchaseResult, { status: "supplied" }>,
	commerceSecret: string,
) {
	const cards = [...new Set(result.cards.map((value) => value.trim()))].filter(
		Boolean,
	);
	if (cards.length !== order.quantity)
		throw new DomainError(
			"supplier_delivery_quantity_mismatch",
			502,
			"Supplier delivery quantity mismatch",
		);
	const prepared = await Promise.all(
		cards.map(async (card, index) => ({
			id: await deterministicSupplierStockId(order.id, index),
			encrypted: await encryptSecret(card, commerceSecret, "stock-entry"),
			fingerprint: await fingerprintInventorySecret(card, commerceSecret),
			mask: maskInventorySecret(card),
		})),
	);
	const now = Date.now();
	const statements: D1PreparedStatement[] = [
		db
			.prepare(
				`UPDATE supplier_orders SET state = 'supplied',
				 upstream_order_id = ?, supplied_at = ?, next_retry_at = NULL,
				 last_error_code = NULL, updated_at = ?
				 WHERE id = ? AND state IN ('submitting', 'uncertain')`,
			)
			.bind(result.upstreamOrderId, now, now, order.id),
	];
	statements.push(
		...prepared.map((entry) =>
			db
				.prepare(
					`INSERT INTO stock_entries
				 (id, sellable_item_id, content_encrypted, key_version,
				  content_fingerprint, content_mask, status, order_item_id,
				  supplier_order_id, reserved_at, created_at, updated_at)
				 SELECT ?, oi.sellable_item_id, ?, 1, ?, ?, 'reserved', ?,
				  ?, ?, ?, ? FROM shop_order_items oi WHERE oi.id = ?
				 ON CONFLICT(id) DO NOTHING`,
				)
				.bind(
					entry.id,
					entry.encrypted,
					entry.fingerprint,
					entry.mask,
					order.order_item_id,
					order.id,
					now,
					now,
					now,
					order.order_item_id,
				),
		),
		db
			.prepare(
				`UPDATE delivery_records SET status = 'pending',
				 next_attempt_at = ?, error_code = NULL, updated_at = ?
				 WHERE id = ? AND status = 'awaiting_supply'`,
			)
			.bind(now, now, order.delivery_record_id),
		db
			.prepare(
				`INSERT INTO outbox_events
				 (id, event_type, aggregate_type, aggregate_id, idempotency_key,
				  payload, status, attempt_count, created_at, updated_at)
				 VALUES (?, 'delivery.requested', 'delivery', ?, ?, ?, 'pending', 0, ?, ?)
				 ON CONFLICT(idempotency_key) DO NOTHING`,
			)
			.bind(
				crypto.randomUUID(),
				order.delivery_record_id,
				`supplier-delivery-requested:${order.delivery_record_id}`,
				JSON.stringify({
					deliveryId: order.delivery_record_id,
					orderItemId: order.order_item_id,
				}),
				now,
				now,
			),
	);
	const results = await db.batch(statements);
	const duplicate = Number(results[0]?.meta.changes ?? 0) !== 1;
	return { id: order.id, state: "supplied", duplicate };
}

async function deterministicSupplierStockId(orderId: string, index: number) {
	const digest = new Uint8Array(
		await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(`supplier-stock:${orderId}:${index}`),
		),
	).slice(0, 16);
	digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50;
	digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
	const hex = Array.from(digest, (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function candidateAccounts(
	db: D1Database,
	snapshot: BindingSnapshot,
	now: number,
) {
	const rows = await db
		.prepare(
			`SELECT * FROM supplier_accounts WHERE provider = ?
			 AND normalized_api_origin = ? AND protocol_version = ?
			 AND enabled = 1 AND health_status <> 'unavailable'
			 AND (cooldown_until IS NULL OR cooldown_until <= ?)
			 ORDER BY consecutive_failures, COALESCE(last_selected_at, 0),
			 LENGTH(balance_minor) DESC, balance_minor DESC, id LIMIT 20`,
		)
		.bind(
			snapshot.provider,
			snapshot.normalizedApiOrigin,
			snapshot.protocolVersion,
			now,
		)
		.all<CandidateAccount>();
	return rows.results;
}

async function assertCandidateBudget(
	db: D1Database,
	account: CandidateAccount,
	balanceMinor: string,
	totalCostMinor: string,
	stockQuantity: number,
	quantity: number,
	active: boolean,
	unitCostMinor: string,
	maxCostMinor: string,
) {
	const commitments = await db
		.prepare(
			`SELECT total_cost_minor FROM supplier_orders
			 WHERE selected_account_id = ? AND state IN ('submitting', 'uncertain')`,
		)
		.bind(account.id)
		.all<{ total_cost_minor: string }>();
	const committed = commitments.results.reduce(
		(total, row) => total + BigInt(row.total_cost_minor),
		0n,
	);
	const effective =
		BigInt(balanceMinor) - BigInt(account.reserve_balance_minor) - committed;
	if (
		!active ||
		stockQuantity < quantity ||
		BigInt(unitCostMinor) > BigInt(maxCostMinor) ||
		effective < BigInt(totalCostMinor) ||
		(account.max_order_cost_minor !== null &&
			BigInt(totalCostMinor) > BigInt(account.max_order_cost_minor))
	)
		throw new DomainError(
			"supplier_account_ineligible",
			409,
			"Supplier account cannot fulfill this order",
		);
}

async function releaseDefinitiveFailure(
	db: D1Database,
	order: SupplierOrderContext,
	accountId: string,
	code: string,
	now: number,
) {
	await db.batch([
		db
			.prepare(
				`UPDATE supplier_orders SET selected_account_id = NULL,
				 selected_credentials_revision = NULL, provider_request_no = NULL,
				 upstream_order_id = NULL, quoted_unit_cost_minor = NULL,
				 total_cost_minor = NULL, account_locked_at = NULL, state = 'selecting',
				 last_error_code = ?, updated_at = ? WHERE id = ?
				 AND selected_account_id = ? AND account_locked_at IS NULL`,
			)
			.bind(code, now, order.id, accountId),
		db
			.prepare(
				`UPDATE supplier_accounts SET health_status = 'degraded',
				 consecutive_failures = consecutive_failures + 1,
				 cooldown_until = ?, last_error_code = ?, last_error_at = ?,
				 updated_at = ? WHERE id = ?`,
			)
			.bind(now + 60_000, code, now, now, accountId),
	]);
}

async function markUncertain(
	db: D1Database,
	order: SupplierOrderContext,
	code: string,
) {
	const now = Date.now();
	await db
		.prepare(
			`UPDATE supplier_orders SET state = 'uncertain',
			 account_locked_at = COALESCE(account_locked_at, ?),
			 next_retry_at = ?, last_error_code = ?, updated_at = ?
			 WHERE id = ? AND selected_account_id IS NOT NULL`,
		)
		.bind(now, now + 15_000, code, now, order.id)
		.run();
}

function loadOrder(db: D1Database, id: string) {
	return db
		.prepare("SELECT * FROM supplier_orders WHERE id = ? LIMIT 1")
		.bind(id)
		.first<SupplierOrderContext>();
}

function loadSelectedAccount(db: D1Database, id: string) {
	return db
		.prepare("SELECT * FROM supplier_accounts WHERE id = ? LIMIT 1")
		.bind(id)
		.first<CandidateAccount>();
}

function parseBindingSnapshot(value: string): BindingSnapshot {
	const parsed = JSON.parse(value) as Partial<BindingSnapshot>;
	if (
		!(["acg", "dujiao_next", "gmshop_edge"] as const).includes(
			parsed.provider as "acg" | "dujiao_next" | "gmshop_edge",
		) ||
		!parsed.normalizedApiOrigin ||
		!parsed.protocolVersion ||
		!parsed.upstreamProductId ||
		!parsed.upstreamSkuId ||
		!parsed.maxCostMinor
	)
		throw new DomainError(
			"supplier_binding_snapshot_invalid",
			500,
			"Supplier binding snapshot invalid",
		);
	return parsed as BindingSnapshot;
}

function callbackUrl(origin: string | undefined, accountId: string) {
	return origin
		? new URL(
				`/api/suppliers/dujiao-next/callback/${encodeURIComponent(accountId)}`,
				origin,
			).toString()
		: "";
}

function isUncertainError(error: unknown) {
	return (
		error instanceof DomainError && error.code === "supplier_request_uncertain"
	);
}

function errorCode(error: unknown) {
	return error instanceof DomainError ? error.code : "supplier_request_failed";
}
