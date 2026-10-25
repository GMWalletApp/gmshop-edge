import { spawn } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

type WranglerConfig = {
	main?: string;
	no_bundle?: boolean;
	d1_databases?: Array<{
		binding?: string;
		database_name?: string;
		database_id?: string;
		migrations_dir?: string;
	}>;
	r2_buckets?: Array<{ binding?: string; bucket_name?: string }>;
	kv_namespaces?: Array<{ binding?: string; id?: string }>;
	queues?: {
		producers?: Array<{ binding?: string; queue?: string }>;
		consumers?: Array<{
			queue?: string;
			max_batch_size?: number;
			max_batch_timeout?: number;
			max_concurrency?: number;
			max_retries?: number;
			retry_delay?: number;
			dead_letter_queue?: string;
		}>;
	};
	triggers?: { crons?: string[] };
};

describe("Cloudflare deployment contract", () => {
	let fixtureDirectory: string;

	beforeEach(async () => {
		fixtureDirectory = await mkdtemp(join(tmpdir(), "gmshop-edge-deploy-"));
		await mkdir(join(fixtureDirectory, "scripts"));
		await mkdir(join(fixtureDirectory, "bin"));
		await writeFile(
			join(fixtureDirectory, "scripts/build.ts"),
			await readFile(
				new URL("../../scripts/build.ts", import.meta.url),
				"utf8",
			),
		);
		await writeFile(
			join(fixtureDirectory, "wrangler.jsonc"),
			await readFile(new URL("../../wrangler.jsonc", import.meta.url), "utf8"),
		);
		const fakeCommand = `#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
const tool = basename(process.argv[1] ?? "");
const args = process.argv.slice(2);
appendFileSync(process.env.COMMAND_LOG, JSON.stringify({ tool, args }) + "\\n");
const databaseMarker = join(process.cwd(), ".database-exists");
const bucketMarker = join(process.cwd(), ".bucket-exists");
const cacheMarker = join(process.cwd(), ".cache-exists");
const queueMarker = join(process.cwd(), "." + (args[2] ?? "queue") + "-exists");
if (tool === "wrangler" && args[0] === "d1" && args[1] === "info") {
	if (process.env.MISSING_D1 === "1" && !existsSync(databaseMarker)) process.exit(1);
	console.log(process.env.INVALID_D1 === "1" ? JSON.stringify({ uuid: "invalid" }) : JSON.stringify({ uuid: "01234567-89ab-4def-8123-456789abcdef" }));
}
if (tool === "wrangler" && args[0] === "d1" && args[1] === "create") {
	writeFileSync(databaseMarker, "");
	if (process.env.CONCURRENT_CREATE === "1") process.exit(1);
}
if (tool === "wrangler" && args[0] === "r2" && args[1] === "bucket" && args[2] === "info" && process.env.MISSING_R2 === "1" && !existsSync(bucketMarker)) process.exit(1);
if (tool === "wrangler" && args[0] === "r2" && args[1] === "bucket" && args[2] === "create") {
	writeFileSync(bucketMarker, "");
	if (process.env.CONCURRENT_CREATE === "1") process.exit(1);
}
if (tool === "wrangler" && args[0] === "kv" && args[1] === "namespace" && args[2] === "list") {
	if (process.env.INVALID_KV === "1") console.log(JSON.stringify({ invalid: true }));
	else {
		const exists = process.env.MISSING_KV !== "1" || existsSync(cacheMarker);
		console.log(JSON.stringify(exists ? [{ id: "0123456789abcdef0123456789abcdef", title: "gmshop-edge-cache" }] : []));
	}
}
if (tool === "wrangler" && args[0] === "kv" && args[1] === "namespace" && args[2] === "create") {
	writeFileSync(cacheMarker, "");
	if (process.env.CONCURRENT_CREATE === "1") process.exit(1);
}
if (tool === "wrangler" && args[0] === "queues" && args[1] === "info" && process.env.MISSING_QUEUES === "1" && !existsSync(queueMarker)) process.exit(1);
if (tool === "wrangler" && args[0] === "queues" && args[1] === "create") {
	writeFileSync(queueMarker, "");
	if (process.env.CONCURRENT_CREATE === "1") process.exit(1);
}
if (tool === "vite" && process.env.WORKERS_CI === "1") {
	mkdirSync(join(process.cwd(), "dist/server"), { recursive: true });
	if (process.env.INVALID_GENERATED_CONFIG === "1") writeFileSync(join(process.cwd(), "dist/server/wrangler.json"), JSON.stringify({ d1_databases: [] }));
	else writeFileSync(join(process.cwd(), "dist/server/wrangler.json"), JSON.stringify({ d1_databases: [{ binding: "DB" }], kv_namespaces: [{ binding: "CACHE" }] }));
}
`;
		for (const command of ["vite", "wrangler"]) {
			const path = join(fixtureDirectory, "bin", command);
			await writeFile(path, fakeCommand);
			await chmod(path, 0o755);
		}
	});

	afterEach(async () => rm(fixtureDirectory, { recursive: true, force: true }));

	it("declares every runtime binding used by GMShop Edge", async () => {
		const config = JSON.parse(
			await readFile(new URL("../../wrangler.jsonc", import.meta.url), "utf8"),
		) as WranglerConfig;

		expect(config.main).toBe("src/server-entry.ts");
		expect(config.d1_databases).toEqual([
			{
				binding: "DB",
				database_name: "gmshop-edge",
				migrations_dir: "drizzle",
			},
		]);
		expect(config.r2_buckets).toEqual([
			{ binding: "FILES", bucket_name: "gmshop-edge-files" },
		]);
		expect(config.kv_namespaces).toEqual([{ binding: "CACHE" }]);
		expect(config.queues?.producers).toEqual([
			{ binding: "COMMERCE_QUEUE", queue: "gmshop-edge-commerce" },
		]);
		expect(config.queues?.consumers).toEqual([
			{
				queue: "gmshop-edge-commerce",
				max_batch_size: 10,
				max_batch_timeout: 1,
				max_concurrency: 4,
				max_retries: 8,
				retry_delay: 15,
				dead_letter_queue: "gmshop-edge-commerce-dlq",
			},
		]);
		expect(config.triggers?.crons).toEqual(["* * * * *"]);
	});

	it("keeps deployment commands direct", async () => {
		const packageJson = JSON.parse(
			await readFile(new URL("../../package.json", import.meta.url), "utf8"),
		) as { scripts?: Record<string, string> };
		expect(packageJson.scripts?.build).toBe("bun run scripts/build.ts");
		expect(packageJson.scripts?.predeploy).toBe(
			"bun run scripts/build.ts --remote",
		);
		expect(packageJson.scripts?.deploy).toBe("wrangler deploy");
		expect(packageJson.scripts?.["db:migrate:remote"]).toBe(
			"wrangler d1 migrations apply DB --remote",
		);
	});

	it("creates missing named storage before migration and build", async () => {
		const originalConfig = await readFile(
			join(fixtureDirectory, "wrangler.jsonc"),
			"utf8",
		);
		const result = await runFixture(fixtureDirectory, {
			MISSING_D1: "1",
			MISSING_KV: "1",
			MISSING_R2: "1",
			MISSING_QUEUES: "1",
			WORKERS_CI: "1",
		});
		expect(result).toBe(0);
		const commands = await readCommands(fixtureDirectory);
		const createIndex = commands.findIndex(
			({ tool, args }) =>
				tool === "wrangler" && args.join(" ") === "d1 create gmshop-edge",
		);
		const migrationIndex = commands.findIndex(
			({ tool, args }) =>
				tool === "wrangler" &&
				args.join(" ") === "d1 migrations apply gmshop-edge --remote",
		);
		const buildIndex = commands.findIndex(
			({ tool, args }) => tool === "vite" && args.join(" ") === "build",
		);
		expect(createIndex).toBeGreaterThanOrEqual(0);
		expect(
			commands.some(
				({ args }) =>
					args.join(" ") === "kv namespace create gmshop-edge-cache",
			),
		).toBe(true);
		expect(
			commands.some(
				({ args }) => args.join(" ") === "r2 bucket create gmshop-edge-files",
			),
		).toBe(true);
		expect(
			commands.some(
				({ args }) => args.join(" ") === "queues create gmshop-edge-commerce",
			),
		).toBe(true);
		expect(
			commands.some(
				({ args }) =>
					args.join(" ") === "queues create gmshop-edge-commerce-dlq",
			),
		).toBe(true);
		expect(migrationIndex).toBeGreaterThan(createIndex);
		expect(buildIndex).toBeGreaterThan(migrationIndex);
		expect(
			await readFile(join(fixtureDirectory, "wrangler.jsonc"), "utf8"),
		).toBe(originalConfig);
		expect(
			JSON.parse(
				await readFile(
					join(fixtureDirectory, "dist/server/wrangler.json"),
					"utf8",
				),
			),
		).toMatchObject({
			d1_databases: [
				{
					binding: "DB",
					database_id: "01234567-89ab-4def-8123-456789abcdef",
				},
			],
			kv_namespaces: [
				{
					binding: "CACHE",
					id: "0123456789abcdef0123456789abcdef",
				},
			],
		});
	});

	it("recovers when another build creates resources concurrently", async () => {
		expect(
			await runFixture(fixtureDirectory, {
				CONCURRENT_CREATE: "1",
				MISSING_D1: "1",
				MISSING_KV: "1",
				MISSING_QUEUES: "1",
				MISSING_R2: "1",
				WORKERS_CI: "1",
			}),
		).toBe(0);
	});

	it("reuses existing D1, KV, R2, and Queue resources", async () => {
		expect(await runFixture(fixtureDirectory, { WORKERS_CI: "1" })).toBe(0);
		const commands = await readCommands(fixtureDirectory);
		expect(commands.some(({ args }) => args.includes("create"))).toBe(false);
		expect(
			commands.some(({ args }) => args.join(" ") === "kv namespace list"),
		).toBe(true);
	});

	it("rejects malformed Wrangler resource responses", async () => {
		expect(
			await runFixture(fixtureDirectory, {
				INVALID_D1: "1",
				WORKERS_CI: "1",
			}),
		).not.toBe(0);
		expect(
			await runFixture(fixtureDirectory, {
				INVALID_KV: "1",
				WORKERS_CI: "1",
			}),
		).not.toBe(0);
	});

	it("rejects a generated config without the required bindings", async () => {
		expect(
			await runFixture(fixtureDirectory, {
				INVALID_GENERATED_CONFIG: "1",
				WORKERS_CI: "1",
			}),
		).not.toBe(0);
	});

	it("keeps an ordinary build local", async () => {
		expect(await runFixture(fixtureDirectory)).toBe(0);
		expect(await readCommands(fixtureDirectory)).toEqual([
			{ tool: "vite", args: ["build"] },
		]);
	});

	it("keeps TanStack Start on its streaming SSR handler", async () => {
		const source = await readFile(
			new URL("../../src/server-entry.ts", import.meta.url),
			"utf8",
		);
		expect(source).toContain("createStartHandler(defaultStreamHandler)");
		expect(source).not.toContain("renderToString");
	});
});

type Command = { tool: string; args: string[] };

async function runFixture(
	directory: string,
	environment: Record<string, string> = {},
) {
	const child = spawn("bun", [join(directory, "scripts/build.ts")], {
		cwd: directory,
		env: {
			...process.env,
			...environment,
			COMMAND_LOG: join(directory, "commands.ndjson"),
			PATH: `${join(directory, "bin")}:${process.env.PATH ?? ""}`,
		},
		stdio: "ignore",
	});
	return new Promise<number>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => resolve(code ?? 1));
	});
}

async function readCommands(directory: string): Promise<Command[]> {
	const source = await readFile(join(directory, "commands.ndjson"), "utf8");
	return source
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Command);
}
