import { DomainError } from "#/lib/domain-error";
import { walletAmountSchema } from "../schema";

const WALLET_MUTATION_ATTEMPTS = 10;
const int64 = 9_223_372_036_854_775_807n;

export type WalletMutation = {
	userId: string;
	direction: "credit" | "debit";
	amountMinor: string;
	currency: string;
	sourceType:
		| "topup"
		| "adjustment"
		| "shop_order"
		| "supplier_order"
		| "refund";
	sourceId: string;
	idempotencyKey: string;
	reason?: string | null;
	actorUserId?: string | null;
};

export type WalletBalanceSnapshot = {
	balanceMinor: string;
	balanceVersion: number;
};

/**
 * Compute the balance a mutation produces from a snapshot, enforcing the
 * non-negative and int64 invariants before any statement is built.
 */
function applyWalletMutation(
	snapshot: WalletBalanceSnapshot,
	direction: WalletMutation["direction"],
	amountMinor: string,
) {
	const amount = BigInt(walletAmountSchema.parse(amountMinor));
	if (amount === 0n)
		throw new DomainError(
			"wallet_amount_invalid",
			400,
			"Amount must be positive",
		);
	const before = BigInt(snapshot.balanceMinor);
	if (direction === "debit" && before < amount)
		throw new DomainError(
			"wallet_insufficient_balance",
			409,
			"Insufficient balance",
		);
	const after = direction === "credit" ? before + amount : before - amount;
	if (after > int64)
		throw new DomainError(
			"wallet_balance_limit",
			409,
			"Balance limit exceeded",
		);
	return { amount, before, after, nextVersion: snapshot.balanceVersion + 1 };
}

/**
 * Build the two statements that move a wallet balance atomically inside a
 * caller-owned batch. Both statements are guarded by the balance snapshot the
 * caller read (old version AND old balance), and the balance update
 * additionally requires the ledger row of this very mutation to exist, so the
 * pair either applies together or not at all. The ledger row is inserted first
 * on purpose: a concurrent writer that already advanced the balance makes both
 * predicates false, which prevents a "phantom" ledger row describing a change
 * that never reached the balance. Callers must check that the returned update
 * statement changed exactly one row.
 */
export function walletMutationStatements(
	db: D1Database,
	input: WalletMutation,
	snapshot: WalletBalanceSnapshot,
	options: {
		now: number;
		entryId?: string;
		guardSql?: string;
		guardBindings?: readonly (string | number | null)[];
		/**
		 * Debits and top-ups require an enabled account; refunds and other
		 * credits owed to a suspended customer must still be booked.
		 */
		requireEnabled?: boolean;
	},
) {
	const { amount, before, after, nextVersion } = applyWalletMutation(
		snapshot,
		input.direction,
		input.amountMinor,
	);
	const entryId = options.entryId ?? crypto.randomUUID();
	const enabledSql = options.requireEnabled === false ? "" : " AND enabled = 1";
	const guardSql = options.guardSql ? ` AND ${options.guardSql}` : "";
	const guardBindings = options.guardBindings ?? [];
	return {
		entryId,
		balanceAfter: after.toString(),
		insert: db
			.prepare(
				`INSERT INTO wallet_entries
				 (id, user_id, direction, amount_minor, balance_before_minor,
				  balance_after_minor, currency, source_type, source_id,
				  idempotency_key, reason, actor_user_id, created_at)
				 SELECT ?, id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
				 FROM users WHERE id = ?${enabledSql} AND balance_version = ?
				 AND balance_minor = ?${guardSql}`,
			)
			.bind(
				entryId,
				input.direction,
				amount.toString(),
				before.toString(),
				after.toString(),
				input.currency,
				input.sourceType,
				input.sourceId,
				input.idempotencyKey,
				input.reason ?? null,
				input.actorUserId ?? null,
				options.now,
				input.userId,
				snapshot.balanceVersion,
				snapshot.balanceMinor,
				...guardBindings,
			),
		update: db
			.prepare(
				`UPDATE users SET balance_minor = ?, balance_version = ?, updated_at = ?
				 WHERE id = ?${enabledSql} AND balance_version = ? AND balance_minor = ?
				 AND EXISTS (SELECT 1 FROM wallet_entries WHERE id = ?)${guardSql}`,
			)
			.bind(
				after.toString(),
				nextVersion,
				options.now,
				input.userId,
				snapshot.balanceVersion,
				snapshot.balanceMinor,
				entryId,
				...guardBindings,
			),
	};
}

export async function loadWalletSnapshot(db: D1Database, userId: string) {
	const user = await db
		.prepare(
			"SELECT balance_minor, balance_version FROM users WHERE id = ? AND enabled = 1 LIMIT 1",
		)
		.bind(userId)
		.first<{ balance_minor: string; balance_version: number }>();
	if (!user)
		throw new DomainError("wallet_user_not_found", 404, "User not found");
	return {
		balanceMinor: user.balance_minor,
		balanceVersion: user.balance_version,
	} satisfies WalletBalanceSnapshot;
}

export async function mutateWallet(db: D1Database, input: WalletMutation) {
	const replay = await findWalletEntry(db, input.idempotencyKey);
	if (replay) return { ...replay, duplicate: true as const };
	for (let attempt = 0; attempt < WALLET_MUTATION_ATTEMPTS; attempt += 1) {
		// Optimistic concurrency: back off briefly so concurrent writers on one
		// balance do not keep colliding on the same snapshot.
		if (attempt > 0)
			await new Promise((resolve) => setTimeout(resolve, 5 * attempt));
		const snapshot = await loadWalletSnapshot(db, input.userId);
		const mutation = walletMutationStatements(db, input, snapshot, {
			now: Date.now(),
		});
		try {
			const results = await db.batch([mutation.insert, mutation.update]);
			if (Number(results[1]?.meta.changes ?? 0) === 1)
				return {
					id: mutation.entryId,
					balanceMinor: mutation.balanceAfter,
					duplicate: false as const,
				};
		} catch (error) {
			const duplicate = await findWalletEntry(db, input.idempotencyKey);
			if (duplicate) return { ...duplicate, duplicate: true as const };
			throw error;
		}
	}
	throw new DomainError("wallet_conflict", 409, "Balance changed; retry");
}

export async function getWallet(db: D1Database, userId: string) {
	type WalletEntryRow = {
		id: string;
		direction: "credit" | "debit";
		amount_minor: string;
		balance_after_minor: string;
		currency: string;
		source_type: string;
		source_id: string;
		reason: string | null;
		created_at: number;
	};
	const [user, settings, entries] = await Promise.all([
		db
			.prepare("SELECT balance_minor FROM users WHERE id = ? LIMIT 1")
			.bind(userId)
			.first<{ balance_minor: string }>(),
		db
			.prepare(
				"SELECT key, value FROM system_settings WHERE key IN ('commerce.default_currency', 'commerce.currency_decimals')",
			)
			.all<{ key: string; value: string }>(),
		db
			.prepare(
				"SELECT id, direction, amount_minor, balance_after_minor, currency, source_type, source_id, reason, created_at FROM wallet_entries WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 100",
			)
			.bind(userId)
			.all<WalletEntryRow>(),
	]);
	if (!user)
		throw new DomainError("wallet_user_not_found", 404, "User not found");
	const values = new Map(
		settings.results.map((row) => [row.key, JSON.parse(row.value)]),
	);
	return {
		balanceMinor: user.balance_minor,
		currency: String(values.get("commerce.default_currency") ?? "USD"),
		currencyDecimals: Number(values.get("commerce.currency_decimals") ?? 2),
		entries: entries.results,
	};
}

export async function findWalletEntry(db: D1Database, idempotencyKey: string) {
	const row = await db
		.prepare(
			"SELECT id, balance_after_minor FROM wallet_entries WHERE idempotency_key = ? LIMIT 1",
		)
		.bind(idempotencyKey)
		.first<{ id: string; balance_after_minor: string }>();
	return row ? { id: row.id, balanceMinor: row.balance_after_minor } : null;
}
