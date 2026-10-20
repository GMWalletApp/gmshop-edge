import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { m } from "#/paraglide/messages";

type Turnstile = {
	render: (element: HTMLElement, options: Record<string, unknown>) => string;
	remove: (id: string) => void;
};
let script: Promise<Turnstile> | undefined;
function loadTurnstile() {
	if (!script)
		script = new Promise<Turnstile>((resolve, reject) => {
			const element = document.createElement("script");
			element.src =
				"https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
			element.async = true;
			element.onload = () => {
				const api = (window as Window & { turnstile?: Turnstile }).turnstile;
				if (api) resolve(api);
				else reject(new Error("turnstile_unavailable"));
			};
			element.onerror = () => {
				script = undefined;
				element.remove();
				reject(new Error("turnstile_unavailable"));
			};
			document.head.appendChild(element);
		});
	return script;
}

function Challenge({
	siteKey,
	action,
	onToken,
}: {
	siteKey: string;
	action: string;
	onToken: (token: string) => void;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		let active = true;
		let widget: string | undefined;
		let api: Turnstile | undefined;
		void loadTurnstile()
			.then((loaded) => {
				if (!active || !ref.current) return;
				api = loaded;
				widget = api.render(ref.current, {
					sitekey: siteKey,
					action,
					callback: (token: string) => {
						setFailed(false);
						onToken(token);
					},
					"expired-callback": () => onToken(""),
					"error-callback": () => {
						onToken("");
						setFailed(true);
					},
				});
			})
			.catch(() => {
				if (active) setFailed(true);
			});
		return () => {
			active = false;
			onToken("");
			if (widget !== undefined) api?.remove(widget);
		};
	}, [siteKey, action, onToken]);
	return (
		<div>
			<div ref={ref} />
			{failed ? <p role="alert">{m.auth_human_verification_failed()}</p> : null}
		</div>
	);
}

export function useTurnstile(action: "register" | "support" | "ipcheck") {
	const [token, setToken] = useState("");
	const [attempt, setAttempt] = useState(0);
	const config = useQuery({
		queryKey: ["public", "turnstile"],
		queryFn: async () => {
			const response = await fetch("/api/auth/turnstile-config");
			if (!response.ok) throw new Error("turnstile_unavailable");
			return response.json() as Promise<{ enabled: boolean; siteKey: string }>;
		},
		staleTime: 30_000,
	});
	return {
		ready: Boolean(config.data && (!config.data.enabled || token)),
		headers: { "cf-turnstile-response": token },
		reset: () => {
			setToken("");
			setAttempt((value) => value + 1);
		},
		widget:
			config.isError || (config.data?.enabled && !config.data.siteKey) ? (
				<p role="alert">{m.auth_human_verification_failed()}</p>
			) : config.data?.enabled ? (
				<Challenge
					key={attempt}
					siteKey={config.data.siteKey}
					action={action}
					onToken={setToken}
				/>
			) : null,
	};
}
