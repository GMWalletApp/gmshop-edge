import { m } from "#/paraglide/messages";

export function notificationEventLabel(event: string) {
	const labels: Record<string, () => string> = {
		support_reply_manual: m.notifications_event_support_reply_manual,
		"auth.email_verification": m.notifications_event_verification,
		"auth.password_reset": m.notifications_event_password_reset,
		order_paid: m.store_account_notification_order_paid,
		delivery_ready: m.store_account_notification_delivery_ready,
		automation_ready: m.store_account_notification_automation_ready,
		automation_failed: m.store_account_notification_automation_failed,
		refund_succeeded: m.store_account_notification_refund_succeeded,
		refund_failed: m.store_account_notification_refund_failed,
		after_sale_updated: m.store_account_notification_after_sale_updated,
		entitlement_expiring: m.store_account_notification_entitlement_expiring,
		renewal_remind_3d: m.notifications_event_renewal_remind_3d,
		renewal_remind_due: m.notifications_event_renewal_remind_due,
		renewal_recall: m.notifications_event_renewal_recall,
	};
	return labels[event]?.() ?? m.status_unknown();
}

export function notificationHealthStatusLabel(status: string) {
	if (status === "healthy") return m.infrastructure_healthy();
	if (status === "unhealthy") return m.infrastructure_unhealthy();
	return m.infrastructure_health_unknown();
}

export function notificationDeliveryErrorLabel(code: string | null) {
	if (!code) return "—";
	if (code.startsWith("recipient_"))
		return m.notifications_error_recipient_suppressed();
	if (code.startsWith("provider_"))
		return m.notifications_error_provider_delivery();
	if (code === "cloudflare_email_unavailable")
		return m.notifications_error_email_unavailable();
	if (code === "providers_unavailable")
		return m.notifications_error_providers_unavailable();
	return m.common_operation_failed();
}
