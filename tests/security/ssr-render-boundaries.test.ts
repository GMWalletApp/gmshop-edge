import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const sourceFiles = collectSourceFiles(resolve(root, "src"));

describe("SSR render data boundaries", () => {
	it("coordinates critical and high-probability data through route loaders", () => {
		expect(ownersOf("useSuspenseQuery(")).toEqual([
			"src/features/dashboard/pages/admin.tsx",
			"src/features/dashboard/pages/tasks.tsx",
		]);
		expect(ownersOf("queryClient.prefetchQuery(")).toEqual([
			"src/routes/admin/agents.tsx",
			"src/routes/admin/index.tsx",
		]);
		// The agent table is awaited for SSR; secondary agent-program reads never gate it.
		const agentsRoute = read("src/routes/admin/agents.tsx");
		expect(agentsRoute).toContain(
			"await context.queryClient.prefetchQuery(agentsQuery(month))",
		);
		for (const query of [
			"leaderboardQuery(month)",
			"withdrawalsQuery()",
			"rulesQuery()",
		])
			expect(agentsRoute).toContain(
				`void context.queryClient.prefetchQuery(${query})`,
			);
		const dashboardRoute = read("src/routes/admin/index.tsx");
		expect(dashboardRoute).toContain(
			"void context.queryClient.prefetchQuery(dashboardQuery)",
		);
		expect(dashboardRoute).toContain(
			"void context.queryClient.prefetchQuery(tasksQuery)",
		);
		expect(dashboardRoute).not.toContain(
			"await context.queryClient.prefetchQuery(dashboardQuery)",
		);
		expect(dashboardRoute).not.toContain(
			"await context.queryClient.prefetchQuery(tasksQuery)",
		);
	});

	it("renders the public catalog from loader-prefetched query data", () => {
		const storefrontRoute = read("src/routes/(public)/index.tsx");
		const homePage = read("src/features/home/index.tsx");

		expect(ownersOf("queryClient.ensureQueryData(")).toEqual([
			"src/routes/(public)/index.tsx",
		]);
		expect(storefrontRoute).toContain("loader: async ({ context, deps }) =>");
		expect(storefrontRoute).toContain(
			"await context.queryClient.ensureQueryData(",
		);
		expect(homePage).toContain("storefrontCatalogQueryOptions({");
	});

	it("resolves identity, authorization, and brand before render", () => {
		const rootRoute = read("src/routes/__root.tsx");
		const adminRoute = read("src/routes/admin/route.tsx");

		expect(rootRoute).toContain("loader: () => getSiteBrandFn()");
		expect(adminRoute).toContain("loader: async ({ location }) =>");
		expect(adminRoute).toContain("bootstrap = await getAdminBootstrapFn()");
		expect(adminRoute).not.toContain("beforeLoad:");
		expect(adminRoute).toContain("return { systemAccess, user }");
	});

	it("keeps localized timestamps stable across the first server and client render", () => {
		for (const file of ["src/features/status/pages/status.tsx"]) {
			const source = read(file);
			expect(source).toContain('mounted ? undefined : "UTC"');
			expect(source).not.toContain(".toLocaleString(");
		}
	});
});

function ownersOf(token: string) {
	return sourceFiles
		.filter((file) => readFileSync(file, "utf8").includes(token))
		.map((file) => relative(root, file).replaceAll("\\", "/"))
		.sort();
}

function read(file: string) {
	return readFileSync(resolve(root, file), "utf8");
}

function collectSourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return collectSourceFiles(path);
		return [".ts", ".tsx"].includes(extname(entry.name)) ? [path] : [];
	});
}
