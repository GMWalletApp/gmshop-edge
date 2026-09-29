/// <reference types="bun-types-no-globals/lib/index.d.ts" />

import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { JSONC } from "bun";

type WranglerConfig = {
	name?: string;
	d1_databases?: Array<{ binding?: string; database_name?: string }>;
	kv_namespaces?: Array<{ binding?: string }>;
	r2_buckets?: Array<{ bucket_name?: string }>;
	queues?: {
		producers?: Array<{ queue?: string }>;
		consumers?: Array<{ queue?: string; dead_letter_queue?: string }>;
	};
};

const wranglerConfigPath = fileURLToPath(
	new URL("../wrangler.jsonc", import.meta.url),
);
const generatedWranglerConfigPath = fileURLToPath(
	new URL("../dist/server/wrangler.json", import.meta.url),
);

function run(command: string, arguments_: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, arguments_, { stdio: "inherit" });
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(`${command} exited with code ${code ?? 1}.`));
		});
	});
}

function capture(command: string, arguments_: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, arguments_, {
			stdio: ["ignore", "pipe", "ignore"],
		});
		let output = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			output += chunk;
		});
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0) {
				resolve(output);
				return;
			}
			reject(new Error(`${command} exited with code ${code ?? 1}.`));
		});
	});
}

async function captureIfExists(
	command: string,
	arguments_: string[],
): Promise<string | undefined> {
	try {
		return await capture(command, arguments_);
	} catch {
		return undefined;
	}
}

async function resourceExists(arguments_: string[]): Promise<boolean> {
	return new Promise((resolve, reject) => {
		const child = spawn("wrangler", arguments_, { stdio: "ignore" });
		child.once("error", reject);
		child.once("close", (code) => resolve(code === 0));
	});
}

async function ensureNamedResource(
	infoArguments: string[],
	createArguments: string[],
): Promise<void> {
	if (await resourceExists(infoArguments)) return;
	try {
		await run("wrangler", createArguments);
	} catch (error) {
		if (await resourceExists(infoArguments)) return;
		throw error;
	}
}

function parseD1DatabaseId(source: string): string {
	const value: unknown = JSON.parse(source);
	if (
		typeof value !== "object" ||
		value === null ||
		!("uuid" in value) ||
		typeof value.uuid !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
			value.uuid,
		)
	) {
		throw new Error("Wrangler returned an invalid D1 database response.");
	}
	return value.uuid;
}

async function ensureD1Database(name: string): Promise<string> {
	const infoArguments = ["d1", "info", name, "--json"];
	const existingDatabase = await captureIfExists("wrangler", infoArguments);
	if (existingDatabase !== undefined)
		return parseD1DatabaseId(existingDatabase);

	try {
		await run("wrangler", ["d1", "create", name]);
	} catch (error) {
		try {
			return parseD1DatabaseId(await capture("wrangler", infoArguments));
		} catch {
			throw error;
		}
	}
	return parseD1DatabaseId(await capture("wrangler", infoArguments));
}

function parseKvNamespaceId(source: string, title: string): string | undefined {
	const value: unknown = JSON.parse(source);
	if (!Array.isArray(value)) {
		throw new Error("Wrangler returned an invalid KV namespace response.");
	}
	for (const namespace of value) {
		if (
			typeof namespace === "object" &&
			namespace !== null &&
			"title" in namespace &&
			namespace.title === title &&
			"id" in namespace &&
			typeof namespace.id === "string" &&
			/^[0-9a-f]{32}$/i.test(namespace.id)
		) {
			return namespace.id;
		}
	}
	return undefined;
}

async function findKvNamespaceId(title: string): Promise<string | undefined> {
	return parseKvNamespaceId(
		await capture("wrangler", ["kv", "namespace", "list"]),
		title,
	);
}

async function ensureKvNamespace(title: string): Promise<string> {
	const existingId = await findKvNamespaceId(title);
	if (existingId) return existingId;
	try {
		await run("wrangler", ["kv", "namespace", "create", title]);
	} catch (error) {
		const concurrentlyCreatedId = await findKvNamespaceId(title);
		if (concurrentlyCreatedId) return concurrentlyCreatedId;
		throw error;
	}
	const createdId = await findKvNamespaceId(title);
	if (!createdId) {
		throw new Error(`KV namespace ${title} was not found after creation.`);
	}
	return createdId;
}

async function bindGeneratedStorage(
	databaseId: string,
	cacheId: string,
): Promise<void> {
	const config: unknown = JSON.parse(
		await readFile(generatedWranglerConfigPath, "utf8"),
	);
	if (typeof config !== "object" || config === null) {
		throw new Error("Vite returned an invalid Wrangler deployment config.");
	}
	const databases = "d1_databases" in config ? config.d1_databases : undefined;
	const namespaces =
		"kv_namespaces" in config ? config.kv_namespaces : undefined;
	if (!Array.isArray(databases) || !Array.isArray(namespaces)) {
		throw new Error(
			"Generated Wrangler config is missing DB or CACHE bindings.",
		);
	}
	const database = databases.find(
		(value) =>
			typeof value === "object" &&
			value !== null &&
			"binding" in value &&
			value.binding === "DB",
	);
	const cache = namespaces.find(
		(value) =>
			typeof value === "object" &&
			value !== null &&
			"binding" in value &&
			value.binding === "CACHE",
	);
	if (!database || !cache) {
		throw new Error(
			"Generated Wrangler config is missing DB or CACHE bindings.",
		);
	}
	database.database_id = databaseId;
	cache.id = cacheId;
	await writeFile(generatedWranglerConfigPath, JSON.stringify(config));
}

async function buildForWorkers(): Promise<void> {
	const config = JSONC.parse(
		await readFile(wranglerConfigPath, "utf8"),
	) as WranglerConfig;
	const database = config.d1_databases?.find(
		(binding) => binding.binding === "DB",
	);
	const cache = config.kv_namespaces?.find(
		(binding) => binding.binding === "CACHE",
	);
	if (!database || !cache || typeof database.database_name !== "string") {
		throw new Error("Missing DB or CACHE binding in wrangler.jsonc.");
	}

	const databaseName = database.database_name;
	const cacheName = "gmshop-edge-cache";
	const bucketNames = (config.r2_buckets ?? []).flatMap((bucket) =>
		bucket.bucket_name ? [bucket.bucket_name] : [],
	);
	const queueNames = [
		...(config.queues?.producers ?? []).flatMap((producer) =>
			producer.queue ? [producer.queue] : [],
		),
		...(config.queues?.consumers ?? []).flatMap((consumer) => [
			...(consumer.queue ? [consumer.queue] : []),
			...(consumer.dead_letter_queue ? [consumer.dead_letter_queue] : []),
		]),
	];

	const [databaseId, cacheId] = await Promise.all([
		ensureD1Database(databaseName),
		ensureKvNamespace(cacheName),
		...bucketNames.map((name) =>
			ensureNamedResource(
				["r2", "bucket", "info", name, "--json"],
				["r2", "bucket", "create", name],
			),
		),
		...[...new Set(queueNames)].map((name) =>
			ensureNamedResource(["queues", "info", name], ["queues", "create", name]),
		),
	]);
	await run("wrangler", [
		"d1",
		"migrations",
		"apply",
		databaseName,
		"--remote",
	]);
	await run("vite", ["build"]);
	await bindGeneratedStorage(databaseId, cacheId);
}

if (process.argv.includes("--remote") || process.env.WORKERS_CI === "1") {
	await buildForWorkers();
} else {
	await run("vite", ["build"]);
}
