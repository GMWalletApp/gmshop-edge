"use client";

import { ChevronRight, Copy } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ThemedToken } from "shiki/core";
import { cn } from "#/lib/utils";
import { m } from "#/paraglide/messages";
import { CopyButton, ProButton } from "../../base/button";
import {
	ensureHighlightLanguage,
	getHighlighter,
	getHighlightThemeName,
} from "../../highlighter";

interface CodeLine {
	index: number;
	tokens: ThemedToken[];
	content: string;
	indent: number;
	isFoldable: boolean;
	foldEnd: number;
}

export function CodeViewer({
	code,
	lang = "typescript",
	theme = "dark",
	className,
	title,
}: {
	code: string;
	lang?: string;
	theme?: "light" | "dark";
	className?: string;
	title?: string;
}) {
	const [tokenLines, setTokenLines] = useState<ThemedToken[][]>([]);
	const [status, setStatus] = useState<"loading" | "ready" | "error">(
		"loading",
	);
	const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
	const isLight = theme === "light";
	const lines = useMemo<CodeLine[]>(() => {
		const lines = (code ? code.split("\n") : []).map((content, index) => {
			const indent = content.search(/[^ \t]/);
			return {
				index,
				tokens: tokenLines[index] ?? [],
				content,
				indent: indent === -1 ? content.length : indent,
				isFoldable: false,
				foldEnd: index,
			};
		});

		for (let index = 0; index < lines.length - 1; index++) {
			const currentLine = lines[index] as CodeLine;
			const nextLine = lines[index + 1] as CodeLine;
			const lastChar = currentLine.content.trimEnd().at(-1);
			if (
				(lastChar === "{" || lastChar === "[" || lastChar === "(") &&
				nextLine.indent > currentLine.indent
			) {
				let nextOutdentIndex = -1;
				for (let lineIndex = index + 1; lineIndex < lines.length; lineIndex++) {
					if ((lines[lineIndex] as CodeLine).indent > currentLine.indent)
						continue;
					nextOutdentIndex = lineIndex;
					break;
				}
				currentLine.isFoldable = true;
				currentLine.foldEnd =
					nextOutdentIndex === -1 ? lines.length - 1 : nextOutdentIndex - 1;
			}
		}

		return lines;
	}, [code, tokenLines]);
	const hiddenLines = useMemo(
		() =>
			new Set(
				Array.from(collapsed).flatMap((foldLine) => {
					const line = lines[foldLine];
					if (!line) return [];
					return Array.from(
						{ length: line.foldEnd - foldLine },
						(_, index) => foldLine + index + 1,
					);
				}),
			),
		[collapsed, lines],
	);
	const codeContent =
		status !== "ready" || lines.length === 0 ? (
			<div className="px-4 py-6 font-mono text-sm opacity-60">
				{getCodeStatusText(status)}
			</div>
		) : (
			<CodeLinesTable
				lines={lines}
				hiddenLines={hiddenLines}
				collapsed={collapsed}
				isLight={isLight}
				toggleFold={toggleFold}
			/>
		);

	function toggleFold(lineIndex: number) {
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(lineIndex)) next.delete(lineIndex);
			else next.add(lineIndex);
			return next;
		});
	}

	useEffect(() => {
		let cancelled = false;

		setStatus("loading");
		setCollapsed(new Set());

		if (!code) {
			setTokenLines([]);
			setStatus("ready");
			return;
		}
		getHighlighter()
			.then(async (highlighter) =>
				highlighter.codeToTokensBase(code, {
					lang: await ensureHighlightLanguage(highlighter, lang),
					theme: getHighlightThemeName(theme),
				}),
			)
			.then((result) => {
				if (!cancelled) setTokenLines(result);
			})
			.catch(() => {
				if (!cancelled) {
					setTokenLines([]);
					setStatus("error");
				}
			})
			.finally(() => {
				if (!cancelled) {
					setStatus((current) => {
						if (current === "loading") return "ready";
						return current;
					});
				}
			});

		return () => {
			cancelled = true;
		};
	}, [code, lang, theme]);

	return (
		<div
			className={cn(
				"group/code-viewer flex min-h-0 flex-col overflow-hidden rounded-lg border",
				isLight ? "bg-muted/40 text-foreground" : "bg-muted text-foreground",
				className,
			)}
		>
			<div className="flex h-7 shrink-0 items-center justify-between px-3">
				<div className="flex items-center gap-2">
					<div
						className={
							"flex gap-1.5 opacity-0 transition-opacity group-hover/code-viewer:opacity-100 group-focus-within/code-viewer:opacity-100"
						}
					>
						<span className="size-2.5 rounded-full bg-muted-foreground/45" />
						<span className="size-2.5 rounded-full bg-muted-foreground/30" />
						<span className="size-2.5 rounded-full bg-muted-foreground/20" />
					</div>
					<span
						className={cn(
							"ml-1 text-[11px]",
							isLight ? "text-muted-foreground" : "text-muted-foreground/70",
						)}
					>
						{title ?? lang}
					</span>
				</div>
				<CopyButton
					variant="ghost"
					size="icon-xs"
					icon={<Copy />}
					tooltip={m.pro_viewer_codeCopy()}
					copy={code}
					className={
						"opacity-0 transition-opacity group-hover/code-viewer:opacity-100 group-focus-within/code-viewer:opacity-100"
					}
				/>
			</div>
			<div
				className={
					"min-h-0 flex-1 overflow-auto [scrollbar-width:thin] [scrollbar-color:transparent_transparent] hover:[scrollbar-color:var(--muted-foreground)_transparent] [&::-webkit-scrollbar]:size-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-transparent hover:[&::-webkit-scrollbar-thumb]:bg-muted-foreground/35"
				}
			>
				{codeContent}
			</div>
		</div>
	);
}

function CodeLinesTable({
	lines,
	hiddenLines,
	collapsed,
	isLight,
	toggleFold,
}: {
	lines: CodeLine[];
	hiddenLines: Set<number>;
	collapsed: Set<number>;
	isLight: boolean;
	toggleFold: (lineIndex: number) => void;
}) {
	return (
		<table className="w-full min-w-full border-collapse">
			<tbody>
				{lines.map((line) => {
					if (hiddenLines.has(line.index)) return null;
					const isFolded = collapsed.has(line.index);
					const foldLabel = isFolded
						? m.pro_action_expand()
						: m.pro_action_collapse();
					const foldControl = line.isFoldable ? (
						<ProButton
							variant="ghost"
							size="icon-xs"
							onClick={() => toggleFold(line.index)}
							className="flex h-full w-4 items-center justify-center"
							aria-label={foldLabel}
						>
							<ChevronRight
								className={cn("transition-transform", !isFolded && "rotate-90")}
							/>
						</ProButton>
					) : null;

					return (
						<tr
							key={line.index}
							className={cn(
								"group/line leading-6",
								isLight ? "hover:bg-accent/60" : "hover:bg-accent/40",
							)}
						>
							<td
								className={
									"w-10 select-none border-r border-border py-0 pl-2 pr-3 text-right font-mono text-xs text-muted-foreground"
								}
							>
								{line.index + 1}
							</td>
							<td className="w-4 select-none py-0">{foldControl}</td>
							<td className="py-0 pl-2 pr-6 font-mono text-sm whitespace-pre">
								<span
									// biome-ignore lint/security/noDangerouslySetInnerHtml: escaped token content from shiki
									dangerouslySetInnerHTML={{
										__html: renderTokenLineHtml(line.tokens),
									}}
								/>
								{isFolded && (
									<ProButton
										variant="outline"
										size="xs"
										onClick={() => toggleFold(line.index)}
										className={
											"ml-1 rounded border border-border px-1.5 py-0 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
										}
									>
										{line.foldEnd - line.index} lines
									</ProButton>
								)}
							</td>
						</tr>
					);
				})}
			</tbody>
		</table>
	);
}

function getCodeStatusText(status: "idle" | "loading" | "ready" | "error") {
	if (status === "loading") return m.pro_viewer_codeLoading();
	if (status === "error") return m.pro_viewer_codeHighlightFailed();
	return m.pro_viewer_codeNoContent();
}

function renderTokenLineHtml(tokens: ThemedToken[]) {
	if (!tokens.length) return "\u00a0";

	return tokens
		.map((token) => {
			const content = token.content
				.replace(/&/g, "&amp;")
				.replace(/</g, "&lt;")
				.replace(/>/g, "&gt;");
			return `<span${token.color ? ` style="color:${token.color}"` : ""}>${content}</span>`;
		})
		.join("");
}
