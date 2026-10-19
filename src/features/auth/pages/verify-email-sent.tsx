"use client";

import { Link } from "@tanstack/react-router";
import { MailCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { useSiteBrand } from "#/context/site-brand-provider";
import { authClient } from "#/features/auth/auth-client";
import { useTurnstile } from "#/features/auth/components/turnstile";
import { m } from "#/paraglide/messages";

export function VerifyEmailSentPage() {
	const brand = useSiteBrand();
	const [email, setEmail] = useState("");
	const [pending, setPending] = useState(false);
	const challenge = useTurnstile("register");
	useEffect(() => {
		setEmail(
			window.sessionStorage.getItem("gmshop.pending_verification_email") ?? "",
		);
	}, []);
	async function resend() {
		if (!email || !challenge.ready) return;
		setPending(true);
		const result = await authClient.sendVerificationEmail(
			{ email, callbackURL: "/account" },
			{ headers: challenge.headers },
		);
		challenge.reset();
		setPending(false);
		if (result.error) return toast.error(m.auth_verification_resend_failed());
		toast.success(m.auth_verification_resent());
	}
	return (
		<div className="w-full space-y-6">
			<div className="space-y-2">
				<p className="font-medium text-primary text-sm">{brand.name}</p>
				<MailCheck className="size-10 text-primary" />
				<h1 className="font-semibold text-3xl tracking-tight">
					{m.auth_verify_email_title()}
				</h1>
				<p className="text-muted-foreground leading-6">
					{m.auth_verify_email_description({ email })}
				</p>
			</div>
			{email ? (
				<>
					{challenge.widget}
					<Button
						disabled={pending || !challenge.ready}
						onClick={() => void resend()}
						variant="outline"
					>
						{m.auth_verification_resend()}
					</Button>
				</>
			) : null}
			<Button asChild variant="link">
				<Link search={{ redirect: undefined }} to="/sign-in">
					{m.auth_back_to_sign_in()}
				</Link>
			</Button>
		</div>
	);
}
