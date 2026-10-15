import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { RenewalUnsubscribePage } from "#/features/renewals/pages/unsubscribe";

const searchSchema = z.object({
	e: z.string().max(320).optional().catch(undefined),
	sig: z.string().max(128).optional().catch(undefined),
});

export const Route = createFileRoute("/(public)/unsubscribe/renewal")({
	validateSearch: searchSchema,
	head: () => ({ meta: [{ name: "robots", content: "noindex" }] }),
	component: RenewalUnsubscribeRoute,
});

function RenewalUnsubscribeRoute() {
	const search = Route.useSearch();
	return <RenewalUnsubscribePage email={search.e} signature={search.sig} />;
}
