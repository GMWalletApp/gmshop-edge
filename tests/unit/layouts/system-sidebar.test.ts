import { readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { systemPermission } from "#/features/access/system-rbac";
import { commandMenuGroups } from "#/layouts/components/command-menu";
import {
	canAccessAdminPath,
	firstAllowedAdminUrl,
	navigationGroups,
	permissionForAdminPath,
	systemSidebarData,
	visibleModuleEntries,
} from "#/layouts/components/data/sidebar-data";
import { matchesNavLocation } from "#/layouts/components/nav-group";

const urls = (permissions: Parameters<typeof systemSidebarData>[0]) =>
	systemSidebarData(permissions).navGroups.flatMap((group) =>
		group.items.flatMap((item) =>
			item.items
				? item.items.map((child) => String(child.url))
				: [String(item.url)],
		),
	);

describe("GMShop admin navigation", () => {
	it("keeps the commerce domain groups in stable order", () => {
		expect(navigationGroups.map((group) => group.id)).toEqual([
			"workbench",
			"catalog",
			"sales",
			"customers",
			"system",
		]);
		expect(
			navigationGroups
				.find((group) => group.id === "system")
				?.modules.slice(0, 3)
				.map((module) => module.id),
		).toEqual(["payment-configurations", "auth-channels", "email-config"]);
		const entries = navigationGroups
			.flatMap((group) => group.modules)
			.flatMap((module) => module.entries);
		expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
		expect(new Set(entries.map((entry) => entry.url)).size).toBe(
			entries.length,
		);
	});

	it.each([
		[systemPermission("dashboard", "read"), ["/admin"]],
		[
			systemPermission("products", "read"),
			["/admin/products", "/admin/products/trash"],
		],
		[
			systemPermission("suppliers", "read"),
			[
				"/admin/suppliers/accounts",
				"/admin/suppliers/products",
				"/admin/suppliers/orders",
				"/admin/settings/supplier-api",
			],
		],
		[systemPermission("orders", "read"), ["/admin/orders"]],
		[
			systemPermission("notifications", "read"),
			["/admin/email", "/admin/email/templates", "/admin/email/records"],
		],
		[
			systemPermission("operations", "read"),
			["/admin/operations/queues", "/admin/operations/scheduled"],
		],
	] as const)(
		"projects only permitted destinations for %j",
		(permission, expected) => {
			expect(urls([permission])).toEqual(expected);
			expect(
				commandMenuGroups(systemSidebarData([permission])).flatMap((group) =>
					group.items.map((item) => String(item.url)),
				),
			).toEqual(expected);
		},
	);

	it("shares one authority between module navigation and route access", () => {
		const permissions = [
			systemPermission("users", "read"),
			systemPermission("roles", "read"),
		];
		expect(
			visibleModuleEntries("access", permissions).map((entry) => entry.url),
		).toEqual([
			"/admin/access/users",
			"/admin/access/roles",
			"/admin/access/modules",
			"/admin/access/permission-bits",
		]);
		expect(firstAllowedAdminUrl(permissions)).toBe("/admin/access/users");
		expect(canAccessAdminPath("/admin/access/users", permissions)).toBe(true);
		expect(canAccessAdminPath("/admin/orders", permissions)).toBe(false);
		expect(permissionForAdminPath("/admin/not-a-route")).toBeUndefined();
	});

	it("keeps every navigation URL bound to its declared permission", () => {
		const entries = navigationGroups
			.flatMap((group) => group.modules)
			.flatMap((module) => module.entries);
		for (const entry of entries) {
			expect(permissionForAdminPath(entry.url), entry.url).toEqual(
				entry.permission,
			);
			expect(canAccessAdminPath(entry.url, [entry.permission]), entry.url).toBe(
				true,
			);
		}
	});

	it("classifies every admin page route and rejects unknown routes", async () => {
		const permissions = navigationGroups
			.flatMap((group) => group.modules)
			.flatMap((module) => module.entries.map((entry) => entry.permission));
		const root = resolve(
			new URL("../../../src/routes/admin", import.meta.url).pathname,
		);
		const pages = (await adminRouteFiles(root)).map((file) => {
			const relativePath = relative(root, file).split(sep).join("/");
			const path = relativePath
				.replace(/\.tsx$/, "")
				.replace(/(^|\/)index$/, "")
				.replaceAll(/\$[a-zA-Z][a-zA-Z0-9]*/g, "example");
			return `/admin${path ? `/${path}` : ""}`;
		});
		for (const path of pages)
			expect(canAccessAdminPath(path, permissions), path).toBe(true);
		expect(canAccessAdminPath("/admin/unknown", permissions)).toBe(false);
	});

	it("selects exact children while allowing explicit active prefixes", () => {
		expect(
			matchesNavLocation(
				{ title: "Dashboard", url: "/admin" },
				{ pathname: "/admin/orders" },
			),
		).toBe(false);
		expect(
			matchesNavLocation(
				{
					title: "Products",
					url: "/admin/products",
					activeUrls: ["/admin/products/example"],
				},
				{ pathname: "/admin/products/example" },
			),
		).toBe(true);
	});
});

async function adminRouteFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map((entry) => {
			const path = resolve(directory, entry.name);
			if (entry.isDirectory()) return adminRouteFiles(path);
			return Promise.resolve(
				entry.name.endsWith(".tsx") && entry.name !== "route.tsx" ? [path] : [],
			);
		}),
	);
	return nested.flat();
}
