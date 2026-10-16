import { describe, expect, it } from "vitest";
import {
	guideProducts,
	guideProductUrl,
	guideStep,
} from "#/features/home/buying-guide-rules";

describe("VIP fixed buying guide", () => {
	it("covers every offered answer with a finite next step or explicit terminal", () => {
		const visit = (path: string[]) => {
			expect(path.length).toBeLessThanOrEqual(7);
			const step = guideStep(path);
			if (step.kind === "question") {
				expect(step.options.length).toBeGreaterThan(1);
				expect(new Set(step.options).size).toBe(step.options.length);
				expect(step.options.join(" ")).not.toMatch(/unknown|unsure|api|agent/);
				for (const answer of step.options) visit([...path, answer]);
			} else if (step.kind === "result") {
				expect(guideProducts[step.product]).toBeDefined();
				if (["plusph", "fiveph", "twentynew"].includes(step.product))
					expect(path[1]).toBe("free");
				expect(path).not.toContain("after_expiry");
				if (step.product === "twentyrenew") {
					expect(path.slice(0, 3)).toEqual(["gpt", "pro200", "current_ph"]);
					expect(path.at(-2)).toBe("yes_8919");
					expect(path.at(-1)).toBe("ph_renew");
				}
				if (
					path[1] === "pro200" &&
					path[2] === "current_ios" &&
					path[3] === "twenty"
				)
					expect(step.product).toBe("gpt20ios");
				if (path[0] === "gpt")
					expect(guideProducts[step.product].productId).toBe(
						"2a794b89-3bb9-49d4-8691-0d13a1606869",
					);
				expect(guideProductUrl(step.product)).toBe(
					`/products/${guideProducts[step.product].productId}?item=${guideProducts[step.product].itemId}#purchase-options`,
				);
			} else expect(step.reason).toBeTruthy();
		};
		visit([]);
	});
	it("distinguishes current Pro tiers without guessing from an expiry date", () => {
		expect(guideStep(["gpt"])).toMatchObject({
			id: "gpt_current",
			options: ["free", "go", "plus", "pro100", "pro200", "pro500"],
		});
		for (const current of ["plus", "pro100", "pro200"])
			expect(guideStep(["gpt", current])).toMatchObject({
				id: "current_channel",
			});
		expect(guideStep(["gpt", "pro500", "twenty"])).toMatchObject({
			id: "timing",
		});
	});
	it.each([
		["plus", "plusph", "plusios"],
		["five", "fiveph", "fiveios"],
		["twenty", "twentynew", "gpt20ios"],
	])("lets Free accounts choose either channel for %s, with no qualification gate", (target, ph, ios) => {
		expect(guideStep(["gpt", "free", target])).toMatchObject({
			id: "channel",
			options: ["ph", "ios"],
		});
		expect(guideStep(["gpt", "free", target, "ph"])).toMatchObject({
			kind: "result",
			product: ph,
		});
		expect(guideStep(["gpt", "free", target, "ios"])).toMatchObject({
			kind: "result",
			product: ios,
		});
	});
	it("does not infer immediate iOS overwrite from Plus → Plus", () => {
		expect(guideStep(["gpt", "plus", "current_ios", "plus"])).toMatchObject({
			id: "timing",
			options: ["recharge_now", "after_expiry"],
		});
		expect(
			guideStep(["gpt", "plus", "current_ios", "plus", "recharge_now"]),
		).toMatchObject({
			kind: "result",
			product: "plusios",
			warning: "overwrite30",
		});
		expect(
			guideStep(["gpt", "plus", "current_ios", "plus", "after_expiry"]),
		).toEqual({
			kind: "stop",
			reason: "wait_for_expiry",
		});
	});
	it("never substitutes ordinary recharge for the pending PH difference upgrade", () => {
		const path = ["gpt", "plus", "current_ph", "five", "recharge_now"];
		expect(guideStep(path)).toMatchObject({
			id: "upgrade_channel",
			options: ["ph_upgrade", "ios"],
		});
		expect(guideStep([...path, "ph_upgrade"])).toEqual({
			kind: "stop",
			reason: "upgrade_pending",
		});
		expect(guideStep([...path, "ios"])).toMatchObject({
			kind: "result",
			product: "fiveios",
			warning: "overwrite30",
		});
		expect(
			guideStep(["gpt", "plus", "current_ios", "five", "recharge_now"]),
		).toMatchObject({ product: "fiveios", warning: "overwrite30" });
	});
	it("routes current PH Pro $200 to its dedicated renewal only after matching the bill", () => {
		const path = ["gpt", "pro200", "current_ph", "twenty", "recharge_now"];
		expect(guideStep(path)).toMatchObject({
			id: "pro_php",
			options: ["yes_8919", "no_8919"],
		});
		expect(guideStep([...path, "yes_8919"])).toMatchObject({
			id: "renew_channel",
			options: ["ph_renew", "ios"],
		});
		expect(guideStep([...path, "yes_8919", "ph_renew"])).toMatchObject({
			product: "twentyrenew",
			warning: undefined,
		});
		expect(guideStep([...path, "yes_8919", "ios"])).toMatchObject({
			product: "gpt20ios",
			warning: "overwrite30",
		});
		expect(guideStep([...path, "no_8919"])).toEqual({
			kind: "stop",
			reason: "renew_bill_mismatch",
		});
	});
	it("routes current iOS Pro $200 through iOS without offering PH renewal or a PHP bill question", () => {
		expect(
			guideStep(["gpt", "pro200", "current_ios", "twenty", "recharge_now"]),
		).toMatchObject({
			kind: "result",
			product: "gpt20ios",
			warning: "overwrite30",
		});
		expect(
			guideStep(["gpt", "pro100", "current_ios", "twenty", "recharge_now"]),
		).toMatchObject({ product: "gpt20ios", warning: "overwrite30" });
	});
	it("does not infer an iOS subscription from an unverified or other channel", () => {
		expect(guideStep(["gpt", "pro200", "current_other"])).toEqual({
			kind: "stop",
			reason: "rule_pending",
		});
		expect(guideStep(["gpt", "pro200", "twenty"])).toEqual({
			kind: "stop",
			reason: "rule_pending",
		});
	});
	it("allows verified same-tier Pro $100 overwrite without treating it as Pro $200", () => {
		expect(
			guideStep(["gpt", "pro100", "current_ios", "five", "recharge_now"]),
		).toMatchObject({
			product: "fiveios",
			warning: "overwrite30",
		});
	});
	it("does not recommend any immediate purchase when the user chooses to wait", () => {
		for (const current of ["go", "plus", "pro100", "pro200", "pro500"])
			for (const target of ["go", "plus", "five", "twenty", "fivehundred"])
				expect(
					guideStep([
						"gpt",
						current,
						...(["plus", "pro100", "pro200"].includes(current)
							? ["current_ios"]
							: []),
						target,
						"after_expiry",
					]).kind,
				).toBe("stop");
	});
	it("maps the opened $500 SKU exactly but never overwrites an active subscription", () => {
		expect(guideStep(["gpt", "free", "fivehundred"])).toMatchObject({
			product: "gpt500",
		});
		expect(guideProducts.gpt500.itemId).toBe(
			"030582df-98c1-5b87-914d-28ddc606e163",
		);
		for (const current of ["go", "plus", "pro100", "pro200", "pro500"])
			expect(
				guideStep([
					"gpt",
					current,
					...(["plus", "pro100", "pro200"].includes(current)
						? ["current_ios"]
						: []),
					"fivehundred",
					"recharge_now",
				]),
			).toEqual({ kind: "stop", reason: "fivehundred_active" });
	});
	it("blocks Free credits and active Claude subscriptions", () => {
		expect(guideStep(["points", "free"])).toEqual({
			kind: "stop",
			reason: "free_points",
		});
		expect(guideStep(["claude", "claude_paid"])).toEqual({
			kind: "stop",
			reason: "claude_active",
		});
		expect(guideStep(["claude", "claude_free", "claudefive"])).toMatchObject({
			warning: "kyc",
		});
	});
	it("skips a redundant single-choice Grok question", () =>
		expect(guideStep(["grok"])).toMatchObject({
			kind: "result",
			product: "grok",
		}));
	it("does not silently recommend unverified Pro downgrades", () =>
		expect(
			guideStep(["gpt", "pro200", "current_ios", "plus", "recharge_now"]),
		).toEqual({
			kind: "stop",
			reason: "rule_pending",
		}));
});

it("has Chinese and English copy for every reachable question, answer and stop", async () => {
	const { readFile } = await import("node:fs/promises");
	const catalogs = await Promise.all(
		["zh-CN", "en-US"].map(
			async (locale) =>
				JSON.parse(await readFile(`messages/${locale}.json`, "utf8")) as Record<
					string,
					string
				>,
		),
	);
	expect(catalogs[0]?.guide_fivehundred).toBe("Pro 500");
	expect(catalogs[1]?.guide_fivehundred).toBe("Pro $500 tier");
	const visit = (path: string[]) => {
		const step = guideStep(path);
		const keys =
			step.kind === "question"
				? [step.id, ...step.options]
				: step.kind === "stop"
					? [step.reason, `${step.reason}_body`]
					: [
							"result",
							...(step.warning ? [step.warning, `${step.warning}_accept`] : []),
						];
		for (const c of catalogs)
			for (const key of keys) expect(c[`guide_${key}`], key).toBeTruthy();
		if (step.kind === "question")
			for (const option of step.options) visit([...path, option]);
	};
	visit([]);
});

it("does not apply the ChatGPT 30-day reset copy to other products", () => {
	expect(
		guideStep(["gpt", "plus", "current_ios", "five", "recharge_now"]),
	).toMatchObject({
		warning: "overwrite30",
	});
	expect(guideStep(["grok"])).toMatchObject({ warning: "overwrite" });
	expect(guideStep(["x", "xpremium"])).toMatchObject({ warning: "overwrite" });
});
