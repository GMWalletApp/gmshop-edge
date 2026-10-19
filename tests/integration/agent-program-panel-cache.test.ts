import { Miniflare } from "miniflare";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	it,
	vi,
} from "vitest";
import { z } from "zod";
import {
	panelMutation,
	requestPanel,
} from "#/features/agent-program/server/panel-cache";
import type { RuntimeEnv } from "#/server/runtime/types";

let mf: Miniflare;
let env: Pick<RuntimeEnv, "DB" | "CACHE">;
const schema = z.object({
	agents: z.array(
		z.object({
			id: z.number(),
			sales: z.string(),
			profit: z.string().nullable(),
		}),
	),
});
const data = {
	agents: Array.from({ length: 60 }, (_, i) => ({
		id: i,
		sales: "12345678901234.57",
		profit: i % 2 ? "-0.01" : "99.99",
	})),
};
const token = "synthetic-panel-token";
let fetch: ReturnType<typeof vi.fn>;
beforeAll(async () => {
	mf = new Miniflare({
		modules: true,
		script: "export default {fetch(){return new Response('ok')}}",
		d1Databases: { DB: "panel-cache" },
		kvNamespaces: ["CACHE"],
	});
	const kv = await mf.getKVNamespace("CACHE");
	env = {
		DB: await mf.getD1Database("DB"),
		CACHE: {
			get: (key) => kv.get(key),
			delete: (key) => kv.delete(key),
			put: (key, value, options) => {
				if (typeof value !== "string") throw Error("test expects JSON text");
				return kv.put(key, value, options);
			},
		},
	};
	await env.DB?.exec(
		"CREATE TABLE system_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL,is_secret INTEGER NOT NULL DEFAULT 0,created_at INTEGER,updated_at INTEGER)",
	);
});
afterAll(async () => mf.dispose());
beforeEach(async () => {
	await env.DB?.prepare("DELETE FROM system_settings").run();
	// A new revision isolates old KV entries without pretending KV delete is global.
	await panelMutation(env, async () => undefined);
	fetch = vi.fn(async () => Response.json({ status_code: 0, data }));
	vi.stubGlobal("fetch", fetch);
	vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

it.each([
	"agents?month=2026-10",
	"agents/12?month=2026-10",
	"leaderboard?month=2026-10",
	"rules",
])("cached and bypassed %s preserve every money string and snapshot age", async (path) => {
	const cold = await requestPanel(env, token, path, schema);
	const warm = await requestPanel(env, token, path, schema);
	expect(warm).toEqual(cold);
	expect(warm.agents).toEqual(data.agents);
	expect(fetch).toHaveBeenCalledTimes(1);
	const fresh = await requestPanel(env, token, path, schema, true);
	expect(fresh.agents).toEqual(warm.agents);
	expect(fetch).toHaveBeenCalledTimes(2);
});
it("keys by query and credential scope, expires after 60 seconds, and does not cache unknown profit", async () => {
	await requestPanel(env, token, "agents?month=2026-10", schema);
	await requestPanel(env, token, "agents?month=2026-09", schema);
	await requestPanel(env, "rotated-token", "agents?month=2026-10", schema);
	expect(fetch).toHaveBeenCalledTimes(3);
	const now = Date.now();
	vi.spyOn(Date, "now").mockReturnValue(now + 60_001);
	await requestPanel(env, token, "agents?month=2026-10", schema);
	expect(fetch).toHaveBeenCalledTimes(4);
	fetch.mockImplementation(async () =>
		Response.json({
			status_code: 0,
			data: { agents: [{ id: 1, sales: "0.00", profit: null }] },
		}),
	);
	await requestPanel(env, token, "agents?month=2026-08", schema);
	await requestPanel(env, token, "agents?month=2026-08", schema);
	expect(fetch).toHaveBeenCalledTimes(6);
});
it("invalidates every endpoint/month after mutations and bypasses reads while any mutation is pending", async () => {
	for (const path of [
		"agents?month=2026-10",
		"agents/1?month=2026-09",
		"leaderboard?month=2026-10",
		"rules",
	])
		await requestPanel(env, token, path, schema);
	let finish = () => {};
	let active = false;
	const pending = panelMutation(
		env,
		() =>
			new Promise<void>((resolve) => {
				active = true;
				finish = resolve;
			}),
	);
	await vi.waitFor(() => expect(active).toBe(true));
	await panelMutation(env, async () => undefined); // overlapping write must not clear pending
	await requestPanel(env, token, "rules", schema);
	await requestPanel(env, token, "rules", schema);
	expect(fetch).toHaveBeenCalledTimes(6);
	finish();
	await pending;
	for (const path of [
		"agents?month=2026-10",
		"agents/1?month=2026-09",
		"leaderboard?month=2026-10",
		"rules",
	])
		await requestPanel(env, token, path, schema);
	expect(fetch).toHaveBeenCalledTimes(10);
});
it("a slow pre-mutation cache fill cannot resurrect old data", async () => {
	let release = () => {};
	fetch.mockImplementationOnce(
		() =>
			new Promise<Response>((resolve) => {
				release = () => resolve(Response.json({ status_code: 0, data }));
			}),
	);
	const old = requestPanel(env, token, "agents", schema);
	await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
	const changed = { agents: [{ id: 1, sales: "1.01", profit: "-2.02" }] };
	await panelMutation(env, async () => {
		fetch.mockImplementation(async () =>
			Response.json({ status_code: 0, data: changed }),
		);
	});
	release();
	await old;
	expect(
		(await requestPanel({ ...env }, token, "agents", schema)).agents,
	).toEqual(changed.agents);
});
it("fails open to origin on cache outage, but never to stale data on origin failure", async () => {
	const broken = {
		...env,
		CACHE: {
			...env.CACHE,
			get: async () => {
				throw Error("cache");
			},
			put: async () => {},
			delete: async () => {},
		},
	};
	expect((await requestPanel(broken, token, "rules", schema)).agents).toEqual(
		data.agents,
	);
	await requestPanel(env, token, "rules", schema);
	fetch.mockRejectedValue(Error("origin"));
	await expect(
		requestPanel(env, token, "rules", schema, true),
	).rejects.toMatchObject({ code: "agent_program_unavailable" });
	await expect(
		requestPanel(env, undefined, "rules", schema),
	).rejects.toMatchObject({ code: "agent_program_unconfigured" });
});
it("measures a local 60-row warm read without origin round trips", async () => {
	fetch.mockImplementation(async () => {
		await new Promise((r) => setTimeout(r, 80));
		return Response.json({ status_code: 0, data });
	});
	const start = performance.now();
	await requestPanel(env, token, "agents", schema);
	const cold = performance.now() - start;
	const next = performance.now();
	await requestPanel(env, token, "agents", schema);
	const warm = performance.now() - next;
	console.log(
		`panel-cache agents=60 cold_ms=${cold.toFixed(2)} warm_ms=${warm.toFixed(2)} upstream_requests=${fetch.mock.calls.length}`,
	);
	expect(fetch).toHaveBeenCalledTimes(1);
});

it("does not attempt a mutation if revision invalidation is unavailable", async () => {
	const mutate = vi.fn(async () => undefined);
	const broken = {
		...env,
		DB: {
			prepare: () => {
				throw Error("db unavailable");
			},
			batch: async () => [],
			exec: async () => ({ count: 0, duration: 0 }),
		},
	};
	await expect(panelMutation(broken, mutate)).rejects.toThrow("db unavailable");
	expect(mutate).not.toHaveBeenCalled();
});
it("validates corrupt KV data and timing logs contain no token or money payload", async () => {
	const broken = {
		...env,
		CACHE: {
			get: async () =>
				JSON.stringify({
					updatedAt: Date.now(),
					data: { agents: [{ id: 1, sales: 123, profit: "0" }] },
				}),
			put: async () => {},
			delete: async () => {},
		},
	};
	expect(
		(await requestPanel(broken, token, "agents/123?month=2026-10", schema))
			.agents,
	).toEqual(data.agents);
	const logs = JSON.stringify(vi.mocked(console.info).mock.calls);
	expect(logs).toContain("duration_ms");
	expect(logs).not.toContain(token);
	expect(logs).not.toContain("12345678901234.57");
	expect(logs).not.toContain("agents/123");
});
