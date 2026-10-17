// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelegramSettingsPage } from "#/features/telegram/pages/admin";
import { m } from "#/paraglide/messages";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

globalThis.ResizeObserver ??= class {
	observe() {}
	unobserve() {}
	disconnect() {}
};

const mocks = vi.hoisted(() => ({
	getTelegramSettingsFn: vi.fn(),
	saveFeishuAlertSettingsFn: vi.fn(async () => ({ saved: true })),
	saveTelegramOwnerAlertSettingsFn: vi.fn(async () => ({ saved: true })),
	saveTelegramSettingsFn: vi.fn(async () => ({ saved: true })),
	syncTelegramBotFn: vi.fn(),
	testFeishuAlertFn: vi.fn(async () => ({ sent: true })),
	testTelegramOwnerAlertFn: vi.fn(async () => ({ sent: true })),
	verifyTelegramOwnerAlertFn: vi.fn(async () => ({
		verified: true,
		type: "supergroup",
		title: "Owner",
	})),
}));

vi.mock("#/features/telegram/server/admin", () => ({
	getTelegramSettingsFn: mocks.getTelegramSettingsFn,
	saveFeishuAlertSettingsFn: mocks.saveFeishuAlertSettingsFn,
	saveTelegramOwnerAlertSettingsFn: mocks.saveTelegramOwnerAlertSettingsFn,
	saveTelegramSettingsFn: mocks.saveTelegramSettingsFn,
	syncTelegramBotFn: mocks.syncTelegramBotFn,
	testFeishuAlertFn: mocks.testFeishuAlertFn,
	testTelegramOwnerAlertFn: mocks.testTelegramOwnerAlertFn,
	verifyTelegramOwnerAlertFn: mocks.verifyTelegramOwnerAlertFn,
}));

const settings = {
	autoSyncEnabled: true,
	autoSyncIntervalMs: 60_000,
	supportEnabled: false,
	webSupportEnabled: false,
	supportChatId: "-1001234567890",
	idleTimeoutMs: 86_400_000,
	status: "active",
	syncedRevision: 1,
	syncedBotUserId: "42",
	syncedBotName: "GMShop",
	syncedDataKeyId: "key",
	syncedOrigin: "https://shop.example",
	syncedCommandVersion: "v1.1",
	lastSyncedAt: null,
	lastAutoSyncCheckAt: null,
	lastErrorCode: null,
	nextRetryAt: null,
	syncAttempts: 0,
	lastAdminSyncAt: null,
	botName: "GMShop",
	botUsername: "gmshop_bot",
	dependencyAvailable: true,
	webhookUrl: "https://shop.example/api/telegram/webhook",
	webhookHealth: {
		status: "ready",
		pendingUpdates: 0,
		lastErrorAt: null,
		errorCode: null,
	},
	lastWebhookUpdateAt: null,
	activeConversationCount: 0,
	administratorCount: 0,
	feishuAlerts: {
		enabled: false,
		appId: null,
		chatId: null,
		hasAppSecret: false,
		lastSentAt: null,
		lastErrorCode: null,
	},
	ownerTelegramAlerts: {
		enabled: false,
		chatId: "-5101401750",
		hasBotToken: true,
		lastSentAt: null,
		lastErrorCode: null,
	},
};

describe("telegram settings page", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		mocks.getTelegramSettingsFn.mockResolvedValue({ ...settings });
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
		vi.clearAllMocks();
	});

	it("saves Telegram owner alerts without resending the write-only bot token", async () => {
		const queryClient = new QueryClient({
			defaultOptions: {
				mutations: { retry: false },
				queries: { retry: false },
			},
		});
		await act(async () => {
			root.render(
				<QueryClientProvider client={queryClient}>
					<TelegramSettingsPage />
				</QueryClientProvider>,
			);
		});
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
		});
		const trigger = Array.from(container.querySelectorAll("button")).find(
			(button) =>
				button.textContent?.includes(m.telegram_owner_alerts_action()),
		);
		expect(trigger).toBeDefined();
		await act(async () => trigger?.click());
		const tokenInput = document.body.querySelector<HTMLInputElement>(
			'input[type="password"]',
		);
		expect(tokenInput?.value).toBe("");
		expect(tokenInput?.placeholder).toBe(m.settings_secret_configured());
		const enabledSwitch = document.body.querySelector<HTMLButtonElement>(
			`[data-slot="switch"][aria-label="${m.telegram_owner_alerts_enabled()}"]`,
		);
		expect(enabledSwitch).not.toBeNull();
		await act(async () => enabledSwitch?.click());
		await act(async () => {
			document.body.querySelector("form")?.requestSubmit();
		});
		expect(mocks.saveTelegramOwnerAlertSettingsFn).toHaveBeenCalledWith({
			data: { enabled: true, chatId: "-5101401750" },
		});
		expect(mocks.saveFeishuAlertSettingsFn).not.toHaveBeenCalled();
	});

	it("submits the support switch as a boolean when enabling support", async () => {
		const queryClient = new QueryClient({
			defaultOptions: {
				mutations: { retry: false },
				queries: { retry: false },
			},
		});
		await act(async () => {
			root.render(
				<QueryClientProvider client={queryClient}>
					<TelegramSettingsPage />
				</QueryClientProvider>,
			);
		});

		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
		});

		const trigger = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.includes(m.telegram_support_action()),
		);
		expect(trigger).toBeDefined();
		await act(async () => trigger?.click());

		const supportSwitch = document.body.querySelector<HTMLButtonElement>(
			`[data-slot="switch"][aria-label="${m.telegram_support_enabled()}"]`,
		);
		expect(supportSwitch).not.toBeNull();
		expect(supportSwitch?.getAttribute("data-state")).toBe("unchecked");
		await act(async () => supportSwitch?.click());
		expect(supportSwitch?.getAttribute("data-state")).toBe("checked");

		await act(async () => {
			document.body.querySelector("form")?.requestSubmit();
		});

		expect(mocks.saveTelegramSettingsFn).toHaveBeenCalledWith({
			data: {
				autoSyncEnabled: true,
				autoSyncIntervalMs: 60_000,
				supportEnabled: true,
				webSupportEnabled: false,
				supportChatId: "-1001234567890",
				idleTimeoutMs: 86_400_000,
			},
		});
	});
});
