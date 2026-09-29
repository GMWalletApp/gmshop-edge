import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import type { z } from "zod";
import { createWalletTopupPayment } from "#/features/shop-payments/server/service";
import { resolveStoreAccount } from "#/features/storefront/server/account";
import { clientIp } from "#/server/client-ip";
import { getDb } from "#/server/db.server";
import { walletTopupSchema } from "../schema";
import { getWallet } from "./ledger";

export const getWalletFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const request = getRequest();
		const db = getDb(request).$client;
		const account = await resolveStoreAccount(db, request, { required: true });
		return getWallet(db, account?.user.id ?? "");
	},
);

export const createWalletTopupFn = createServerFn({ method: "POST" })
	.validator((value: z.input<typeof walletTopupSchema>) =>
		walletTopupSchema.parse(value),
	)
	.handler(async ({ data }) => {
		const request = getRequest();
		const db = getDb(request).$client;
		const account = await resolveStoreAccount(db, request, { required: true });
		const returnUrl = new URL("/account", request.url).toString();
		return createWalletTopupPayment(db, {
			userId: account?.user.id ?? "",
			amountMinor: data.amountMinor,
			channelId: data.channelId,
			idempotencyKey: `topup:${account?.user.id}:${data.idempotencyKey}`,
			paymentCurrency: data.paymentCurrency,
			successUrl: returnUrl,
			cancelUrl: returnUrl,
			payerIp: clientIp(request),
		});
	});
