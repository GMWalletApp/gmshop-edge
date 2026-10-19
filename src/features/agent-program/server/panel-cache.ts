import { z } from "zod";
import { requestProgram } from "#/features/agent-program/server/client";
import type { RuntimeEnv } from "#/server/runtime/types";

const revisionKey = "agent-program:panel-cache:v1";
const revisionSchema = z.object({
	generation: z.string(),
	pending: z.number().int().nonnegative(),
});

// KV is only a read cache. A primary DB revision makes old entries unreachable
// across POPs immediately after a write, including late in-flight cache fills.
async function revision(env: Pick<RuntimeEnv, "DB" | "CACHE">) {
	const row = await env.DB?.prepare(
		"SELECT value FROM system_settings WHERE key = ?",
	)
		.bind(revisionKey)
		.first<{ value: string }>();
	return row
		? revisionSchema.parse(JSON.parse(row.value))
		: { generation: "0", pending: 0 };
}
export async function panelMutation<T>(
	env: Pick<RuntimeEnv, "DB" | "CACHE">,
	mutate: () => Promise<T>,
): Promise<T> {
	if (!env.CACHE || !env.DB) return mutate();
	const db = env.DB;
	const change = async (delta: number) => {
		const now = Date.now();
		await db
			.prepare(`INSERT INTO system_settings (key,value,is_secret,created_at,updated_at)
   VALUES (?,json_object('generation',?,'pending',?),0,?,?)
   ON CONFLICT(key) DO UPDATE SET value=json_object('generation',?, 'pending',MAX(0, json_extract(value,'$.pending') + ?)),updated_at=?`)
			.bind(
				revisionKey,
				crypto.randomUUID(),
				Math.max(0, delta),
				now,
				now,
				crypto.randomUUID(),
				delta,
				now,
			)
			.run();
	};
	// If invalidation fails, do not attempt the upstream mutation. While a write is
	// pending, reads bypass KV. A failed final invalidation stays fail-safe (pending).
	await change(1);
	try {
		return await mutate();
	} finally {
		await change(-1);
	}
}
export async function requestPanel<T extends object>(
	env: Pick<RuntimeEnv, "DB" | "CACHE">,
	token: string | undefined,
	path: string,
	schema: z.ZodType<T>,
	refresh = false,
): Promise<T & { data_updated_at: number }> {
	const started = performance.now();
	let hit = false;
	try {
		let key: string | undefined;
		if (env.CACHE && env.DB && token?.trim()) {
			try {
				const state = await revision(env);
				if (!state.pending) {
					const digest = await crypto.subtle.digest(
						"SHA-256",
						new TextEncoder().encode(token),
					);
					const scope = Array.from(new Uint8Array(digest), (b) =>
						b.toString(16).padStart(2, "0"),
					).join("");
					key = `${revisionKey}:${scope}:${state.generation}:${path}`;
					if (!refresh) {
						const raw = await env.CACHE.get(key);
						if (raw) {
							const entry = z
								.object({ updatedAt: z.number().int(), data: schema })
								.parse(JSON.parse(raw));
							if (
								entry.updatedAt <= Date.now() &&
								Date.now() - entry.updatedAt < 60_000
							) {
								hit = true;
								return { ...entry.data, data_updated_at: entry.updatedAt };
							}
						}
					}
				}
			} catch {
				key = undefined;
			} // Cache/revision outage never produces fake money.
		}
		const data = await requestProgram(token, path, schema);
		const updatedAt = Date.now();
		// Never retain a transient unavailable profit result for another full TTL.
		const unavailable = JSON.stringify(data).includes('"profit":null');
		if (key && !unavailable) {
			try {
				await env.CACHE?.put(key, JSON.stringify({ updatedAt, data }), {
					expirationTtl: 60,
				});
			} catch {
				/* origin result remains authoritative */
			}
		}
		return { ...data, data_updated_at: updatedAt };
	} finally {
		console.info(
			JSON.stringify({
				event: "agent_program_panel_read",
				endpoint: path.split("?")[0]?.replace(/\d+/g, ":id"),
				duration_ms: Math.round(performance.now() - started),
				cache: hit ? "hit" : "miss",
			}),
		);
	}
}
