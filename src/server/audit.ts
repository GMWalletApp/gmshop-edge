import { redactAuditValue } from "#/server/audit-redaction";
import { clientIp } from "#/server/client-ip";

export function createAuditStatement(
	db: D1Database,
	request: Request,
	actorUserId: string,
	input: {
		action: string;
		targetType: string;
		targetId?: string | null;
		before?: Record<string, unknown> | null;
		after?: Record<string, unknown> | null;
	},
) {
	return db
		.prepare(
			`INSERT INTO audit_logs
			 (id, actor_user_id, action, target_type, target_id, request_id,
			  ip_address, before, after, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			crypto.randomUUID(),
			actorUserId,
			input.action,
			input.targetType,
			input.targetId ?? null,
			request.headers.get("x-request-id"),
			clientIp(request),
			input.before == null
				? null
				: JSON.stringify(redactAuditValue(input.before)),
			input.after == null
				? null
				: JSON.stringify(redactAuditValue(input.after)),
			Date.now(),
		);
}
