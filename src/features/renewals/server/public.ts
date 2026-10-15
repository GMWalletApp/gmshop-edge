import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { getCloudflareEnv } from "#/server/db.server";
import { unsubscribeRenewalEmail } from "./links";

const unsubscribeInput = z.object({
	email: z.string().trim().max(320),
	signature: z.string().trim().max(128),
});

export const unsubscribeRenewalFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof unsubscribeInput>) =>
		unsubscribeInput.parse(input),
	)
	.handler(async ({ data }) => {
		const db = getCloudflareEnv(getRequest()).DB;
		if (!db) throw new Error("D1 binding DB is unavailable");
		return unsubscribeRenewalEmail(db, data.email, data.signature);
	});
