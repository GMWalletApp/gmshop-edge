import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

const adminServerModules = [
	"src/features/agent-access/server/admin.ts",
	"src/features/access/server/admin.ts",
	"src/features/auth/server/provider-admin.ts",
	"src/features/builds/server/admin.ts",
	"src/features/builds/server/center.ts",
	"src/features/catalog/server/admin.ts",
	"src/features/catalog/server/editor.ts",
	"src/features/catalog/server/workspace.ts",
	"src/features/coupons/server/admin.ts",
	"src/features/customers/server/admin.ts",
	"src/features/dashboard/server/admin.ts",
	"src/features/dashboard/server/tasks.ts",
	"src/features/exchange-rates/server/admin.ts",
	"src/features/fulfillment/server/admin.ts",
	"src/features/notifications/server/admin.ts",
	"src/features/operations/server/admin.ts",
	"src/features/promotions/server/admin.ts",
	"src/features/redeem-warehouse/server/admin.ts",
	"src/features/renewals/server/admin.ts",
	"src/features/settings/server/admin.ts",
	"src/features/shop-orders/server/admin.ts",
	"src/features/shop-payments/server/admin.ts",
	"src/features/supplier-api/server/admin.ts",
	"src/features/supply-console/server/query.ts",
	"src/features/supply-console/server/restock.ts",
	"src/features/suppliers/server/admin.ts",
	"src/features/suppliers/server/catalog-admin.ts",
	"src/features/suppliers/server/orders-admin.ts",
	"src/features/telegram/server/admin.ts",
	"src/features/users/server/admin.ts",
] as const;

const reviewedPublicServerModules = [
	"src/features/agent-access/server/functions.ts",
	"src/features/auth/server/session.ts",
	"src/features/exchange-rates/server/public.ts",
	"src/features/installation/server/functions.ts",
	"src/features/promotions/server/functions.ts",
	// Signed one-click unsubscribe: HMAC over the address, no session.
	"src/features/renewals/server/public.ts",
	"src/features/settings/server/site-brand-entry.ts",
	"src/features/status/server/functions.ts",
	"src/features/storefront/server/account-functions.ts",
	"src/features/storefront/server/catalog.ts",
	"src/features/storefront/server/cart.ts",
	"src/features/storefront/server/functions.ts",
	"src/features/supplier-api/server/keys.ts",
	"src/features/wallet/server/functions.ts",
] as const;

const reviewedInputlessPostFunctions = new Set([
	"prepareAgentProductsFn",
	"exportAuditLogsFn",
	"removeSiteLogoFn",
	"syncTelegramBotFn",
	// No caller-supplied user ID: the authenticated session owns the persistent code.
	"openReferralFn",
]);

describe("server entry authorization coverage", () => {
	it("classifies every Server Function as protected admin or reviewed public", () => {
		const discovered = sourceFiles(resolve(root, "src"))
			.filter((file) => readFileSync(file, "utf8").includes("createServerFn"))
			.map(relative)
			.sort();
		expect(discovered).toEqual(
			[...adminServerModules, ...reviewedPublicServerModules].sort(),
		);
	});

	it("keeps every admin module behind the dynamic system permission authority", () => {
		for (const file of adminServerModules) {
			const source = read(file);
			expect(source, file).toContain("systemPermission(");
			expect(source, file).toMatch(
				/requireAdmin|adminContext|authProviderAdminContext|getAdminServerContext|getAdminRuntimeServerContext/,
			);
			expect(source, file).not.toMatch(/currentRole|activeRole|roleFromRoute/);
		}
	});

	it("declares methods and validates every input-bearing mutation", () => {
		for (const file of [
			...adminServerModules,
			...reviewedPublicServerModules,
		]) {
			const source = read(file);
			const declarations = [
				...source.matchAll(
					/export const (\w+) = createServerFn\(\s*\{\s*method: "(GET|POST)"\s*,?\s*\}\s*\)([\s\S]*?)(?=\nexport const |\n(?:async )?function |\nconst \w+ = |$)/g,
				),
			];
			expect(declarations.length, file).toBe(
				[...source.matchAll(/createServerFn\s*\(/g)].length,
			);
			for (const [, name, method, body] of declarations) {
				if (
					method === "POST" &&
					!reviewedInputlessPostFunctions.has(name ?? "")
				)
					expect(body, `${file}:${name}`).toContain(".validator(");
			}
		}
	});

	it("keeps every GET Server Function attached to a route or query owner", () => {
		const files = sourceFiles(resolve(root, "src"));
		for (const file of [
			...adminServerModules,
			...reviewedPublicServerModules,
		]) {
			const source = read(file);
			for (const match of source.matchAll(
				/export const (\w+) = createServerFn\(\s*\{\s*method: "GET"/g,
			)) {
				const name = match[1];
				const consumers = files.filter(
					(candidate) =>
						candidate !== resolve(root, file) &&
						!candidate.includes("/server/") &&
						new RegExp(`\\b${name}\\b`).test(readFileSync(candidate, "utf8")),
				);
				expect(
					consumers.length,
					`${file}:${name} has no owner`,
				).toBeGreaterThan(0);
			}
		}
	});

	it("never renders arbitrary error.message in presentation modules", () => {
		for (const file of sourceFiles(resolve(root, "src")).filter(
			(file) =>
				/[\\/](?:components|layouts|pages|routes)[\\/]/.test(file) &&
				!file.includes("/server/"),
		))
			expect(readFileSync(file, "utf8"), relative(file)).not.toMatch(
				/(?:error|result\.error)\.message/,
			);
	});

	it("does not mutate runtime configuration from public install or auth reads", () => {
		for (const file of [
			"src/features/installation/server/functions.ts",
			"src/features/auth/server/auth.ts",
		])
			expect(read(file), file).not.toContain("initializeMissingRuntimeConfig");
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
			: entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name)
				? [path]
				: [];
	});
}
