"use client";

import { Link, useNavigate } from "@tanstack/react-router";
import { KeyRound, Loader2, Mail } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Password } from "#/components/pro/base/fields/input";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { authClient } from "#/features/auth/auth-client";
import { useTurnstile } from "#/features/auth/components/turnstile";
import { m } from "#/paraglide/messages";

export function ForgotPasswordPage() {
	const navigate = useNavigate();
	const [email, setEmail] = useState("");
	const [otp, setOtp] = useState("");
	const [password, setPassword] = useState("");
	const [confirmation, setConfirmation] = useState("");
	const [pending, setPending] = useState(false);
	const [sent, setSent] = useState(false);
	const challenge = useTurnstile("register");

	async function requestCode() {
		if (!challenge.ready)
			return toast.error(m.auth_human_verification_required());
		setPending(true);
		const result = await authClient.emailOtp.requestPasswordReset(
			{ email },
			{ headers: challenge.headers },
		);
		// Turnstile tokens are single-use; every send needs a fresh challenge.
		challenge.reset();
		setPending(false);
		if (result.error) return toast.error(m.auth_reset_request_failed());
		setSent(true);
		toast.success(m.auth_reset_request_sent());
	}

	async function submit(
		event: React.SyntheticEvent<HTMLFormElement, SubmitEvent>,
	) {
		event.preventDefault();
		if (!sent) {
			await requestCode();
			return;
		}
		if (
			!/^\d{6}$/.test(otp) ||
			password.length < 12 ||
			password !== confirmation
		)
			return toast.error(m.auth_reset_password_invalid());
		setPending(true);
		const result = await authClient.emailOtp.resetPassword({
			email,
			otp,
			password,
		});
		setPending(false);
		if (result.error) return toast.error(m.auth_reset_password_failed());
		toast.success(m.auth_reset_password_success());
		void navigate({
			to: "/sign-in",
			search: { redirect: undefined },
			replace: true,
		});
	}

	return (
		<div className="w-full space-y-6">
			<div className="space-y-2">
				<h1 className="font-semibold text-3xl tracking-tight">
					{m.auth_forgot_password()}
				</h1>
				<p className="text-muted-foreground leading-6">
					{sent
						? m.auth_reset_code_description({ email })
						: m.auth_reset_request_description()}
				</p>
			</div>
			<form className="grid gap-3" onSubmit={submit}>
				<Label htmlFor="reset-email">{m.common_email()}</Label>
				<Input
					autoComplete="email"
					disabled={sent}
					id="reset-email"
					onChange={(event) => setEmail(event.target.value)}
					required
					type="email"
					value={email}
				/>
				{sent ? (
					<>
						<Label htmlFor="reset-code">{m.auth_reset_code()}</Label>
						<Input
							autoComplete="one-time-code"
							id="reset-code"
							inputMode="numeric"
							maxLength={6}
							onChange={(event) =>
								setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))
							}
							pattern="[0-9]{6}"
							required
							value={otp}
						/>
						<Label htmlFor="reset-new-password">{m.auth_new_password()}</Label>
						<Password
							autoComplete="new-password"
							id="reset-new-password"
							maxLength={200}
							minLength={12}
							onChange={(event) => setPassword(event.target.value)}
							required
							value={password}
						/>
						<Label htmlFor="reset-confirm-password">
							{m.auth_confirm_password()}
						</Label>
						<Password
							autoComplete="new-password"
							id="reset-confirm-password"
							maxLength={200}
							minLength={12}
							onChange={(event) => setConfirmation(event.target.value)}
							required
							value={confirmation}
						/>
					</>
				) : (
					challenge.widget
				)}
				<Button disabled={pending || (!sent && !challenge.ready)} type="submit">
					{pending ? (
						<Loader2 className="animate-spin" />
					) : sent ? (
						<KeyRound />
					) : (
						<Mail />
					)}
					{sent
						? m.auth_reset_password_submit()
						: m.auth_reset_request_submit()}
				</Button>
			</form>
			{sent ? (
				<div className="flex flex-wrap gap-2">
					{challenge.widget}
					<Button
						disabled={pending || !challenge.ready}
						onClick={requestCode}
						variant="ghost"
					>
						{m.auth_reset_resend_code()}
					</Button>
					<Button
						disabled={pending}
						onClick={() => {
							setSent(false);
							setOtp("");
						}}
						variant="ghost"
					>
						{m.auth_reset_change_email()}
					</Button>
				</div>
			) : null}
			<div className="flex justify-center">
				<Button asChild variant="link">
					<Link search={{ redirect: undefined }} to="/sign-in">
						{m.auth_back_to_sign_in()}
					</Link>
				</Button>
			</div>
		</div>
	);
}
