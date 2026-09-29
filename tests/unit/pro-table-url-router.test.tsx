// @vitest-environment jsdom

import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ProTable } from "#/components/pro/table";
import {
	useCurrentProTableUrlState,
	validateProTableSearch,
} from "#/lib/pro-table-url-state";

const rows = Array.from({ length: 11 }, (_, index) => ({
	id: index + 1,
	name: `Row ${index + 1}`,
}));

describe("ProTable router URL state", () => {
	let container: HTMLDivElement | undefined;

	afterEach(() => {
		container?.remove();
		container = undefined;
	});

	it("hydrates deep links and debounces URL-backed search", async () => {
		const rootRoute = createRootRoute();
		const parentRoute = createRoute({
			getParentRoute: () => rootRoute,
			path: "table",
		});
		const indexRoute = createRoute({
			getParentRoute: () => parentRoute,
			path: "/",
			validateSearch: validateProTableSearch,
			component: TestTable,
		});
		const history = createMemoryHistory({
			initialEntries: ["/table?page=2"],
		});
		const router = createRouter({
			history,
			routeTree: rootRoute.addChildren([parentRoute.addChildren([indexRoute])]),
		});

		await router.load();
		container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);

		await act(async () => {
			root.render(<RouterProvider router={router} />);
		});
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 75));
		});

		expect(container.querySelector("tbody")?.textContent).toContain("Row 11");
		expect(router.state.location.search).toMatchObject({ page: 2 });
		const input = container.querySelector("input");
		expect(input).not.toBeNull();
		await act(async () => {
			if (!input) return;
			Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)?.set?.call(input, "Row 1");
			input.dispatchEvent(new Event("input", { bubbles: true }));
			await new Promise((resolve) => setTimeout(resolve, 50));
		});
		expect(router.state.location.search).not.toHaveProperty("q");
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 300));
		});
		expect(router.state.location.search).toMatchObject({ q: "Row 1" });

		await act(async () => root.unmount());
	});
});

function TestTable() {
	const tableUrlState = useCurrentProTableUrlState({ searchColumnId: "name" });
	const [data, setData] = useState<typeof rows>([]);
	useEffect(() => {
		const timeout = setTimeout(() => setData(rows), 25);
		return () => clearTimeout(timeout);
	}, []);
	return (
		<ProTable
			columns={[
				{ accessorKey: "name", header: "Name", meta: { search: true } },
			]}
			data={data}
			initialState={tableUrlState.initialState}
			loading={data.length === 0}
			onChange={tableUrlState.onChange}
			toolbarSearch="name"
		/>
	);
}
