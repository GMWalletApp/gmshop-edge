"use client";

import { Headphones, LoaderCircle, Send, X } from "lucide-react";
import {
	type KeyboardEvent,
	type SyntheticEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { Textarea } from "#/components/pro/base/fields/input";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { authClient } from "#/features/auth/auth-client";
import { cn } from "#/lib/utils";
import { m } from "#/paraglide/messages";
import { getLocale } from "#/paraglide/runtime";
import {
	decryptWebSupportReply,
	getWebSupportIdentity,
	loadWebSupportMessages,
	saveWebSupportMessage,
	setWebSupportConversationId,
	type WebSupportLocalMessage,
} from "../web-support-storage";

type SupportStatus = {
	enabled: boolean;
	hasConversation: boolean;
	status: string | null;
};

function formatMessageTime(timestamp: number) {
	return new Intl.DateTimeFormat(getLocale(), {
		hour: "2-digit",
		minute: "2-digit",
	}).format(timestamp);
}

function deriveDeviceFingerprint() {
	return import("@fingerprintjs/fingerprintjs")
		.then((module) => module.default.load({ monitoring: false }))
		.then((agent) => agent.get())
		.then((result) => ({
			visitorId: result.visitorId,
			version: result.version,
		}))
		.catch(() => undefined);
}

export function WebSupportWidget() {
	const session = authClient.useSession();
	const [available, setAvailable] = useState(false);
	const [supportEnabled, setSupportEnabled] = useState(false);
	const [open, setOpen] = useState(false);
	const [status, setStatus] = useState<string | null>(null);
	const [email, setEmail] = useState("");
	const [messages, setMessages] = useState<WebSupportLocalMessage[]>([]);
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const lastSequence = useRef(0);
	const messagesViewportRef = useRef<HTMLDivElement>(null);
	const sessionEmail = session.data?.user?.email ?? "";

	useEffect(() => {
		void Promise.all([
			fetch("/api/support/web/status", { credentials: "include" }).then(
				(response) => response.json() as Promise<SupportStatus>,
			),
			loadWebSupportMessages(),
		])
			.then(([result, localMessages]) => {
				setAvailable(result.enabled || result.hasConversation);
				setSupportEnabled(result.enabled);
				setStatus(result.status);
				setMessages(localMessages);
				lastSequence.current = Math.max(
					0,
					...localMessages.map((message) => message.sequence ?? 0),
				);
			})
			.catch(() => undefined);
	}, []);

	useEffect(() => {
		if (sessionEmail) setEmail(sessionEmail);
	}, [sessionEmail]);

	const poll = useCallback(async () => {
		if (!open || !["active", "closing"].includes(status ?? "")) return;
		const response = await fetch(
			`/api/support/web/current?after=${lastSequence.current}`,
			{ credentials: "include" },
		);
		if (!response.ok) return;
		const result = (await response.json()) as {
			status: string;
			replies: Array<{
				id: string;
				sequence: number;
				algorithm: string;
				wrapped_key: string;
				iv: string;
				ciphertext: string;
				created_at: number;
			}>;
		};
		setStatus(result.status);
		if (result.replies.length === 0) return;
		const identity = await getWebSupportIdentity();
		if (!identity.conversationId) return;
		const received: WebSupportLocalMessage[] = [];
		for (const reply of result.replies) {
			const message: WebSupportLocalMessage = {
				id: reply.id,
				role: "support",
				text: await decryptWebSupportReply(
					identity,
					identity.conversationId,
					reply,
				),
				createdAt: reply.created_at,
				sequence: reply.sequence,
			};
			await saveWebSupportMessage(message);
			received.push(message);
			lastSequence.current = Math.max(lastSequence.current, reply.sequence);
		}
		setMessages((current) => [...current, ...received]);
		await fetch("/api/support/web/replies/ack", {
			method: "POST",
			credentials: "include",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ids: result.replies.map((reply) => reply.id) }),
		});
	}, [open, status]);

	useEffect(() => {
		void poll();
		if (!open) return;
		const interval = window.setInterval(() => {
			if (document.visibilityState === "visible" && navigator.onLine)
				void poll();
		}, 3000);
		return () => window.clearInterval(interval);
	}, [open, poll]);

	useEffect(() => {
		if (!open || (messages.length === 0 && status !== "closed")) return;
		const frame = window.requestAnimationFrame(() => {
			const viewport = messagesViewportRef.current;
			if (!viewport) return;
			viewport.scrollTop = viewport.scrollHeight;
		});
		return () => window.cancelAnimationFrame(frame);
	}, [messages.length, open, status]);

	if (!available) return null;

	async function startConversation(
		event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
	) {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			// Reopening an existing conversation never stores a fingerprint, so the
			// device identifier is only derived when a new conversation starts.
			const [identity, fingerprint] = await Promise.all([
				getWebSupportIdentity(),
				status === "closed" ? undefined : deriveDeviceFingerprint(),
			]);
			const response = await fetch("/api/support/web/conversations", {
				method: "POST",
				credentials: "include",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					email: sessionEmail || email,
					visitorId: identity.visitorId,
					publicKeyJwk: identity.publicKeyJwk,
					fingerprint,
					diagnostics: {
						locale: getLocale(),
						timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
					},
				}),
			});
			if (!response.ok) throw new Error("start_failed");
			const result = (await response.json()) as { id: string; status: string };
			await setWebSupportConversationId(result.id);
			setStatus(result.status);
		} catch {
			setError(m.web_support_failed());
		} finally {
			setBusy(false);
		}
	}

	async function sendMessage(
		event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
	) {
		event.preventDefault();
		const value = text.trim();
		if (!value || busy) return;
		setBusy(true);
		setError(null);
		const message: WebSupportLocalMessage = {
			id: crypto.randomUUID(),
			role: "customer",
			text: value,
			createdAt: Date.now(),
		};
		try {
			const response = await fetch("/api/support/web/messages", {
				method: "POST",
				credentials: "include",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ clientMessageId: message.id, text: value }),
			});
			if (!response.ok) throw new Error("send_failed");
			await saveWebSupportMessage(message);
			setMessages((current) => [...current, message]);
			setText("");
		} catch {
			setError(m.web_support_failed());
		} finally {
			setBusy(false);
		}
	}

	function handleMessageKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
		if (
			event.key !== "Enter" ||
			event.shiftKey ||
			event.nativeEvent.isComposing
		)
			return;
		event.preventDefault();
		event.currentTarget.form?.requestSubmit();
	}

	return (
		<>
			<Button
				className="fixed right-4 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-40 rounded-full shadow-lg lg:bottom-6"
				size="lg"
				onClick={() => setOpen(true)}
				aria-label={m.web_support_button()}
			>
				<Headphones />{" "}
				<span className="hidden sm:inline">{m.web_support_button()}</span>
			</Button>
			{open ? (
				<section
					role="dialog"
					aria-modal="true"
					aria-labelledby="web-support-title"
					className="fixed inset-x-0 bottom-0 z-50 flex h-[min(78dvh,42rem)] flex-col rounded-t-2xl border bg-background shadow-2xl sm:inset-x-auto sm:right-4 sm:bottom-4 sm:h-[38rem] sm:w-[24rem] sm:rounded-2xl"
				>
					<header className="flex items-center justify-between border-b p-4">
						<h2 id="web-support-title" className="font-semibold">
							{m.web_support_title()}
						</h2>
						<Button
							variant="ghost"
							size="icon"
							onClick={() => setOpen(false)}
							aria-label={m.common_close()}
						>
							<X />
						</Button>
					</header>
					{!["active", "closing", "closed"].includes(status ?? "") ? (
						session.isPending ? (
							<div className="flex flex-1 items-center justify-center">
								<LoaderCircle className="animate-spin text-muted-foreground" />
							</div>
						) : (
							<form
								className="flex flex-1 flex-col gap-4 overflow-y-auto p-5"
								onSubmit={startConversation}
							>
								{!sessionEmail ? (
									<Input
										type="email"
										required
										maxLength={254}
										disabled={busy}
										value={email}
										onChange={(event) => setEmail(event.target.value)}
										placeholder={m.web_support_email()}
										aria-label={m.web_support_email()}
									/>
								) : null}
								<p className="text-muted-foreground text-xs leading-5">
									{m.web_support_device_notice()}
								</p>
								{error ? (
									<p className="text-sm text-destructive" role="alert">
										{error}
									</p>
								) : null}
								<Button className="mt-auto w-full" disabled={busy}>
									{busy ? <LoaderCircle className="animate-spin" /> : null}
									{busy ? m.web_support_connecting() : m.web_support_start()}
								</Button>
							</form>
						)
					) : (
						<>
							<div
								ref={messagesViewportRef}
								className="flex-1 scroll-smooth space-y-3 overflow-y-auto p-4 motion-reduce:scroll-auto"
								aria-live="polite"
							>
								{messages.map((message) => (
									<div
										key={message.id}
										className={cn(
											"w-fit max-w-[85%] rounded-2xl px-3 py-2 text-sm",
											message.role === "customer"
												? "ml-auto bg-primary text-primary-foreground"
												: "bg-muted",
										)}
									>
										<span className="mb-1 flex items-center gap-2 text-xs opacity-70">
											{message.role === "customer"
												? m.web_support_you()
												: m.web_support_agent()}
											<time
												dateTime={new Date(message.createdAt).toISOString()}
											>
												{formatMessageTime(message.createdAt)}
											</time>
										</span>
										<p className="whitespace-pre-wrap break-words">
											{message.text}
										</p>
									</div>
								))}
								{status === "closed" ? (
									<p className="text-center text-sm text-muted-foreground">
										{m.web_support_closed()}
									</p>
								) : null}
							</div>
							{error ? (
								<p className="px-4 text-sm text-destructive" role="alert">
									{error}
								</p>
							) : null}
							{status === "closed" && supportEnabled ? (
								<form className="border-t p-3" onSubmit={startConversation}>
									<Button className="w-full" disabled={busy}>
										{busy ? <LoaderCircle className="animate-spin" /> : null}
										{busy ? m.web_support_reopening() : m.web_support_reopen()}
									</Button>
								</form>
							) : status !== "closed" ? (
								<form
									className="border-t pb-[env(safe-area-inset-bottom)]"
									onSubmit={sendMessage}
								>
									<Textarea
										allowClear={false}
										className="min-h-20 max-h-32 resize-none rounded-none border-0 bg-transparent px-4 py-3 pr-14 shadow-none focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
										maxLength={3500}
										value={text}
										onChange={(event) => setText(event.target.value)}
										onKeyDown={handleMessageKeyDown}
										placeholder={m.web_support_message_placeholder()}
										aria-label={m.web_support_message_placeholder()}
										suffix={
											<Button
												className="rounded-full"
												size="icon-sm"
												disabled={busy || !text.trim()}
												aria-label={m.web_support_send()}
											>
												<Send />
											</Button>
										}
									/>
								</form>
							) : null}
						</>
					)}
				</section>
			) : null}
		</>
	);
}
