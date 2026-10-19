import {
	Activity,
	CalendarClock,
	CircleDollarSign,
	CreditCard,
	Download,
	FileText,
	Hammer,
	KeyRound,
	LayoutDashboard,
	Mail,
	Package,
	PackageSearch,
	ReceiptText,
	ScrollText,
	Send,
	Settings,
	ShieldCheck,
	ShieldEllipsis,
	TicketPercent,
	Trash2,
	Users,
	Warehouse,
} from "lucide-react";
import {
	hasSystemPermission,
	type SystemPermission,
	type SystemPermissionGrant,
	systemPermission,
} from "#/features/access/system-rbac";
import { m } from "#/paraglide/messages";
import type { SidebarData } from "../types";

export type NavigationModuleId =
	| "dashboard"
	| "products"
	| "product-recycle-bin"
	| "supply-console"
	| "suppliers"
	| "orders"
	| "agents"
	| "customers"
	| "coupons"
	| "payment-configurations"
	| "delivery"
	| "automation"
	| "email-config"
	| "auth-channels"
	| "access"
	| "operations"
	| "settings";

type NavigationEntry = {
	id: string;
	title: () => string;
	url: string;
	icon: typeof LayoutDashboard;
	permission: SystemPermission;
	permissions: readonly SystemPermission[];
	activePrefixes?: readonly string[];
};

type NavigationModule = {
	id: NavigationModuleId;
	title: () => string;
	icon: typeof LayoutDashboard;
	entries: readonly NavigationEntry[];
};

type NavigationGroup = {
	id: string;
	title: () => string;
	modules: readonly NavigationModule[];
};

const entry = (
	id: string,
	title: () => string,
	url: string,
	icon: typeof LayoutDashboard,
	permission: SystemPermission | readonly SystemPermission[],
	activePrefixes?: readonly string[],
): NavigationEntry => {
	const permissions = Array.isArray(permission) ? permission : [permission];
	const primaryPermission = permissions[0];
	if (!primaryPermission) throw new Error("Navigation permission is required");
	return {
		id,
		title,
		url,
		icon,
		permission: primaryPermission,
		permissions,
		activePrefixes,
	};
};

export const navigationGroups: readonly NavigationGroup[] = [
	{
		id: "workbench",
		title: () => m.nav_group_workbench(),
		modules: [
			{
				id: "dashboard",
				title: () => m.shop_dashboard_title(),
				icon: LayoutDashboard,
				entries: [
					entry(
						"dashboard",
						() => m.shop_dashboard_title(),
						"/admin",
						LayoutDashboard,
						systemPermission("dashboard", "read"),
					),
				],
			},
		],
	},
	{
		id: "catalog",
		title: () => m.nav_group_products(),
		modules: [
			{
				id: "products",
				title: () => m.nav_product_management(),
				icon: Package,
				entries: [
					entry(
						"products",
						() => m.nav_product_management(),
						"/admin/products",
						Package,
						systemPermission("products", "read"),
					),
				],
			},
			{
				id: "supply-console",
				title: () => m.supply_console_title(),
				icon: Warehouse,
				entries: [
					entry(
						"supply-console",
						() => m.supply_console_title(),
						"/admin/supply",
						Warehouse,
						systemPermission("inventory", "read"),
					),
				],
			},
			{
				id: "product-recycle-bin",
				title: () => m.catalog_recycle_bin(),
				icon: Trash2,
				entries: [
					entry(
						"product-recycle-bin",
						() => m.catalog_recycle_bin(),
						"/admin/products/trash",
						Trash2,
						systemPermission("products", "read"),
					),
				],
			},
			{
				id: "suppliers",
				title: () => m.nav_supplier_management(),
				icon: PackageSearch,
				entries: [
					entry(
						"supplier-accounts",
						() => m.supplier_accounts_title(),
						"/admin/suppliers/accounts",
						KeyRound,
						systemPermission("suppliers", "read"),
					),
					entry(
						"supplier-products",
						() => m.supplier_products_title(),
						"/admin/suppliers/products",
						PackageSearch,
						systemPermission("suppliers", "read"),
					),
					entry(
						"supplier-orders",
						() => m.supplier_orders_title(),
						"/admin/suppliers/orders",
						ReceiptText,
						systemPermission("suppliers", "read"),
					),
				],
			},
		],
	},
	{
		id: "sales",
		title: () => m.nav_group_transactions(),
		modules: [
			{
				id: "orders",
				title: () => m.system_nav_orders(),
				icon: ReceiptText,
				entries: [
					entry(
						"orders",
						() => m.system_nav_orders(),
						"/admin/orders",
						ReceiptText,
						systemPermission("orders", "read"),
					),
				],
			},
			{
				id: "agents",
				title: () => m.agent_program_title(),
				icon: Users,
				entries: [
					entry(
						"agents",
						() => m.agent_program_title(),
						"/admin/agents",
						Users,
						systemPermission("operations", "read"),
					),
				],
			},
			{
				id: "delivery",
				title: () => m.delivery_center_title(),
				icon: Download,
				entries: [
					entry(
						"delivery-center",
						() => m.delivery_center_title(),
						"/admin/delivery",
						Package,
						systemPermission("delivery", "read"),
					),
				],
			},
			{
				id: "automation",
				title: () => m.nav_automation(),
				icon: Hammer,
				entries: [
					entry(
						"automation-center",
						() => m.automation_center_title(),
						"/admin/automation",
						Hammer,
						systemPermission("automation", "read"),
					),
				],
			},
		],
	},
	{
		id: "customers",
		title: () => m.nav_group_customer_growth(),
		modules: [
			{
				id: "coupons",
				title: () => m.nav_coupons(),
				icon: TicketPercent,
				entries: [
					entry(
						"coupons",
						() => m.nav_coupons(),
						"/admin/coupons",
						TicketPercent,
						systemPermission("coupons", "read"),
					),
				],
			},
		],
	},
	{
		id: "system",
		title: () => m.nav_group_system_management(),
		modules: [
			{
				id: "payment-configurations",
				title: () => m.nav_payment_channels(),
				icon: CreditCard,
				entries: [
					entry(
						"payment-configurations",
						() => m.nav_payment_channels(),
						"/admin/payment-configurations",
						CreditCard,
						systemPermission("payments", "read"),
					),
				],
			},
			{
				id: "auth-channels",
				title: () => m.settings_group_auth(),
				icon: KeyRound,
				entries: [
					entry(
						"auth-channels",
						() => m.settings_group_auth(),
						"/admin/auth",
						KeyRound,
						systemPermission("settings", "read"),
					),
				],
			},
			{
				id: "email-config",
				title: () => m.settings_group_email(),
				icon: Mail,
				entries: [
					entry(
						"email-channels",
						() => m.notifications_email_channel(),
						"/admin/email",
						Mail,
						systemPermission("notifications", "read"),
					),
					entry(
						"email-templates",
						() => m.notifications_email_templates(),
						"/admin/email/templates",
						FileText,
						systemPermission("notifications", "read"),
					),
					entry(
						"email-records",
						() => m.notifications_deliveries(),
						"/admin/email/records",
						ScrollText,
						systemPermission("notifications", "read"),
					),
					entry(
						"email-renewal",
						() => m.renewal_nav(),
						"/admin/email/renewal",
						CalendarClock,
						systemPermission("notifications", "read"),
					),
				],
			},
			{
				id: "access",
				title: () => m.nav_user_access(),
				icon: ShieldCheck,
				entries: [
					entry(
						"users",
						() => m.nav_user_management(),
						"/admin/access/users",
						Users,
						[
							systemPermission("users", "read"),
							systemPermission("customers", "read"),
						],
					),
					entry(
						"roles",
						() => m.nav_role_management(),
						"/admin/access/roles",
						ShieldCheck,
						systemPermission("roles", "read"),
					),
					entry(
						"permission-modules",
						() => m.access_permission_modules(),
						"/admin/access/modules",
						ShieldCheck,
						systemPermission("roles", "read"),
					),
					entry(
						"permission-bits",
						() => m.access_permission_bits(),
						"/admin/access/permission-bits",
						ShieldEllipsis,
						systemPermission("roles", "read"),
					),
				],
			},
			{
				id: "operations",
				title: () => m.nav_operations_center(),
				icon: Activity,
				entries: [
					entry(
						"queues",
						() => m.nav_queue_monitoring(),
						"/admin/operations/queues",
						Activity,
						systemPermission("operations", "read"),
					),
					entry(
						"scheduled",
						() => m.nav_scheduled_tasks(),
						"/admin/operations/scheduled",
						Activity,
						systemPermission("operations", "read"),
					),
					entry(
						"audit",
						() => m.nav_audit_logs(),
						"/admin/operations/audit-logs",
						ScrollText,
						systemPermission("audit", "read"),
					),
				],
			},
			{
				id: "settings",
				title: () => m.system_nav_settings(),
				icon: Settings,
				entries: [
					entry(
						"settings-branding",
						() => m.settings_group_brand(),
						"/admin/settings",
						Settings,
						systemPermission("settings", "read"),
					),
					entry(
						"settings-orders",
						() => m.settings_group_orders(),
						"/admin/settings/orders",
						ReceiptText,
						systemPermission("settings", "read"),
					),
					entry(
						"settings-commerce",
						() => m.settings_group_commerce(),
						"/admin/settings/commerce",
						CircleDollarSign,
						systemPermission("settings", "read"),
					),
					entry(
						"settings-supplier-api",
						() => m.settings_supplier_api_enabled(),
						"/admin/settings/supplier-api",
						KeyRound,
						systemPermission("suppliers", "read"),
					),
					entry(
						"settings-fulfillment",
						() => m.settings_group_fulfillment(),
						"/admin/settings/fulfillment",
						Package,
						systemPermission("settings", "read"),
					),
					entry(
						"settings-operations",
						() => m.settings_group_operations(),
						"/admin/settings/operations",
						Activity,
						systemPermission("settings", "read"),
					),
					entry(
						"settings-access",
						() => m.settings_group_access(),
						"/admin/settings/access",
						ShieldCheck,
						systemPermission("settings", "read"),
					),
					entry(
						"settings-retention",
						() => m.settings_group_retention(),
						"/admin/settings/retention",
						ScrollText,
						systemPermission("settings", "read"),
					),
					entry(
						"settings-telegram",
						() => m.settings_group_telegram(),
						"/admin/settings/telegram",
						Send,
						systemPermission("settings", "read"),
					),
					entry(
						"settings-secrets",
						() => m.settings_group_secrets(),
						"/admin/settings/secrets",
						KeyRound,
						systemPermission("settings", "read"),
					),
				],
			},
		],
	},
] as const;

export function visibleModuleEntries(
	moduleId: NavigationModuleId,
	permissions: readonly SystemPermissionGrant[],
) {
	const module = navigationGroups
		.flatMap((group) => group.modules)
		.find((candidate) => candidate.id === moduleId);
	return (
		module?.entries.filter((item) => canAccessEntry(item, permissions)) ?? []
	);
}

export function firstAllowedAdminUrl(
	permissions: readonly SystemPermissionGrant[],
) {
	return navigationGroups
		.flatMap((group) => group.modules)
		.flatMap((module) => module.entries)
		.find((item) => canAccessEntry(item, permissions))?.url;
}

export function systemSidebarData(
	permissions: readonly SystemPermissionGrant[],
	roles: readonly string[] = [],
): SidebarData {
	const navGroups: SidebarData["navGroups"] = [];
	for (const group of navigationGroups) {
		const items: SidebarData["navGroups"][number]["items"] = [];
		for (const module of group.modules) {
			if (
				module.id === "agents" &&
				!roles.some((role) => role === "root" || role === "admin")
			)
				continue;
			const visible = module.entries.filter((candidate) =>
				canAccessEntry(candidate, permissions),
			);
			if (!visible.length) continue;
			if (visible.length === 1) {
				const [first] = visible;
				if (!first) continue;
				items.push({
					id: module.id,
					title: module.title(),
					url: first.url,
					icon: module.icon,
					activeUrls:
						module.entries.length > 1
							? module.entries.map((candidate) => candidate.url)
							: undefined,
					activePrefixes: first.activePrefixes
						? [...first.activePrefixes]
						: undefined,
				});
			} else {
				items.push({
					id: module.id,
					title: module.title(),
					icon: module.icon,
					items: visible.map((item) => ({
						id: item.id,
						title: item.title(),
						url: item.url,
						icon: item.icon,
						activePrefixes: item.activePrefixes
							? [...item.activePrefixes]
							: undefined,
					})),
				});
			}
		}
		if (items.length)
			navGroups.push({ id: group.id, title: group.title(), items });
	}
	return { navGroups };
}

export function permissionForAdminPath(
	pathname: string,
): SystemPermission | undefined {
	const normalized =
		pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
	return matchingEntries(normalized)[0]?.permissions[0];
}

function matchingEntries(pathname: string) {
	return navigationGroups
		.flatMap((group) => group.modules)
		.flatMap((module) => module.entries)
		.filter(
			(candidate) =>
				pathname === candidate.url ||
				(candidate.url !== "/admin" &&
					pathname.startsWith(`${candidate.url}/`)) ||
				candidate.activePrefixes?.some(
					(prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
				),
		)
		.sort((left, right) => right.url.length - left.url.length);
}

export function canAccessAdminPath(
	pathname: string,
	permissions: readonly SystemPermissionGrant[],
) {
	const normalized =
		pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
	const entries = matchingEntries(normalized);
	if (entries.length)
		return entries.some((candidate) => canAccessEntry(candidate, permissions));
	const module = navigationGroups
		.flatMap((group) => group.modules)
		.find((candidate) =>
			candidate.entries.every((item) => item.url.startsWith(`${normalized}/`)),
		);
	return module
		? module.entries.some((item) => canAccessEntry(item, permissions))
		: false;
}

function canAccessEntry(
	entry: NavigationEntry,
	permissions: readonly SystemPermissionGrant[],
) {
	return entry.permissions.some((permission) =>
		hasSystemPermission(permissions, permission),
	);
}
