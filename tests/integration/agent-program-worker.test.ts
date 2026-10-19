import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFetchMock, Miniflare } from "miniflare";
import { afterAll, beforeAll, expect, it } from "vitest";

let directory: string;
let script: string;
beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), "agent-program-worker-test-"));
	script = join(directory, "worker.mjs");
	execFileSync(
		"bun",
		[
			"build",
			"tests/fixtures/agent-program-worker.ts",
			"--target=node",
			"--external=node:async_hooks",
			`--outfile=${script}`,
		],
		{ stdio: "pipe" },
	);
});
afterAll(async () => {
	await rm(directory, { recursive: true, force: true });
});
async function probe(status: number, headers: Record<string, string> = {}) {
	const mock = createFetchMock();
	mock.disableNetConnect();
	mock
		.get("https://lsrai.shop")
		.intercept({ path: "/api/internal/reseller-program/rules", method: "GET" })
		.reply(
			status,
			JSON.stringify({ status_code: 0, data: { enabled: true } }),
			{ headers },
		);
	const config = JSON.parse(readFileSync("wrangler.jsonc", "utf8"));
	const mf = new Miniflare({
		modules: true,
		script: await readFile(script, "utf8"),
		compatibilityDate: config.compatibility_date,
		compatibilityFlags: config.compatibility_flags,
		bindings: {
			PROGRAM_TOKEN: "synthetic-program-token",
		},
		fetchMock: mock,
	});
	try {
		return await (await mf.dispatchFetch("http://localhost/check")).json();
	} finally {
		await mf.dispose();
	}
}
it("executes the real program transport with manual redirects in workerd", async () => {
	expect(await probe(200, { "content-type": "application/json" })).toEqual({
		ok: true,
		data: { enabled: true },
	});
});
it("refuses redirects without forwarding bearer credentials", async () => {
	expect(
		await probe(302, { location: "https://untrusted.example.test/" }),
	).toMatchObject({ ok: false, code: "agent_program_unavailable" });
});
