/**
 * Owner-local, read-only renewal preview. Lists how many recall emails would go
 * out now, renders one example of each template with masked addresses, and
 * prints the per-stage stats. It only issues SELECT/WITH statements and never
 * enqueues or sends email. Secrets never enter argv, files or stdout.
 *
 * Usage: bun scripts/renewal-preview.ts --account CF_ACCOUNT_ID --database D1_DATABASE_ID
 */
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import {
	loadRenewalStats,
	previewRenewalEmails,
} from "../src/features/renewals/server/stats";

type Row = Record<string, unknown>;

function readOnlyD1(query: (sql: string, params: unknown[]) => Promise<Row[]>) {
	const statement = (sql: string, params: unknown[] = []) => {
		if (!/^\s*(?:SELECT|WITH)\b/i.test(sql))
			throw new Error("renewal preview is read-only");
		return {
			bind: (...values: unknown[]) => statement(sql, values),
			all: async () => ({ results: await query(sql, params) }),
			first: async (column?: string) => {
				const row = (await query(sql, params))[0];
				if (!row) return null;
				return column ? (row[column] ?? null) : row;
			},
		};
	};
	return { prepare: (sql: string) => statement(sql) } as unknown as D1Database;
}

async function main() {
	const { values } = parseArgs({
		options: {
			account: { type: "string" },
			database: { type: "string" },
		},
	});
	if (!values.account || !values.database) {
		console.error(
			"Usage: bun scripts/renewal-preview.ts --account ID --database ID",
		);
		process.exit(2);
	}
	const secret = spawnSync(
		"agent-switch",
		["secret", "get", "--fd", "3", "CLOUDFLARE_API_TOKEN"],
		{ stdio: ["ignore", "ignore", "ignore", "pipe"] },
	);
	const token = secret.output[3]?.toString().trim();
	if (secret.status !== 0 || !token)
		throw new Error("Cloudflare credential unavailable");
	const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(values.account)}/d1/database/${encodeURIComponent(values.database)}/query`;
	const db = readOnlyD1(async (sql, params) => {
		const response = await fetch(endpoint, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ sql, params }),
		});
		if (!response.ok) throw new Error(`D1 returned HTTP ${response.status}`);
		const data = (await response.json()) as {
			success: boolean;
			result: Array<{ results: Row[] }>;
		};
		if (!data.success) throw new Error("D1 query failed");
		return data.result[0]?.results ?? [];
	});
	const preview = await previewRenewalEmails(db);
	const stats = await loadRenewalStats(db);
	console.log(
		JSON.stringify(
			{
				recallEnabled: preview.recallEnabled,
				recallDueNow: {
					emails: preview.recallDueRows,
					recipients: preview.recallDueRecipients,
				},
				examples: preview.examples,
				stats,
			},
			null,
			2,
		),
	);
}

await main();
