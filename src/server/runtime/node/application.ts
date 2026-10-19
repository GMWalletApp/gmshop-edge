import { access, chmod, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { handleQueue } from "#/server/queue";
import type { CommerceQueueMessage } from "#/server/queue/types";
import { runWithRuntimeEnv } from "#/server/runtime/context";
import type { RuntimeEnv } from "#/server/runtime/types";
import { runScheduledCommerceWork } from "#/server/scheduled";
import { NodeMemoryCache } from "./cache";
import { resolveNodeDataLayout } from "./data-layout";
import { openNodeDatabase } from "./database";
import { NodeRuntimeLifecycle } from "./lifecycle";
import { applyNodeMigrations } from "./migrations";
import { NodeObjectStorage } from "./object-storage";
import { NodeDurableQueue } from "./queue";
import { NodeScheduler } from "./scheduler";

const COMMERCE_QUEUE_NAME = "gmshop-edge-commerce";

export type NodeApplication = {
	env: RuntimeEnv;
	dataDirectory: string;
	stop(): Promise<void>;
};

export async function createNodeApplication(
	dataDirectory = process.env.GMSHOP_DATA_DIR,
): Promise<NodeApplication> {
	if (!dataDirectory)
		throw new Error(
			"GMSHOP_DATA_DIR must point to a persistent data directory",
		);

	const layout = resolveNodeDataLayout(dataDirectory);
	await mkdir(layout.root, { recursive: true, mode: 0o700 });
	await chmod(layout.root, 0o700);
	if (await pathExists(layout.maintenanceLock))
		throw new Error(
			`Data maintenance is active for ${layout.root}; start the server after it completes`,
		);
	const database = openNodeDatabase(layout.database);
	try {
		await applyNodeMigrations(database, resolve(process.cwd(), "drizzle"));
	} catch (error) {
		database.close();
		throw error;
	}

	const commerceQueue = new NodeDurableQueue<CommerceQueueMessage>(
		database,
		COMMERCE_QUEUE_NAME,
	);
	const pendingTasks = new Set<Promise<unknown>>();
	const env: RuntimeEnv = {
		runtime: "bun",
		AGENT_ACCESS_SIGNING_KEY: process.env.AGENT_ACCESS_SIGNING_KEY,
		AGENT_SHOP_PROGRAM_TOKEN: process.env.AGENT_SHOP_PROGRAM_TOKEN,
		AGENT_PROGRAM_PROFIT_TOKEN: process.env.AGENT_PROGRAM_PROFIT_TOKEN,
		DB: database,
		CACHE: new NodeMemoryCache(),
		FILES: new NodeObjectStorage(layout.objects),
		COMMERCE_QUEUE: commerceQueue,
		waitUntil(promise) {
			pendingTasks.add(promise);
			void promise
				.catch((error: unknown) => {
					console.error(
						JSON.stringify({
							event: "bun_background_task_failed",
							error: error instanceof Error ? error.name : "UnknownError",
						}),
					);
				})
				.finally(() => pendingTasks.delete(promise));
		},
	};
	const workerEnv = env as unknown as Env;
	const consume = (batch: unknown) =>
		runWithRuntimeEnv(env, () =>
			handleQueue(batch as MessageBatch<CommerceQueueMessage>, workerEnv),
		);
	const commerceConsumer = commerceQueue.createConsumer(consume, {
		concurrency: 4,
		maxAttempts: 8,
		baseRetryDelayMs: 15_000,
	});
	const scheduler = new NodeScheduler((scheduledAt) =>
		runWithRuntimeEnv(env, () =>
			runScheduledCommerceWork(workerEnv, "* * * * *", scheduledAt).then(
				() => undefined,
			),
		),
	);
	const lifecycle = new NodeRuntimeLifecycle([
		{
			start() {},
			async stop() {
				await Promise.allSettled(pendingTasks);
				database.close();
			},
		},
		commerceConsumer,
		scheduler,
	]);
	await lifecycle.start();
	const removeSignalHandlers = lifecycle.installSignalHandlers();

	return {
		env,
		dataDirectory: layout.root,
		async stop() {
			removeSignalHandlers();
			await lifecycle.stop();
		},
	};
}

async function pathExists(path: string) {
	try {
		await access(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}
