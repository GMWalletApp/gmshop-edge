import { sha256Hex } from "#/lib/crypto";
import type { SupportedLocale } from "#/lib/locales";

export const renewalStages = ["remind_3d", "remind_due", "recall"] as const;
export type RenewalStage = (typeof renewalStages)[number];

export const renewalStageRef: Record<RenewalStage, string> = {
	remind_3d: "renew_3d",
	remind_due: "renew_due",
	recall: "recall",
};

const dayMs = 86_400_000;
const beijingOffsetMs = 8 * 3_600_000;
/** Reminders go out on/after 10:00 Asia/Shanghai of the due calendar day. */
export const renewalSendHourBeijing = 10;
/** A stage more than this late is skipped instead of being sent stale. */
export const renewalStaleAfterMs = 2 * dayMs;
/** Codes still unredeemed this long after delivery are abandoned. */
export const renewalRedeemWaitMs = 60 * dayMs;
/** Direct orders delivered since 2026-08-25 00:00 Asia/Shanghai are backfilled. */
export const renewalBackfillSince = Date.UTC(2026, 7, 24, 16);

// Warehouse code formats (the redeem lookup contract).
const warehouseCodePattern =
	/\b(?:gpt-(?:go|plus|5x|20x)-ios|gpt-(?:plus|5x|20x)-ph|gpt-20x-renew-ph|gpt-500-cl|claude-(?:pro|max-(?:5x|20x))-ios)-[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}\b/gi;

/** Embedded warehouse codes, lowercased and de-duplicated, in text order. */
export function extractWarehouseCodes(content: string) {
	return [
		...new Set(
			(content.match(warehouseCodePattern) ?? []).map((code) =>
				code.toLowerCase(),
			),
		),
	];
}

/** Contract normalize(): an embedded code when present, else the trimmed text. */
export function normalizeRedeemCode(content: string) {
	return (extractWarehouseCodes(content)[0] ?? content.trim()).toLowerCase();
}

export function redeemCodeHash(code: string) {
	return sha256Hex(normalizeRedeemCode(code));
}

export function beijingDayStart(at: number) {
	return Math.floor((at + beijingOffsetMs) / dayMs) * dayMs - beijingOffsetMs;
}

export function isRenewalSendWindow(now: number) {
	return now - beijingDayStart(now) >= renewalSendHourBeijing * 3_600_000;
}

export function renewalStageOffsetDays(stage: RenewalStage, cycleDays: number) {
	if (stage === "remind_3d") return cycleDays - 3;
	if (stage === "remind_due") return cycleDays;
	return cycleDays + 10;
}

/** 10:00 Beijing on the calendar day that is `offset` days after the anchor. */
export function renewalStageDueAt(
	anchorAt: number,
	cycleDays: number,
	stage: RenewalStage,
) {
	return (
		beijingDayStart(anchorAt) +
		renewalStageOffsetDays(stage, cycleDays) * dayMs +
		renewalSendHourBeijing * 3_600_000
	);
}

export function renewalExpiresAt(anchorAt: number, cycleDays: number) {
	return anchorAt + cycleDays * dayMs;
}

/**
 * A reminder is stale once it is over two days late or the next reminder is
 * already due; recall never goes stale (historical customers get it once).
 */
export function isRenewalStageStale(
	stage: RenewalStage,
	dueAt: number,
	anchorAt: number,
	cycleDays: number,
	now: number,
) {
	if (stage === "recall") return false;
	if (now - dueAt > renewalStaleAfterMs) return true;
	return (
		stage === "remind_3d" &&
		now >= renewalStageDueAt(anchorAt, cycleDays, "remind_due")
	);
}

export function isEmailAddress(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length <= 320 &&
		/^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/.test(value.trim())
	);
}

export function maskEmail(email: string) {
	const [local = "", domain = ""] = email.split("@");
	const head = local.slice(0, Math.min(2, Math.max(1, local.length - 1)));
	return `${head}${"*".repeat(Math.max(1, local.length - head.length))}@${domain}`;
}

export type RenewalEmailInput = {
	stage: RenewalStage;
	locale: SupportedLocale;
	itemName: string;
	expiresAt: number;
	now: number;
	siteDomain: string;
	brand: string;
	renewUrl: string;
	unsubscribeUrl: string;
};

function beijingDate(at: number) {
	const date = new Date(at + beijingOffsetMs);
	return {
		year: date.getUTCFullYear(),
		month: date.getUTCMonth() + 1,
		day: date.getUTCDate(),
	};
}

const englishMonths = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

/** Plain-text renewal email. No coupons or promotional copy by design. */
export function renderRenewalEmail(input: RenewalEmailInput) {
	const expiry = beijingDate(input.expiresAt);
	const dueToday =
		beijingDayStart(input.expiresAt) === beijingDayStart(input.now);
	if (input.locale === "en-US") {
		const short = `${englishMonths[expiry.month - 1]} ${expiry.day}`;
		const long = `${short}, ${expiry.year}`;
		const subject =
			input.stage === "remind_3d"
				? `Your ${input.itemName} expires on ${short}`
				: input.stage === "remind_due"
					? dueToday
						? `Your ${input.itemName} expires today`
						: `Your ${input.itemName} expired on ${short}`
					: `Long time no see — renewals are still at ${input.siteDomain}`;
		const lead =
			input.stage === "recall"
				? `Last time you bought "${input.itemName}" at ${input.siteDomain}. If you want to keep using it, you can renew here:`
				: `Your "${input.itemName}" from ${input.siteDomain} ${
						input.stage === "remind_due" && dueToday
							? "expires today"
							: input.stage === "remind_due"
								? "expired on"
								: "expires on"
					}${input.stage === "remind_due" && dueToday ? "" : ` ${long}`} (Beijing time).\n\nRenew in one click:`;
		const text = [
			"Hello,",
			"",
			lead,
			input.renewUrl,
			"",
			`Remember us: ${input.siteDomain} — bookmark it for your next renewal.`,
			"",
			`— ${input.brand}`,
			"",
			`Don't want renewal reminders? Unsubscribe: ${input.unsubscribeUrl}`,
		].join("\n");
		return { subject, text };
	}
	const short = `${expiry.month}月${expiry.day}日`;
	const long = `${expiry.year}年${short}`;
	const subject =
		input.stage === "remind_3d"
			? `你的 ${input.itemName} 将于 ${short} 到期`
			: input.stage === "remind_due"
				? dueToday
					? `你的 ${input.itemName} 今天到期`
					: `你的 ${input.itemName} 已于 ${short} 到期`
				: `好久不见，续费还在 ${input.siteDomain}`;
	const lead =
		input.stage === "recall"
			? `你上次在 ${input.siteDomain} 购买的是「${input.itemName}」。如需继续使用，可以在这里续费：`
			: `你在 ${input.siteDomain} 购买的「${input.itemName}」${
					input.stage === "remind_due"
						? dueToday
							? "今天到期"
							: `已于 ${long}到期`
						: `将于 ${long}到期`
				}（北京时间）。\n\n一键续费：`;
	const text = [
		"你好，",
		"",
		lead,
		input.renewUrl,
		"",
		`记住我们：${input.siteDomain}${pinyinHint(input.siteDomain)}，建议收藏，下次续费直接来。`,
		"",
		`—— ${input.brand}`,
		"",
		`不想再收到续费提醒？退订：${input.unsubscribeUrl}`,
	].join("\n");
	return { subject, text };
}

/** The domain is the pinyin of the brand; saying so makes it easier to remember. */
function pinyinHint(siteDomain: string) {
	return siteDomain.replace(/^www\./, "").startsWith("laoshirenvip.")
		? "（就是「老实人VIP」的拼音）"
		: "";
}
