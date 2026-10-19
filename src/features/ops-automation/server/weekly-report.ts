import { paymentProcessingFeeAmount } from "#/features/shop-payments/fees";
import {
	collectSupplierBalances,
	daysLeft,
	formatDaysLeft,
	type SupplierBalance,
} from "./balance-guard";
import { itemCostSql } from "./item-cost";
import {
	beijingClock,
	beijingDay,
	claimPeriod,
	type Deliver,
	fetchProcurementStats,
	formatYuan,
	loadSettings,
	type ProcurementStats,
	resolveDeliver,
	retryUnsent,
	sendOrPark,
} from "./shared";

export const weeklyReportSettingKeys = {
	enabled: "ops.weekly_report.enabled",
	lastRunWeek: "ops.weekly_report.last_run_week",
	unsent: "ops.weekly_report.unsent_message",
} as const;

export const weeklyReportHour = 9;
const dayMs = 86_400_000;
const paidStatuses = "('paid','fulfilling','completed')";

type OrderRow = {
	id: string;
	paid_at: number;
	total_minor: string;
	email: string | null;
	is_agent: number;
	cost_minor: number;
	cost_missing: number;
	fee_bps: number | null;
	fixed_fee_minor: string | null;
	payment_currency: string | null;
};

export type PeriodMetrics = {
	orders: number;
	directOrders: number;
	agentOrders: number;
	revenueMinor: number;
	directRevenueMinor: number;
	agentRevenueMinor: number;
	profitMinor: number;
	costMissing: number;
};

function summarize(rows: OrderRow[]): PeriodMetrics {
	const metrics: PeriodMetrics = {
		orders: 0,
		directOrders: 0,
		agentOrders: 0,
		revenueMinor: 0,
		directRevenueMinor: 0,
		agentRevenueMinor: 0,
		profitMinor: 0,
		costMissing: 0,
	};
	for (const row of rows) {
		const total = Number(row.total_minor);
		const fee =
			row.fee_bps === null
				? 0
				: Number(
						paymentProcessingFeeAmount(
							row.total_minor,
							row.fee_bps,
							// A fixed fee in another currency cannot be applied to a CNY total.
							row.payment_currency === "CNY"
								? (row.fixed_fee_minor ?? "0")
								: "0",
						),
					);
		metrics.orders += 1;
		metrics.revenueMinor += total;
		if (row.is_agent) {
			metrics.agentOrders += 1;
			metrics.agentRevenueMinor += total;
		} else {
			metrics.directOrders += 1;
			metrics.directRevenueMinor += total;
		}
		metrics.profitMinor += total - Number(row.cost_minor) - fee;
		metrics.costMissing += Number(row.cost_missing);
	}
	return metrics;
}

export type WeeklyReport = {
	from: number;
	to: number;
	current: PeriodMetrics;
	previous: PeriodMetrics;
	repeat: { customers: number; repeatCustomers: number };
	topSkus: { label: string; quantity: number; profitMinor: number }[];
	promotions: {
		referralUses: number;
		referralDiscountMinor: number;
		recallUses: number;
		recallDiscountMinor: number;
		rewardsCreated: number;
		rewardsCreatedMinor: number;
		rewardsCredited: number;
		rewardsCreditedMinor: number;
	};
	suppliers: SupplierBalance[];
};

export async function buildWeeklyReport(input: {
	db: D1Database;
	now: number;
	readStats: () => Promise<ProcurementStats | null>;
}): Promise<WeeklyReport> {
	const { db } = input;
	const to = beijingClock(input.now).dayStart;
	const from = to - 7 * dayMs;
	const previousFrom = from - 7 * dayMs;
	const orders = await db
		.prepare(
			`SELECT orders.id, orders.paid_at, orders.total_minor,
			  lower(COALESCE(orders.normalized_contact_email, orders.contact_email)) AS email,
			  EXISTS (SELECT 1 FROM supplier_api_orders api WHERE api.shop_order_id = orders.id) AS is_agent,
			  COALESCE((SELECT SUM(COALESCE(${itemCostSql("item")}, 0)) FROM shop_order_items item
			   WHERE item.order_id = orders.id), 0) AS cost_minor,
			  (SELECT COUNT(*) FROM shop_order_items item WHERE item.order_id = orders.id
			   AND (${itemCostSql("item")}) IS NULL) AS cost_missing,
			  (SELECT channel.fee_bps FROM payment_attempts payment
			   JOIN payment_channels channel ON channel.id = payment.channel_id
			   WHERE payment.order_id = orders.id AND payment.status = 'succeeded'
			   ORDER BY payment.succeeded_at DESC, payment.id DESC LIMIT 1) AS fee_bps,
			  (SELECT channel.fixed_fee_minor FROM payment_attempts payment
			   JOIN payment_channels channel ON channel.id = payment.channel_id
			   WHERE payment.order_id = orders.id AND payment.status = 'succeeded'
			   ORDER BY payment.succeeded_at DESC, payment.id DESC LIMIT 1) AS fixed_fee_minor,
			  (SELECT channel.currency FROM payment_attempts payment
			   JOIN payment_channels channel ON channel.id = payment.channel_id
			   WHERE payment.order_id = orders.id AND payment.status = 'succeeded'
			   ORDER BY payment.succeeded_at DESC, payment.id DESC LIMIT 1) AS payment_currency
			 FROM shop_orders orders
			 WHERE orders.status IN ${paidStatuses} AND orders.currency = 'CNY'
			  AND orders.paid_at >= ? AND orders.paid_at < ?`,
		)
		.bind(previousFrom, to)
		.all<OrderRow>();
	const current = summarize(
		orders.results.filter((row) => row.paid_at >= from),
	);
	const previous = summarize(
		orders.results.filter((row) => row.paid_at < from),
	);

	const [repeat, topSkus, coupons, rewards, balances] = await Promise.all([
		db
			.prepare(
				`SELECT COUNT(*) AS customers, COALESCE(SUM(order_count >= 2), 0) AS repeat_customers FROM (
				  SELECT lower(COALESCE(orders.normalized_contact_email, orders.contact_email)) AS email,
				   COUNT(*) AS order_count
				  FROM shop_orders orders
				  WHERE orders.status IN ${paidStatuses} AND orders.paid_at >= ? AND orders.paid_at < ?
				   AND COALESCE(orders.normalized_contact_email, orders.contact_email) IS NOT NULL
				   AND NOT EXISTS (SELECT 1 FROM supplier_api_orders api WHERE api.shop_order_id = orders.id)
				  GROUP BY 1)`,
			)
			.bind(to - 30 * dayMs, to)
			.first<{ customers: number; repeat_customers: number }>(),
		db
			.prepare(
				`SELECT item.product_name || ' · ' || item.sellable_item_name AS label,
				  SUM(item.quantity) AS quantity,
				  SUM(CAST(item.subtotal_minor AS INTEGER) - CAST(item.discount_minor AS INTEGER)
				      - COALESCE(${itemCostSql("item")}, 0)) AS profit_minor
				 FROM shop_order_items item JOIN shop_orders orders ON orders.id = item.order_id
				 WHERE orders.status IN ${paidStatuses} AND orders.currency = 'CNY'
				  AND orders.paid_at >= ? AND orders.paid_at < ?
				 GROUP BY item.sellable_item_id ORDER BY profit_minor DESC LIMIT 5`,
			)
			.bind(from, to)
			.all<{ label: string; quantity: number; profit_minor: number }>(),
		db
			.prepare(
				`SELECT coupon.purpose, COUNT(*) AS uses,
				  COALESCE(SUM(CAST(redemption.discount_minor AS INTEGER)), 0) AS discount_minor
				 FROM coupon_redemptions redemption JOIN coupons coupon ON coupon.id = redemption.coupon_id
				 WHERE redemption.status = 'consumed' AND coupon.purpose IN ('referral', 'recall')
				  AND redemption.consumed_at >= ? AND redemption.consumed_at < ?
				 GROUP BY coupon.purpose`,
			)
			.bind(from, to)
			.all<{
				purpose: "referral" | "recall";
				uses: number;
				discount_minor: number;
			}>(),
		db
			.prepare(
				`SELECT
				  (SELECT COUNT(*) FROM promotion_rewards WHERE created_at >= ?1 AND created_at < ?2) AS created,
				  (SELECT COALESCE(SUM(CAST(amount_minor AS INTEGER)), 0) FROM promotion_rewards
				   WHERE created_at >= ?1 AND created_at < ?2) AS created_minor,
				  (SELECT COUNT(*) FROM promotion_rewards WHERE state = 'available'
				   AND updated_at >= ?1 AND updated_at < ?2) AS credited,
				  (SELECT COALESCE(SUM(CAST(amount_minor AS INTEGER)), 0) FROM promotion_rewards
				   WHERE state = 'available' AND updated_at >= ?1 AND updated_at < ?2) AS credited_minor`,
			)
			.bind(from, to)
			.first<{
				created: number;
				created_minor: number;
				credited: number;
				credited_minor: number;
			}>(),
		collectSupplierBalances({ db, now: input.now, readStats: input.readStats }),
	]);
	const purpose = (name: "referral" | "recall") =>
		coupons.results.find((row) => row.purpose === name);
	return {
		from,
		to,
		current,
		previous,
		repeat: {
			customers: Number(repeat?.customers ?? 0),
			repeatCustomers: Number(repeat?.repeat_customers ?? 0),
		},
		topSkus: topSkus.results.map((row) => ({
			label: row.label,
			quantity: Number(row.quantity),
			profitMinor: Number(row.profit_minor),
		})),
		promotions: {
			referralUses: Number(purpose("referral")?.uses ?? 0),
			referralDiscountMinor: Number(purpose("referral")?.discount_minor ?? 0),
			recallUses: Number(purpose("recall")?.uses ?? 0),
			recallDiscountMinor: Number(purpose("recall")?.discount_minor ?? 0),
			rewardsCreated: Number(rewards?.created ?? 0),
			rewardsCreatedMinor: Number(rewards?.created_minor ?? 0),
			rewardsCredited: Number(rewards?.credited ?? 0),
			rewardsCreditedMinor: Number(rewards?.credited_minor ?? 0),
		},
		suppliers: balances.suppliers,
	};
}

function change(current: number, previous: number) {
	if (previous === 0) return current === 0 ? "持平" : "上周为 0";
	const bps =
		Math.round(((current - previous) * 1000) / Math.abs(previous)) / 10;
	return `${bps >= 0 ? "+" : ""}${bps.toFixed(1)}%`;
}

function average(totalMinor: number, count: number) {
	return count === 0 ? 0 : Math.round(totalMinor / count);
}

export function formatWeeklyReport(report: WeeklyReport) {
	const { current: c, previous: p, promotions: promo } = report;
	const range = `${beijingDay(report.from)} ~ ${beijingDay(report.to - 1)}`;
	const rate =
		report.repeat.customers === 0
			? "—"
			: `${((report.repeat.repeatCustomers * 100) / report.repeat.customers).toFixed(1)}%`;
	const lines = [
		`📊 经营周报｜${range}（北京时间，对比前 7 天）`,
		`付款订单：${c.orders} 单（${change(c.orders, p.orders)}）；主站直销 ${c.directOrders} 单，代理 API ${c.agentOrders} 单`,
		`营业额：${formatYuan(c.revenueMinor)}（${change(c.revenueMinor, p.revenueMinor)}）；直销 ${formatYuan(c.directRevenueMinor)}，代理 ${formatYuan(c.agentRevenueMinor)}`,
		`预估毛利：${formatYuan(c.profitMinor)}（${change(c.profitMinor, p.profitMinor)}，已扣成本和支付手续费）${
			c.costMissing ? `；${c.costMissing} 件商品缺成本，按 0 计` : ""
		}`,
		`平均每单毛利：${formatYuan(average(c.profitMinor, c.orders))}（上周 ${formatYuan(average(p.profitMinor, p.orders))}）`,
		`30 天复购率：${rate}（${report.repeat.repeatCustomers}/${report.repeat.customers} 位直销客户下单 ≥2 次）`,
	];
	if (report.topSkus.length)
		lines.push(
			"",
			"毛利前 5 的商品：",
			...report.topSkus.map(
				(sku, index) =>
					`${index + 1}. ${sku.label}：${sku.quantity} 件，毛利 ${formatYuan(sku.profitMinor)}`,
			),
		);
	lines.push(
		"",
		`促销：邀请券用了 ${promo.referralUses} 次（让利 ${formatYuan(promo.referralDiscountMinor)}），召回券用了 ${promo.recallUses} 次（让利 ${formatYuan(promo.recallDiscountMinor)}）`,
		`邀请返佣：新增 ${promo.rewardsCreated} 笔 ${formatYuan(promo.rewardsCreatedMinor)}，已到账 ${promo.rewardsCredited} 笔 ${formatYuan(promo.rewardsCreditedMinor)}`,
	);
	if (report.suppliers.length)
		lines.push(
			"",
			"供应商余额：",
			...report.suppliers.map((supplier) =>
				supplier.balanceMinor === null
					? `· ${supplier.label}：余额读取失败`
					: `· ${supplier.label}：余额 ${formatYuan(supplier.balanceMinor)}，近 7 天消耗 ${formatYuan(supplier.spend7dMinor)}，约剩 ${formatDaysLeft(daysLeft(supplier.balanceMinor, supplier.spend7dMinor))}`,
			),
		);
	return lines.join("\n");
}

export async function runWeeklyReport(input: {
	db: D1Database;
	now?: number;
	force?: boolean;
	fetcher?: typeof fetch;
	deliver?: Deliver;
	readStats?: () => Promise<ProcurementStats | null>;
}) {
	const now = input.now ?? Date.now();
	const fetcher = input.fetcher ?? fetch;
	const settings = await loadSettings(
		input.db,
		Object.values(weeklyReportSettingKeys),
	);
	if (!input.force && settings.get(weeklyReportSettingKeys.enabled) !== true)
		return { status: "disabled" as const };
	const deliver = resolveDeliver(
		input.db,
		fetcher,
		input.deliver,
		"ops-weekly",
		now,
	);
	const retried = await retryUnsent(
		input.db,
		weeklyReportSettingKeys.unsent,
		deliver,
		now,
		settings.get(weeklyReportSettingKeys.unsent),
	);
	const clock = beijingClock(now);
	if (!input.force && (clock.weekday !== 1 || clock.hour < weeklyReportHour))
		return { status: "waiting" as const, retried };
	if (
		!(await claimPeriod(
			input.db,
			weeklyReportSettingKeys.lastRunWeek,
			clock.day,
			now,
		)) &&
		!input.force
	)
		return { status: "done" as const, retried };
	const report = await buildWeeklyReport({
		db: input.db,
		now,
		readStats:
			input.readStats ?? (() => fetchProcurementStats(input.db, fetcher)),
	});
	const delivery = await sendOrPark(
		input.db,
		weeklyReportSettingKeys.unsent,
		formatWeeklyReport(report),
		deliver,
		now,
	);
	return {
		status: "ran" as const,
		retried,
		delivery,
		orders: report.current.orders,
	};
}
