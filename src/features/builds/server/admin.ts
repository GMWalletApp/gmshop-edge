import { createServerFn } from "@tanstack/react-start";
import type { z } from "zod";
import { systemPermission } from "#/features/access/system-rbac";
import {
	buildConfigurationIdSchema,
	buildConfigurationListSchema,
	buildConfigurationProductSchema,
	buildDefinitionListSchema,
	saveBuildConfigurationSchema,
} from "#/features/builds/schema";
import {
	decryptBuildConfigSecret,
	encryptBuildConfigSecret,
} from "#/features/builds/secrets";
import { DomainError } from "#/lib/domain-error";
import { isSafeWebhookUrl } from "#/lib/webhook-url";
import { clientIp } from "#/server/client-ip";
import { getAdminServerContext } from "#/server/context";
import { fetchOutbound } from "#/server/outbound-fetch";
import { loadRuntimeConfig } from "#/server/runtime-config";

type SaveInput = z.input<typeof saveBuildConfigurationSchema>;
type SaveOutput = z.output<typeof saveBuildConfigurationSchema>;

export const listBuildConfigurationsFn = createServerFn({
	method: "GET",
})
	.validator((input: z.input<typeof buildConfigurationListSchema>) =>
		buildConfigurationListSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const { db } = await getAdminServerContext(
			systemPermission("automation", "read"),
		);
		const rows = await db.$client
			.prepare(
				`SELECT p.id AS product_id, p.name AS product_name, p.status AS product_status,
				 item.id, item.id AS delivery_component_id, item.name,
				 item.automation_provider AS provider,
				 item.automation_base_url AS base_url,
				 item.automation_repository_owner AS repository_owner,
				 item.automation_repository_name AS repository_name,
				 item.automation_default_branch AS default_branch,
				 item.automation_workflow_file AS workflow_file,
				 item.version AS active_version, item.enabled, item.updated_at,
				 (SELECT COUNT(*) FROM product_automation_methods method
				  WHERE method.sellable_item_id = item.id
				  AND method.config_version = item.version AND method.enabled = 1) AS method_count,
				 COALESCE((SELECT json_array_length(version.schema_json)
				  FROM product_definition_versions version
				  WHERE version.id = item.active_definition_version_id), 0) AS definition_count
				 FROM product_sellable_items item JOIN products p ON p.id = item.product_id
				  AND p.product_type = 'automation'
				 WHERE item.automation_provider IS NOT NULL
				 AND (? IS NULL OR p.id = ?)
				 ORDER BY p.name, item.sort_order, item.id`,
			)
			.bind(data.productId ?? null, data.productId ?? null)
			.all<Record<string, unknown>>();
		return rows.results.map((row) => ({
			productId: String(row.product_id),
			productName: String(row.product_name),
			deliveryComponentId: String(row.delivery_component_id),
			productStatus: String(row.product_status),
			configured: true,
			id: String(row.id),
			name: String(row.name),
			provider: String(row.provider) as "github_actions" | "gitlab_ci",
			baseUrl: String(row.base_url),
			repository:
				row.repository_owner == null
					? null
					: `${row.repository_owner}/${row.repository_name}`,
			branch: row.default_branch == null ? null : String(row.default_branch),
			workflowFile:
				row.workflow_file == null ? null : String(row.workflow_file),
			activeVersion:
				row.active_version == null ? null : Number(row.active_version),
			enabled: Boolean(row.enabled),
			methodCount: Number(row.method_count),
			definitionCount: Number(row.definition_count),
			updatedAt: row.updated_at == null ? null : Number(row.updated_at),
		}));
	});

export const getBuildConfigurationFn = createServerFn({ method: "GET" })
	.validator((input: z.input<typeof buildConfigurationProductSchema>) =>
		buildConfigurationProductSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const { db } = await getAdminServerContext(
			systemPermission("automation", "read"),
		);
		const product = await db.$client
			.prepare(
				`SELECT product.id, product.name,
				 COALESCE((SELECT item.id FROM product_sellable_items item
				  WHERE item.id = ? AND item.product_id = product.id), ?,
				 (SELECT item.id FROM product_sellable_items item
				  WHERE item.product_id = product.id AND item.enabled = 1
				  ORDER BY item.created_at, item.id LIMIT 1)) AS delivery_component_id
				 FROM products product WHERE product.id = ? LIMIT 1`,
			)
			.bind(data.id ?? "", data.deliveryComponentId ?? null, data.productId)
			.first<Record<string, unknown>>();
		if (!product)
			throw new DomainError(
				"automation_product_not_found",
				404,
				"Build product not found",
			);
		if (!product.delivery_component_id)
			throw new DomainError(
				"automation_component_not_found",
				404,
				"Create an enabled build delivery component first",
			);
		if (!data.id)
			return {
				productId: data.productId,
				productName: String(product.name),
				deliveryComponentId: String(product.delivery_component_id),
				configured: false as const,
				methods: [],
				definitions: [],
			};
		const config = await db.$client
			.prepare(
				`SELECT item.* FROM product_sellable_items item
				 WHERE item.id = ? AND item.product_id = ?
				 AND item.automation_provider IS NOT NULL LIMIT 1`,
			)
			.bind(data.id, data.productId)
			.first<Record<string, unknown>>();
		if (!config)
			throw new DomainError(
				"automation_configuration_not_found",
				404,
				"Automation configuration not found",
			);
		const [methods, definitionVersion] = await db.$client.batch([
			db.$client
				.prepare(
					`SELECT key, name, description, runtime, branch, command, artifact_policy, output_pattern,
					 sort_order, enabled FROM product_automation_methods
					 WHERE sellable_item_id = ? AND config_version = ? ORDER BY sort_order, id`,
				)
				.bind(config.id, config.version),
			db.$client
				.prepare(
					`SELECT schema_json FROM product_definition_versions
					 WHERE id = ? LIMIT 1`,
				)
				.bind(config.active_definition_version_id),
		]);
		return {
			productId: data.productId,
			productName: String(product.name),
			deliveryComponentId: String(config.id),
			configured: true as const,
			id: String(config.id),
			provider: String(config.automation_provider) as
				| "github_actions"
				| "gitlab_ci",
			baseUrl: String(config.automation_base_url),
			repositoryOwner: String(config.automation_repository_owner),
			repositoryName: String(config.automation_repository_name),
			defaultBranch: String(config.automation_default_branch),
			workflowFile: String(config.automation_workflow_file),
			enabled: Boolean(config.enabled),
			credentialConfigured: Boolean(config.automation_credential_encrypted),
			activeVersion: Number(config.version),
			methods: rows(methods).map(presentMethod),
			definitions: presentDefinitions(
				String(rows(definitionVersion)[0]?.schema_json ?? "[]"),
			),
		};
	});

export const saveBuildConfigurationFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof saveBuildConfigurationSchema>) =>
		saveBuildConfigurationSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const { currentUser, db, request } = await getAdminServerContext(
			systemPermission("automation", "update"),
		);
		return saveBuildConfiguration(db.$client, data, {
			actorUserId: currentUser.id,
			request,
		});
	});

export const testBuildConfigurationFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof buildConfigurationIdSchema>) =>
		buildConfigurationIdSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const { currentUser, db, request } = await getAdminServerContext(
			systemPermission("automation", "read"),
		);
		const config = await db.$client
			.prepare(
				`SELECT automation_provider AS provider, automation_base_url AS base_url,
				 automation_repository_owner AS repository_owner,
				 automation_repository_name AS repository_name,
				 automation_workflow_file AS workflow_file,
				 automation_credential_encrypted AS credential_encrypted
				 FROM product_sellable_items WHERE id = ?
				 AND automation_provider IS NOT NULL LIMIT 1`,
			)
			.bind(data.id)
			.first<{
				provider: "github_actions" | "gitlab_ci";
				base_url: string;
				repository_owner: string;
				repository_name: string;
				workflow_file: string;
				credential_encrypted: string;
			}>();
		if (!config)
			throw new DomainError(
				"automation_configuration_not_found",
				404,
				"Automation configuration not found",
			);
		const runtime = await loadRuntimeConfig(db.$client);
		const credential = await decryptBuildConfigSecret(
			config.credential_encrypted,
			runtime.commerceSecret,
		);
		const endpoint = buildProviderHealthUrl(config);
		let response: Response;
		try {
			response = await fetchOutbound(
				endpoint,
				{ headers: buildProviderHealthHeaders(config.provider, credential) },
				{ timeoutMs: 8_000, maxResponseBytes: 64 * 1024 },
			);
		} catch (error) {
			if (
				error instanceof DomainError &&
				error.code === "outbound_redirect_rejected"
			)
				throw error;
			throw new DomainError(
				"automation_provider_unreachable",
				502,
				"Build provider is unreachable",
			);
		}
		if (!response.ok)
			throw new DomainError(
				"automation_provider_unhealthy",
				502,
				"Repository, workflow, or credential is invalid",
			);
		await db.$client
			.prepare(
				`INSERT INTO audit_logs
				 (id, actor_user_id, action, target_type, target_id, request_id,
				  ip_address, after, created_at)
				 VALUES (?, ?, 'automation_configuration.connection_tested', 'automation_configuration', ?, ?, ?, ?, ?)`,
			)
			.bind(
				crypto.randomUUID(),
				currentUser.id,
				data.id,
				request.headers.get("x-request-id"),
				clientIp(request),
				JSON.stringify({ healthy: true }),
				Date.now(),
			)
			.run();
		return { healthy: true };
	});

export async function saveBuildConfiguration(
	db: D1Database,
	rawInput: SaveInput,
	context: { actorUserId: string; request?: Request },
) {
	const input = saveBuildConfigurationSchema.parse(rawInput);
	assertUniqueKeys(
		input.methods.map((method) => method.key),
		"automation_method_key",
	);
	assertUniqueKeys(
		input.definitions.map((definition) => definition.key),
		"automation_definition_key",
	);
	for (const definition of input.definitions)
		assertUniqueKeys(
			definition.options.map((option) => option.value),
			"automation_definition_option",
		);
	const runtime = await loadRuntimeConfig(db);
	if (!runtime.commerceSecret)
		throw new DomainError(
			"automation_secret_unavailable",
			503,
			"Build secret configuration is unavailable",
		);
	const existing = await db
		.prepare(
			`SELECT p.id AS product_id, item.id AS delivery_component_id,
			 item.automation_provider, item.version AS active_version,
			 item.automation_credential_encrypted AS credential_encrypted
			 FROM products p
			 JOIN product_sellable_items item ON item.id = ? AND item.product_id = p.id
			 WHERE p.id = ? AND p.product_type = 'automation' LIMIT 1`,
		)
		.bind(input.deliveryComponentId, input.productId)
		.first<{
			product_id: string;
			delivery_component_id: string;
			automation_provider: string | null;
			active_version: number;
			credential_encrypted: string | null;
		}>();
	if (!existing)
		throw new DomainError(
			"automation_product_not_found",
			404,
			"Build product not found",
		);
	if (input.id && input.id !== existing.delivery_component_id)
		throw new DomainError(
			"automation_configuration_not_found",
			404,
			"Automation configuration does not belong to this sellable item",
		);
	if (!existing.automation_provider && !input.credential)
		throw new DomainError(
			"automation_credentials_required",
			400,
			"Credentials are required for a new automation configuration",
		);
	const configId = existing.delivery_component_id;
	const version = existing.active_version + 1;
	const latestDefinitionVersion = await db
		.prepare(
			"SELECT COALESCE(MAX(version), 0) AS version FROM product_definition_versions WHERE sellable_item_id = ?",
		)
		.bind(input.deliveryComponentId)
		.first<{ version: number }>();
	const definitionVersion = Number(latestDefinitionVersion?.version ?? 0) + 1;
	const credentialEncrypted = input.credential
		? await encryptBuildConfigSecret(input.credential, runtime.commerceSecret)
		: existing.credential_encrypted;
	if (!credentialEncrypted)
		throw new DomainError(
			"automation_credentials_required",
			400,
			"Build credentials are required",
		);
	const now = Date.now();
	const definitionVersionId = crypto.randomUUID();
	const statements: D1PreparedStatement[] = [
		db
			.prepare(
				`UPDATE product_sellable_items SET automation_provider = ?,
				 automation_base_url = ?, automation_repository_owner = ?,
				 automation_repository_name = ?, automation_default_branch = ?,
				 automation_workflow_file = ?, automation_credential_encrypted = ?,
				 automation_credential_key_version = 1, version = ?,
				 active_definition_version_id = ?, enabled = ?, updated_at = ?
				 WHERE id = ? AND product_id = ?`,
			)
			.bind(
				input.provider,
				input.baseUrl,
				input.repositoryOwner,
				input.repositoryName,
				input.defaultBranch,
				input.workflowFile,
				credentialEncrypted,
				version,
				definitionVersionId,
				input.enabled ? 1 : 0,
				now,
				configId,
				input.productId,
			),
		db
			.prepare(
				`INSERT INTO product_definition_versions
			 (id, product_id, sellable_item_id, version, schema_json, published_at,
			  created_by, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				definitionVersionId,
				input.productId,
				input.deliveryComponentId,
				definitionVersion,
				JSON.stringify(input.definitions),
				now,
				context.actorUserId,
				now,
				now,
			),
	];
	for (const method of input.methods) {
		statements.push(
			db
				.prepare(
					`INSERT INTO product_automation_methods
					 (id, sellable_item_id, config_version, key, name, description, runtime,
					  branch, command, artifact_policy, output_pattern, sort_order, enabled, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.bind(
					crypto.randomUUID(),
					configId,
					version,
					method.key,
					method.name,
					method.description || null,
					method.runtime,
					method.branch || null,
					method.command || null,
					method.artifactPolicy,
					method.outputPattern,
					method.sortOrder,
					method.enabled ? 1 : 0,
					now,
					now,
				),
		);
	}
	statements.push(
		db
			.prepare(
				`INSERT INTO audit_logs
				 (id, actor_user_id, action, target_type, target_id, request_id,
				  ip_address, after, created_at)
				 VALUES (?, ?, 'automation_configuration.published', 'automation_configuration', ?, ?, ?, ?, ?)`,
			)
			.bind(
				crypto.randomUUID(),
				context.actorUserId,
				configId,
				context.request?.headers.get("x-request-id") ?? null,
				clientIp(context.request),
				JSON.stringify({
					provider: input.provider,
					version,
					methodCount: input.methods.length,
					definitionCount: input.definitions.length,
					enabled: input.enabled,
				}),
				now,
			),
	);
	await db.batch(statements);
	return {
		id: configId,
		productId: input.productId,
		activeVersion: version,
		definitionVersion,
	};
}

function assertUniqueKeys(values: string[], code: string) {
	if (new Set(values).size !== values.length)
		throw new DomainError(code, 400, "Keys must be unique");
}

function rows(result: D1Result<unknown> | undefined) {
	return (result?.results ?? []) as Record<string, unknown>[];
}

function presentMethod(row: Record<string, unknown>) {
	return {
		key: String(row.key),
		name: String(row.name),
		description: row.description == null ? "" : String(row.description),
		runtime: String(row.runtime),
		branch: row.branch == null ? "" : String(row.branch),
		command: row.command == null ? "" : String(row.command),
		artifactPolicy: String(row.artifact_policy) as
			| "none"
			| "optional"
			| "required",
		outputPattern: String(row.output_pattern),
		sortOrder: Number(row.sort_order),
		enabled: Boolean(row.enabled),
	};
}

function presentDefinitions(value: string): SaveOutput["definitions"] {
	try {
		const parsed: unknown = JSON.parse(value);
		return buildDefinitionListSchema.parse(parsed);
	} catch {
		throw new DomainError(
			"automation_definition_invalid",
			500,
			"Published automation definition is invalid",
		);
	}
}

function buildProviderHealthUrl(config: {
	provider: "github_actions" | "gitlab_ci";
	base_url: string;
	repository_owner: string;
	repository_name: string;
	workflow_file: string;
}) {
	const baseUrl = new URL(config.base_url);
	if (baseUrl.protocol !== "https:" || !isSafeWebhookUrl(config.base_url))
		throw new DomainError(
			"automation_provider_url_invalid",
			400,
			"Build provider URL must be a safe public HTTPS URL",
		);
	const project = `${config.repository_owner}/${config.repository_name}`;
	return config.provider === "gitlab_ci"
		? new URL(
				`/api/v4/projects/${encodeURIComponent(project)}`,
				baseUrl,
			).toString()
		: new URL(
				`/repos/${encodeURIComponent(config.repository_owner)}/${encodeURIComponent(config.repository_name)}/actions/workflows/${encodeURIComponent(config.workflow_file)}`,
				baseUrl,
			).toString();
}

function buildProviderHealthHeaders(
	provider: "github_actions" | "gitlab_ci",
	credential: string,
): Record<string, string> {
	return provider === "gitlab_ci"
		? { "PRIVATE-TOKEN": credential, "User-Agent": "GMShop-Edge" }
		: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${credential}`,
				"User-Agent": "GMShop-Edge",
				"X-GitHub-Api-Version": "2022-11-28",
			};
}
