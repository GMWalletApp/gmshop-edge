"use client";

import { diffLines } from "diff";
import { useEffect, useMemo, useState } from "react";
import type { ThemedToken } from "shiki/core";
import { cn } from "#/lib/utils";
import { m } from "#/paraglide/messages";
import { ProButton } from "../../base/button";
import {
	ensureHighlightLanguage,
	getHighlighter,
	getHighlightThemeName,
} from "../../highlighter";

interface DiffLine {
	type: "added" | "removed" | "unchanged";
	content: string;
	oldLineNo?: number;
	newLineNo?: number;
}

export function DiffViewer({
	oldCode,
	newCode,
	oldTitle = m.pro_viewer_diffBefore(),
	newTitle = m.pro_viewer_diffAfter(),
	lang = "typescript",
	theme = "dark",
	className,
}: {
	oldCode: string;
	newCode: string;
	oldTitle?: string;
	newTitle?: string;
	lang?: string;
	theme?: "light" | "dark";
	className?: string;
}) {
	const [view, setView] = useState<"split" | "unified">("split");
	const { unified, left, right, added, removed } = useMemo(() => {
		let oldLineNo = 1;
		let newLineNo = 1;
		let added = 0;
		let removed = 0;
		const unified: DiffLine[] = [];
		const left: (DiffLine | null)[] = [];
		const right: (DiffLine | null)[] = [];
		for (const change of diffLines(oldCode, newCode)) {
			const value = change.value.replace(/\n$/, "");
			for (const content of value.split("\n")) {
				let line: DiffLine;
				if (change.added) {
					added++;
					line = { type: "added", content, newLineNo: newLineNo++ };
				} else if (change.removed) {
					removed++;
					line = { type: "removed", content, oldLineNo: oldLineNo++ };
				} else {
					line = {
						type: "unchanged",
						content,
						oldLineNo: oldLineNo++,
						newLineNo: newLineNo++,
					};
				}
				unified.push(line);
				left.push(line.type === "added" ? null : line);
				right.push(line.type === "removed" ? null : line);
			}
		}
		return {
			unified,
			left,
			right,
			added,
			removed,
		};
	}, [oldCode, newCode]);
	const [htmlMap, setHtmlMap] = useState<Map<string, string>>(new Map());

	useEffect(() => {
		let cancelled = false;
		getHighlighter()
			.then(async (highlighter) => {
				const highlightLang = await ensureHighlightLanguage(highlighter, lang);
				const themeName = getHighlightThemeName(theme);
				return Array.from(
					new Set(unified.map((line) => line.content)),
					(line) => {
						const tokenLines = highlighter.codeToTokensBase(line || " ", {
							lang: highlightLang,
							theme: themeName,
						});
						return [line, renderTokenLinesHtml(tokenLines)] as const;
					},
				);
			})
			.then((entries) => {
				if (!cancelled) setHtmlMap(new Map(entries));
			})
			.catch(() => {
				if (!cancelled) setHtmlMap(new Map());
			});

		return () => {
			cancelled = true;
		};
	}, [unified, lang, theme]);
	return (
		<div
			className={cn(
				"overflow-hidden rounded-lg border bg-muted text-foreground",
				className,
			)}
		>
			<div className="flex items-center justify-between border-b border-border px-4 py-2">
				<div className="flex items-center gap-3">
					<span className="font-mono text-xs text-primary">+{added}</span>
					<span className="font-mono text-xs text-destructive">-{removed}</span>
				</div>
				<div className="flex gap-1 rounded-md border border-border p-0.5">
					<ProButton
						variant={view === "split" ? "secondary" : "ghost"}
						size="xs"
						onClick={() => setView("split")}
					>
						Split
					</ProButton>
					<ProButton
						variant={view === "unified" ? "secondary" : "ghost"}
						size="xs"
						onClick={() => setView("unified")}
					>
						Unified
					</ProButton>
				</div>
			</div>
			{view === "unified" ? (
				<div className="overflow-auto">
					<table className="w-full border-collapse">
						<tbody>
							{unified.map((line, index) => (
								<tr
									// biome-ignore lint/suspicious/noArrayIndexKey: duplicate diff lines require their sequence position for identity.
									key={`${line.type}:${line.oldLineNo ?? ""}:${line.newLineNo ?? ""}:${line.content}:${index}`}
									className={cn(
										"leading-6",
										line.type === "added" && "bg-primary/10",
										line.type === "removed" && "bg-destructive/10",
									)}
								>
									<td
										className={
											"w-10 select-none border-r border-border py-0 pl-2 pr-2 text-right font-mono text-xs text-muted-foreground"
										}
									>
										{line.oldLineNo ?? ""}
									</td>
									<td
										className={
											"w-10 select-none border-r border-border py-0 pl-2 pr-2 text-right font-mono text-xs text-muted-foreground"
										}
									>
										{line.newLineNo ?? ""}
									</td>
									<td
										className={
											"w-4 select-none py-0 pl-2 pr-1 font-mono text-xs text-muted-foreground"
										}
									>
										{getDiffSign(line.type)}
									</td>
									{renderHighlightedLine(line.content, htmlMap)}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : (
				<div className="grid grid-cols-2 divide-x divide-border overflow-auto">
					<SplitDiffPane
						title={oldTitle}
						lines={left}
						side="old"
						htmlMap={htmlMap}
					/>
					<SplitDiffPane
						title={newTitle}
						lines={right}
						side="new"
						htmlMap={htmlMap}
					/>
				</div>
			)}
		</div>
	);
}

function getDiffSign(type: DiffLine["type"]) {
	if (type === "added") return "+";
	if (type === "removed") return "-";
	return " ";
}

function SplitDiffPane({
	title,
	lines,
	side,
	htmlMap,
}: {
	title: string;
	lines: (DiffLine | null)[];
	side: "old" | "new";
	htmlMap: Map<string, string>;
}) {
	return (
		<div>
			<div className="border-b border-border px-4 py-1.5 text-xs text-muted-foreground">
				{title}
			</div>
			<table className="w-full border-collapse">
				<tbody>
					{lines.map((line, index) => {
						if (!line) {
							return (
								<tr
									// biome-ignore lint/suspicious/noArrayIndexKey: empty alignment rows only have a positional identity.
									key={`${side}:empty:${index}`}
									className="bg-muted/60 leading-6"
								>
									<td className="w-10" />
									<td className="py-0 pr-4 font-mono text-xs text-muted-foreground/30">
										.
									</td>
								</tr>
							);
						}

						return (
							<tr
								// biome-ignore lint/suspicious/noArrayIndexKey: duplicate diff lines require their sequence position for identity.
								key={`${side}:${line.type}:${line.oldLineNo ?? ""}:${line.newLineNo ?? ""}:${line.content}:${index}`}
								className={cn(
									"leading-6",
									line.type === "added" && "bg-primary/10",
									line.type === "removed" && "bg-destructive/10",
								)}
							>
								<td
									className={
										"w-10 select-none border-r border-border py-0 pl-2 pr-2 text-right font-mono text-xs text-muted-foreground"
									}
								>
									{(side === "old" ? line.oldLineNo : line.newLineNo) ?? ""}
								</td>
								{renderHighlightedLine(line.content, htmlMap)}
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

function renderHighlightedLine(content: string, htmlMap: Map<string, string>) {
	const html = htmlMap.get(content);
	if (!html) {
		return (
			<td className="py-0 pl-2 pr-4 whitespace-pre font-mono text-xs text-foreground">
				{content || " "}
			</td>
		);
	}

	return (
		<td
			className="py-0 pl-2 pr-4 whitespace-pre font-mono text-xs"
			// biome-ignore lint/security/noDangerouslySetInnerHtml: escaped token content from shiki
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
}

function renderTokenLinesHtml(tokenLines: ThemedToken[][]) {
	return (
		tokenLines
			.flatMap((line) =>
				line.map((token) => {
					const content = token.content
						.replace(/&/g, "&amp;")
						.replace(/</g, "&lt;")
						.replace(/>/g, "&gt;");
					return `<span${token.color ? ` style="color:${token.color}"` : ""}>${content}</span>`;
				}),
			)
			.join("") || "\u00a0"
	);
}
