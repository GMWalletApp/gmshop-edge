// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ deliveryState: "pending" }));
vi.mock("#/features/auth/auth-client", () => ({
	authClient: {
		useSession: () => ({
			data: {
				user: { id: "buyer", email: "a@customer.test", emailVerified: true },
			},
		}),
	},
}));
vi.mock("#/features/agent-access/server/functions", () => ({
	getAgentDeliveryFn: async () => ({
		kind: "subsite",
		state: state.deliveryState,
		orderStatus: state.deliveryState === "active" ? "completed" : "paid",
		email: "a@customer.test",
		domain: "apple.lsrai.shop",
		prefixFallback: "mystore",
		needsSupport: false,
	}),
	openAgentAccountFn: vi.fn(),
	checkAgentAccessFn: vi.fn(),
}));
vi.mock("#/features/agent-access/server/admin", () => ({
	listAgentAccessIssuesFn: vi.fn(),
	prepareAgentProductsFn: vi.fn(),
	retryAgentAccessFn: vi.fn(),
}));
vi.mock("#/paraglide/messages", () => ({
	m: new Proxy({}, { get: (_, key) => () => String(key) }),
}));
vi.mock("#/paraglide/runtime", () => ({ getLocale: () => "zh-CN" }));

import { AgentAccessDelivery } from "#/features/agent-access/components/access";
import {
	agentAccessProducts,
	isAgentAccessProduct,
} from "#/features/agent-access/products";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

async function render() {
	const node = document.createElement("div");
	document.body.appendChild(node);
	const root = createRoot(node);
	await act(async () => {
		root.render(
			<QueryClientProvider
				client={
					new QueryClient({ defaultOptions: { queries: { retry: false } } })
				}
			>
				<AgentAccessDelivery orderNumber="local-order" />
			</QueryClientProvider>,
		);
		await new Promise((r) => setTimeout(r, 20));
	});
	await act(async () => {
		await new Promise((r) => setTimeout(r, 20));
	});
	return { node, root };
}

it("shows the owner's WeChat QR with a tap-to-enlarge link for access orders", async () => {
	for (const deliveryState of ["pending", "active"]) {
		state.deliveryState = deliveryState;
		const { node, root } = await render();
		expect(node.textContent).toContain("agent_access_wechat");
		const image = node.querySelector("img");
		expect(image?.getAttribute("src")).toBe("/owner-wechat-qr.jpg");
		expect(image?.closest("a")?.getAttribute("href")).toBe(
			"/owner-wechat-qr.jpg",
		);
		root.unmount();
		node.remove();
	}
});

it("explains a lost prefix race next to the assigned host", async () => {
	state.deliveryState = "active";
	const { node, root } = await render();
	expect(node.textContent).toContain("agent_subsite_prefix_fallback");
	root.unmount();
	node.remove();
});

it("hides the QR once the opening is revoked", async () => {
	state.deliveryState = "revoked";
	const { node, root } = await render();
	expect(node.querySelector("img")).toBeNull();
	root.unmount();
	node.remove();
});

it("gates the order-page block to the two access products only", () => {
	expect(isAgentAccessProduct(agentAccessProducts.subsite.productId)).toBe(
		true,
	);
	expect(isAgentAccessProduct(agentAccessProducts.api.productId)).toBe(true);
	expect(isAgentAccessProduct("00000000-0000-4000-8000-000000000001")).toBe(
		false,
	);
});
