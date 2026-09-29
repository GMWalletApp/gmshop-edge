"use client";

import { useForm } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Loader2, UserPlus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { Input, Password } from "#/components/pro/base/fields/input";
import { Button } from "#/components/ui/button";
import { Label } from "#/components/ui/label";
import { authClient } from "#/features/auth/auth-client";
import { signInErrorMessage } from "#/features/auth/error-message";
import { listPublicAuthProvidersFn } from "#/features/auth/server/provider-admin";
import { m } from "#/paraglide/messages";
import { getLocale } from "#/paraglide/runtime";

export function RegisterPage() {
	const navigate = useNavigate();
	const [pending, setPending] = useState(false);
	const providers = useQuery({
		queryKey: ["public", "auth-providers"],
		queryFn: () => listPublicAuthProvidersFn(),
		staleTime: 30_000,
	});
	const credential = providers.data?.find(
		(provider) => provider.providerType === "email",
	);
	const schema = z
		.object({
			name: z
				.string()
				.trim()
				.min(1, m.auth_name_required())
				.max(120, m.auth_name_too_long()),
			email: z.email({
				error: (issue) =>
					issue.input === "" ? m.auth_email_required() : m.auth_email_invalid(),
			}),
			password: z.string().min(12, m.auth_password_min()),
			confirmPassword: z.string(),
		})
		.refine((value) => value.password === value.confirmPassword, {
			path: ["confirmPassword"],
			message: m.auth_password_mismatch(),
		});
	const form = useForm({
		defaultValues: { name: "", email: "", password: "", confirmPassword: "" },
		validators: { onSubmit: schema },
		onSubmit: async ({ value }) => {
			setPending(true);
			const signUpInput: Parameters<typeof authClient.signUp.email>[0] & {
				preferredLocale: "en-US" | "zh-CN";
			} = {
				name: value.name,
				email: value.email,
				password: value.password,
				preferredLocale: getLocale(),
				callbackURL: "/",
			};
			const result = await authClient.signUp.email(signUpInput);
			setPending(false);
			if (result.error) return toast.error(signInErrorMessage(result.error));
			const session = await authClient.getSession();
			if (session.data?.session) {
				void navigate({ to: "/", replace: true });
				return;
			}
			window.sessionStorage.setItem(
				"gmshop.pending_verification_email",
				value.email,
			);
			void navigate({ to: "/verify-email-sent", replace: true });
		},
	});
	if (providers.isPending)
		return (
			<div className="grid min-h-40 place-items-center">
				<Loader2
					aria-label={m.common_loading()}
					className="animate-spin text-muted-foreground"
				/>
			</div>
		);
	if (!credential?.passwordLoginEnabled || !credential.allowSignup)
		return (
			<div className="grid gap-4 text-center">
				<p className="text-muted-foreground">
					{m.auth_email_sign_in_unavailable()}
				</p>
				<Button asChild variant="link">
					<Link search={{ redirect: undefined }} to="/sign-in">
						{m.auth_have_account()}
					</Link>
				</Button>
			</div>
		);
	return (
		<div className="w-full space-y-6">
			<div className="space-y-2">
				<h1 className="font-semibold text-3xl tracking-tight">
					{m.auth_register_title()}
				</h1>
				<p className="text-muted-foreground leading-6">
					{m.auth_register_description()}
				</p>
			</div>
			<form
				className="grid gap-3"
				onSubmit={(event) => {
					event.preventDefault();
					void form.handleSubmit();
				}}
			>
				<form.Field name="name">
					{(field) => (
						<RegistrationInput
							id="register-name"
							label={m.auth_register_name()}
							value={field.state.value}
							error={field.state.meta.errors[0]?.message}
							onBlur={field.handleBlur}
							onChange={field.handleChange}
						/>
					)}
				</form.Field>
				<form.Field name="email">
					{(field) => (
						<RegistrationInput
							id="register-email"
							label={m.common_email()}
							type="email"
							value={field.state.value}
							error={field.state.meta.errors[0]?.message}
							onBlur={field.handleBlur}
							onChange={field.handleChange}
						/>
					)}
				</form.Field>
				<form.Field name="password">
					{(field) => (
						<RegistrationInput
							id="register-password"
							label={m.common_password()}
							password
							value={field.state.value}
							error={field.state.meta.errors[0]?.message}
							onBlur={field.handleBlur}
							onChange={field.handleChange}
						/>
					)}
				</form.Field>
				<form.Field name="confirmPassword">
					{(field) => (
						<RegistrationInput
							id="register-confirm-password"
							label={m.auth_confirm_password()}
							password
							value={field.state.value}
							error={field.state.meta.errors[0]?.message}
							onBlur={field.handleBlur}
							onChange={field.handleChange}
						/>
					)}
				</form.Field>
				<Button className="mt-2" disabled={pending} type="submit">
					{pending ? <Loader2 className="animate-spin" /> : <UserPlus />}
					{m.auth_register_submit()}
				</Button>
				<Button asChild variant="link">
					<Link search={{ redirect: undefined }} to="/sign-in">
						{m.auth_have_account()}
					</Link>
				</Button>
			</form>
		</div>
	);
}

function RegistrationInput({
	id,
	label,
	value,
	error,
	type,
	password = false,
	onBlur,
	onChange,
}: {
	id: string;
	label: string;
	value: string;
	error?: string;
	type?: string;
	password?: boolean;
	onBlur: () => void;
	onChange: (value: string) => void;
}) {
	const Control = password ? Password : Input;
	return (
		<div className="grid gap-2">
			<Label htmlFor={id}>{label}</Label>
			<Control
				id={id}
				type={type}
				value={value}
				aria-invalid={Boolean(error)}
				onBlur={onBlur}
				onChange={(event) => onChange(event.currentTarget.value)}
			/>
			{error ? <p className="text-destructive text-sm">{error}</p> : null}
		</div>
	);
}
