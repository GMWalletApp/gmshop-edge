import { randomUUID } from "node:crypto";
import type { NodeDatabase } from "#/server/runtime/node/database";
import type {
	RuntimeQueue,
	RuntimeQueueMessage,
	RuntimeQueueSendOptions,
} from "#/server/runtime/types";

type StoredQueueMessage = {
	id: string;
	body: string;
	attempts: number;
	created_at: number;
	lease_token: string;
};

type Disposition = {
	kind: "pending" | "ack" | "retry";
	delaySeconds?: number;
};

export type NodeQueueMessage<T> = {
	id: string;
	timestamp: Date;
	attempts: number;
	body: T;
	ack(): void;
	retry(options?: { delaySeconds?: number }): void;
};

export type NodeQueueBatch<T> = {
	queue: string;
	messages: NodeQueueMessage<T>[];
	ackAll(): void;
	retryAll(options?: { delaySeconds?: number }): void;
};

export type NodeQueueConsumerOptions = {
	concurrency: number;
	maxAttempts: number;
	pollIntervalMs?: number;
	maxIdlePollIntervalMs?: number;
	leaseMs?: number;
	baseRetryDelayMs?: number;
	maxRetryDelayMs?: number;
	now?: () => number;
};

export class NodeDurableQueue<T = unknown> implements RuntimeQueue<T> {
	private readonly statements: ReturnType<typeof prepareQueueStatements>;
	private readonly consumerWakeups = new Set<() => void>();

	constructor(
		private readonly database: NodeDatabase,
		readonly name: string,
	) {
		initializeQueueSchema(database);
		this.statements = prepareQueueStatements(database);
	}

	async send(message: T, options: RuntimeQueueSendOptions = {}) {
		const id = this.insert(message, options.delaySeconds ?? 0);
		this.wakeConsumers();
		return { outcome: "ok", messageId: id };
	}

	async sendBatch(
		messages: Iterable<RuntimeQueueMessage<T>>,
		options: Pick<RuntimeQueueSendOptions, "delaySeconds"> = {},
	) {
		const inserted = this.database.sqlite.transaction(() =>
			Array.from(messages, (message) =>
				this.insert(
					message.body,
					message.delaySeconds ?? options.delaySeconds ?? 0,
				),
			),
		)();
		if (inserted.length > 0) this.wakeConsumers();
		return { outcome: "ok", messageIds: inserted };
	}

	createConsumer(
		handler: (batch: NodeQueueBatch<T>) => Promise<void>,
		options: NodeQueueConsumerOptions,
	) {
		return new NodeQueueConsumer(this, handler, options);
	}

	claim(limit: number, leaseMs: number, now: number) {
		return this.database.sqlite.transaction(() => {
			const candidates = this.statements.selectCandidates.all(
				this.name,
				now,
				now,
				limit,
			) as { id: string }[];
			return candidates.flatMap(({ id }) => {
				const token = randomUUID();
				const row = this.statements.claim.get(
					token,
					now + leaseMs,
					now,
					id,
					this.name,
					now,
				) as StoredQueueMessage | undefined;
				return row ? [row] : [];
			});
		})();
	}

	ack(id: string, leaseToken: string) {
		this.statements.ack.run(id, this.name, leaseToken);
	}

	extendLease(
		id: string,
		leaseToken: string,
		leaseExpiresAt: number,
		now: number,
	) {
		this.statements.extendLease.run(
			leaseExpiresAt,
			now,
			id,
			this.name,
			leaseToken,
		);
	}

	retry(
		message: StoredQueueMessage,
		options: {
			maxAttempts: number;
			delayMs: number;
			now: number;
			error?: string;
		},
	) {
		const dead = message.attempts >= options.maxAttempts;
		this.statements.retry.run(
			dead ? "dead" : "ready",
			options.now + options.delayMs,
			options.error?.slice(0, 500) ?? null,
			options.now,
			message.id,
			this.name,
			message.lease_token,
		);
	}

	private insert(message: T, delaySeconds: number) {
		const id = randomUUID();
		const now = Date.now();
		this.statements.insert.run(
			id,
			this.name,
			JSON.stringify(message),
			now + Math.max(0, delaySeconds) * 1_000,
			now,
			now,
		);
		return id;
	}

	registerConsumerWakeup(wakeup: () => void) {
		this.consumerWakeups.add(wakeup);
		return () => {
			this.consumerWakeups.delete(wakeup);
		};
	}

	private wakeConsumers() {
		for (const wakeup of this.consumerWakeups) wakeup();
	}
}

export class NodeQueueConsumer<T> {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private readonly inFlight = new Set<Promise<void>>();
	private stopped = true;
	private idlePollIntervalMs = 0;
	private unregisterWakeup: (() => void) | undefined;

	constructor(
		private readonly queue: NodeDurableQueue<T>,
		private readonly handler: (batch: NodeQueueBatch<T>) => Promise<void>,
		private readonly options: NodeQueueConsumerOptions,
	) {}

	start() {
		if (!this.stopped) return;
		this.stopped = false;
		this.idlePollIntervalMs = 0;
		this.unregisterWakeup = this.queue.registerConsumerWakeup(() =>
			this.wake(),
		);
		this.schedule(0);
	}

	async stop() {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.unregisterWakeup?.();
		this.unregisterWakeup = undefined;
		await Promise.allSettled(this.inFlight);
	}

	private schedule(delayMs: number) {
		if (this.stopped) return;
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => this.poll(), delayMs);
		this.timer.unref?.();
	}

	private poll() {
		this.timer = undefined;
		const available = Math.max(
			0,
			this.options.concurrency - this.inFlight.size,
		);
		let claimedCount = 0;
		if (available > 0) {
			const now = (this.options.now ?? Date.now)();
			for (const message of this.queue.claim(
				available,
				this.options.leaseMs ?? 60_000,
				now,
			)) {
				claimedCount += 1;
				const task = this.process(message).finally(() => this.complete(task));
				this.inFlight.add(task);
			}
		}
		if (this.inFlight.size >= this.options.concurrency) return;
		if (claimedCount > 0) {
			this.idlePollIntervalMs = this.minimumPollIntervalMs;
		} else {
			this.idlePollIntervalMs = Math.min(
				this.maximumIdlePollIntervalMs,
				Math.max(this.minimumPollIntervalMs, this.idlePollIntervalMs * 2),
			);
		}
		this.schedule(this.idlePollIntervalMs);
	}

	private wake() {
		if (this.stopped) return;
		this.idlePollIntervalMs = 0;
		this.schedule(0);
	}

	private complete(task: Promise<void>) {
		this.inFlight.delete(task);
		this.wake();
	}

	private get minimumPollIntervalMs() {
		return Math.max(1, this.options.pollIntervalMs ?? 250);
	}

	private get maximumIdlePollIntervalMs() {
		return Math.max(
			this.minimumPollIntervalMs,
			this.options.maxIdlePollIntervalMs ?? 5_000,
		);
	}

	private async process(stored: StoredQueueMessage) {
		const disposition: Disposition = { kind: "pending" };
		let error: unknown;
		// Handlers that outlive the lease (several provider calls with 10 s
		// timeouts) must not be re-claimed by another poll while still running.
		const leaseMs = this.options.leaseMs ?? 60_000;
		const heartbeat = setInterval(
			() => {
				const now = (this.options.now ?? Date.now)();
				this.queue.extendLease(
					stored.id,
					stored.lease_token,
					now + leaseMs,
					now,
				);
			},
			Math.max(1_000, Math.floor(leaseMs / 3)),
		);
		heartbeat.unref?.();
		try {
			const message: NodeQueueMessage<T> = {
				id: stored.id,
				timestamp: new Date(stored.created_at),
				attempts: stored.attempts,
				body: JSON.parse(stored.body) as T,
				ack: () => {
					disposition.kind = "ack";
					delete disposition.delaySeconds;
				},
				retry: (options) => {
					disposition.kind = "retry";
					disposition.delaySeconds = options?.delaySeconds;
				},
			};
			const batch: NodeQueueBatch<T> = {
				queue: this.queue.name,
				messages: [message],
				ackAll: message.ack,
				retryAll: message.retry,
			};
			await this.handler(batch);
		} catch (caught) {
			error = caught;
			disposition.kind = "retry";
		} finally {
			clearInterval(heartbeat);
		}
		if (disposition.kind === "ack") {
			this.queue.ack(stored.id, stored.lease_token);
			return;
		}
		const exponentialMs = Math.min(
			this.options.maxRetryDelayMs ?? 3_600_000,
			(this.options.baseRetryDelayMs ?? 15_000) *
				2 ** Math.max(0, stored.attempts - 1),
		);
		this.queue.retry(stored, {
			maxAttempts: this.options.maxAttempts,
			delayMs:
				disposition.kind === "retry" && disposition.delaySeconds !== undefined
					? Math.max(0, disposition.delaySeconds) * 1_000
					: exponentialMs,
			now: (this.options.now ?? Date.now)(),
			...(error instanceof Error ? { error: error.name } : {}),
		});
	}
}

function initializeQueueSchema(database: NodeDatabase) {
	database.sqlite.run(`CREATE TABLE IF NOT EXISTS node_queue_messages (
		id TEXT PRIMARY KEY NOT NULL,
		queue TEXT NOT NULL,
		body TEXT NOT NULL,
		status TEXT NOT NULL CHECK (status IN ('ready', 'leased', 'dead')),
		attempts INTEGER NOT NULL DEFAULT 0,
		available_at INTEGER NOT NULL,
		lease_token TEXT,
		lease_expires_at INTEGER,
		last_error TEXT,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);`);
	database.sqlite.run(`CREATE INDEX IF NOT EXISTS node_queue_ready_idx
	ON node_queue_messages (queue, status, available_at, created_at);`);
}

function prepareQueueStatements(database: NodeDatabase) {
	return {
		selectCandidates: database.sqlite.prepare(
			`SELECT id FROM node_queue_messages
			 WHERE queue = ? AND available_at <= ?
			 AND (status = 'ready' OR (status = 'leased' AND lease_expires_at <= ?))
			 ORDER BY available_at, created_at, id LIMIT ?`,
		),
		claim: database.sqlite.prepare(
			`UPDATE node_queue_messages
			 SET status = 'leased', lease_token = ?, lease_expires_at = ?,
			 attempts = attempts + 1, updated_at = ?
			 WHERE id = ? AND queue = ?
			 AND (status = 'ready' OR (status = 'leased' AND lease_expires_at <= ?))
			 RETURNING id, body, attempts, created_at, lease_token`,
		),
		ack: database.sqlite.prepare(
			"DELETE FROM node_queue_messages WHERE id = ? AND queue = ? AND status = 'leased' AND lease_token = ?",
		),
		extendLease: database.sqlite.prepare(
			`UPDATE node_queue_messages SET lease_expires_at = ?, updated_at = ?
			 WHERE id = ? AND queue = ? AND status = 'leased' AND lease_token = ?`,
		),
		retry: database.sqlite.prepare(
			`UPDATE node_queue_messages SET status = ?, available_at = ?,
			 lease_token = NULL, lease_expires_at = NULL, last_error = ?, updated_at = ?
			 WHERE id = ? AND queue = ? AND status = 'leased' AND lease_token = ?`,
		),
		insert: database.sqlite.prepare(
			`INSERT INTO node_queue_messages
			 (id, queue, body, status, attempts, available_at, created_at, updated_at)
			 VALUES (?, ?, ?, 'ready', 0, ?, ?, ?)`,
		),
	};
}
