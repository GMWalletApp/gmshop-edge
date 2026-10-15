"use client";

import { useMutation } from "@tanstack/react-query";
import { MailX } from "lucide-react";
import { Button } from "#/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "#/components/ui/card";
import { unsubscribeRenewalFn } from "#/features/renewals/server/public";
import { m } from "#/paraglide/messages";

export function RenewalUnsubscribePage({
	email,
	signature,
}: {
	email?: string;
	signature?: string;
}) {
	const unsubscribe = useMutation({
		mutationFn: () =>
			unsubscribeRenewalFn({
				data: { email: email ?? "", signature: signature ?? "" },
			}),
	});
	const invalid =
		!email ||
		!signature ||
		unsubscribe.data?.ok === false ||
		unsubscribe.isError;
	return (
		<main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-10">
			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2 text-lg">
						<MailX aria-hidden className="size-5" />
						{m.renewal_unsubscribe_title()}
					</CardTitle>
					{email && !unsubscribe.data?.ok ? (
						<CardDescription className="break-all">
							{m.renewal_unsubscribe_description({ email })}
						</CardDescription>
					) : null}
				</CardHeader>
				<CardContent className="flex flex-col gap-3">
					{unsubscribe.data?.ok ? (
						<output>{m.renewal_unsubscribe_done()}</output>
					) : invalid ? (
						<p className="text-destructive" role="alert">
							{m.renewal_unsubscribe_invalid()}
						</p>
					) : (
						<Button
							className="w-full"
							disabled={unsubscribe.isPending}
							onClick={() => unsubscribe.mutate()}
							type="button"
						>
							{m.renewal_unsubscribe_confirm()}
						</Button>
					)}
				</CardContent>
			</Card>
		</main>
	);
}
