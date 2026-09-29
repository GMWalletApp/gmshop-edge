import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

describe("server middleware boundaries", () => {
	it("keeps the middleware registry small and purpose-specific", () => {
		const middlewareFiles = sourceFiles(resolve(root, "src/server/middleware"));
		const customMiddleware = [
			...middlewareFiles,
			resolve(root, "src/server/server-function-errors.ts"),
		]
			.filter((file) =>
				readFileSync(file, "utf8").includes("createMiddleware("),
			)
			.map(relative)
			.sort();

		expect(customMiddleware).toEqual([
			"src/server/middleware/protected-api.ts",
			"src/server/server-function-errors.ts",
		]);
		expect(read("src/server/middleware/index.ts")).toContain(
			"csrfMiddleware,\n\tprotectedApiMiddleware",
		);
		expect(read("src/server/middleware/csrf.ts")).toContain(
			'context.handlerType === "serverFn"',
		);
	});

	it("does not place commerce domain behavior in middleware", () => {
		const sources = [
			...sourceFiles(resolve(root, "src/server/middleware")),
			resolve(root, "src/server/server-function-errors.ts"),
		].map((file) => readFileSync(file, "utf8"));
		const combined = sources.join("\n");

		expect(combined).not.toMatch(
			/#\/features\/(?:catalog|shop-orders|shop-payments|fulfillment|builds|notifications|telegram)\//,
		);
		expect(combined).not.toMatch(
			/\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO|FROM)?\s*[`"']?[a-z_]+/i,
		);
		expect(combined).not.toMatch(/\.send\(|fulfillOrder|allocateInventory/);
	});

	it("orders liveness, authority, app handling, and response security once", () => {
		const entry = read("src/server-entry.ts");
		const positions = [
			"handleLivenessRequest(incoming)",
			"const rejected = await validateRequestAuthority(",
			"const request = await normalizeRequest(incoming, env);",
			"handleI18nRequest(",
			"return applySecurityHeaders(",
		].map((token) => entry.lastIndexOf(token));

		expect(positions.every((position) => position >= 0)).toBe(true);
		expect(positions[0]).toBeLessThan(positions[1] ?? -1);
		expect(positions[1]).toBeLessThan(positions[2] ?? -1);
		expect(positions[2]).toBeLessThan(positions[3] ?? -1);
		expect(positions[3]).toBeLessThan(positions[4] ?? -1);
		expect(read("src/start.ts")).toContain(
			"functionMiddleware: [serverFunctionErrorMiddleware]",
		);
	});

	it("shares request settings and effective access within one Request", () => {
		const settings = read("src/server/request-settings.ts");
		const authority = read("src/server/middleware/authority.ts");
		const runtime = read("src/server/runtime-config.ts");
		const access = read("src/features/access/server/require-admin.ts");

		expect(settings).toContain("new WeakMap<Request");
		expect(authority).toContain("loadRequestSettings(request, db)");
		expect(runtime).toContain("loadRequestSettings(request, db)");
		expect(access).toContain("new WeakMap<Request");
		expect(access).toContain("memoizeRequestAccess(requestAccess, request");
	});

	it("protects non-public API routes and delegates exact public boundaries", () => {
		const source = read("src/server/middleware/protected-api.ts");

		expect(source).toContain('url.pathname.startsWith("/api/")');
		expect(source).toContain("isPublicApiRequest(request)");
		expect(source).toContain("await requireAdmin(request)");
		expect(source).toContain("return next()");
	});
});

function read(file: string) {
	return readFileSync(resolve(root, file), "utf8");
}

function relative(file: string) {
	return file.slice(root.length + 1);
}

function sourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = resolve(directory, entry.name);
		return entry.isDirectory()
			? sourceFiles(path)
			: entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name)
				? [path]
				: [];
	});
}
