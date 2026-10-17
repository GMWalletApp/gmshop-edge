import { z } from "zod";
import { saleComponents } from "#/features/redeem-warehouse/server/sale-capacity";
import {
	beijingClock,
	claimPeriod,
	type Deliver,
	fetchProcurementPrices,
	fetchProcurementStats,
	formatYuan,
	loadSettings,
	type ProcurementPrices,
	type ProcurementStats,
	resolveDeliver,
	retryUnsent,
	sendOrPark,
} from "./shared";

export const pricingGuardSettingKeys = {
	enabled: "ops.pricing_guard.enabled",
	lastRunDay: "ops.pricing_guard.last_run_day",
	unsent: "ops.pricing_guard.unsent_message",
	costFactors: "pricing.cost_factors",
	minNetMinor: "pricing.min_net_minor",
} as const;

export const defaultCostFactors = {
	"86": 1.0042,
	xiaojiu: 1.0018,
	aisou: 0.9937,
	buffer: 1.01,
} as const;
export const defaultMinNetMinor = 300;
/** Agent supply prices below this net are flagged for review. */
export const agentMinNetMinor = 100;
export const pricingGuardHour = 9;
/** Raises at or under this share apply automatically; above it they need the owner. */
const autoRaiseLimitPercent = 5;
const alipayKeepPercent = 98;
const alipayOverUsdtPercent = 102;

type CostSource = "86" | "xiaojiu" | "aisou";
type FactorsPpm = Record<CostSource | "buffer", bigint>;

const factorSchema = z.number().min(0.5).max(2);

export function parseCostFactors(value: unknown): FactorsPpm {
	const record =
		value && typeof value === "object"
			? (value as Record<string, unknown>)
			: {};
	const pick = (key: keyof typeof defaultCostFactors) => {
		const parsed = factorSchema.safeParse(record[key]);
		return BigInt(
			Math.round(
				(parsed.success ? parsed.data : defaultCostFactors[key]) * 1e6,
			),
		);
	};
	return {
		"86": pick("86"),
		xiaojiu: pick("xiaojiu"),
		aisou: pick("aisou"),
		buffer: pick("buffer"),
	};
}

/** C = supplier price × source factor × buffer, rounded up to the fen. */
export function realCostMinor(
	supplierPriceMinor: number,
	source: CostSource,
	factors: FactorsPpm,
) {
	const numerator =
		BigInt(supplierPriceMinor) * factors[source] * factors.buffer;
	const denominator = 1_000_000_000_000n;
	return Number((numerator + denominator - 1n) / denominator);
}

/** Next whole-yuan price ending in 9 (or 8 from ¥1000, e.g. ¥1098) that is ≥ minor. */
export function roundUpRetailMinor(minor: number) {
	let yuan = Math.ceil(minor / 100);
	if (yuan < 1000) {
		const nine = yuan + ((19 - (yuan % 10)) % 10);
		if (nine < 1000) return nine * 100;
		yuan = 1000;
	}
	return (yuan + ((18 - (yuan % 10)) % 10)) * 100;
}

const ceilDiv = (a: number, b: number) => Math.ceil(a / b);

export type PricePlan = {
	usdtOld: number;
	usdtNew: number;
	alipayOld: number | null;
	alipayNew: number | null;
	auto: boolean;
};

/** Minimal raise satisfying both nets ≥ floor and 支付宝 ≥ USDT × 1.02. Never lowers. */
export function planPrice(input: {
	usdtMinor: number;
	alipayMinor: number | null;
	costMinor: number;
	floorMinor: number;
}): PricePlan | null {
	const need = input.costMinor + input.floorMinor;
	const usdtLow = input.usdtMinor < need;
	const alipayLow =
		input.alipayMinor !== null &&
		input.alipayMinor * alipayKeepPercent < need * 100;
	if (!usdtLow && !alipayLow) return null;
	const usdtNew = usdtLow
		? Math.max(input.usdtMinor, roundUpRetailMinor(need))
		: input.usdtMinor;
	let alipayNew: number | null = null;
	if (input.alipayMinor !== null) {
		const required = Math.max(
			ceilDiv(need * 100, alipayKeepPercent),
			ceilDiv(usdtNew * alipayOverUsdtPercent, 100),
		);
		alipayNew =
			input.alipayMinor >= required
				? input.alipayMinor
				: Math.max(input.alipayMinor, roundUpRetailMinor(required));
	}
	const within = (oldMinor: number, newMinor: number) =>
		(newMinor - oldMinor) * 100 <= oldMinor * autoRaiseLimitPercent;
	return {
		usdtOld: input.usdtMinor,
		usdtNew,
		alipayOld: input.alipayMinor,
		alipayNew,
		auto:
			within(input.usdtMinor, usdtNew) &&
			(input.alipayMinor === null ||
				alipayNew === null ||
				within(input.alipayMinor, alipayNew)),
	};
}

type ItemRow = {
	id: string;
	product_id: string;
	product_name: string;
	item_name: string;
	price_minor: string;
	version: number;
	usdt_price_id: string | null;
	alipay_price_id: string | null;
	alipay_minor: string | null;
	aisou_cost_minor: string | null;
	agent_price_minor: string | null;
};

export type PricingOutcome = {
	label: string;
	costMinor: number;
	plan: PricePlan;
	applied: boolean;
};
export type AgentWarning = {
	label: string;
	costMinor: number;
	agentMinor: number;
	suggestedMinor: number;
};

export async function runPricingGuard(input: {
	db: D1Database;
	now?: number;
	force?: boolean;
	fetcher?: typeof fetch;
	deliver?: Deliver;
	readStats?: () => Promise<ProcurementStats | null>;
	readPrices?: () => Promise<ProcurementPrices | null>;
}) {
	const now = input.now ?? Date.now();
	const fetcher = input.fetcher ?? fetch;
	const settings = await loadSettings(
		input.db,
		Object.values(pricingGuardSettingKeys),
	);
	if (!input.force && settings.get(pricingGuardSettingKeys.enabled) !== true)
		return { status: "disabled" as const };
	const deliver = resolveDeliver(
		input.db,
		fetcher,
		input.deliver,
		"ops-pricing",
		now,
	);
	const retried = await retryUnsent(
		input.db,
		pricingGuardSettingKeys.unsent,
		deliver,
		now,
		settings.get(pricingGuardSettingKeys.unsent),
	);
	const clock = beijingClock(now);
	if (!input.force && clock.hour < pricingGuardHour)
		return { status: "waiting" as const, retried };
	if (
		!(await claimPeriod(
			input.db,
			pricingGuardSettingKeys.lastRunDay,
			clock.day,
			now,
		)) &&
		!input.force
	)
		return { status: "done" as const, retried };

	const factors = parseCostFactors(
		settings.get(pricingGuardSettingKeys.costFactors),
	);
	const floorSetting = z
		.number()
		.int()
		.nonnegative()
		.safeParse(settings.get(pricingGuardSettingKeys.minNetMinor));
	const floorMinor = floorSetting.success
		? floorSetting.data
		: defaultMinNetMinor;
	const [map, rows] = await Promise.all([
		saleComponents(input.db).catch(() => ({}) as Record<string, string>),
		loadItems(input.db),
	]);
	const needsRedeem = rows.some((row) => map[row.id]);
	const [stats, prices] = needsRedeem
		? await Promise.all([
				(
					input.readStats ?? (() => fetchProcurementStats(input.db, fetcher))
				)().catch(() => null),
				(
					input.readPrices ?? (() => fetchProcurementPrices(input.db, fetcher))
				)().catch(() => null),
			])
		: [null, null];

	const outcomes: PricingOutcome[] = [];
	const agentWarnings: AgentWarning[] = [];
	let skipped = 0;
	for (const row of rows) {
		const cost = supplierCost(row, map, stats, prices, factors);
		if (cost === null) {
			skipped += 1;
			continue;
		}
		const label = `${row.product_name} · ${row.item_name}`;
		if (row.agent_price_minor !== null) {
			const agentMinor = Number(row.agent_price_minor);
			if (agentMinor - cost < agentMinNetMinor)
				agentWarnings.push({
					label,
					costMinor: cost,
					agentMinor,
					suggestedMinor: ceilDiv(cost + agentMinNetMinor, 100) * 100,
				});
		}
		const plan = planPrice({
			usdtMinor: Number(row.price_minor),
			alipayMinor: row.alipay_minor === null ? null : Number(row.alipay_minor),
			costMinor: cost,
			floorMinor,
		});
		if (!plan) continue;
		const applied = plan.auto
			? await applyRaise(input.db, row, plan, cost, floorMinor, now)
			: false;
		outcomes.push({ label, costMinor: cost, plan, applied });
	}

	const text = formatPricingReport(
		clock.day,
		outcomes,
		agentWarnings,
		floorMinor,
	);
	const delivery = text
		? await sendOrPark(
				input.db,
				pricingGuardSettingKeys.unsent,
				text,
				deliver,
				now,
			)
		: ("nothing" as const);
	return {
		status: "ran" as const,
		retried,
		delivery,
		applied: outcomes.filter((outcome) => outcome.applied).length,
		proposed: outcomes.filter((outcome) => !outcome.applied).length,
		agentWarnings: agentWarnings.length,
		skipped,
	};
}

function supplierCost(
	row: ItemRow,
	map: Record<string, string>,
	stats: ProcurementStats | null,
	prices: ProcurementPrices | null,
	factors: FactorsPpm,
) {
	const sku = map[row.id];
	if (sku) {
		const source = stats?.skus[sku]?.restockSource;
		if (!source || !prices) return null;
		const price = prices.find(
			(entry) => entry.sku === sku && entry.source === source,
		)?.priceMinor;
		return price == null ? null : realCostMinor(price, source, factors);
	}
	if (row.aisou_cost_minor === null) return null;
	return realCostMinor(Number(row.aisou_cost_minor), "aisou", factors);
}

async function loadItems(db: D1Database) {
	const rows = await db
		.prepare(
			`SELECT item.id, item.product_id, product.name AS product_name,
			  item.name AS item_name, item.price_minor, item.version,
			  (SELECT price.id FROM sellable_item_channel_prices price
			   JOIN payment_channels channel ON channel.id = price.channel_id
			   WHERE price.sellable_item_id = item.id AND price.enabled = 1
			    AND channel.name = 'USDT' LIMIT 1) AS usdt_price_id,
			  (SELECT price.id FROM sellable_item_channel_prices price
			   JOIN payment_channels channel ON channel.id = price.channel_id
			   WHERE price.sellable_item_id = item.id AND price.enabled = 1
			    AND channel.name = '支付宝' LIMIT 1) AS alipay_price_id,
			  (SELECT price.price_minor FROM sellable_item_channel_prices price
			   JOIN payment_channels channel ON channel.id = price.channel_id
			   WHERE price.sellable_item_id = item.id AND price.enabled = 1
			    AND channel.name = '支付宝' LIMIT 1) AS alipay_minor,
			  (SELECT binding.reference_cost_minor FROM supplier_bindings binding
			   WHERE binding.sellable_item_id = item.id AND binding.enabled = 1
			    AND binding.provider = 'shared_stock'
			    AND binding.normalized_api_origin = 'https://aisou.pro'
			   ORDER BY binding.updated_at DESC LIMIT 1) AS aisou_cost_minor,
			  (SELECT listing.price_minor FROM supplier_export_listings listing
			   WHERE listing.sellable_item_id = item.id AND listing.enabled = 1
			    AND listing.currency = 'CNY' AND listing.currency_decimals = 2
			   LIMIT 1) AS agent_price_minor
			 FROM product_sellable_items item
			 JOIN products product ON product.id = item.product_id
			 WHERE item.enabled = 1 AND item.sale_disabled = 0
			  AND product.status = 'active' AND product.sale_disabled = 0
			  AND item.currency = 'CNY' AND item.currency_decimals = 2
			 ORDER BY product.sort_order, item.sort_order, item.id`,
		)
		.all<ItemRow>();
	return rows.results;
}

async function applyRaise(
	db: D1Database,
	row: ItemRow,
	plan: PricePlan,
	costMinor: number,
	floorMinor: number,
	now: number,
) {
	const usdt = String(plan.usdtNew);
	// Every follow-up statement is guarded on the item update having landed.
	const landed = `EXISTS (SELECT 1 FROM product_sellable_items WHERE id = ? AND version = ? AND price_minor = ?)`;
	const landedArgs = [row.id, row.version + 1, usdt] as const;
	const statements = [
		db
			.prepare(
				`UPDATE product_sellable_items SET price_minor = ?, version = version + 1,
				 updated_at = ? WHERE id = ? AND version = ? AND price_minor = ?`,
			)
			.bind(usdt, now, row.id, row.version, row.price_minor),
	];
	if (row.usdt_price_id)
		statements.push(
			db
				.prepare(
					`UPDATE sellable_item_channel_prices SET
					 price_minor = CASE WHEN CAST(price_minor AS INTEGER) < ? THEN ? ELSE price_minor END,
					 updated_at = ? WHERE id = ? AND ${landed}`,
				)
				.bind(plan.usdtNew, usdt, now, row.usdt_price_id, ...landedArgs),
		);
	if (row.alipay_price_id && plan.alipayNew !== null)
		statements.push(
			db
				.prepare(
					`UPDATE sellable_item_channel_prices SET
					 price_minor = CASE WHEN CAST(price_minor AS INTEGER) < ? THEN ? ELSE price_minor END,
					 updated_at = ? WHERE id = ? AND ${landed}`,
				)
				.bind(
					plan.alipayNew,
					String(plan.alipayNew),
					now,
					row.alipay_price_id,
					...landedArgs,
				),
		);
	statements.push(
		db
			.prepare(
				`UPDATE products SET revision = revision + 1, revision_token = ?, updated_at = ?
				 WHERE id = ? AND ${landed}`,
			)
			.bind(crypto.randomUUID(), now, row.product_id, ...landedArgs),
		db
			.prepare(
				`INSERT INTO audit_logs (id, action, target_type, target_id, before, after, created_at)
				 SELECT ?, 'pricing_guard.auto_raise', 'sellable_item', ?, ?, ?, ? WHERE ${landed}`,
			)
			.bind(
				crypto.randomUUID(),
				row.id,
				JSON.stringify({
					priceMinor: row.price_minor,
					alipayMinor: row.alipay_minor,
					version: row.version,
				}),
				JSON.stringify({
					priceMinor: usdt,
					alipayMinor: plan.alipayNew === null ? null : String(plan.alipayNew),
					version: row.version + 1,
					costMinor: String(costMinor),
					minNetMinor: String(floorMinor),
				}),
				now,
				...landedArgs,
			),
	);
	const [result] = await db.batch(statements);
	return Number(result?.meta.changes ?? 0) === 1;
}

function percent(oldMinor: number, newMinor: number) {
	return `+${(Math.ceil(((newMinor - oldMinor) * 1000) / oldMinor) / 10).toFixed(1)}%`;
}

function priceChange(plan: PricePlan, withPercent: boolean) {
	const part = (name: string, oldMinor: number, newMinor: number) =>
		oldMinor === newMinor
			? `${name} ${formatYuan(oldMinor)}（不变）`
			: `${name} ${formatYuan(oldMinor)}→${formatYuan(newMinor)}${withPercent ? `（${percent(oldMinor, newMinor)}）` : ""}`;
	return [
		part("USDT", plan.usdtOld, plan.usdtNew),
		plan.alipayOld !== null && plan.alipayNew !== null
			? part("支付宝", plan.alipayOld, plan.alipayNew)
			: null,
	]
		.filter(Boolean)
		.join("，");
}

export function formatPricingReport(
	day: string,
	outcomes: PricingOutcome[],
	agentWarnings: AgentWarning[],
	floorMinor: number,
) {
	const applied = outcomes.filter((outcome) => outcome.applied);
	const proposed = outcomes.filter((outcome) => !outcome.applied);
	if (!applied.length && !proposed.length && !agentWarnings.length) return null;
	const lines = [`📈 定价守护｜${day}（净利底线 ${formatYuan(floorMinor)}）`];
	if (applied.length)
		lines.push(
			"",
			"自动调价（事后通知）：",
			...applied.map(
				(outcome) =>
					`· ${outcome.label}：成本 ${formatYuan(outcome.costMinor)}；${priceChange(outcome.plan, false)}`,
			),
		);
	if (proposed.length)
		lines.push(
			"",
			"需要你确认（未改价）：",
			...proposed.map(
				(outcome) =>
					`· ${outcome.label}：成本 ${formatYuan(outcome.costMinor)}；建议 ${priceChange(outcome.plan, true)}${
						outcome.plan.auto ? "（自动调价未成功，可能刚被改过）" : ""
					}`,
			),
		);
	if (agentWarnings.length)
		lines.push(
			"",
			"代理价需要调整（仅建议，未改动）：",
			...agentWarnings.map(
				(warning) =>
					`· ${warning.label}：代理价 ${formatYuan(warning.agentMinor)}，成本 ${formatYuan(warning.costMinor)}，净利 ${formatYuan(warning.agentMinor - warning.costMinor)}；建议至少 ${formatYuan(warning.suggestedMinor)}`,
			),
		);
	return lines.join("\n");
}
