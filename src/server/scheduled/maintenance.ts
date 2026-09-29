import { syncExchangeRatesIfDue } from "#/features/exchange-rates/server/sync";
import { runOperationalRetentionCleanup } from "#/features/operations/server/operational-retention";
import { runSupplierMaintenance } from "#/features/suppliers/server/maintenance";
import { loadOperationalSettings } from "#/server/operational-settings";
import { loadRuntimeConfig } from "#/server/runtime-config";
import { progressivelyReencryptSecrets } from "#/server/scheduled/secret-rotation";

// Work that has been pending for this long without a live outbox row is
// re-requested; the window also bounds how often one record is re-emitted.
const RECONCILE_WINDOW_MS = 10 * 60_000;

export async function runMaintenance(
	env: Env,
	_cron: string,
	_dependencies?: unknown,
	now = Date.now(),
) {
	const [
		entitlements,
		builds,
		notifications,
		outbox,
		deliveriesReconciled,
		,
		refundsReconciled,
		,
		entitlementSevenDayReminders,
		entitlementOneDayReminders,
		expiredCarts,
		expiredCommerceEvents,
		expiredReplayReceipts,
		authVerifications,
		expiredRateLimits,
	] = await env.DB.batch([
		env.DB.prepare(
			`UPDATE customer_entitlements SET status = 'expired', updated_at = ?
			 WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?`,
		).bind(now, now),
		env.DB.prepare(
			`UPDATE automation_jobs SET status = 'expired', completed_at = ?, updated_at = ?
			 WHERE status IN ('queued','dispatching','running') AND timeout_at <= ?`,
		).bind(now, now, now),
		env.DB.prepare(
			`UPDATE notification_deliveries SET status = 'pending', next_attempt_at = ?,
			 updated_at = ? WHERE status = 'sending' AND updated_at <= ?`,
		).bind(now, now, now - 300_000),
		env.DB.prepare(
			`UPDATE outbox_events SET status = 'pending', next_attempt_at = ?, updated_at = ?
			 WHERE status = 'processing' AND updated_at <= ?`,
		).bind(now, now, now - 300_000),
		// Deliveries still pending long after their request was published lost
		// their queue message (dead-lettered or dropped); re-request them at most
		// once per reconciliation window.
		env.DB.prepare(
			`INSERT INTO outbox_events
			 (id, event_type, aggregate_type, aggregate_id, idempotency_key, payload,
			  status, attempt_count, created_at, updated_at)
			 SELECT lower(hex(randomblob(16))), 'delivery.requested', 'delivery', dr.id,
			  'delivery-reconcile:' || dr.id || ':' || ?,
			  json_object('deliveryId', dr.id, 'orderItemId', dr.order_item_id),
			  'pending', 0, ?, ?
			 FROM delivery_records dr
			 JOIN shop_order_items oi ON oi.id = dr.order_item_id
			 JOIN shop_orders o ON o.id = oi.order_id
			 WHERE dr.status = 'pending' AND dr.updated_at <= ?
			 AND o.status IN ('paid', 'fulfilling')
			 AND NOT EXISTS (SELECT 1 FROM outbox_events oe
			  WHERE oe.aggregate_type = 'delivery' AND oe.aggregate_id = dr.id
			  AND oe.status IN ('pending', 'processing'))
			 ORDER BY dr.updated_at, dr.id LIMIT 100
			 ON CONFLICT(idempotency_key) DO NOTHING`,
		).bind(
			Math.floor(now / RECONCILE_WINDOW_MS),
			now,
			now,
			now - RECONCILE_WINDOW_MS,
		),
		// Re-stamp the re-requested deliveries so they only qualify again after a
		// full window, whatever happens to the outbox row in between.
		env.DB.prepare(
			`UPDATE delivery_records SET updated_at = ? WHERE status = 'pending'
			 AND EXISTS (SELECT 1 FROM outbox_events oe
			  WHERE oe.aggregate_type = 'delivery' AND oe.aggregate_id = delivery_records.id
			  AND oe.idempotency_key = 'delivery-reconcile:' || delivery_records.id || ':' || ?
			  AND oe.created_at = ?)`,
		).bind(now, Math.floor(now / RECONCILE_WINDOW_MS), now),
		env.DB.prepare(
			`INSERT INTO outbox_events
			 (id, event_type, aggregate_type, aggregate_id, idempotency_key, payload,
			  status, attempt_count, created_at, updated_at)
			 SELECT lower(hex(randomblob(16))), 'refund.requested', 'refund', r.id,
			  'refund-reconcile:' || r.id || ':' || ?,
			  json_object('refundId', r.id), 'pending', 0, ?, ?
			 FROM refunds r
			 WHERE r.status IN ('pending', 'processing')
			 AND COALESCE(r.failure_code, '') <> 'manual_action_required'
			 AND r.updated_at <= ?
			 AND (r.next_attempt_at IS NULL OR r.next_attempt_at <= ?)
			 AND NOT EXISTS (SELECT 1 FROM outbox_events oe
			  WHERE oe.aggregate_type = 'refund' AND oe.aggregate_id = r.id
			  AND oe.status IN ('pending', 'processing'))
			 ORDER BY r.updated_at, r.id LIMIT 100
			 ON CONFLICT(idempotency_key) DO NOTHING`,
		).bind(
			Math.floor(now / RECONCILE_WINDOW_MS),
			now,
			now,
			now - RECONCILE_WINDOW_MS,
			now - RECONCILE_WINDOW_MS,
		),
		env.DB.prepare(
			`UPDATE refunds SET updated_at = ? WHERE status IN ('pending', 'processing')
			 AND EXISTS (SELECT 1 FROM outbox_events oe
			  WHERE oe.aggregate_type = 'refund' AND oe.aggregate_id = refunds.id
			  AND oe.idempotency_key = 'refund-reconcile:' || refunds.id || ':' || ?
			  AND oe.created_at = ?)`,
		).bind(now, Math.floor(now / RECONCILE_WINDOW_MS), now),
		env.DB.prepare(
			`INSERT INTO outbox_events
			 (id, event_type, aggregate_type, aggregate_id, idempotency_key, payload,
			  status, attempt_count, created_at, updated_at)
			 SELECT lower(hex(randomblob(16))), 'entitlement.expiring', 'customer_entitlement',
			 ce.id, 'entitlement-expiring-7d:' || ce.id, '{}', 'pending', 0, ?, ?
			 FROM customer_entitlements ce
			 WHERE ce.status = 'active'
			 AND ce.expires_at > ? AND ce.expires_at <= ?
			 AND NOT EXISTS (SELECT 1 FROM outbox_events oe
			  WHERE oe.idempotency_key = 'entitlement-expiring-7d:' || ce.id)
			 LIMIT 200`,
		).bind(now, now, now + 86_400_000, now + 7 * 86_400_000),
		env.DB.prepare(
			`INSERT INTO outbox_events
			 (id, event_type, aggregate_type, aggregate_id, idempotency_key, payload,
			  status, attempt_count, created_at, updated_at)
			 SELECT lower(hex(randomblob(16))), 'entitlement.expiring', 'customer_entitlement',
			 ce.id, 'entitlement-expiring-1d:' || ce.id, '{}', 'pending', 0, ?, ?
			 FROM customer_entitlements ce
			 WHERE ce.status = 'active'
			 AND ce.expires_at > ? AND ce.expires_at <= ?
			 AND NOT EXISTS (SELECT 1 FROM outbox_events oe
			  WHERE oe.idempotency_key = 'entitlement-expiring-1d:' || ce.id)
			 LIMIT 200`,
		).bind(now, now, now, now + 86_400_000),
		env.DB.prepare(
			`DELETE FROM shopping_carts WHERE id IN (
			 SELECT id FROM shopping_carts WHERE expires_at <= ?
			 ORDER BY expires_at, id LIMIT 200)`,
		).bind(now),
		env.DB.prepare(
			`DELETE FROM commerce_events WHERE id IN (
			 SELECT id FROM commerce_events WHERE created_at <= ?
			 ORDER BY created_at, id LIMIT 500)`,
		).bind(now - 90 * 86_400_000),
		env.DB.prepare(
			`DELETE FROM replay_receipts WHERE id IN (
			 SELECT id FROM replay_receipts INDEXED BY replay_receipts_status_created_idx
			 WHERE status IN ('processed', 'rejected', 'failed') AND created_at <= ?
			 ORDER BY status, created_at, id LIMIT 500)`,
		).bind(now - 90 * 86_400_000),
		env.DB.prepare(
			`DELETE FROM verifications WHERE id IN (
			 SELECT id FROM verifications WHERE expires_at <= ?
			 ORDER BY expires_at, id LIMIT 500)`,
		).bind(now),
		env.DB.prepare(
			`DELETE FROM rate_limit_counters WHERE id IN (
			 SELECT id FROM rate_limit_counters INDEXED BY rate_limit_counters_expiry_idx
			 WHERE expires_at <= ? ORDER BY expires_at, id LIMIT 500)`,
		).bind(now),
	]);
	const artifacts = await cleanupExpiredArtifacts(env.DB, env.FILES, now);
	const runtime = await loadRuntimeConfig(env.DB);
	const exchangeRates = await syncExchangeRatesIfDue(
		env.DB,
		runtime.dataEncryptionSecret,
		fetch,
		now,
	);
	const suppliers = await runSupplierMaintenance({
		db: env.DB,
		cache: env.CACHE,
		runtime,
		now,
	});
	const secretsReencrypted = await progressivelyReencryptSecrets(
		env.DB,
		runtime,
	);
	const settings = await loadOperationalSettings(env.DB);
	const retention = await runOperationalRetentionCleanup({
		db: env.DB,
		bucket: env.FILES,
		now,
		retentionMs: settings.retentionAuditMs,
	});
	await env.DB.prepare("PRAGMA optimize").run();
	return {
		entitlementsExpired: changes(entitlements),
		buildsExpired: changes(builds),
		notificationsRecovered: changes(notifications),
		outboxRecovered: changes(outbox),
		deliveriesReconciled: changes(deliveriesReconciled),
		refundsReconciled: changes(refundsReconciled),
		entitlementRemindersQueued:
			changes(entitlementSevenDayReminders) +
			changes(entitlementOneDayReminders),
		expiredCartsDeleted: changes(expiredCarts),
		commerceEventsDeleted: changes(expiredCommerceEvents),
		replayReceiptsDeleted: changes(expiredReplayReceipts),
		authVerificationsDeleted: changes(authVerifications),
		rateLimitsDeleted: changes(expiredRateLimits),
		artifactsDeleted: artifacts,
		exchangeRatesSynced: exchangeRates?.updated ?? 0,
		exchangeRatesSyncFailed: exchangeRates?.failed ?? 0,
		supplierBalancesUpdated: suppliers.balancesUpdated,
		supplierBalancesFailed: suppliers.balancesFailed,
		supplierCatalogsUpdated: suppliers.catalogsUpdated,
		supplierCatalogsSkipped: suppliers.catalogsSkipped,
		supplierCatalogsFailed: suppliers.catalogsFailed,
		secretsReencrypted,
		retentionRows: retention.affectedRows,
	};
}

async function cleanupExpiredArtifacts(
	db: D1Database,
	files: R2Bucket,
	now: number,
) {
	const expired = await db
		.prepare(
			`SELECT id, object_key FROM automation_artifacts WHERE deleted_at IS NULL
			 AND delete_after <= ? ORDER BY delete_after, id LIMIT 100`,
		)
		.bind(now)
		.all<{ id: string; object_key: string }>();
	let deleted = 0;
	for (const artifact of expired.results) {
		await files.delete(artifact.object_key);
		const result = await db
			.prepare(
				`UPDATE automation_artifacts SET download_enabled = 0, deleted_at = ?, updated_at = ?
				 WHERE id = ? AND deleted_at IS NULL`,
			)
			.bind(now, now, artifact.id)
			.run();
		deleted += changes(result);
	}
	return deleted;
}

function changes(result: D1Result<unknown> | undefined) {
	return Number(result?.meta.changes ?? 0);
}
