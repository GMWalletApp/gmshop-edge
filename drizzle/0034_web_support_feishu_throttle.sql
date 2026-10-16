-- Last Feishu ping for a web support conversation; further messages within 5 minutes stay in Telegram only.
ALTER TABLE telegram_web_support_conversations ADD COLUMN feishu_alerted_at INTEGER;
