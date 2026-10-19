import { useForm } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Loader2, LogIn } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { Captcha, Input, Password } from "#/components/pro/base/fields/input";
import { AuthProviderLogo } from "#/components/provider-logo";
import { Button } from "#/components/ui/button";
import { Label } from "#/components/ui/label";
import { authClient } from "#/features/auth/auth-client";
import { useAuthAnimation } from "#/features/auth/components/auth-animation-context";
import { useTurnstile } from "#/features/auth/components/turnstile";
import { signInErrorMessage } from "#/features/auth/error-message";
import { listPublicAuthProvidersFn } from "#/features/auth/server/provider-admin";
import { cn } from "#/lib/utils";
import { m } from "#/paraglide/messages";

interface UserAuthFormProps extends React.HTMLAttributes<HTMLFormElement> {
	redirectTo?: string;
}

export function UserAuthForm({
	className,
	redirectTo = "/",
	...props
}: UserAuthFormProps) {
	const [isLoading, setIsLoading] = useState(false);
	const animation = useAuthAnimation();
	const navigate = useNavigate();
	const providers = useQuery({
		queryKey: ["public", "auth-providers"],
		queryFn: () => listPublicAuthProvidersFn(),
		staleTime: 30_000,
	});
	const [emailMethod, setEmailMethod] = useState<"password" | "otp">(
		"password",
	);
	const [emailValue, setEmailValue] = useState("");
	const [sentEmail, setSentEmail] = useState<string | null>(null);
	const challenge = useTurnstile("register");
	const emailProvider = providers.data?.find(
		(provider) => provider.providerType === "email",
	);
	const externalProviders =
		providers.data?.filter((provider) => provider.providerType === "social") ??
		[];
	const showPassword =
		Boolean(emailProvider?.passwordLoginEnabled) &&
		(emailMethod === "password" || !emailProvider?.emailOtpEnabled);
	const showEmailOtp = Boolean(emailProvider?.emailOtpEnabled) && !showPassword;
	const formSchema = z
		.object({
			email: z.email({
				error: (iss) =>
					iss.input === "" ? m.auth_email_required() : undefined,
			}),
			password: z.string(),
			otp: z.string(),
		})
		.superRefine((value, context) => {
			if (showPassword) {
				if (!value.password)
					context.addIssue({
						code: "custom",
						path: ["password"],
						message: m.auth_password_required(),
					});
				else if (value.password.length < 12)
					context.addIssue({
						code: "custom",
						path: ["password"],
						message: m.auth_password_min(),
					});
				return;
			}
			if (!/^\d{6}$/.test(value.otp))
				context.addIssue({
					code: "custom",
					path: ["otp"],
					message: m.auth_email_otp_invalid(),
				});
		});

	const form = useForm({
		defaultValues: {
			email: "",
			password: "",
			otp: "",
		},
		validators: { onSubmit: formSchema },
		onSubmit: ({ value }) => signIn(value),
	});

	async function signIn(data: z.infer<typeof formSchema>) {
		setIsLoading(true);
		if (typeof window !== "undefined") {
			window.sessionStorage.setItem("gmshop.post_auth_redirect", redirectTo);
		}

		if (showEmailOtp) {
			if (sentEmail !== data.email.trim()) {
				setIsLoading(false);
				toast.error(m.auth_email_otp_send_code());
				return;
			}
			const result = await authClient.signIn.emailOtp({
				email: data.email,
				otp: data.otp,
			});
			setIsLoading(false);
			if (result.error) {
				toast.error(signInErrorMessage(result.error));
				return;
			}
			void navigate({ to: redirectTo, replace: true });
			return;
		}

		toast.promise(
			authClient.signIn.email({
				email: data.email,
				password: data.password,
				callbackURL: redirectTo,
			}),
			{
				loading: m.auth_signingIn(),
				success: (result) => {
					setIsLoading(false);
					if (result.error) throw result.error;
					navigate({ to: redirectTo, replace: true });
					return m.auth_welcomeBack({ email: data.email });
				},
				error: (error) => {
					setIsLoading(false);
					if (
						error &&
						typeof error === "object" &&
						"code" in error &&
						error.code === "EMAIL_NOT_VERIFIED"
					) {
						window.sessionStorage.setItem(
							"gmshop.pending_verification_email",
							data.email.trim(),
						);
						void navigate({ to: "/verify-email-sent" });
					}
					return signInErrorMessage(error);
				},
			},
		);
	}

	return (
		<div className="grid gap-4">
			{emailProvider ? (
				<form
					onSubmit={(event) => {
						event.preventDefault();
						void form.handleSubmit();
					}}
					className={cn("grid gap-3", className)}
					{...props}
				>
					<form.Field name="email">
						{(field) => {
							const error = field.state.meta.errors[0]?.message;
							return (
								<div className="grid gap-2">
									<Label htmlFor="sign-in-email">{m.common_email()}</Label>
									<Input
										id="sign-in-email"
										name={field.name}
										value={field.state.value}
										aria-describedby={error ? "sign-in-email-error" : undefined}
										aria-invalid={Boolean(error)}
										placeholder="name@example.com"
										onBlur={() => {
											animation.setIsTyping(false);
											field.handleBlur();
										}}
										onChange={(event) => {
											const email = event.currentTarget.value;
											setEmailValue(email);
											field.handleChange(email);
											if (sentEmail !== email.trim()) setSentEmail(null);
										}}
										onFocus={() => animation.setIsTyping(true)}
									/>
									{error ? (
										<p
											className="text-sm text-destructive"
											id="sign-in-email-error"
										>
											{error}
										</p>
									) : null}
								</div>
							);
						}}
					</form.Field>
					{showPassword ? (
						<form.Field name="password">
							{(field) => {
								const error = field.state.meta.errors[0]?.message;
								return (
									<div className="relative grid gap-2">
										<div className="flex items-center justify-between gap-3">
											<Label htmlFor="sign-in-password">
												{m.common_password()}
											</Label>
											{emailProvider.emailOtpEnabled ? (
												<Button
													className="h-auto p-0"
													size="sm"
													type="button"
													variant="link"
													onClick={() => setEmailMethod("otp")}
												>
													{m.auth_sign_in_email_code()}
												</Button>
											) : null}
										</div>
										<Password
											id="sign-in-password"
											name={field.name}
											value={field.state.value}
											aria-describedby={
												error ? "sign-in-password-error" : undefined
											}
											aria-invalid={Boolean(error)}
											placeholder="********"
											onBlur={() => {
												animation.setIsTyping(false);
												field.handleBlur();
											}}
											onChange={(event) => {
												animation.setPasswordLength(event.target.value.length);
												field.handleChange(event.currentTarget.value);
											}}
											onFocus={() => animation.setIsTyping(true)}
											onVisibilityChange={animation.setShowPassword}
										/>
										{error ? (
											<p
												className="text-sm text-destructive"
												id="sign-in-password-error"
											>
												{error}
											</p>
										) : null}
										<div className="flex justify-end">
											<Button
												asChild
												className="h-auto px-0 py-0"
												size="sm"
												variant="link"
											>
												<Link to="/forgot-password">
													{m.auth_forgot_password()}
												</Link>
											</Button>
										</div>
									</div>
								);
							}}
						</form.Field>
					) : (
						<form.Field name="otp">
							{(field) => {
								const error = field.state.meta.errors[0]?.message;
								return (
									<div className="grid gap-2">
										<div className="flex items-center justify-between gap-3">
											<Label htmlFor="sign-in-otp">
												{m.auth_email_otp_code()}
											</Label>
											{emailProvider.passwordLoginEnabled ? (
												<Button
													className="h-auto p-0"
													size="sm"
													type="button"
													variant="link"
													onClick={() => setEmailMethod("password")}
												>
													{m.auth_sign_in_password()}
												</Button>
											) : null}
										</div>
										{challenge.widget}
										<Captcha
											autoComplete="one-time-code"
											disabled={!z.email().safeParse(emailValue.trim()).success}
											id="sign-in-otp"
											inputMode="numeric"
											maxLength={6}
											value={field.state.value}
											aria-describedby={error ? "sign-in-otp-error" : undefined}
											aria-invalid={Boolean(error)}
											onBlur={field.handleBlur}
											onChange={(event) =>
												field.handleChange(
													event.currentTarget.value.replace(/\D/g, ""),
												)
											}
											onSend={sendCode}
										/>
										{sentEmail ? (
											<p className="text-muted-foreground text-xs">
												{m.auth_email_otp_sent({ email: sentEmail })}
											</p>
										) : null}
										{error ? (
											<p
												className="text-sm text-destructive"
												id="sign-in-otp-error"
											>
												{error}
											</p>
										) : null}
									</div>
								);
							}}
						</form.Field>
					)}
					<Button className="mt-2" disabled={isLoading}>
						{isLoading ? <Loader2 className="animate-spin" /> : <LogIn />}
						{m.auth_submit()}
					</Button>
				</form>
			) : null}
			{externalProviders.length ? (
				<>
					{emailProvider ? (
						<div className="flex items-center gap-3 text-muted-foreground text-xs before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">
							{m.auth_or_continue_with()}
						</div>
					) : null}
					<div className="grid gap-2">
						{externalProviders.map((provider) => (
							<Button
								key={provider.providerId}
								type="button"
								variant="outline"
								onClick={() => void signInWithProvider(provider)}
							>
								<AuthProviderLogo
									className="size-5 rounded-sm"
									logoUrl={provider.icon}
									providerId={provider.providerId}
								/>
								{provider.displayName}
							</Button>
						))}
					</div>
				</>
			) : null}
			{emailProvider?.passwordLoginEnabled && emailProvider.allowSignup ? (
				<Button asChild variant="link">
					<Link to="/register">{m.auth_create_account()}</Link>
				</Button>
			) : null}
		</div>
	);

	async function signInWithProvider(provider: {
		providerId: string;
		providerType: string;
	}) {
		if (typeof window !== "undefined")
			window.sessionStorage.setItem("gmshop.post_auth_redirect", redirectTo);
		if (provider.providerType === "social") {
			await authClient.signIn.social({
				provider: provider.providerId as
					| "apple"
					| "discord"
					| "github"
					| "google"
					| "line"
					| "microsoft"
					| "telegram"
					| "wechat",
				callbackURL: redirectTo,
			});
			return;
		}
		throw new Error("unsupported_auth_provider");
	}

	async function sendCode() {
		const email = String(form.getFieldValue("email")).trim();
		if (!z.email().safeParse(email).success) {
			toast.error(m.auth_email_required());
			return false;
		}
		if (!challenge.ready) {
			toast.error(m.auth_human_verification_required());
			return false;
		}
		const result = await authClient.emailOtp.sendVerificationOtp(
			{ email, type: "sign-in" },
			{ headers: challenge.headers },
		);
		// Turnstile tokens are single-use; a resend needs a fresh challenge.
		challenge.reset();
		if (result.error) {
			toast.error(signInErrorMessage(result.error));
			return false;
		}
		setSentEmail(email);
		return true;
	}
}
