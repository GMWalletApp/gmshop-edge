import { reconcileAgentAccess } from "#/features/agent-access/server/fulfillment";
import { publishAuthSecurityAlert } from "#/features/auth/server/security-alerts";
import { publishPendingBuilds } from "#/features/builds/server/outbox";
import { publishPendingDeliveries } from "#/features/fulfillment/server/outbox";
import { publishPendingNotifications } from "#/features/notifications/server/delivery";
import { fanOutPendingCommerceNotifications } from "#/features/notifications/server/fanout";
import { publishPendingOwnerSaleAlerts } from "#/features/notifications/server/owner-sale-alerts";
import { runBalanceGuard } from "#/features/ops-automation/server/balance-guard";
import { runPricingGuard } from "#/features/ops-automation/server/pricing-guard";
import { runWeeklyReport } from "#/features/ops-automation/server/weekly-report";
import { settlePromotionRewards } from "#/features/promotions/server/balance";
import { runRedemptionExceptionTodos } from "#/features/redeem-warehouse/server/exception-todos";
import { runRenewalReminders } from "#/features/renewals/server/scheduler";
import { expireStoreOrders } from "#/features/shop-orders/server/expiration";
import { publishPendingRefunds } from "#/features/shop-payments/server/refunds";
import { reconcilePendingShopPayments } from "#/features/shop-payments/server/service";
import { publishPendingInventoryEvents } from "#/features/supplier-api/server/inventory-events";
import { publishPendingSupplierOrders } from "#/features/suppliers/server/outbox";
import { runTelegramMaintenance } from "#/features/telegram/server/maintenance";
import { runMaintenance } from "#/server/scheduled/maintenance";

export { runMaintenance };

export function handleScheduled(
	controller: ScheduledController,
	env: Env,
	context: ExecutionContext,
): void {
	context.waitUntil(
		runScheduledCommerceWork(env, controller.cron, controller.scheduledTime),
	);
}

export async function runScheduledCommerceWork(
	env: Env,
	cron: string,
	scheduledAt: number,
) {
	const agentAccess = await reconcileAgentAccess(env.DB);
	const publishBatchSize = await loadPublishBatchSize(env.DB);
	const payments = await reconcilePendingShopPayments(
		env.DB,
		fetch,
		scheduledAt,
	);
	const expired = await expireStoreOrders(env.DB, scheduledAt);
	const promotionRewards = await settlePromotionRewards(env.DB, scheduledAt);
	const deliveries = await publishPendingDeliveries(
		env.DB,
		env.COMMERCE_QUEUE,
		publishBatchSize,
	);
	const suppliers = await publishPendingSupplierOrders(
		env.DB,
		env.COMMERCE_QUEUE,
		publishBatchSize,
	);
	const inventoryEvents = await publishPendingInventoryEvents(
		env.DB,
		env.COMMERCE_QUEUE,
		publishBatchSize,
	);
	const ownerSaleAlerts = await publishPendingOwnerSaleAlerts({
		db: env.DB,
		limit: publishBatchSize,
		now: scheduledAt,
	});
	const builds = await publishPendingBuilds(
		env.DB,
		env.COMMERCE_QUEUE,
		publishBatchSize,
	);
	const refunds = await publishPendingRefunds(
		env.DB,
		env.COMMERCE_QUEUE,
		publishBatchSize,
	);
	const notificationEvents = await fanOutPendingCommerceNotifications(
		env.DB,
		publishBatchSize,
	);
	const notifications = await publishPendingNotifications(
		env.DB,
		env.COMMERCE_QUEUE,
		publishBatchSize,
	);
	const telegram = await runTelegramMaintenance(env.DB, scheduledAt);
	const maintenance = await runMaintenance(env, cron, undefined, scheduledAt);
	const securityAlert = await publishAuthSecurityAlert(
		env.DB,
		scheduledAt,
	).catch(() => ({ status: "failed" }));
	const redemptionExceptions = await runRedemptionExceptionTodos({
		db: env.DB,
	}).catch(() => ({ status: "failed", changed: 0, accepted: 0 }));
	// Renewal reminders are optional marketing work: they run last, with their
	// own D1 budget, so they can never delay or break the jobs above.
	const renewals = await runRenewalReminders(env.DB, {
		now: scheduledAt,
	}).catch(() => ({ status: "failed" as const }));
	// Owner automation (balance guard, pricing guard, weekly report): each is
	// off by default, self-throttled per Beijing period and isolated from the rest.
	const balanceGuard = await runBalanceGuard({
		db: env.DB,
		now: scheduledAt,
	}).catch(() => ({ status: "failed" as const }));
	const pricingGuard = await runPricingGuard({
		db: env.DB,
		now: scheduledAt,
	}).catch(() => ({ status: "failed" as const }));
	const weeklyReport = await runWeeklyReport({
		db: env.DB,
		now: scheduledAt,
	}).catch(() => ({ status: "failed" as const }));
	return {
		balanceGuard,
		pricingGuard,
		weeklyReport,
		agentAccess,
		promotionRewards,
		payments,
		redemptionExceptions,
		expired,
		deliveries,
		suppliers,
		inventoryEvents,
		ownerSaleAlerts,
		builds,
		refunds,
		notificationEvents,
		renewals,
		notifications,
		telegram,
		maintenance,
		securityAlert,
	};
}

async function loadPublishBatchSize(db: D1Database) {
	const row = await db
		.prepare(
			"SELECT value FROM system_settings WHERE key = 'queue.publish_batch_size' LIMIT 1",
		)
		.first<{ value: string }>();
	if (!row) return 25;
	try {
		const value: unknown = JSON.parse(row.value);
		return typeof value === "number" && value >= 1 && value <= 100 ? value : 25;
	} catch {
		return 25;
	}
}
