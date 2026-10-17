import { z } from "zod";
import {
	loadDeliveryWarehouseToken,
	requestWarehouse,
} from "#/features/redeem-warehouse/server/warehouse-client";
import {
	feishuAlertErrorCode,
	recordFeishuAlertResult,
	resolveFeishuAlertCredentials,
	sendFeishuText,
} from "#/features/telegram/server/feishu-alerts";
import { loadRuntimeConfig } from "#/server/runtime-config";

/** Delivers one owner text. Tests inject it; production posts to the Feishu alert chat. */
export type Deliver = (text: string) => Promise<void>;

const dayMs = 86_400_000;
const beijingOffsetMs = 8 * 3_600_000;

export function beijingClock(now: number) {
	const shifted = new Date(now + beijingOffsetMs);
	return {
		day: shifted.toISOString().slice(0, 10),
		hour: shifted.getUTCHours(),
		/** 0 = Sunday, 1 = Monday. */
		weekday: shifted.getUTCDay(),
		dayStart:
			Math.floor((now + beijingOffsetMs) / dayMs) * dayMs - beijingOffsetMs,
	};
}

export function beijingDay(ms: number) {
	return beijingClock(ms).day;
}

export function formatYuan(minor: number | bigint) {
	const value = BigInt(minor);
	const sign = value < 0n ? "-" : "";
	const abs = value < 0n ? -value : value;
	return `${sign}¥${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`;
}

/** "12.3" / 12.3 → 1230 fen. Extra decimals round up, so costs are never understated. */
export function yuanToMinor(value: unknown): number | null {
	if (value === null || value === undefined) return null;
	const text = typeof value === "number" ? String(value) : value;
	if (typeof text !== "string") return null;
	const match = /^(\d{1,12})(?:\.(\d+))?$/.exec(text.trim());
	if (!match) return null;
	const fraction = match[2] ?? "";
	let minor =
		Number(match[1]) * 100 + Number(fraction.slice(0, 2).padEnd(2, "0"));
	if (/[1-9]/.test(fraction.slice(2))) minor += 1;
	return minor;
}

export async function loadSettings(db: D1Database, keys: readonly string[]) {
	const rows = await db
		.prepare(
			`SELECT key, value FROM system_settings WHERE key IN (${keys.map(() => "?").join(", ")})`,
		)
		.bind(...keys)
		.all<{ key: string; value: string }>();
	const values = new Map<string, unknown>();
	for (const row of rows.results) {
		try {
			values.set(row.key, JSON.parse(row.value));
		} catch {
			// A malformed value behaves like a missing one.
		}
	}
	return values;
}

export function settingStatement(
	db: D1Database,
	key: string,
	value: unknown,
	now: number,
) {
	return db
		.prepare(
			`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
			 VALUES (?, ?, 0, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value,
			 updated_at = excluded.updated_at`,
		)
		.bind(key, JSON.stringify(value), now, now);
}

/** Atomically moves a period key to `period`; false when another run already owns it. */
export async function claimPeriod(
	db: D1Database,
	key: string,
	period: string,
	now: number,
) {
	const result = await db
		.prepare(
			`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
			 VALUES (?, ?, 0, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value,
			 updated_at = excluded.updated_at
			 WHERE system_settings.value <> excluded.value`,
		)
		.bind(key, JSON.stringify(period), now, now)
		.run();
	return Number(result.meta.changes ?? 0) === 1;
}

/** Atomically claims an interval run stored as a millisecond timestamp. */
export async function claimInterval(
	db: D1Database,
	key: string,
	now: number,
	intervalMs: number,
) {
	const result = await db
		.prepare(
			`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
			 VALUES (?, ?, 0, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value,
			 updated_at = excluded.updated_at
			 WHERE CAST(system_settings.value AS INTEGER) <= ?`,
		)
		.bind(key, JSON.stringify(now), now, now, now - intervalMs)
		.run();
	return Number(result.meta.changes ?? 0) === 1;
}

export async function deliverToFeishu(
	db: D1Database,
	text: string,
	fetcher: typeof fetch,
	uuid: string,
) {
	try {
		const credentials = await resolveFeishuAlertCredentials(db, {
			requireEnabled: false,
		});
		if (!credentials) throw new Error("feishu_configuration_unavailable");
		await sendFeishuText(credentials, text, fetcher, uuid);
		await recordFeishuAlertResult(db, { sent: true });
	} catch (error) {
		await recordFeishuAlertResult(db, {
			sent: false,
			errorCode: feishuAlertErrorCode(error),
		}).catch(() => undefined);
		throw error;
	}
}

const unsentSchema = z.object({ text: z.string(), at: z.number() });
const unsentMaxAgeMs = 2 * dayMs;

/**
 * Sends a once-per-period message. A failed send is parked under `unsentKey`
 * and retried by `retryUnsent` on later ticks, so the period claim never loses it.
 */
export async function sendOrPark(
	db: D1Database,
	unsentKey: string,
	text: string,
	deliver: Deliver,
	now: number,
) {
	try {
		await deliver(text);
		return "sent" as const;
	} catch {
		await settingStatement(db, unsentKey, { text, at: now }, now).run();
		return "parked" as const;
	}
}

export async function retryUnsent(
	db: D1Database,
	unsentKey: string,
	deliver: Deliver,
	now: number,
	stored: unknown,
) {
	const parsed = unsentSchema.safeParse(stored);
	if (!parsed.success) return "none" as const;
	const clear = () =>
		db
			.prepare("DELETE FROM system_settings WHERE key = ?")
			.bind(unsentKey)
			.run();
	if (now - parsed.data.at > unsentMaxAgeMs) {
		await clear();
		return "expired" as const;
	}
	try {
		await deliver(parsed.data.text);
	} catch {
		return "failed" as const;
	}
	await clear();
	return "sent" as const;
}

export function resolveDeliver(
	db: D1Database,
	fetcher: typeof fetch,
	deliver: Deliver | undefined,
	uuidPrefix: string,
	now: number,
): Deliver {
	return (
		deliver ??
		((text) => deliverToFeishu(db, text, fetcher, `${uuidPrefix}-${now}`))
	);
}

// ---- Redeem warehouse procurement endpoints (optional; absent → null) ----

const amountSchema = z.union([z.string(), z.number()]).nullable().optional();
export type RestockSource = "86" | "xiaojiu";
export const restockLabel: Record<RestockSource, string> = {
	"86": "86",
	xiaojiu: "小九",
};

const statsSchema = z.object({
	success: z.literal(true),
	data: z.object({
		suppliers: z
			.array(
				z.object({
					name: z.enum(["86", "xiaojiu"]),
					balance: amountSchema,
					spend_7d: amountSchema,
					purchases_7d: z.number().int().nonnegative().nullable().optional(),
				}),
			)
			.default([]),
		skus: z
			.array(
				z.object({
					sku: z.string(),
					available: z.number().int().nullable().optional(),
					restock_source: z.enum(["86", "xiaojiu"]).nullable().optional(),
					unit_cost_latest: amountSchema,
				}),
			)
			.default([]),
	}),
});

const pricesSchema = z.object({
	success: z.literal(true),
	data: z.array(
		z.object({
			sku: z.string(),
			source: z.enum(["86", "xiaojiu"]),
			price: amountSchema,
		}),
	),
});

export type ProcurementStats = {
	suppliers: {
		name: RestockSource;
		balanceMinor: number | null;
		spend7dMinor: number;
		purchases7d: number;
	}[];
	skus: Record<string, { restockSource: RestockSource | null }>;
};
export type ProcurementPrices = {
	sku: string;
	source: RestockSource;
	priceMinor: number | null;
}[];

async function warehouseGet(
	db: D1Database,
	path: string,
	fetcher: typeof fetch,
) {
	const { commerceSecret } = await loadRuntimeConfig(db);
	const token = await loadDeliveryWarehouseToken(db, commerceSecret);
	return requestWarehouse(token, path, {}, fetcher);
}

export function parseProcurementStats(body: unknown): ProcurementStats {
	const parsed = statsSchema.parse(body).data;
	return {
		suppliers: parsed.suppliers.map((row) => ({
			name: row.name,
			balanceMinor: yuanToMinor(row.balance),
			spend7dMinor: yuanToMinor(row.spend_7d) ?? 0,
			purchases7d: row.purchases_7d ?? 0,
		})),
		skus: Object.fromEntries(
			parsed.skus.map((row) => [
				row.sku,
				{ restockSource: row.restock_source ?? null },
			]),
		),
	};
}

export function parseProcurementPrices(body: unknown): ProcurementPrices {
	return pricesSchema.parse(body).data.map((row) => ({
		sku: row.sku,
		source: row.source,
		priceMinor: yuanToMinor(row.price),
	}));
}

export async function fetchProcurementStats(
	db: D1Database,
	fetcher: typeof fetch,
): Promise<ProcurementStats | null> {
	try {
		return parseProcurementStats(
			await warehouseGet(db, "/api/internal/procurement/stats", fetcher),
		);
	} catch {
		return null;
	}
}

export async function fetchProcurementPrices(
	db: D1Database,
	fetcher: typeof fetch,
): Promise<ProcurementPrices | null> {
	try {
		return parseProcurementPrices(
			await warehouseGet(db, "/api/internal/procurement/prices", fetcher),
		);
	} catch {
		return null;
	}
}
