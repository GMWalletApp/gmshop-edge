import { createBuildJobSchema } from "#/features/builds/schema";
import {
	encryptAutomationCallbackSecret,
	encryptBuildInput,
} from "#/features/builds/secrets";
import {
	assertKnownInputKeys,
	type ProductInputDefinition,
	parseProductInputDefinitions,
	serializeInputValue,
} from "#/features/catalog/input-values";
import { getStoreOrder } from "#/features/storefront/server/order-query";
import { DomainError } from "#/lib/domain-error";
import { clientIp } from "#/server/client-ip";
import { loadRuntimeConfig } from "#/server/runtime-config";

const buildDispatchWindowMs = 86_400_000;

type BuildContext = {
	entitlement_id: string;
	order_item_id: string;
	definition_version_id: string;
	usage_limit: number | null;
	usage_count: number;
	automation_config_id: string;
	provider: "github_actions" | "gitlab_ci";
	provider_base_url: string;
	repository_owner: string;
	repository_name: string;
	default_branch: string;
	workflow_file: string;
	method_id: string;
	method_key: string;
	method_runtime: string;
	method_branch: string | null;
	method_command: string | null;
	artifact_policy: "none" | "optional" | "required";
	output_pattern: string;
};

type Definition = ProductInputDefinition & {
	id: string;
};

export async function createBuildJob(
	db: D1Database,
	rawInput: unknown,
	access: { userId?: string; actorUserId?: string; request?: Request } = {},
) {
	const input = createBuildJobSchema.parse(rawInput);
	// Authorize the order first and scope the client-chosen key to it, so a
	// key can neither probe nor replay another customer's job.
	const order = await getStoreOrder(db, input, access);
	const idempotencyKey = `${order.id}:${input.idempotencyKey}`;
	const existing = await findJobByIdempotencyKey(
		db,
		idempotencyKey,
		// Keys issued before keys were scoped to the order still replay, but only
		// against the same order.
		{ legacyKey: input.idempotencyKey, orderId: order.id },
	);
	if (existing) return existing;
	await assertBuildNotificationChannelAvailable(
		db,
		order.id,
		input.notificationChannel,
	);
	const context = await db
		.prepare(
			`SELECT ce.id AS entitlement_id, ce.order_item_id,
			 item.active_definition_version_id AS definition_version_id,
			 ce.usage_limit, ce.usage_count, item.id AS automation_config_id,
			 item.automation_provider AS provider,
			 item.automation_base_url AS provider_base_url,
			 item.automation_repository_owner AS repository_owner,
			 item.automation_repository_name AS repository_name,
			 item.automation_default_branch AS default_branch,
			 item.automation_workflow_file AS workflow_file,
			 bm.id AS method_id, bm.key AS method_key,
			 bm.runtime AS method_runtime, bm.branch AS method_branch,
			 bm.command AS method_command, bm.artifact_policy, bm.output_pattern
			 FROM customer_entitlements ce
			 JOIN shop_order_items oi ON oi.id = ce.order_item_id
			 JOIN product_sellable_items item ON item.id = ce.sellable_item_id
			  AND item.product_id = ce.product_id
			 JOIN product_automation_methods bm ON bm.id = ?
			  AND bm.sellable_item_id = item.id
			  AND bm.config_version = item.version AND bm.enabled = 1
			 WHERE ce.id = ? AND oi.order_id = ? AND ce.entitlement_type = 'automation'
			 AND ce.status IN ('active', 'exhausted')
			 AND item.active_definition_version_id IS NOT NULL
			 AND (ce.expires_at IS NULL OR ce.expires_at > ?)
			 AND item.enabled = 1 AND item.automation_provider IS NOT NULL LIMIT 1`,
		)
		.bind(input.methodId, input.entitlementId, order.id, Date.now())
		.first<BuildContext>();
	if (!context)
		throw new DomainError(
			"automation_entitlement_unavailable",
			404,
			"Build entitlement is unavailable",
		);
	const definitionVersion = await db
		.prepare(
			`SELECT schema_json FROM product_definition_versions WHERE id = ? LIMIT 1`,
		)
		.bind(context.definition_version_id)
		.first<{ schema_json: string }>();
	if (!definitionVersion)
		throw new DomainError(
			"automation_definition_unavailable",
			409,
			"Automation input definition is unavailable",
		);
	const definitions = parseProductInputDefinitions(
		context.definition_version_id,
		definitionVersion.schema_json,
	);
	assertKnownInputKeys(
		input.authorizationValues,
		definitions,
		"authorization",
		"automation",
	);
	assertKnownInputKeys(
		input.automationValues,
		definitions,
		"automation",
		"automation",
	);
	const currentAuthorization = await db
		.prepare(
			`SELECT id, definition_key, masked_value FROM entitlement_authorization_values
			 WHERE entitlement_id = ?`,
		)
		.bind(context.entitlement_id)
		.all<{ id: string; definition_key: string; masked_value: string }>();
	const authorizationIds = new Map(
		currentAuthorization.results.map((row) => [row.definition_key, row.id]),
	);
	const authorizationMasks = new Map(
		currentAuthorization.results.map((row) => [
			row.definition_key,
			row.masked_value,
		]),
	);
	const runtime = await loadRuntimeConfig(db);
	if (!runtime.commerceSecret)
		throw new DomainError(
			"automation_secret_unavailable",
			503,
			"Build secret configuration is unavailable",
		);
	const authorizationWrites: Array<{
		definition: Definition;
		id: string;
		encrypted: string;
		masked: string;
		previousMasked: string | null;
	}> = [];
	const jobInputs: Array<{
		definition: Definition;
		authorizationValueId: string | null;
		value: string | null;
		valueEncrypted: string | null;
	}> = [];
	for (const definition of definitions) {
		if (definition.scope === "order") continue;
		if (definition.scope === "authorization") {
			const provided = input.authorizationValues[definition.definition_key];
			let authorizationValueId = authorizationIds.get(
				definition.definition_key,
			);
			if (provided !== undefined) {
				const value = serializeInputValue(definition, provided, "automation");
				authorizationValueId ??= crypto.randomUUID();
				authorizationWrites.push({
					definition,
					id: authorizationValueId,
					encrypted: await encryptBuildInput(value, runtime.commerceSecret),
					masked: maskValue(value),
					previousMasked:
						authorizationMasks.get(definition.definition_key) ?? null,
				});
			}
			if (!authorizationValueId && definition.required)
				throw new DomainError(
					"automation_input_required",
					400,
					`Authorization input ${definition.definition_key} is required`,
				);
			if (authorizationValueId)
				jobInputs.push({
					definition,
					authorizationValueId,
					value: null,
					valueEncrypted: null,
				});
			continue;
		}
		const provided = input.automationValues[definition.definition_key];
		if (
			provided === undefined &&
			!definition.required &&
			!definition.default_value
		)
			continue;
		const value = serializeInputValue(
			definition,
			provided ?? definition.default_value ?? "",
			"automation",
		);
		jobInputs.push({
			definition,
			authorizationValueId: null,
			value: definition.sensitive ? null : value,
			valueEncrypted: definition.sensitive
				? await encryptBuildInput(value, runtime.commerceSecret)
				: null,
		});
	}
	const jobId = crypto.randomUUID();
	const now = Date.now();
	const timeoutAt = now + buildDispatchWindowMs;
	if (!runtime.automationCallbackSecret)
		throw new DomainError(
			"automation_secret_unavailable",
			503,
			"Build callback key is unavailable",
		);
	const callbackSecretEncrypted = await encryptAutomationCallbackSecret(
		runtime.automationCallbackSecret,
		runtime.commerceSecret,
	);
	const inputsJson = JSON.stringify(
		Object.fromEntries(
			jobInputs
				.filter((item) => item.value !== null || item.authorizationValueId)
				.map((item) => [
					item.definition.definition_key,
					item.authorizationValueId
						? {
								authorizationValueId: item.authorizationValueId,
								maskedValue:
									authorizationWrites.find(
										(write) => write.id === item.authorizationValueId,
									)?.masked ??
									authorizationMasks.get(item.definition.definition_key) ??
									null,
							}
						: { value: item.value as string },
				]),
		),
	);
	const sensitiveInputsJson = JSON.stringify(
		Object.fromEntries(
			jobInputs
				.filter((item) => item.valueEncrypted !== null)
				.map((item) => [
					item.definition.definition_key,
					{ envelope: item.valueEncrypted as string, keyVersion: 1 },
				]),
		),
	);
	const statements: D1PreparedStatement[] = [
		db
			.prepare(
				`INSERT INTO automation_jobs
				 (id, entitlement_id, order_item_id, sellable_item_id, automation_method_id,
				  definition_version_id, provider, provider_base_url, repository_owner, repository_name,
				  branch, workflow_file, method_key, runtime, command, artifact_policy, output_pattern,
				  callback_secret_encrypted, callback_secret_key_version, idempotency_key,
				  notification_channel, inputs_json, sensitive_inputs_json,
				  status, attempt_count, next_attempt_at, timeout_at, created_at, updated_at)
				 SELECT ?, ce.id, ce.order_item_id, ?, ?, ?, ?, ?, ?, ?,
				  ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?
				 FROM customer_entitlements ce
				 WHERE ce.id = ? AND ce.status IN ('active', 'exhausted')
				 AND (ce.expires_at IS NULL OR ce.expires_at > ?)
				 AND (ce.usage_limit IS NULL OR ce.usage_count < ce.usage_limit)`,
			)
			.bind(
				jobId,
				context.automation_config_id,
				context.method_id,
				context.definition_version_id,
				context.provider,
				context.provider_base_url,
				context.repository_owner,
				context.repository_name,
				context.method_branch || context.default_branch,
				context.workflow_file,
				context.method_key,
				context.method_runtime,
				context.method_command,
				context.artifact_policy,
				context.output_pattern,
				callbackSecretEncrypted,
				idempotencyKey,
				input.notificationChannel,
				inputsJson,
				sensitiveInputsJson,
				now,
				timeoutAt,
				now,
				now,
				context.entitlement_id,
				now,
			),
		db
			.prepare(
				`UPDATE customer_entitlements SET
				 usage_count = usage_count + 1,
				 status = CASE
				  WHEN usage_limit IS NOT NULL AND usage_count + 1 >= usage_limit
				  THEN 'exhausted'
				  ELSE 'active'
				 END,
				 updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM automation_jobs WHERE id = ?)`,
			)
			.bind(now, context.entitlement_id, jobId),
		db
			.prepare(
				`INSERT INTO entitlement_events
				 (id, kind, entitlement_id, event_type, amount, source_type, source_id,
				  idempotency_key, created_at)
				 SELECT ?, 'usage', ?, 'consumed', 1, 'automation_job', ?, ?, ?
				 FROM automation_jobs WHERE id = ?`,
			)
			.bind(
				crypto.randomUUID(),
				context.entitlement_id,
				jobId,
				`entitlement-usage:automation:${jobId}`,
				now,
				jobId,
			),
	];
	for (const write of authorizationWrites)
		statements.push(
			db
				.prepare(
					`INSERT INTO entitlement_authorization_values
					 (id, entitlement_id, definition_key, value_encrypted,
					  key_version, masked_value, created_at, updated_at)
					 SELECT ?, ?, ?, ?, 1, ?, ?, ? FROM automation_jobs WHERE id = ?
					 ON CONFLICT(entitlement_id, definition_key) DO UPDATE SET
					 value_encrypted = excluded.value_encrypted, key_version = excluded.key_version,
					 masked_value = excluded.masked_value, updated_at = excluded.updated_at`,
				)
				.bind(
					write.id,
					context.entitlement_id,
					write.definition.definition_key,
					write.encrypted,
					write.masked,
					now,
					now,
					jobId,
				),
			buildAuditStatement(db, jobId, access, {
				action: write.previousMasked
					? "automation.authorization_updated"
					: "automation.authorization_created",
				targetType: "entitlement_authorization_value",
				targetId: write.id,
				before: write.previousMasked
					? {
							definitionKey: write.definition.definition_key,
							maskedValue: write.previousMasked,
						}
					: null,
				after: {
					definitionKey: write.definition.definition_key,
					maskedValue: write.masked,
				},
			}),
		);
	statements.push(
		db
			.prepare(
				`INSERT INTO outbox_events
				 (id, event_type, aggregate_type, aggregate_id, idempotency_key, payload,
				  status, attempt_count, created_at, updated_at)
				 SELECT ?, 'automation.requested', 'automation_job', ?, ?, ?, 'pending', 0, ?, ?
				 FROM automation_jobs WHERE id = ?`,
			)
			.bind(
				crypto.randomUUID(),
				jobId,
				`automation-requested:${jobId}`,
				JSON.stringify({ automationJobId: jobId }),
				now,
				now,
				jobId,
			),
		buildAuditStatement(db, jobId, access, {
			action: "automation.job_created",
			targetType: "automation_job",
			targetId: jobId,
			after: {
				entitlementId: context.entitlement_id,
				methodKey: context.method_key,
				notificationChannel: input.notificationChannel,
				authorizationKeys: authorizationWrites.map(
					(write) => write.definition.definition_key,
				),
				buildKeys: jobInputs
					.filter((item) => !item.authorizationValueId)
					.map((item) => item.definition.definition_key),
			},
		}),
	);
	let results: D1Result<unknown>[];
	try {
		results = await db.batch(statements);
	} catch (error) {
		const replay = await findJobByIdempotencyKey(db, idempotencyKey);
		if (replay) return replay;
		throw error;
	}
	if (Number(results[0]?.meta.changes ?? 0) !== 1)
		throw new DomainError(
			"automation_capacity_unavailable",
			409,
			"Build quota is exhausted",
		);
	return { id: jobId, status: "queued", timeoutAt, duplicate: false };
}

async function findJobByIdempotencyKey(
	db: D1Database,
	idempotencyKey: string,
	legacy?: { legacyKey: string; orderId: string },
) {
	const job = legacy
		? await db
				.prepare(
					`SELECT jobs.id, jobs.status, jobs.timeout_at FROM automation_jobs jobs
					 JOIN shop_order_items items ON items.id = jobs.order_item_id
					 WHERE jobs.idempotency_key IN (?, ?) AND items.order_id = ? LIMIT 1`,
				)
				.bind(idempotencyKey, legacy.legacyKey, legacy.orderId)
				.first<{ id: string; status: string; timeout_at: number }>()
		: await db
				.prepare(
					"SELECT id, status, timeout_at FROM automation_jobs WHERE idempotency_key = ? LIMIT 1",
				)
				.bind(idempotencyKey)
				.first<{ id: string; status: string; timeout_at: number }>();
	return job
		? {
				id: job.id,
				status: job.status,
				timeoutAt: job.timeout_at,
				duplicate: true as const,
			}
		: null;
}

async function assertBuildNotificationChannelAvailable(
	db: D1Database,
	orderId: string,
	channel: "none" | "email",
) {
	if (channel === "none") return;
	const available = await db
		.prepare(
			`SELECT 1 AS available FROM shop_orders o
			 WHERE o.id = ? AND length(o.normalized_contact_email) > 3
			 AND EXISTS (
			  SELECT 1 FROM notification_channel_configs config
			  WHERE config.channel = 'email' AND config.enabled = 1
			 ) LIMIT 1`,
		)
		.bind(orderId)
		.first<{ available: number }>();
	if (available) return;
	throw new DomainError(
		"automation_notification_channel_unavailable",
		409,
		"Email notification is unavailable",
	);
}

function buildAuditStatement(
	db: D1Database,
	jobId: string,
	access: { actorUserId?: string; request?: Request },
	input: {
		action: string;
		targetType: string;
		targetId: string;
		before?: Record<string, unknown> | null;
		after?: Record<string, unknown> | null;
	},
) {
	return db
		.prepare(
			`INSERT INTO audit_logs
			 (id, actor_user_id, action, target_type, target_id, request_id,
			  ip_address, before, after, created_at)
			 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM automation_jobs WHERE id = ?`,
		)
		.bind(
			crypto.randomUUID(),
			access.actorUserId ?? null,
			input.action,
			input.targetType,
			input.targetId,
			access.request?.headers.get("x-request-id") ?? null,
			clientIp(access.request),
			input.before == null ? null : JSON.stringify(input.before),
			input.after == null ? null : JSON.stringify(input.after),
			Date.now(),
			jobId,
		);
}

function maskValue(value: string) {
	if (value.length <= 4) return "••••";
	return `${value.slice(0, 2)}••••${value.slice(-2)}`;
}
