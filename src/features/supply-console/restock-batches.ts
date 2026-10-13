import type { restockSupplyFn } from "./server/restock";

type Input = Parameters<typeof restockSupplyFn>[0]["data"];
export type RestockResult = Awaited<ReturnType<typeof restockSupplyFn>>;
type Send = (options: { data: Input }) => Promise<RestockResult>;
export type RestockProgress = {
	completed: number;
	batches: number;
	imported: number;
	generated: number;
};

export class RestockBatchError extends Error {
	constructor(readonly progress: RestockProgress) {
		super("restock_batch_unconfirmed");
	}
}

export async function restockInBatches(
	input: Input,
	sku: string | null,
	send: Send,
	progress: (value: RestockProgress) => void = () => {},
	wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
		new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<RestockResult> {
	// Keep batches on the client: every server request retains its own bounded
	// warehouse timeout. Never retry an uncertain write automatically.
	if (!sku?.endsWith("_PH")) return send({ data: input });
	const keys = input.content
		.split(/\r?\n/)
		.map((key) => key.trim())
		.filter(Boolean);
	if (!keys.length || keys.length > 100 || input.content.length > 250_000)
		throw new Error("restock_invalid");
	const state: RestockProgress = {
		completed: 0,
		batches: Math.ceil(keys.length / 5),
		imported: 0,
		generated: 0,
	};
	const aggregate: RestockResult = {
		route: "central",
		total: 0,
		imported: 0,
		generated: 0,
		generationFailed: false,
		counts: {},
	};
	progress({ ...state });
	for (let offset = 0; offset < keys.length; offset += 5) {
		// The PH verifier shares a 3.1-second cooldown across requests.
		// Server-side spacing covers keys within a batch, not the next batch.
		if (offset > 0) await wait(3_300);
		let result: RestockResult;
		try {
			result = await send({
				data: {
					...input,
					requestRef: `${input.requestRef}_${offset / 5}`,
					content: keys.slice(offset, offset + 5).join("\n"),
				},
			});
		} catch {
			throw new RestockBatchError({ ...state });
		}
		aggregate.total += result.total;
		aggregate.imported += result.imported;
		aggregate.generated += result.generated;
		const counts: Record<string, number> = result.counts;
		for (const [status, count] of Object.entries(counts))
			aggregate.counts[status] = (aggregate.counts[status] ?? 0) + count;
		state.completed++;
		state.imported = aggregate.imported;
		state.generated = aggregate.generated;
		progress({ ...state });
		// Import and storefront generation are separate writes. Stop and retain the
		// confirmed counts rather than presenting partial fulfillment as success.
		if (
			result.generationFailed ||
			result.generated !== result.imported ||
			(counts.rejected ?? 0) > 0 ||
			(counts.quarantined ?? 0) > 0
		)
			throw new RestockBatchError({ ...state });
	}
	return aggregate;
}
