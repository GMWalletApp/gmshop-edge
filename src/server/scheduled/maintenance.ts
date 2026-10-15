import { syncExchangeRatesIfDue } from "#/features/exchange-rates/server/sync";
import { runOperationalRetentionCleanup } from "#/features/operations/server/operational-retention";
import { runSupplierMaintenance } from "#/features/suppliers/server/maintenance";
import { cleanupSupportAttachments } from "#/features/telegram/server/web-support-attachments";
import { loadOperationalSettings } from "#/server/operational-settings";
import { loadRuntimeConfig } from "#/server/runtime-config";
import { progressivelyReencryptSecrets } from "#/server/scheduled/secret-rotation";

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
			 AND NOT (namespace='telegram_support_away' AND scope_id=COALESCE((
			  SELECT json_extract(CASE WHEN json_valid(value) THEN value ELSE '{}' END,'$.roundId')
			  FROM system_settings WHERE key='telegram.support.away_mode'
			  AND json_extract(CASE WHEN json_valid(value) THEN value ELSE '{}' END,'$.enabled')=1
			 ),''))
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
	const supportAttachmentsDeleted = await cleanupSupportAttachments(
		env.DB,
		env.FILES,
		now,
	);
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
		expiredCartsDeleted: changes(expiredCarts),
		commerceEventsDeleted: changes(expiredCommerceEvents),
		replayReceiptsDeleted: changes(expiredReplayReceipts),
		authVerificationsDeleted: changes(authVerifications),
		rateLimitsDeleted: changes(expiredRateLimits),
		artifactsDeleted: artifacts,
		supportAttachmentsDeleted,
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
