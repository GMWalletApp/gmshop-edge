import { z } from "zod";
import { DomainError } from "#/lib/domain-error";
import { currentRuntimeEnv } from "#/server/runtime/context";
import type { AgentAccessKind } from "../products";

export const agentOrigin = "https://lsrai.shop";
const responseSchema = z.object({
	state: z.enum([
		"eligible",
		"binding_required",
		"already_active",
		"active",
		"provisioning",
		"revoked",
	]),
	initialPasswordValid: z.boolean().optional(),
	userId: z.number().int().positive().optional(),
	domain: z
		.string()
		.regex(/^[a-z0-9-]+\.lsrai\.shop$/)
		.optional(),
	ticket: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.optional(),
	purpose: z.enum(["bind", "activate"]).optional(),
});
export type AgentResult = z.infer<typeof responseSchema>;
export type AgentRequest = {
	operation: "check" | "provision" | "status" | "access" | "revoke";
	sourceUserId: string;
	email: string;
	kind: AgentAccessKind;
	orderItemId?: string;
	initialPassword?: string;
	paidAmount?: string;
};
export type AgentTransport = (input: AgentRequest) => Promise<AgentResult>;
export async function requireAgentAccessEnabled(db: D1Database) {
	const row = await db
		.prepare(
			"SELECT value FROM system_settings WHERE key='agent_access.enabled'",
		)
		.first<{ value: string }>();
	if (row?.value !== "true")
		throw new DomainError(
			"agent_access_disabled",
			409,
			"Agent access sales are not enabled",
		);
}
const hex = (bytes: ArrayBuffer) =>
	Array.from(new Uint8Array(bytes), (v) =>
		v.toString(16).padStart(2, "0"),
	).join("");
export async function callAgent(input: AgentRequest): Promise<AgentResult> {
	const secret = currentRuntimeEnv().AGENT_ACCESS_SIGNING_KEY;
	if (!secret || secret.length < 32)
		throw new DomainError(
			"agent_access_unavailable",
			503,
			"Agent access is unavailable",
		);
	const path = "/api/v1/internal/agent-access";
	const body = JSON.stringify(input),
		stamp = String(Math.floor(Date.now() / 1000));
	const nonce = hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
	const encoder = new TextEncoder();
	const hash = hex(await crypto.subtle.digest("SHA-256", encoder.encode(body)));
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = hex(
		await crypto.subtle.sign(
			"HMAC",
			key,
			encoder.encode(`POST\n${path}\n${stamp}\n${nonce}\n${hash}`),
		),
	);
	const response = await fetch(agentOrigin + path, {
		method: "POST",
		body,
		// workerd rejects redirect:"error" before sending. Manual + !ok rejects 3xx safely.
		redirect: "manual",
		signal: AbortSignal.timeout(20000),
		headers: {
			"Content-Type": "application/json",
			"X-Agent-Timestamp": stamp,
			"X-Agent-Nonce": nonce,
			"X-Agent-Signature": signature,
		},
	});
	if (!response.ok)
		throw new DomainError(
			"agent_access_unavailable",
			409,
			"Opening requires retry or support; do not pay again",
		);
	return responseSchema.parse(await response.json());
}
export function accessURL(result: AgentResult) {
	if (result.ticket && result.purpose)
		return `${agentOrigin}/agent-access#${new URLSearchParams({ ticket: result.ticket, purpose: result.purpose })}`;
	return `${agentOrigin}/auth/login`;
}
