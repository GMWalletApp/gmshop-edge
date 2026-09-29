import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dispatchGitHubActionsBuild } from "#/features/builds/providers/github-actions";
import { saveBuildConfiguration } from "#/features/builds/server/admin";
import {
	processAutomationCallback,
	uploadAutomationArtifact,
} from "#/features/builds/server/callback";
import {
	cancelBuildJob,
	retryBuildJob,
} from "#/features/builds/server/job-actions";
import { createBuildJob } from "#/features/builds/server/jobs";
import { fanOutPendingCommerceNotifications } from "#/features/notifications/server/fanout";
import { hmacSha256Hex } from "#/features/shop-payments/signature";
import { storeAutomationArtifactResponse } from "#/features/storefront/server/build-artifact-response";
import { getStoreOrder } from "#/features/storefront/server/order-query";
import { applyMigrations } from "./migrations";

vi.mock("cloudflare:workers", () => ({ env: {} }));

const productId = "11111111-1111-4111-8111-111111111111";
const sellableItemId = "22222222-2222-4222-8222-222222222222";
const entitlementId = "33333333-3333-4333-8333-333333333333";
const dataEncryptionSecret = "commerce-test-secret";
const callbackSecret = "build-callback-secret-at-least-32-characters";
const customerAccess = { userId: "customer-build" };

describe("build lifecycle", { timeout: 30_000 }, () => {
	let miniflare: Miniflare;
	let database: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmshop-edge-build-lifecycle" },
		});
		database = await miniflare.getD1Database("DB");
		await applyMigrations(database);
		await seed(database);
	});

	afterAll(async () => miniflare.dispose());

	it("validates, encrypts, dispatches and completes a build with an artifact", async () => {
		const method = await database
			.prepare(
				"SELECT id FROM product_automation_methods WHERE sellable_item_id = ? LIMIT 1",
			)
			.bind(sellableItemId)
			.first<{ id: string }>();
		if (!method) throw new Error("Build method fixture is required");
		await expect(
			createBuildJob(
				database,
				{
					orderNumber: "GM200001",
					entitlementId,
					methodId: method.id,
					idempotencyKey: "build-input-required",
					authorizationValues: {},
					automationValues: { channel: "stable" },
				},
				customerAccess,
			),
		).rejects.toMatchObject({ code: "automation_input_required" });
		await expect(
			createBuildJob(
				database,
				{
					orderNumber: "GM200001",
					entitlementId,
					methodId: method.id,
					idempotencyKey: "build-input-invalid",
					authorizationValues: { license_key: "LICENSE-SECRET-123" },
					automationValues: { channel: "unknown" },
				},
				customerAccess,
			),
		).rejects.toMatchObject({ code: "automation_input_invalid" });
		const rejectedInputState = await database
			.prepare(
				`SELECT ce.usage_count,
				 (SELECT COUNT(*) FROM automation_jobs
				  WHERE entitlement_id = ce.id) AS jobs
				 FROM customer_entitlements ce WHERE ce.id = ?`,
			)
			.bind(entitlementId)
			.first<Record<string, number>>();
		expect(rejectedInputState).toEqual({ usage_count: 0, jobs: 0 });
		const created = await createBuildJob(
			database,
			{
				orderNumber: "GM200001",
				entitlementId,
				methodId: method.id,
				idempotencyKey: "build-lifecycle-idempotency",
				notificationChannel: "none",
				authorizationValues: { license_key: "LICENSE-SECRET-123" },
				automationValues: { channel: "stable" },
			},
			customerAccess,
		);
		expect(created).toMatchObject({ status: "queued", duplicate: false });
		const beforeDispatch = await database
			.prepare(
				`SELECT bj.status, bj.notification_channel, ce.usage_count,
				 bj.callback_secret_encrypted,
				 (SELECT value_encrypted FROM entitlement_authorization_values
				  WHERE entitlement_id = ce.id) AS authorization_encrypted,
				 (SELECT payload FROM outbox_events WHERE aggregate_id = bj.id) AS payload
				 FROM automation_jobs bj JOIN customer_entitlements ce ON ce.id = bj.entitlement_id
				 WHERE bj.id = ?`,
			)
			.bind(created.id)
			.first<Record<string, unknown>>();
		expect(beforeDispatch).toMatchObject({
			status: "queued",
			notification_channel: "none",
			usage_count: 1,
		});
		expect(String(beforeDispatch?.authorization_encrypted)).not.toContain(
			"LICENSE-SECRET-123",
		);
		expect(String(beforeDispatch?.payload)).not.toContain("LICENSE-SECRET-123");
		expect(String(beforeDispatch?.callback_secret_encrypted)).not.toContain(
			callbackSecret,
		);
		const creationAudits = await database
			.prepare(
				`SELECT action, before, after FROM audit_logs
				 WHERE target_id IN (?, (SELECT id FROM entitlement_authorization_values
				  WHERE entitlement_id = ?)) ORDER BY action`,
			)
			.bind(created.id, entitlementId)
			.all<Record<string, unknown>>();
		expect(creationAudits.results.map(({ action }) => action)).toEqual([
			"automation.authorization_created",
			"automation.job_created",
		]);
		expect(JSON.stringify(creationAudits.results)).not.toContain(
			"LICENSE-SECRET-123",
		);

		let dispatchBody = "";
		await expect(
			dispatchGitHubActionsBuild(database, created.id, async (_url, init) => {
				dispatchBody = String(init?.body ?? "");
				return new Response(null, { status: 204 });
			}),
		).resolves.toMatchObject({ status: "running", duplicate: false });
		expect(dispatchBody).not.toContain("LICENSE-SECRET-123");
		expect(dispatchBody).not.toContain(callbackSecret);
		expect(dispatchBody).toContain("gmshop_payload_encrypted");
		expect(JSON.parse(dispatchBody)).toMatchObject({
			inputs: {
				gmshop_job_id: created.id,
				gmshop_callback_url:
					"https://shop.example/api/shop/automation/callback",
				gmshop_artifact_upload_url: `https://shop.example/api/shop/automation/${created.id}/artifacts`,
			},
		});
		const timestamp = Date.now();
		const runningBody = JSON.stringify({
			jobId: created.id,
			status: "running",
			providerJobId: "github-run-100",
			runUrl: "https://github.com/gmshop/example-app/actions/runs/100",
		});
		await expect(
			processAutomationCallback(
				database,
				runningBody,
				await signature(timestamp, runningBody),
				timestamp,
			),
		).resolves.toMatchObject({ status: "running", duplicate: true });
		const runningJob = await database
			.prepare(
				"SELECT provider_job_id, run_url FROM automation_jobs WHERE id = ? LIMIT 1",
			)
			.bind(created.id)
			.first<Record<string, unknown>>();
		expect(runningJob).toEqual({
			provider_job_id: "github-run-100",
			run_url: "https://github.com/gmshop/example-app/actions/runs/100",
		});
		const foreignRunBody = JSON.stringify({
			jobId: created.id,
			status: "running",
			providerJobId: "github-run-foreign",
		});
		await expect(
			processAutomationCallback(
				database,
				foreignRunBody,
				await signature(timestamp, foreignRunBody),
				timestamp,
			),
		).rejects.toMatchObject({ code: "automation_provider_job_mismatch" });
		const consumedAudit = await database
			.prepare(
				`SELECT after FROM audit_logs WHERE action = 'automation.authorization_consumed'
				 AND target_id = ? LIMIT 1`,
			)
			.bind(created.id)
			.first<{ after: string }>();
		expect(JSON.parse(consumedAudit?.after ?? "null")).toEqual({
			authorizationKeys: ["license_key"],
		});

		const earlySuccessBody = JSON.stringify({
			jobId: created.id,
			status: "succeeded",
			providerJobId: "github-run-100",
		});
		await expect(
			processAutomationCallback(
				database,
				earlySuccessBody,
				await signature(timestamp, earlySuccessBody),
				timestamp,
			),
		).rejects.toMatchObject({ code: "automation_artifact_required" });

		const artifactId = "44444444-4444-4444-8444-444444444444";
		const bytes = new TextEncoder().encode("release-content");
		const checksum = await sha256Hex(bytes.buffer);
		const artifactPayload = `${created.id}.${artifactId}.release.zip.${checksum}`;
		const artifactSignature = await signature(timestamp, artifactPayload);
		const objects = new Map<string, Uint8Array<ArrayBuffer>>();
		const bucket = {
			put: async (key: string, value: Uint8Array<ArrayBuffer>) =>
				void objects.set(key, value),
			delete: async (key: string) => void objects.delete(key),
			get: async (key: string) => {
				const value = objects.get(key);
				return value ? { bytes: async () => value } : null;
			},
		};
		await expect(
			uploadAutomationArtifact(
				database,
				bucket,
				{
					jobId: created.id,
					artifactId,
					fileName: "release.zip",
					contentType: "application/zip",
				},
				bytes.buffer,
				artifactSignature,
				timestamp,
			),
		).resolves.toMatchObject({ duplicate: false, checksumSha256: checksum });
		expect(objects.size).toBe(1);
		await expect(
			uploadAutomationArtifact(
				database,
				bucket,
				{
					jobId: created.id,
					artifactId,
					fileName: "release.zip",
					contentType: "application/zip",
				},
				bytes.buffer,
				artifactSignature,
				timestamp,
			),
		).resolves.toMatchObject({ duplicate: true, checksumSha256: checksum });
		const conflictingBytes = new TextEncoder().encode("different-content");
		const conflictingChecksum = await sha256Hex(conflictingBytes.buffer);
		const conflictingPayload = `${created.id}.${artifactId}.release.zip.${conflictingChecksum}`;
		await expect(
			uploadAutomationArtifact(
				database,
				bucket,
				{
					jobId: created.id,
					artifactId,
					fileName: "release.zip",
					contentType: "application/zip",
				},
				conflictingBytes.buffer,
				await signature(timestamp, conflictingPayload),
				timestamp,
			),
		).rejects.toMatchObject({ code: "automation_artifact_conflict" });

		const callbackBody = JSON.stringify({
			jobId: created.id,
			status: "succeeded",
			providerJobId: "github-run-100",
			runUrl: "https://github.com/gmshop/example-app/actions/runs/100",
		});
		await expect(
			processAutomationCallback(
				database,
				callbackBody,
				await signature(timestamp, callbackBody),
				timestamp,
			),
		).resolves.toMatchObject({ status: "succeeded", duplicate: false });
		await expect(
			processAutomationCallback(
				database,
				callbackBody,
				await signature(timestamp, callbackBody),
				timestamp,
			),
		).resolves.toMatchObject({ status: "succeeded", duplicate: true });
		await expect(
			uploadAutomationArtifact(
				database,
				bucket,
				{
					jobId: created.id,
					artifactId,
					fileName: "release.zip",
					contentType: "application/zip",
				},
				bytes.buffer,
				artifactSignature,
				timestamp,
			),
		).resolves.toMatchObject({ duplicate: true, checksumSha256: checksum });
		await expect(
			uploadAutomationArtifact(
				database,
				bucket,
				{
					jobId: created.id,
					artifactId,
					fileName: "release.zip",
					contentType: "application/octet-stream",
				},
				bytes.buffer,
				artifactSignature,
				timestamp,
			),
		).rejects.toMatchObject({ code: "automation_artifact_conflict" });
		const completed = await database
			.prepare(
				`SELECT bj.status, bj.provider_job_id,
				 (SELECT COUNT(*) FROM automation_artifacts WHERE automation_job_id = bj.id) AS artifacts,
				 (SELECT COUNT(*) FROM shop_order_events WHERE event_type = 'automation_succeeded') AS events
				 FROM automation_jobs bj WHERE bj.id = ?`,
			)
			.bind(created.id)
			.first<Record<string, unknown>>();
		expect(completed).toEqual({
			status: "succeeded",
			provider_job_id: "github-run-100",
			artifacts: 1,
			events: 1,
		});
		const artifactResponse = await storeAutomationArtifactResponse(
			new Request("https://shop.example/artifact", {
				method: "POST",
				headers: {
					"x-request-id": "artifact-download",
					"x-gmshop-client-ip": "192.0.2.20",
				},
			}),
			{
				orderNumber: "GM200001",
				automationJobId: created.id,
				artifactId,
			},
			database,
			{
				get: async (key: string) => {
					const value = objects.get(key);
					return value
						? {
								body: new Response(value).body,
								httpEtag: '"artifact-etag"',
								writeHttpMetadata() {},
							}
						: null;
				},
			} as unknown as R2Bucket,
			customerAccess,
		);
		expect(artifactResponse.status).toBe(200);
		expect(artifactResponse.headers.get("cache-control")).toBe(
			"private, no-store",
		);
		expect(await artifactResponse.text()).toBe("release-content");
		const accessState = await database
			.prepare(
				`SELECT ce.access_count, artifact.download_count,
				 (SELECT COUNT(*) FROM audit_logs
				  WHERE action = 'automation_artifact.accessed'
				  AND target_id = artifact.id) AS audits
				 FROM customer_entitlements ce
				 JOIN automation_jobs job ON job.entitlement_id = ce.id
				 JOIN automation_artifacts artifact ON artifact.automation_job_id = job.id
				 WHERE artifact.id = ?`,
			)
			.bind(artifactId)
			.first<Record<string, number>>();
		expect(accessState).toEqual({
			access_count: 1,
			download_count: 1,
			audits: 1,
		});
		await expect(
			fanOutPendingCommerceNotifications(database),
		).resolves.toMatchObject({ deliveries: 0 });
		const currentDefinition = await database
			.prepare(
				`SELECT version.id, version.version, version.schema_json
				 FROM product_sellable_items item
				 JOIN product_definition_versions version
				  ON version.id = item.active_definition_version_id
				 WHERE item.id = ?`,
			)
			.bind(sellableItemId)
			.first<{ id: string; version: number; schema_json: string }>();
		if (!currentDefinition) throw new Error("Active definition is required");
		const updatedDefinitionKey = `BUILD_INPUT_${crypto
			.randomUUID()
			.replaceAll("-", "_")
			.toUpperCase()}`;
		const updatedDefinitionId = crypto.randomUUID();
		const updatedSchema = (
			JSON.parse(currentDefinition.schema_json) as Array<
				Record<string, unknown>
			>
		).map((definition) =>
			definition.key === "channel"
				? { ...definition, key: updatedDefinitionKey }
				: definition,
		);
		const updatedAt = Date.now();
		await database.batch([
			database
				.prepare(
					`INSERT INTO product_definition_versions
					 (id, product_id, sellable_item_id, version, schema_json, published_at,
					  created_by, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, 'admin-user', ?, ?)`,
				)
				.bind(
					updatedDefinitionId,
					productId,
					sellableItemId,
					currentDefinition.version + 1,
					JSON.stringify(updatedSchema),
					updatedAt,
					updatedAt,
					updatedAt,
				),
			database
				.prepare(
					"UPDATE product_sellable_items SET active_definition_version_id = ?, updated_at = ? WHERE id = ?",
				)
				.bind(updatedDefinitionId, updatedAt, sellableItemId),
		]);
		const refreshedOrder = await getStoreOrder(
			database,
			{ orderNumber: "GM200001" },
			customerAccess,
		);
		expect(refreshedOrder.automationRuns[0]?.definitions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ key: updatedDefinitionKey }),
			]),
		);
		const reused = await createBuildJob(
			database,
			{
				orderNumber: "GM200001",
				entitlementId,
				methodId: method.id,
				idempotencyKey: "build-lifecycle-reuse",
				authorizationValues: {},
				automationValues: { [updatedDefinitionKey]: "stable" },
			},
			customerAccess,
		);
		expect(reused).toMatchObject({ status: "queued", duplicate: false });
		const reuseState = await database
			.prepare(
				`SELECT
				 (SELECT COUNT(*) FROM entitlement_authorization_values
				  WHERE entitlement_id = ?) AS authorization_values,
				 (SELECT COUNT(*) FROM automation_jobs WHERE id = ?
				  AND json_extract(inputs_json, '$.license_key.authorizationValueId') IS NOT NULL) AS authorization_references,
				 (SELECT COUNT(*) FROM automation_jobs WHERE id = ?
				  AND definition_version_id = ?
				  AND json_extract(inputs_json, ?) = 'stable') AS build_values`,
			)
			.bind(
				entitlementId,
				reused.id,
				reused.id,
				updatedDefinitionId,
				`$.${updatedDefinitionKey}.value`,
			)
			.first<Record<string, unknown>>();
		expect(reuseState).toEqual({
			authorization_values: 1,
			authorization_references: 1,
			build_values: 1,
		});
		await expect(
			cancelBuildJob(database, reused.id, {
				orderId: "another-order",
				actorUserId: null,
			}),
		).rejects.toMatchObject({ code: "automation_job_not_found" });
		await expect(
			cancelBuildJob(database, reused.id, {
				orderId: "order-build",
				actorUserId: null,
			}),
		).resolves.toMatchObject({ status: "cancelled" });
		await expect(
			retryBuildJob(database, reused.id, {
				orderId: "order-build",
				actorUserId: null,
			}),
		).resolves.toMatchObject({ status: "queued" });
		const actionState = await database
			.prepare(
				`SELECT bj.status,
				 (SELECT COUNT(*) FROM outbox_events WHERE aggregate_id = bj.id
				  AND event_type = 'automation.requested') AS requests,
				 (SELECT COUNT(*) FROM audit_logs WHERE target_id = bj.id
				  AND action IN ('automation_job.cancelled', 'automation_job.retried')) AS audits
				 FROM automation_jobs bj WHERE bj.id = ?`,
			)
			.bind(reused.id)
			.first<Record<string, unknown>>();
		expect(actionState).toEqual({ status: "queued", requests: 2, audits: 2 });
		await database.batch([
			database
				.prepare(
					`UPDATE product_sellable_items
					 SET automation_provider = 'gitlab_ci',
					  automation_base_url = 'https://gitlab.example.com'
					 WHERE id = (SELECT sellable_item_id FROM automation_jobs WHERE id = ?)`,
				)
				.bind(reused.id),
			database
				.prepare(
					"UPDATE automation_jobs SET provider = 'gitlab_ci', provider_base_url = 'https://gitlab.example.com' WHERE id = ?",
				)
				.bind(reused.id),
		]);
		let gitLabRequest: { url: string; init?: RequestInit } | undefined;
		await expect(
			dispatchGitHubActionsBuild(database, reused.id, async (url, init) => {
				gitLabRequest = { url: String(url), init };
				return Response.json(
					{
						id: 42,
						web_url:
							"https://gitlab.example.com/gmshop/example-app/-/pipelines/42",
					},
					{ status: 201 },
				);
			}),
		).resolves.toMatchObject({ status: "running", duplicate: false });
		expect(gitLabRequest?.url).toBe(
			"https://gitlab.example.com/api/v4/projects/gmshop%2Fexample-app/pipeline",
		);
		expect(gitLabRequest?.init?.headers).toMatchObject({
			"PRIVATE-TOKEN": "github-token-secret",
		});
		expect(JSON.parse(String(gitLabRequest?.init?.body))).toMatchObject({
			ref: "main",
			variables: expect.arrayContaining([
				{ key: "GMSHOP_JOB_ID", value: reused.id },
				{
					key: "GMSHOP_ARTIFACT_UPLOAD_URL",
					value: `https://shop.example/api/shop/automation/${reused.id}/artifacts`,
				},
			]),
		});

		const constrainedInput = (idempotencyKey: string) => ({
			orderNumber: "GM200001",
			entitlementId,
			methodId: method.id,
			idempotencyKey,
			authorizationValues: {},
			automationValues: { [updatedDefinitionKey]: "stable" },
		});
		await expect(
			createBuildJob(
				database,
				constrainedInput("build-usage-exhausted"),
				customerAccess,
			),
		).rejects.toMatchObject({ code: "automation_capacity_unavailable" });
		await database
			.prepare(
				"UPDATE customer_entitlements SET usage_limit = NULL WHERE id = ?",
			)
			.bind(entitlementId)
			.run();
		await database
			.prepare(
				"UPDATE products SET status = 'trashed', trashed_at = ? WHERE id = ?",
			)
			.bind(Date.now(), productId)
			.run();
		await expect(
			createBuildJob(
				database,
				constrainedInput("build-product-trashed"),
				customerAccess,
			),
		).resolves.toMatchObject({ status: "queued", duplicate: false });
		await database
			.prepare(
				"UPDATE products SET status = 'active', trashed_at = NULL WHERE id = ?",
			)
			.bind(productId)
			.run();
		await database
			.prepare("UPDATE customer_entitlements SET expires_at = 1 WHERE id = ?")
			.bind(entitlementId)
			.run();
		await expect(
			createBuildJob(
				database,
				constrainedInput("build-entitlement-expired"),
				customerAccess,
			),
		).rejects.toMatchObject({ code: "automation_entitlement_unavailable" });
		await database
			.prepare(
				"UPDATE customer_entitlements SET expires_at = NULL WHERE id = ?",
			)
			.bind(entitlementId)
			.run();
		await expect(
			createBuildJob(
				database,
				constrainedInput("build-provider-concurrency"),
				customerAccess,
			),
		).resolves.toMatchObject({ status: "queued", duplicate: false });
		await expect(
			processAutomationCallback(
				database,
				callbackBody,
				"t=1,v1=invalid",
				timestamp,
			),
		).rejects.toMatchObject({ code: "automation_signature_invalid" });
	});

	it("applies optional and none artifact policies", async () => {
		const job = await database
			.prepare(
				"SELECT id FROM automation_jobs WHERE status = 'succeeded' ORDER BY created_at LIMIT 1",
			)
			.first<{ id: string }>();
		if (!job) throw new Error("Succeeded automation fixture is required");
		await database.batch([
			database
				.prepare("DELETE FROM automation_artifacts WHERE automation_job_id = ?")
				.bind(job.id),
			database
				.prepare(
					"UPDATE automation_jobs SET status = 'running', artifact_policy = 'optional', completed_at = NULL WHERE id = ?",
				)
				.bind(job.id),
		]);
		const optionalBody = JSON.stringify({
			jobId: job.id,
			status: "succeeded",
		});
		const now = Date.now();
		await expect(
			processAutomationCallback(
				database,
				optionalBody,
				await signature(now, optionalBody),
				now,
			),
		).resolves.toMatchObject({ status: "succeeded" });

		await database
			.prepare(
				"UPDATE automation_jobs SET status = 'running', artifact_policy = 'none', completed_at = NULL WHERE id = ?",
			)
			.bind(job.id)
			.run();
		const bytes = new TextEncoder().encode("not-accepted");
		const artifactId = "99999999-9999-4999-8999-999999999999";
		const checksum = await sha256Hex(bytes.buffer);
		const payload = `${job.id}.${artifactId}.release.zip.${checksum}`;
		await expect(
			uploadAutomationArtifact(
				database,
				{
					put: async () => undefined,
					delete: async () => undefined,
				},
				{
					jobId: job.id,
					artifactId,
					fileName: "release.zip",
					contentType: "application/zip",
				},
				bytes.buffer,
				await signature(now, payload),
				now,
			),
		).rejects.toMatchObject({ code: "automation_artifact_not_accepted" });
		const noneBody = JSON.stringify({ jobId: job.id, status: "succeeded" });
		await expect(
			processAutomationCallback(
				database,
				noneBody,
				await signature(now, noneBody),
				now,
			),
		).resolves.toMatchObject({ status: "succeeded" });
	});

	it("authorizes the order before consulting idempotency keys and scopes keys to the order", async () => {
		const method = await database
			.prepare(
				"SELECT id FROM product_automation_methods WHERE sellable_item_id = ? LIMIT 1",
			)
			.bind(sellableItemId)
			.first<{ id: string }>();
		if (!method) throw new Error("Build method fixture is required");
		const input = {
			orderNumber: "GM200001",
			entitlementId,
			methodId: method.id,
			idempotencyKey: "build-scoped-idempotency",
			authorizationValues: {},
			automationValues: {},
		};
		const intruder = { userId: "another-customer" };
		await expect(
			createBuildJob(database, input, intruder),
		).rejects.toMatchObject({ code: "order_not_found", status: 404 });
		const created = await createBuildJob(database, input, customerAccess);
		expect(created).toMatchObject({ status: "queued", duplicate: false });
		// A stranger presenting the same key learns nothing about the job.
		await expect(
			createBuildJob(database, input, intruder),
		).rejects.toMatchObject({ code: "order_not_found", status: 404 });
		await expect(
			createBuildJob(database, input, customerAccess),
		).resolves.toMatchObject({ id: created.id, duplicate: true });
		const stored = await database
			.prepare("SELECT idempotency_key FROM automation_jobs WHERE id = ?")
			.bind(created.id)
			.first<{ idempotency_key: string }>();
		expect(stored).toEqual({
			idempotency_key: "order-build:build-scoped-idempotency",
		});
	});
});

async function signature(timestamp: number, payload: string) {
	return `t=${timestamp},v1=${await hmacSha256Hex(callbackSecret, `${timestamp}.${payload}`)}`;
}

async function sha256Hex(body: ArrayBuffer) {
	const digest = await crypto.subtle.digest("SHA-256", body);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

async function seed(database: D1Database) {
	await database.batch([
		database.prepare(
			`INSERT INTO users
			 (id, name, email, email_verified, enabled, created_at, updated_at)
			 VALUES ('admin-user', 'Admin', 'admin@example.com', 1, 1, 1, 1)`,
		),
		database.prepare(
			`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
			 VALUES ('runtime.data_encryption_secret', '"${dataEncryptionSecret}"', 1, 1, 1),
			 ('runtime.automation_callback_secret', '"${callbackSecret}"', 1, 1, 1),
			 ('runtime.better_auth_url', '"https://shop.example"', 0, 1, 1)`,
		),
		database.prepare(
			`INSERT INTO products
			 (id, name, product_type, status, sort_order, created_at, updated_at)
			 VALUES ('${productId}', 'Builder', 'automation', 'active', 100, 1, 1)`,
		),
		database.prepare(
			`INSERT INTO product_sellable_items
			 (id, product_id, name, usage_limit, currency, currency_decimals,
			  price_minor, minimum_quantity,
			  maximum_quantity, sort_order, enabled, created_at, updated_at)
			 VALUES ('${sellableItemId}', '${productId}', 'Standard', 2,
			  'CNY', 2, '1000', 1, 1, 100, 1, 1, 1)`,
		),
	]);
	await saveBuildConfiguration(
		database,
		{
			productId,
			deliveryComponentId: sellableItemId,
			provider: "github_actions",
			baseUrl: "https://api.github.com",
			repositoryOwner: "gmshop",
			repositoryName: "example-app",
			defaultBranch: "main",
			workflowFile: "build.yml",
			credential: "github-token-secret",
			enabled: true,
			methods: [
				{
					key: "production",
					name: "Production",
					description: "",
					runtime: "ubuntu-latest",
					branch: "main",
					command: "bun run build",
					artifactPolicy: "required",
					outputPattern: "dist/*.zip",
					sortOrder: 100,
					enabled: true,
				},
			],
			definitions: [
				{
					key: "license_key",
					name: "License",
					description: "",
					inputType: "text",
					scope: "authorization",
					required: true,
					sensitive: true,
					validationPattern: "^[A-Z0-9-]+$",
					minimumValue: null,
					maximumValue: null,
					defaultValue: "",
					sortOrder: 100,
					options: [],
				},
				{
					key: "channel",
					name: "Channel",
					description: "",
					inputType: "select",
					scope: "automation",
					required: true,
					sensitive: false,
					validationPattern: "",
					minimumValue: null,
					maximumValue: null,
					defaultValue: "stable",
					sortOrder: 200,
					options: [{ value: "stable", label: "Stable" }],
				},
			],
		},
		{ actorUserId: "admin-user" },
	);
	const definition = await database
		.prepare(
			"SELECT id FROM product_definition_versions WHERE sellable_item_id = ? ORDER BY version DESC LIMIT 1",
		)
		.bind(sellableItemId)
		.first<{ id: string }>();
	if (!definition) throw new Error("Definition fixture is required");
	await database.batch([
		database.prepare(
			`INSERT INTO users
			 (id, name, email, email_verified, created_at, updated_at)
			 VALUES ('customer-build', 'Build customer', 'buyer@example.com', 1, 1, 1)`,
		),
		database.prepare(
			`INSERT INTO shop_orders
			 (id, order_number, user_id, contact_email,
			  normalized_contact_email, status, currency, currency_decimals,
			  subtotal_minor, discount_minor, total_minor, paid_minor, version,
			  expires_at, paid_at, completed_at, created_at, updated_at)
			 VALUES ('order-build', 'GM200001', 'customer-build', 'buyer@example.com',
			  'buyer@example.com', 'completed', 'CNY', 2, '1000', '0', '1000',
			  '1000', 3, 9999999999999, 2, 3, 1, 3)`,
		),
		database
			.prepare(
				`INSERT INTO shop_order_items
				 (id, order_id, product_id, sellable_item_id, product_name, delivery_component_id,
				  delivery_component_type, delivery_component_version,
				  sellable_item_name, quantity, unit_price_minor, discount_minor,
				  subtotal_minor, usage_limit, definition_version_id, created_at, updated_at)
				 VALUES ('item-build', 'order-build', '${productId}', '${sellableItemId}', 'Builder',
				  '${sellableItemId}', 'automation', 1,
				  'Standard', 1, '1000', '0',
				  '1000', 2, ?, 1, 1)`,
			)
			.bind(definition.id),
		database
			.prepare(
				`INSERT INTO customer_entitlements
				 (id, user_id, order_item_id, product_id, sellable_item_id, delivery_component_id, entitlement_type,
				  status, definition_version_id, usage_limit, usage_count, access_count,
				  created_at, updated_at)
				 VALUES ('${entitlementId}', 'customer-build', 'item-build', '${productId}',
				  '${sellableItemId}', '${sellableItemId}', 'automation', 'active', ?, 2, 0, 0, 1, 1)`,
			)
			.bind(definition.id),
	]);
}
