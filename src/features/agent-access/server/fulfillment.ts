import { activateEntitlementGrantStatements } from "#/features/entitlements/server/ledger";
import { DomainError } from "#/lib/domain-error";
import { decryptSecret, encryptSecret } from "#/lib/secrets";
import { loadRuntimeConfig } from "#/server/runtime-config";
import type { AgentAccessKind } from "../products";
import { type AgentTransport, callAgent } from "./client";

type AccessOrder = {
	order_item_id: string;
	user_id: string;
	email: string;
	kind: AgentAccessKind;
	state: string;
	order_id: string;
	order_status: string;
	paid_minor: string;
	attempt_count: number;
	next_attempt_at: number;
	refund_pending: number;
	requested_subdomain: string | null;
};
const query = `SELECT a.*,oi.order_id,o.status AS order_status,o.paid_minor,
 EXISTS(SELECT 1 FROM refunds r WHERE r.order_id=o.id AND r.status IN ('pending','processing')) AS refund_pending
 FROM agent_access_orders a JOIN shop_order_items oi ON oi.id=a.order_item_id JOIN shop_orders o ON o.id=oi.order_id`;

export async function processAgentDelivery(
	db: D1Database,
	deliveryId: string,
	transport: AgentTransport = callAgent,
) {
	const row = await db
		.prepare(
			`${query} JOIN delivery_records d ON d.order_item_id=a.order_item_id WHERE d.id=?`,
		)
		.bind(deliveryId)
		.first<AccessOrder>();
	if (!row) return null;
	if (row.state === "revoked" || row.state === "cancelled")
		return { status: row.state };
	if (row.order_status === "refunded") {
		await revoke(db, row, transport);
		return { status: "revoked" };
	}
	if (
		row.refund_pending ||
		!["paid", "fulfilling", "completed"].includes(row.order_status)
	)
		return { status: "waiting" };
	if (row.state === "active") return { status: "delivered" };
	if (row.attempt_count >= 8)
		throw new DomainError(
			"agent_access_support_required",
			409,
			"Opening requires support; do not pay again",
		);
	if (row.next_attempt_at > Date.now()) return { status: "processing" };
	const now = Date.now();
	// A short durable lease also spaces duplicate queue messages. Remote writes
	// remain idempotent if the worker crashes after the remote grant commits.
	const lease = await db
		.prepare(
			`UPDATE agent_access_orders SET attempt_count=attempt_count+1,next_attempt_at=?,updated_at=? WHERE order_item_id=? AND state='pending' AND next_attempt_at<=? AND attempt_count<8`,
		)
		.bind(now + 60000, now, row.order_item_id, now)
		.run();
	if (!lease.meta.changes) return { status: "processing" };
	try {
		const secret = (await loadRuntimeConfig(db)).commerceSecret;
		if (!secret) throw new Error("delivery_secret_unavailable");
		// Persist before the remote call: retry uses the same password after an unknown outcome.
		const generated =
			"Aa1!" +
			Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) =>
				b.toString(16).padStart(2, "0"),
			).join("");
		await db
			.prepare(
				"UPDATE agent_access_orders SET initial_password_encrypted=? WHERE order_item_id=? AND initial_password_encrypted IS NULL AND state='pending'",
			)
			.bind(
				await encryptSecret(generated, secret, "agent-initial-password"),
				row.order_item_id,
			)
			.run();
		const encrypted = await db
			.prepare(
				"SELECT initial_password_encrypted FROM agent_access_orders WHERE order_item_id=?",
			)
			.bind(row.order_item_id)
			.first<string>("initial_password_encrypted");
		if (!encrypted) throw new Error("initial_password_missing");
		const initialPassword = await decryptSecret(
			encrypted,
			secret,
			"agent-initial-password",
		);
		const result = await transport({
			initialPassword,
			operation: "provision",
			sourceUserId: row.user_id,
			email: row.email,
			kind: row.kind,
			orderItemId: row.order_item_id,
			...(row.kind === "subsite"
				? {
						paidAmount: `${BigInt(row.paid_minor) / 100n}.${(BigInt(row.paid_minor) % 100n).toString().padStart(2, "0")}`,
						...(row.requested_subdomain
							? { subdomain: row.requested_subdomain }
							: {}),
					}
				: {}),
		});
		// Record the assigned host as soon as lsrai.shop reports it, so the
		// order page and owner alert can show it while HTTPS is still warming up.
		if (result.domain)
			await db
				.prepare(
					"UPDATE agent_access_orders SET domain=?,subdomain_fallback=?,updated_at=? WHERE order_item_id=? AND state='pending'",
				)
				.bind(
					result.domain,
					result.subdomainFallback ?? null,
					Date.now(),
					row.order_item_id,
				)
				.run();
		if (result.state !== "active" || !result.userId)
			throw new Error("not_ready");
		if (!result.initialPasswordValid) {
			await db
				.prepare(
					"UPDATE agent_access_orders SET initial_password_encrypted=NULL WHERE order_item_id=?",
				)
				.bind(row.order_item_id)
				.run();
		}
		const complete = Date.now();
		await db.batch([
			db
				.prepare(
					`UPDATE agent_access_orders SET state='active',remote_user_id=?,domain=?,error_code=NULL,updated_at=? WHERE order_item_id=? AND state='pending' AND EXISTS(SELECT 1 FROM shop_orders o WHERE o.id=? AND o.status IN ('paid','fulfilling')) AND NOT EXISTS(SELECT 1 FROM refunds r WHERE r.order_id=? AND r.status IN ('pending','processing','succeeded'))`,
				)
				.bind(
					result.userId,
					result.domain ?? null,
					complete,
					row.order_item_id,
					row.order_id,
					row.order_id,
				),
			db
				.prepare(
					`UPDATE delivery_records SET status='delivered',delivered_at=?,updated_at=? WHERE id=? AND status IN ('pending','processing') AND EXISTS(SELECT 1 FROM agent_access_orders a WHERE a.order_item_id=delivery_records.order_item_id AND a.state='active') AND EXISTS(SELECT 1 FROM shop_orders o WHERE o.id=? AND o.status IN ('paid','fulfilling'))`,
				)
				.bind(complete, complete, deliveryId, row.order_id),
			...activateEntitlementGrantStatements(db, row.order_item_id, complete),
			db
				.prepare(
					`UPDATE shop_orders SET status='completed',completed_at=?,version=version+1,updated_at=? WHERE id=? AND status IN ('paid','fulfilling') AND NOT EXISTS(SELECT 1 FROM delivery_records d JOIN shop_order_items oi ON oi.id=d.order_item_id WHERE oi.order_id=shop_orders.id AND d.status<>'delivered')`,
				)
				.bind(complete, complete, row.order_id),
			db
				.prepare(
					`INSERT OR IGNORE INTO shop_order_events(id,order_id,event_type,visibility,from_status,to_status,order_version,actor_type,created_at) SELECT ?,id,'delivery_progressed','customer','fulfilling','completed',version,'system',? FROM shop_orders WHERE id=? AND status='completed'`,
				)
				.bind(`agent-access:${row.order_item_id}`, complete, row.order_id),
			db
				.prepare(
					`INSERT INTO audit_logs(id,action,target_type,target_id,created_at) SELECT ?,'agent_access.delivered','order_item',?,? WHERE EXISTS(SELECT 1 FROM agent_access_orders WHERE order_item_id=? AND state='active')`,
				)
				.bind(
					crypto.randomUUID(),
					row.order_item_id,
					complete,
					row.order_item_id,
				),
		]);
		const actual = await db
			.prepare("SELECT state FROM agent_access_orders WHERE order_item_id=?")
			.bind(row.order_item_id)
			.first<{ state: string }>();
		return { status: actual?.state === "active" ? "delivered" : "processing" };
	} catch {
		await db
			.prepare(
				`UPDATE agent_access_orders SET error_code='agent_access_pending',next_attempt_at=?,updated_at=? WHERE order_item_id=? AND state='pending'`,
			)
			.bind(
				now + Math.min(3600000, 60000 * 2 ** row.attempt_count),
				Date.now(),
				row.order_item_id,
			)
			.run();
		throw new DomainError(
			"agent_access_pending",
			503,
			"Opening is pending; do not pay again",
		);
	}
}
async function revoke(
	db: D1Database,
	row: AccessOrder,
	transport: AgentTransport,
) {
	const result = await transport({
		operation: "revoke",
		sourceUserId: row.user_id,
		email: row.email,
		kind: row.kind,
		orderItemId: row.order_item_id,
	});
	if (result.state !== "revoked") throw new Error("revocation_pending");
	await db
		.prepare(
			`UPDATE agent_access_orders SET state='revoked',initial_password_encrypted=NULL,error_code=NULL,updated_at=? WHERE order_item_id=?`,
		)
		.bind(Date.now(), row.order_item_id)
		.run();
}
// Minute scheduler is the recovery path for queue loss and successful refunds.
// A failed remote call is isolated; it must not stop ordinary commerce work.
export async function reconcileAgentAccess(
	db: D1Database,
	transport: AgentTransport = callAgent,
) {
	const rows = await db
		.prepare(
			`${query} WHERE a.state IN ('pending','active') AND ((o.status='refunded' AND (a.error_code IS NOT 'agent_access_revoke_pending' OR a.next_attempt_at<=?)) OR (a.state='pending' AND a.attempt_count<8 AND a.next_attempt_at<=? AND o.status IN ('paid','fulfilling'))) ORDER BY a.next_attempt_at,a.order_item_id LIMIT 20`,
		)
		.bind(Date.now(), Date.now())
		.all<AccessOrder>();
	let completed = 0;
	for (const row of rows.results) {
		try {
			if (row.order_status === "refunded") await revoke(db, row, transport);
			else {
				const d = await db
					.prepare(
						"SELECT id FROM delivery_records WHERE order_item_id=? LIMIT 1",
					)
					.bind(row.order_item_id)
					.first<{ id: string }>();
				if (!d) continue;
				await processAgentDelivery(db, d.id, transport);
			}
			completed++;
		} catch {
			await db
				.prepare(
					"UPDATE agent_access_orders SET error_code=?,next_attempt_at=?,updated_at=? WHERE order_item_id=?",
				)
				.bind(
					row.order_status === "refunded"
						? "agent_access_revoke_pending"
						: "agent_access_pending",
					Date.now() + 60000,
					Date.now(),
					row.order_item_id,
				)
				.run();
		}
	}
	return { checked: rows.results.length, completed };
}
export async function assertAgentRefundAmount(
	db: D1Database,
	orderId: string,
	amountMinor: string,
) {
	const row = await db
		.prepare(
			`SELECT o.paid_minor FROM shop_orders o JOIN shop_order_items oi ON oi.order_id=o.id JOIN agent_access_orders a ON a.order_item_id=oi.id WHERE o.id=? LIMIT 1`,
		)
		.bind(orderId)
		.first<{ paid_minor: string }>();
	if (row && BigInt(row.paid_minor) !== BigInt(amountMinor))
		throw new DomainError(
			"agent_access_full_refund_required",
			409,
			"Access orders require a full refund to revoke the qualification safely",
		);
}
