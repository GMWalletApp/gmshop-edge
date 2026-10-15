export async function loadRenewalSettings(db: D1Database) {
	const rows = await db
		.prepare(
			`SELECT key, value FROM system_settings WHERE key IN
			 ('notifications.renewal_reminders_enabled','notifications.renewal_recall_enabled')`,
		)
		.all<{ key: string; value: string }>();
	const stored = new Map(rows.results.map((row) => [row.key, row.value]));
	const flag = (key: string, fallback: boolean) => {
		const value = stored.get(key);
		if (value === undefined) return fallback;
		try {
			const parsed: unknown = JSON.parse(value);
			return typeof parsed === "boolean" ? parsed : fallback;
		} catch {
			return fallback;
		}
	};
	return {
		remindersEnabled: flag("notifications.renewal_reminders_enabled", true),
		recallEnabled: flag("notifications.renewal_recall_enabled", false),
	};
}
