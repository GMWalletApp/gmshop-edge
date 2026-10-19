import { z } from "zod";

export const amountSchema = z.string().regex(/^\d{1,10}(?:\.\d{1,2})?$/);
const money = z.string().regex(/^\d{1,18}(?:\.\d{1,2})?$/);
const id = z.number().int().positive();
export const monthQuerySchema = z.object({
	refresh: z.boolean().optional(),
	month: z
		.string()
		.regex(/^\d{4}-(0[1-9]|1[0-2])$/)
		.optional(),
});
export const feeSourceSchema = z.enum([
	"offline_alipay",
	"shop_order",
	"manual",
	"none",
]);
const tierSchema = z.object({ threshold: money, amount: money });
export const rulesSchema = z.object({
	currency: z
		.string()
		.trim()
		.min(1)
		.max(16)
		.regex(/^[A-Z][A-Z0-9]*$/),
	start_date: z.string(),
	rebate_enabled: z.boolean(),
	rebate_window_days: z.number().int(),
	schedules: z.record(z.string(), z.array(tierSchema)),
	leaderboard_enabled: z.boolean(),
	leaderboard_rewards: z.array(money),
	withdraw_settlement_weekday: z.number().int().min(0).max(6),
	withdraw_min_amount: money,
	min_markup_percent: money,
	default_markup_percent: money,
});
const salesSchema = z.object({
	orders: z.number().int(),
	sales: money,
	profit: z.string().regex(/^-?\d+(?:\.\d{1,2})?$/),
});
const periodProfitSchema = z.object({
	profit: salesSchema.shape.profit.nullable(),
	unknown_order_count: z.number().int().nonnegative(),
});
export const agentSchema = z.object({
	id,
	user_id: id,
	label: z.string(),
	email: z.string(),
	payout_alipay_account: z.string(),
	status: z.string(),
	domains: z.array(
		z.object({ domain: z.string(), type: z.string(), status: z.string() }),
	),
	our_profit_month: periodProfitSchema,
	our_profit_last_month: periodProfitSchema,
	opened_at: z.string(),
	opening_fee_paid: money,
	opening_fee_source: feeSourceSchema,
	our_profit_in_window: z
		.string()
		.regex(/^-?\d+(?:\.\d{1,2})?$/)
		.nullable(),
	profit_data_state: z.enum(["available", "unavailable"]),
	unknown_profit_order_count: z.number().int().nonnegative(),
	unknown_profit_assumed_loss: money,
	unknown_profit_orders: z.array(
		z.object({ order_id: id, reason: z.string() }),
	),
	rebate: z.object({
		eligible: z.boolean(),
		manual_confirmation: z.boolean(),
		fee_paid: money,
		window_start: z.string(),
		window_end: z.string(),
		days_left: z.number().int(),
		wholesale: money,
		tiers: z.array(
			tierSchema.extend({
				reached: z.boolean(),
				credited: z.boolean(),
				guard_state: z.enum([
					"credited",
					"not_reached",
					"waiting_profit",
					"profit_unavailable",
					"ready",
				]),
				profit_gap: money.optional(),
			}),
		),
		credited_total: money,
		max_total: money,
		next_gap: money,
		next_amount: money,
	}),
	month: salesSchema,
	last_month: salesSchema,
	all_time: salesSchema,
	withdrawable: money,
	locked: money,
	pending_withdrawal: money,
	last_order_at: z.string().nullable(),
});
export const agentsSchema = z.object({
	month: z.string(),
	agents: z.array(agentSchema),
	rules: rulesSchema,
});
export const detailSchema = z.object({
	agent: agentSchema,
	monthly_series: z.array(
		salesSchema.extend({ month: z.string(), wholesale: money }),
	),
	credit_history: z.array(
		z.object({
			id,
			type: z.string(),
			amount: money,
			currency: z.string(),
			remark: z.string(),
			created_at: z.string(),
		}),
	),
});
export const leaderboardSchema = z.object({
	month: z.string(),
	ranking: z.array(
		z.object({
			rank: z.number().int(),
			profile_id: id,
			user_id: id,
			label: z.string(),
			wholesale: money,
		}),
	),
	drafts: z.array(
		z.object({
			id,
			month: z.string(),
			rank: z.number().int(),
			reseller_id: id,
			user_id: id,
			wholesale_amount: money,
			reward_amount: money,
			status: z.string(),
			reviewed_operator: z.string(),
			reviewed_at: z.string().nullable().optional().default(null),
			reject_reason: z.string().optional().default(""),
		}),
	),
	rules: rulesSchema,
});
export const withdrawalsSchema = z.array(
	z.object({
		id,
		reseller_id: id,
		label: z.string(),
		amount: money,
		currency: z.string(),
		account: z.string(),
		email: z.string(),
		status: z.string(),
		created_at: z.string(),
		alipay_trade_no: z.string(),
		processed_operator: z.string(),
	}),
);
export const feeInputSchema = z.object({
	id,
	amount: amountSchema,
	source: feeSourceSchema,
	reason: z.string().trim().min(1).max(500),
});
export const reviewInputSchema = z
	.object({
		id,
		action: z.enum(["approve", "reject"]),
		reason: z.string().trim().max(500).optional(),
	})
	.refine((v) => v.action !== "reject" || Boolean(v.reason));
export const payoutInputSchema = z.object({
	id,
	alipay_trade_no: z
		.string()
		.trim()
		.min(1)
		.max(128)
		.regex(/^[A-Za-z0-9_-]+$/),
});
export type FeeSource = z.infer<typeof feeSourceSchema>;
export type Agent = z.infer<typeof agentSchema>;
export type ProgramRules = z.infer<typeof rulesSchema>;

export function amountMinor(value: string): bigint {
	const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value);
	if (!match) throw new Error("Invalid decimal amount");
	return (
		(match[1] ? -1n : 1n) *
		(BigInt(match[2] ?? "0") * 100n + BigInt((match[3] ?? "").padEnd(2, "0")))
	);
}
export function canManageAgentProgram(user: {
	root: boolean;
	roles: readonly string[];
}) {
	return user.root || user.roles.includes("admin");
}
