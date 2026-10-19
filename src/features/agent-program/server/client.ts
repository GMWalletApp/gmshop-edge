import type { z } from "zod";
import { DomainError } from "#/lib/domain-error";

// Server-only: fixed origin, no caller-selected URL and no forwarded browser credentials.
export async function requestProgram<T>(
	token: string | undefined,
	path: string,
	schema: z.ZodType<T>,
	method: "GET" | "POST" | "PATCH" = "GET",
	body?: unknown,
): Promise<T> {
	const started = performance.now();
	let ok = false;
	try {
		if (!token?.trim())
			throw new DomainError(
				"agent_program_unconfigured",
				503,
				"Agent program is unavailable",
			);
		try {
			const response = await fetch(
				`https://lsrai.shop/api/internal/reseller-program/${path}`,
				{
					method,
					credentials: "omit",
					redirect: "manual",
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
					},
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
					signal: AbortSignal.timeout(20000),
				},
			);
			if (!response.ok) throw new Error();
			const envelope: unknown = await response.json();
			if (
				typeof envelope !== "object" ||
				envelope === null ||
				!("status_code" in envelope) ||
				envelope.status_code !== 0 ||
				!("data" in envelope)
			)
				throw new Error();
			const result = schema.parse(envelope.data);
			ok = true;
			return result;
		} catch {
			throw new DomainError(
				"agent_program_unavailable",
				502,
				"Agent program request failed",
			);
		}
	} finally {
		console.info(
			JSON.stringify({
				event: "agent_program_origin_request",
				endpoint: path.split("?")[0]?.replace(/\d+/g, ":id"),
				method,
				ok,
				duration_ms: Math.round(performance.now() - started),
			}),
		);
	}
}
