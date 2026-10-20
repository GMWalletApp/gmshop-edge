// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
	check: vi.fn(async ({ data }: { data: { prefix: string } }) => ({
		state: data.prefix === "taken" ? "taken" : "available",
		label: data.prefix,
		domain: `${data.prefix}.lsrai.shop`,
	})),
}));
vi.mock("#/features/agent-access/server/functions", () => ({
	checkAgentSubsitePrefixFn: f.check,
}));

import {
	AgentSubsitePrefixField,
	useSubsitePrefixCheck,
} from "#/features/agent-access/components/subsite-prefix";

let blocking: boolean | undefined;
function Harness({ initial }: { initial: string }) {
	const [value, setValue] = useState(initial);
	const check = useSubsitePrefixCheck(value, true);
	blocking = check.blocking;
	return (
		<AgentSubsitePrefixField value={value} onChange={setValue} check={check} />
	);
}

let container: HTMLDivElement;
beforeEach(() => {
	vi.useFakeTimers();
	container = document.createElement("div");
	document.body.appendChild(container);
	f.check.mockClear();
});
afterEach(() => {
	vi.useRealTimers();
	container.remove();
});

async function render(initial: string) {
	const root = createRoot(container);
	const client = new QueryClient();
	await act(async () => {
		root.render(
			<QueryClientProvider client={client}>
				<Harness initial={initial} />
			</QueryClientProvider>,
		);
	});
	await act(async () => {
		await vi.advanceTimersByTimeAsync(500);
	});
	return root;
}

it("allows an empty prefix without a remote check", async () => {
	const root = await render("");
	expect(blocking).toBe(false);
	expect(f.check).not.toHaveBeenCalled();
	expect(container.textContent).toContain("3–20");
	root.unmount();
});

it("previews the full domain and allows an available prefix", async () => {
	const root = await render("MyStore");
	expect(f.check).toHaveBeenCalledWith({ data: { prefix: "mystore" } });
	expect(container.textContent).toContain("mystore.lsrai.shop");
	expect(blocking).toBe(false);
	root.unmount();
});

it("blocks a taken prefix with a clear message", async () => {
	const root = await render("taken");
	expect(blocking).toBe(true);
	expect(container.querySelector("[role=alert]")?.textContent).toBeTruthy();
	root.unmount();
});

it("blocks invalid and reserved prefixes locally", async () => {
	let root = await render("my--store");
	expect(blocking).toBe(true);
	expect(container.querySelector("[role=alert]")).not.toBeNull();
	root.unmount();
	root = await render("admin");
	expect(blocking).toBe(true);
	expect(container.textContent).toContain("admin.lsrai.shop");
	expect(f.check).not.toHaveBeenCalled();
	root.unmount();
});
