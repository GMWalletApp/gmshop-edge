import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireAdmin } from "#/features/access/server/require-admin";
import {
	type SystemPermission,
	systemPermission,
} from "#/features/access/system-rbac";
import {
	removeSiteLogo,
	uploadSiteLogo,
} from "#/features/settings/server/site-asset";
import {
	listSystemSettings,
	saveSystemSettings,
} from "#/features/settings/server/system-settings";
import { siteAssetContentTypes } from "#/features/settings/site-assets";
import { DomainError } from "#/lib/domain-error";
import { rotateSecretKeyring } from "#/lib/secrets";
import { clientIp } from "#/server/client-ip";
import { getCloudflareEnv } from "#/server/db.server";

export const listSystemSettingsFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const { db } = await adminContext(systemPermission("settings", "read"));
		return listSystemSettings(db);
	},
);

const updateInput = z.object({
	items: z
		.array(z.object({ key: z.string(), value: z.json() }))
		.min(1)
		.max(20),
});

export const updateSystemSettingsFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof updateInput>) => updateInput.parse(input))
	.handler(async ({ data }) => {
		const context = await adminContext(systemPermission("settings", "update"));
		return saveSystemSettings(data.items, {
			db: context.db,
			cache: context.env.CACHE,
			userId: context.user.id,
			requestId: context.request.headers.get("x-request-id"),
			ipAddress: clientIp(context.request),
		});
	});

const rotatableSecretKeys = ["runtime.data_encryption_secret"] as const;

const rotateSecretInput = z.object({ key: z.enum(rotatableSecretKeys) });

export const rotateRuntimeSecretFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof rotateSecretInput>) =>
		rotateSecretInput.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await adminContext(systemPermission("settings", "update"));
		const row = await context.db
			.prepare("SELECT value FROM system_settings WHERE key = ? LIMIT 1")
			.bind(data.key)
			.first<{ value: string }>();
		if (!row)
			throw new DomainError(
				"runtime_secret_unavailable",
				409,
				"The runtime secret is not initialized",
			);
		const current: unknown = JSON.parse(row.value);
		if (typeof current !== "string")
			throw new DomainError(
				"runtime_secret_invalid",
				409,
				"The runtime secret is invalid",
			);
		await saveSystemSettings(
			[{ key: data.key, value: rotateSecretKeyring(current) }],
			{
				db: context.db,
				cache: context.env.CACHE,
				userId: context.user.id,
				requestId: context.request.headers.get("x-request-id"),
				ipAddress: clientIp(context.request),
				allowKeyringReplacement: true,
			},
		);
		return { key: data.key, rotated: true };
	});

const siteLogoInput = z.object({
	contentType: z.enum(siteAssetContentTypes),
	base64: z.string().max(4_000_000),
});

export const uploadSiteLogoFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof siteLogoInput>) =>
		siteLogoInput.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await adminContext(systemPermission("settings", "update"));
		return uploadSiteLogo(data, siteAssetDependencies(context));
	});

export const removeSiteLogoFn = createServerFn({ method: "POST" }).handler(
	async () => {
		const context = await adminContext(systemPermission("settings", "update"));
		return removeSiteLogo(siteAssetDependencies(context));
	},
);

function siteAssetDependencies(
	context: Awaited<ReturnType<typeof adminContext>>,
) {
	if (!context.env.FILES)
		throw new DomainError(
			"site_asset_storage_unavailable",
			503,
			"Site asset storage is unavailable",
		);
	return {
		db: context.db,
		bucket: context.env.FILES,
		cache: context.env.CACHE,
		userId: context.user.id,
		requestId: context.request.headers.get("x-request-id"),
		ipAddress: clientIp(context.request),
	};
}

async function adminContext(permission: SystemPermission) {
	const request = getRequest();
	const user = await requireAdmin(request, permission);
	const env = getCloudflareEnv(request);
	const db = env.DB;
	if (!db) throw new Error("D1 binding DB is unavailable");
	return { db, env, request, user };
}
