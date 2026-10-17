import {
	ownerAlertConfigured,
	sendOwnerAlert,
} from "#/features/telegram/server/owner-alerts";
import { claimFixedWindowRateLimit } from "#/server/rate-limit";

// Reuse the owner's configured operational recipient, never customer email.
export async function publishAuthSecurityAlert(
	db: D1Database,
	now = Date.now(),
	deliver?: (text: string) => Promise<void>,
) {
	const setting = await db
		.prepare(
			"SELECT value FROM system_settings WHERE key='security.feishu_alerts_enabled'",
		)
		.first<{ value: string }>();
	if (setting?.value !== "true") return { status: "disabled" };
	const end = Math.floor(now / 900_000) * 900_000;
	const rows = await db
		.prepare(
			`SELECT action, COUNT(*) AS count FROM audit_logs INDEXED BY audit_logs_created_idx WHERE created_at >= ? AND created_at < ? AND action IN ('auth.sign_in_failed','auth.email_otp_sign_in_failed','auth.telegram_oidc_failed','security.auth_rate_limited','auth.telegram_widget_failed','auth.telegram_mini_app_failed') GROUP BY action`,
		)
		.bind(end - 900_000, end)
		.all<{ action: string; count: number }>();
	const blocked =
		rows.results.find((r) => r.action === "security.auth_rate_limited")
			?.count ?? 0;
	const failures = rows.results
		.filter((r) => r.action !== "security.auth_rate_limited")
		.reduce((sum, r) => sum + r.count, 0);
	if (!blocked && failures < 10) return { status: "quiet" };
	if (!deliver && !(await ownerAlertConfigured(db)))
		return { status: "unconfigured" };
	const claim = await claimFixedWindowRateLimit(db, {
		bucketKey: `security:alert:${end}`,
		limit: 1,
		windowMs: 900_000,
		now,
	});
	if (!claim.allowed) return { status: "deduplicated" };
	try {
		const at = new Intl.DateTimeFormat("zh-CN", {
			timeZone: "Asia/Shanghai",
			dateStyle: "short",
			timeStyle: "short",
		}).format(end);
		const text = `商城认证安全告警\n截至 ${at}（北京时间）的15分钟\n认证失败：${failures}\n触发限流的计数窗口：${blocked}\n请核查商城审计；这不是入侵成功的证明。`;
		if (deliver) await deliver(text);
		else if (!(await sendOwnerAlert(db, text))) throw new Error("unconfigured");
		await record(db, "security.alert_sent", end, now);
		return { status: "sent" };
	} catch {
		await record(db, "security.alert_failed", end, now);
		return { status: "failed" };
	}
}
async function record(
	db: D1Database,
	action: string,
	end: number,
	now: number,
) {
	await db
		.prepare(
			"INSERT INTO audit_logs (id,action,target_type,target_id,created_at) VALUES (?,?,?,?,?)",
		)
		.bind(crypto.randomUUID(), action, "security_window", String(end), now)
		.run();
}
