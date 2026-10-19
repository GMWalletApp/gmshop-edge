import { z } from "zod";
import {
	beijingClock,
	claimInterval,
	type Deliver,
	fetchProcurementStats,
	formatYuan,
	loadSettings,
	type ProcurementStats,
	type RestockSource,
	resolveDeliver,
	restockLabel,
	settingStatement,
} from "./shared";

export const balanceGuardSettingKeys = {
	enabled: "ops.balance_guard.enabled",
	lastRunAt: "ops.balance_guard.last_run_at",
	alertedDays: "ops.balance_guard.alerted_days",
} as const;

export const balanceGuardIntervalMs = 2 * 3_600_000;
const weekMs = 7 * 86_400_000;
const aisouOrigin = "https://aisou.pro";

export type SupplierKey = RestockSource;
export type SupplierBalance = {
	key: SupplierKey;
	label: string;
	balanceMinor: number | null;
	spend7dMinor: number;
	purchases7d: number;
};

export function supplierLabel(key: SupplierKey) {
	return restockLabel[key];
}

/** Real AISOU numbers live in GMShop: stored account balance and supplied orders. */
export async function readAisouBalance(
	db: D1Database,
	now: number,
): Promise<SupplierBalance | null> {
	const account = await db
		.prepare(
			`SELECT account.balance_minor,
			  (SELECT COALESCE(SUM(CAST(supplied.total_cost_minor AS INTEGER)), 0)
			   FROM supplier_orders supplied
			   JOIN supplier_bindings binding ON binding.id = supplied.supplier_binding_id
			   WHERE supplied.state = 'supplied' AND supplied.created_at >= ?
			    AND binding.provider = 'shared_stock'
			    AND binding.normalized_api_origin = ?) AS spend_7d,
			  (SELECT COUNT(*) FROM supplier_orders supplied
			   JOIN supplier_bindings binding ON binding.id = supplied.supplier_binding_id
			   WHERE supplied.state = 'supplied' AND supplied.created_at >= ?
			    AND binding.provider = 'shared_stock'
			    AND binding.normalized_api_origin = ?) AS purchases_7d
			 FROM supplier_accounts account
			 WHERE account.provider = 'shared_stock'
			  AND account.normalized_api_origin = ? AND account.enabled = 1
			 ORDER BY account.id LIMIT 1`,
		)
		.bind(now - weekMs, aisouOrigin, now - weekMs, aisouOrigin, aisouOrigin)
		.first<{
			balance_minor: string | null;
			spend_7d: number;
			purchases_7d: number;
		}>();
	if (!account) return null;
	return {
		key: "aisou",
		label: supplierLabel("aisou"),
		balanceMinor:
			account.balance_minor === null ? null : Number(account.balance_minor),
		spend7dMinor: Number(account.spend_7d),
		purchases7d: Number(account.purchases_7d),
	};
}

/** 86 and 小九 come from the redeem warehouse; AISOU from GMShop. Missing sources are skipped. */
export async function collectSupplierBalances(input: {
	db: D1Database;
	now: number;
	readStats: () => Promise<ProcurementStats | null>;
}) {
	const [stats, aisou] = await Promise.all([
		input.readStats().catch(() => null),
		readAisouBalance(input.db, input.now),
	]);
	// GMShop's own AISOU account is the same wallet, so it wins over a warehouse copy.
	const fromWarehouse = (stats?.suppliers ?? []).filter(
		(row) => !(aisou && row.name === "aisou"),
	);
	const suppliers: SupplierBalance[] = fromWarehouse.map((row) => ({
		key: row.name,
		label: supplierLabel(row.name),
		balanceMinor: row.balanceMinor,
		spend7dMinor: row.spend7dMinor,
		purchases7d: row.purchases7d,
	}));
	if (aisou) suppliers.push(aisou);
	return { suppliers, redeemStatsAvailable: stats !== null };
}

export type SupplierRisk = SupplierBalance & {
	balanceMinor: number;
	daysLeft: number | null;
	typicalPurchaseMinor: number | null;
	suggestedTopUpMinor: number;
};

/** days_left = balance / (7-day spend / 7). */
export function daysLeft(balanceMinor: number, spend7dMinor: number) {
	return spend7dMinor > 0 ? (balanceMinor * 7) / spend7dMinor : null;
}

export function assessSupplier(supplier: SupplierBalance): SupplierRisk | null {
	if (supplier.balanceMinor === null) return null;
	const balance = supplier.balanceMinor;
	const left = daysLeft(balance, supplier.spend7dMinor);
	const typical =
		supplier.purchases7d > 0
			? Math.ceil(supplier.spend7dMinor / supplier.purchases7d)
			: null;
	const lowDays = left !== null && left < 2;
	const belowNextPurchase = typical !== null && balance < typical;
	if (!lowDays && !belowNextPurchase) return null;
	// Enough for 7 more days of typical spend, rounded up to ¥100.
	const target = Math.max(supplier.spend7dMinor, typical ?? 0);
	const shortfall = Math.max(1, target - balance);
	return {
		...supplier,
		balanceMinor: balance,
		daysLeft: left,
		typicalPurchaseMinor: typical,
		suggestedTopUpMinor: Math.ceil(shortfall / 10_000) * 10_000,
	};
}

export function formatDaysLeft(value: number | null) {
	return value === null
		? "—"
		: `${(Math.floor(value * 10) / 10).toFixed(1)} 天`;
}

export function formatBalanceAlert(risks: SupplierRisk[], day: string) {
	return [
		`⚠️ 供应商余额不足｜${day}`,
		...risks.map(
			(risk) =>
				`· ${risk.label}：余额 ${formatYuan(risk.balanceMinor)}，近 7 天消耗 ${formatYuan(risk.spend7dMinor)}，约剩 ${formatDaysLeft(risk.daysLeft)}${
					risk.typicalPurchaseMinor !== null &&
					risk.balanceMinor < risk.typicalPurchaseMinor
						? `（不够下一笔约 ${formatYuan(risk.typicalPurchaseMinor)} 的进货）`
						: ""
				}；建议充值 ${formatYuan(risk.suggestedTopUpMinor)}`,
		),
		"建议充值金额按 7 天用量计算，已向上取整到 ¥100。",
	].join("\n");
}

const alertedSchema = z.record(z.string(), z.string());

export async function runBalanceGuard(input: {
	db: D1Database;
	now?: number;
	force?: boolean;
	fetcher?: typeof fetch;
	deliver?: Deliver;
	readStats?: () => Promise<ProcurementStats | null>;
}) {
	const now = input.now ?? Date.now();
	const fetcher = input.fetcher ?? fetch;
	const settings = await loadSettings(input.db, [
		balanceGuardSettingKeys.enabled,
		balanceGuardSettingKeys.alertedDays,
	]);
	if (!input.force && settings.get(balanceGuardSettingKeys.enabled) !== true)
		return { status: "disabled" as const };
	if (
		!input.force &&
		!(await claimInterval(
			input.db,
			balanceGuardSettingKeys.lastRunAt,
			now,
			// One minute of slack so the every-minute cron keeps a two-hour rhythm.
			balanceGuardIntervalMs - 60_000,
		))
	)
		return { status: "throttled" as const };
	const { suppliers } = await collectSupplierBalances({
		db: input.db,
		now,
		readStats:
			input.readStats ?? (() => fetchProcurementStats(input.db, fetcher)),
	});
	const { day } = beijingClock(now);
	const parsedAlerted = alertedSchema.safeParse(
		settings.get(balanceGuardSettingKeys.alertedDays),
	);
	const alerted = parsedAlerted.success ? parsedAlerted.data : {};
	const risks = suppliers
		.map(assessSupplier)
		.filter((risk): risk is SupplierRisk => risk !== null)
		.filter((risk) => alerted[risk.key] !== day);
	if (risks.length === 0)
		return { status: "ok" as const, checked: suppliers.length, alerted: 0 };
	const deliver = resolveDeliver(
		input.db,
		fetcher,
		input.deliver,
		"ops-balance",
		now,
	);
	try {
		await deliver(formatBalanceAlert(risks, day));
	} catch {
		// Not marked as alerted: the next two-hour run tries again.
		return { status: "failed" as const, checked: suppliers.length, alerted: 0 };
	}
	const next = { ...alerted };
	for (const risk of risks) next[risk.key] = day;
	await settingStatement(
		input.db,
		balanceGuardSettingKeys.alertedDays,
		next,
		now,
	).run();
	return {
		status: "sent" as const,
		checked: suppliers.length,
		alerted: risks.length,
	};
}
