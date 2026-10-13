import { describe, expect, it, vi } from "vitest";
import {
	RestockBatchError,
	restockInBatches as runBatches,
} from "#/features/supply-console/restock-batches";
import type { restockSupplyFn } from "#/features/supply-console/server/restock";

type Input = Parameters<typeof restockSupplyFn>[0];
const data = (count: number) => ({
	requestRef: "supply_00000000-0000-4000-8000-000000000001",
	componentId: "00000000-0000-4000-8000-000000000002",
	unitCostYuan: "113",
	content: Array.from({ length: count }, (_, i) => `synthetic-${i}`).join("\n"),
});
const result = (count: number) => ({
	route: "central" as const,
	total: count,
	imported: count,
	generated: count,
	generationFailed: false,
	counts: { available: count },
});

const restockInBatches = (...args: Parameters<typeof runBatches>) =>
	runBatches(args[0], args[1], args[2], args[3], async () => {});

describe("quick restock batches", () => {
	it("waits between batches for the shared PH verifier cooldown", async () => {
		vi.useFakeTimers();
		try {
			const send = vi.fn(async ({ data }: Input) =>
				result(data.content.split("\n").length),
			);
			const pending = runBatches(data(6), "GPT_PLUS_PH", send);
			await vi.advanceTimersByTimeAsync(3299);
			expect(send).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(1);
			await pending;
			expect(send).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("submits 30 PH keys as six sequential requests with distinct references", async () => {
		let active = 0;
		const send = vi.fn(async ({ data }: Input) => {
			const keys = data.content.split("\n");
			if (keys.length > 5) throw new Error("input.batch_too_large");
			expect(++active).toBe(1);
			await Promise.resolve();
			active--;
			return result(keys.length);
		});
		const progress = vi.fn();
		expect(
			await restockInBatches(data(30), "GPT_PLUS_PH", send, progress),
		).toEqual(result(30));
		expect(send).toHaveBeenCalledTimes(6);
		expect(
			new Set(send.mock.calls.map(([arg]) => arg.data.requestRef)).size,
		).toBe(6);
		expect(
			send.mock.calls.flatMap(([arg]) => arg.data.content.split("\n")),
		).toEqual(data(30).content.split("\n"));
		expect(progress).toHaveBeenLastCalledWith({
			completed: 6,
			batches: 6,
			imported: 30,
			generated: 30,
		});
	});
	it("handles a remainder and ignores blank lines", async () => {
		const send = vi.fn(async ({ data }: Input) =>
			result(data.content.split("\n").length),
		);
		await restockInBatches(
			{ ...data(7), content: `\n${data(7).content}\n\n` },
			"GPT_PLUS_PH",
			send,
		);
		expect(
			send.mock.calls.map(([arg]) => arg.data.content.split("\n").length),
		).toEqual([5, 2]);
	});
	it("stops on an uncertain batch without retries or sending remaining keys", async () => {
		const send = vi
			.fn(async () => result(5))
			.mockResolvedValueOnce(result(5))
			.mockRejectedValueOnce(new Error("sensitive provider response"));
		const error = await restockInBatches(data(30), "GPT_PLUS_PH", send).catch(
			(e) => e,
		);
		expect(error).toBeInstanceOf(RestockBatchError);
		expect(error.progress).toEqual({
			completed: 1,
			batches: 6,
			imported: 5,
			generated: 5,
		});
		expect(String(error)).not.toContain("sensitive");
		expect(send).toHaveBeenCalledTimes(2);
	});
	it("stops when warehouse import succeeded but storefront generation failed", async () => {
		const send = vi.fn(async () => ({
			...result(5),
			generated: 0,
			generationFailed: true,
		}));
		const error = await restockInBatches(data(30), "GPT_PLUS_PH", send).catch(
			(e) => e,
		);
		expect(error).toBeInstanceOf(RestockBatchError);
		expect(error.progress.imported).toBe(5);
		expect(error.progress.generated).toBe(0);
		expect(send).toHaveBeenCalledTimes(1);
	});
	it("counts only newly accepted keys and does not create stock for duplicates", async () => {
		const send = vi.fn(async () => ({
			...result(5),
			imported: 0,
			generated: 0,
			counts: { duplicate: 5 },
		}));
		const value = await restockInBatches(data(30), "GPT_PLUS_PH", send);
		expect(value).toMatchObject({
			total: 30,
			imported: 0,
			generated: 0,
			counts: { duplicate: 30 },
		});
	});
	it("does not send invalid or over-limit submissions", async () => {
		const send = vi.fn(async () => result(5));
		for (const count of [0, 101])
			await expect(
				restockInBatches(data(count), "GPT_PLUS_PH", send),
			).rejects.toThrow("restock_invalid");
		expect(send).not.toHaveBeenCalled();
	});
	it("stops on rejected or quarantined keys instead of hiding partial validation", async () => {
		for (const status of ["rejected", "quarantined"]) {
			const send = vi.fn(async () => ({
				...result(5),
				imported: 4,
				generated: 4,
				counts: { available: 4, [status]: 1 },
			}));
			await expect(
				restockInBatches(data(30), "GPT_PLUS_PH", send),
			).rejects.toBeInstanceOf(RestockBatchError);
			expect(send).toHaveBeenCalledTimes(1);
		}
	});

	it("preserves non-PH and direct import behavior", async () => {
		for (const sku of [null, "GPT_20X_IOS"]) {
			const send = vi.fn(async () => result(30));
			await restockInBatches(data(30), sku, send);
			expect(send).toHaveBeenCalledExactlyOnceWith({ data: data(30) });
		}
	});
});
