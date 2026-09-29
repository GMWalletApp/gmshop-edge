import { z } from "zod";
import {
	BodyLimitExceededError,
	readBoundedRequestBytes,
} from "#/lib/bounded-stream";
import { DomainError } from "#/lib/domain-error";
import { loadRuntimeConfig } from "#/server/runtime-config";
import { signDujiaoNextRequest } from "../providers/signatures";
import { findDujiaoCredentialRevision } from "../secrets";
import { completeSupplierOrderFromCallback } from "./process";
import { claimSupplierCallbackBudget } from "./rate-limit";

const MAX_CALLBACK_BYTES = 1024 * 1024;
const MAX_TIMESTAMP_SKEW_SECONDS = 60;
const CALLBACK_SIGNING_PATH = "/api/v1/upstream/callback";

const callbackSchema = z.object({
	event: z.string().min(1).max(120),
	order_id: z.number().int().positive(),
	order_no: z.string().max(256).default(""),
	downstream_order_no: z.string().min(1).max(256),
	status: z.string().min(1).max(64),
	fulfillment: z
		.object({
			type: z.string().max(64),
			status: z.string().max(64),
			payload: z.string().max(640_000),
			delivery_data: z.unknown().optional(),
			delivered_at: z.string().optional(),
		})
		.nullable()
		.optional(),
	timestamp: z.number().int(),
});

type CallbackAccount = {
	id: string;
	credentials_encrypted: string;
};

export async function handleDujiaoSupplierCallback(
	request: Request,
	accountId: string,
	db: D1Database,
	now = Date.now(),
) {
	let raw: Uint8Array;
	try {
		raw = await readBoundedRequestBytes(request, MAX_CALLBACK_BYTES);
	} catch (error) {
		if (error instanceof BodyLimitExceededError)
			return rejected("body_too_large", 413);
		throw error;
	}
	const rawBody = new TextDecoder().decode(raw);
	const apiKey = request.headers.get("Dujiao-Next-Api-Key") ?? "";
	const timestampHeader = request.headers.get("Dujiao-Next-Timestamp") ?? "";
	const signature = request.headers.get("Dujiao-Next-Signature") ?? "";
	const timestamp = Number(timestampHeader);
	if (
		!apiKey ||
		!signature ||
		!Number.isSafeInteger(timestamp) ||
		Math.abs(Math.floor(now / 1000) - timestamp) > MAX_TIMESTAMP_SKEW_SECONDS
	)
		return rejected("authentication_failed");
	const account = await db
		.prepare(
			`SELECT id, credentials_encrypted FROM supplier_accounts
			 WHERE id = ? AND provider = 'dujiao_next' LIMIT 1`,
		)
		.bind(accountId)
		.first<CallbackAccount>();
	if (!account) return rejected("authentication_failed");
	const runtime = await loadRuntimeConfig(db);
	if (!runtime.commerceSecret) return rejected("authentication_failed");
	const credential = await findDujiaoCredentialRevision(
		account.credentials_encrypted,
		apiKey,
		runtime.commerceSecret,
	);
	if (!credential) return rejected("authentication_failed");
	const expected = signDujiaoNextRequest({
		method: "POST",
		path: CALLBACK_SIGNING_PATH,
		timestamp: timestampHeader,
		rawBody,
		apiSecret: credential.credentials.apiSecret,
	});
	if (!constantTimeEqual(signature.toLowerCase(), expected))
		return rejected("authentication_failed");
	// Only authenticated callbacks consume the per-account budget; forged
	// requests must not be able to starve the real supplier.
	if (!(await claimSupplierCallbackBudget(db, accountId, now)))
		return rejected("rate_limited");
	let payload: z.infer<typeof callbackSchema>;
	try {
		payload = callbackSchema.parse(JSON.parse(rawBody));
	} catch {
		return rejected("invalid_payload");
	}
	if (payload.timestamp !== timestamp) return rejected("timestamp_mismatch");
	const order = await db
		.prepare(
			`SELECT id, upstream_order_id, selected_credentials_revision, state
			 FROM supplier_orders WHERE selected_account_id = ?
			  AND provider_request_no = ? LIMIT 1`,
		)
		.bind(account.id, payload.downstream_order_no)
		.first<{
			id: string;
			upstream_order_id: string | null;
			selected_credentials_revision: number;
			state: string;
		}>();
	if (
		!order ||
		order.selected_credentials_revision !== credential.revision ||
		(order.upstream_order_id !== null &&
			order.upstream_order_id !== String(payload.order_id))
	)
		return rejected("supplier_order_not_found");
	const digest = await sha256Hex(raw);
	const replayId = crypto.randomUUID();
	try {
		await db
			.prepare(
				`INSERT INTO replay_receipts
				 (id, namespace, scope_id, external_id, event_type,
				  payload_digest, status, created_at, updated_at)
				 VALUES (?, 'supplier_callback', ?, ?, ?, ?, 'received', ?, ?)`,
			)
			.bind(
				replayId,
				account.id,
				`${payload.downstream_order_no}:${payload.event}:${digest}`,
				payload.event,
				digest,
				now,
				now,
			)
			.run();
	} catch {
		return Response.json({ ok: true, message: "received" });
	}
	try {
		if (
			["delivered", "completed", "fulfilled"].includes(
				payload.status.toLowerCase(),
			) &&
			payload.fulfillment?.status.toLowerCase() === "delivered"
		) {
			const cards = payload.fulfillment.payload
				.split(/\r?\n/)
				.map((value) => value.trim())
				.filter(Boolean);
			await completeSupplierOrderFromCallback(db, order.id, {
				status: "supplied",
				upstreamOrderId: String(payload.order_id),
				cards,
			});
		}
		await db
			.prepare(
				`UPDATE replay_receipts SET status = 'processed',
				 processed_at = ?, updated_at = ? WHERE id = ?`,
			)
			.bind(now, now, replayId)
			.run();
		return Response.json({ ok: true, message: "received" });
	} catch (error) {
		await db
			.prepare(
				`UPDATE replay_receipts SET status = 'failed',
				 failure_code = ?, updated_at = ? WHERE id = ?`,
			)
			.bind(
				error instanceof DomainError ? error.code : "callback_failed",
				now,
				replayId,
			)
			.run();
		return rejected("callback_failed");
	}
}

function rejected(message: string, status = 200) {
	return Response.json({ ok: false, message }, { status });
}

function constantTimeEqual(left: string, right: string) {
	let difference = left.length ^ right.length;
	const length = Math.max(left.length, right.length);
	for (let index = 0; index < length; index += 1)
		difference |=
			left.charCodeAt(index % Math.max(1, left.length)) ^
			right.charCodeAt(index % Math.max(1, right.length));
	return difference === 0;
}

async function sha256Hex(value: Uint8Array) {
	const digest = new Uint8Array(
		await crypto.subtle.digest("SHA-256", Uint8Array.from(value)),
	);
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}
