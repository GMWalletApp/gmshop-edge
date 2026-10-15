import { createFileRoute } from "@tanstack/react-router";
import { RenewalRemindersPage } from "#/features/renewals/pages/admin";

export const Route = createFileRoute("/admin/email/renewal")({
	component: RenewalRemindersPage,
});
