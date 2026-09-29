"use client";

import MonacoEditor, { type Monaco } from "@monaco-editor/react";
import { shikiToMonaco, textmateThemeToMonacoTheme } from "@shikijs/monaco";
import {
	Columns2,
	Copy,
	Eye,
	EyeOff,
	Maximize2,
	Minimize2,
	WandSparkles,
} from "lucide-react";
import type { editor } from "monaco-editor";
import {
	type ComponentProps,
	type ComponentType,
	type ReactNode,
	type Ref,
	Suspense,
	type UIEvent,
	type UIEventHandler,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import type { HighlighterCore } from "shiki/core";
import { cn } from "#/lib/utils";
import { m } from "#/paraglide/messages";
import { CopyButton, ProButton, type ProButtonSize } from "../base/button";
import { useFullscreen } from "../base/hooks/use-fullscreen";
import { getHighlighter, getHighlightThemeName } from "../highlighter";
import { HtmlViewer } from "../viewer/html";
import { MarkdownViewer } from "../viewer/markdown";

type EditorTheme = "light" | "dark";
type MonacoEditorInstance = editor.IStandaloneCodeEditor;
type EditorViewMode = "edit" | "preview" | "split";
type EditorFullscreenMode = "fixed" | "screen";

type EditorToolbarSlot =
	| ReactNode
	| ((context: EditorToolbarActionContext) => ReactNode);

interface EditorToolbarActionContext {
	value: string;
	disabled: boolean;
	language: string;
	theme: EditorTheme;
	size?: ProButtonSize;
	mode: EditorViewMode;
	hasPreview: boolean;
	isSplitView: boolean;
	fullscreen: boolean;
	fullscreenMode: EditorFullscreenMode;
	editor: MonacoEditorInstance | null;
	format: () => void;
	setMode: (mode: EditorViewMode) => void;
	setFullscreen: (fullscreen: boolean) => void;
}

interface EditorProps {
	value?: string;
	onChange?: (value: string) => void;
	disabled?: boolean;
	language?: string;
	theme?: EditorTheme;
	className?: string;
	height?: string | number;
	size?: ProButtonSize;
	toolbar?: false | EditorToolbarSlot;
	toolbarTitle?: EditorToolbarSlot;
	toolbarMode?: boolean;
	toolbarFormat?: boolean;
	toolbarCopy?: boolean;
	fullscreen?:
		| false
		| {
				value?: boolean;
				defaultValue?: boolean;
				onChange?: (fullscreen: boolean) => void;
				mode?: EditorFullscreenMode;
		  };
	preview?: {
		component: ComponentType<{
			content: string;
			language: string;
			scrollContainerRef?: Ref<HTMLElement>;
			onScroll?: UIEventHandler<HTMLElement>;
		}>;
		mode?: EditorViewMode;
		defaultMode?: EditorViewMode;
		onModeChange?: (mode: EditorViewMode) => void;
	};
}

export function ProEditorToolbarButton({
	size = "icon",
	variant = "ghost",
	...props
}: ComponentProps<typeof ProButton>) {
	return <ProButton size={size} variant={variant} {...props} />;
}

const TSX_REACT_TYPES = `
declare namespace JSX {
  interface IntrinsicElements {
    [elemName: string]: any
  }
}

declare module "react" {
  export type ReactNode = any
  export type ComponentType<P = any> = (props: P) => ReactNode
  export function useState<S>(initialState: S | (() => S)): [S, (value: S | ((prev: S) => S)) => void]
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
  export function useMemo<T>(factory: () => T, deps?: readonly unknown[]): T
  export function useCallback<T extends (...args: any[]) => any>(callback: T, deps?: readonly unknown[]): T
  const React: {
    createElement: (...args: any[]) => any
  }
  export default React
}

declare module "react/jsx-runtime" {
  export const jsx: (...args: any[]) => any
  export const jsxs: (...args: any[]) => any
  export const Fragment: any
}
`;

let wiredMonaco: Monaco | null = null;
let hasRegisteredTsxTypes = false;

async function applyShadcnTheme(monaco: Monaco, theme: EditorTheme) {
	const name = getHighlightThemeName(theme);
	const highlighter = await ensureShiki(monaco);
	const base = textmateThemeToMonacoTheme(
		highlighter.getTheme(name),
	) as editor.IStandaloneThemeData;
	const baseColors = base.colors;
	const bg =
		cssVar("--background") || baseColors?.["editor.background"] || "#ffffff";
	const fg =
		cssVar("--foreground") || baseColors?.["editor.foreground"] || "#000000";
	const muted = cssVar("--muted") || "#f4f4f5";
	const mutedFg = cssVar("--muted-foreground") || "#71717a";
	const border = cssVar("--border") || "#e4e4e7";
	const accent = cssVar("--accent") || "#f4f4f5";
	const primary = cssVar("--primary") || "#18181b";

	monaco.editor.defineTheme(name, {
		...base,
		colors: {
			...baseColors,
			"editor.background": bg,
			"editor.foreground": fg,
			"editorLineNumber.foreground": mutedFg,
			"editorLineNumber.activeForeground": fg,
			"editor.lineHighlightBackground": muted,
			"editor.selectionBackground": `${primary}33`,
			"editor.inactiveSelectionBackground": `${primary}1a`,
			"editorCursor.foreground": fg,
			"editorWhitespace.foreground": border,
			"editorIndentGuide.background1": border,
			"editorIndentGuide.activeBackground1": mutedFg,
			"editor.selectionHighlightBorder": border,
			"editorWidget.background": bg,
			"editorWidget.border": border,
			"editorSuggestWidget.background": bg,
			"editorSuggestWidget.border": border,
			"editorSuggestWidget.foreground": fg,
			"editorSuggestWidget.selectedBackground": accent,
			"editorSuggestWidget.selectedForeground": fg,
			"editorHoverWidget.background": bg,
			"editorHoverWidget.border": border,
			"editorGutter.background": bg,
			"scrollbar.shadow": "#00000000",
			"scrollbarSlider.background": `${mutedFg}40`,
			"scrollbarSlider.hoverBackground": `${mutedFg}66`,
			"scrollbarSlider.activeBackground": `${mutedFg}99`,
			"minimap.background": bg,
		},
	});
	monaco.editor.setTheme(name);
}

async function ensureShiki(monaco: Monaco): Promise<HighlighterCore> {
	const highlighter = await getHighlighter();
	if (wiredMonaco !== monaco) {
		shikiToMonaco(highlighter, monaco);
		wiredMonaco = monaco;
	}
	return highlighter;
}

function cssVar(name: string): string {
	if (typeof document === "undefined") return "";
	const raw = getComputedStyle(document.documentElement)
		.getPropertyValue(name)
		.trim();
	if (!raw) return "";
	try {
		const canvas = document.createElement("canvas");
		canvas.width = canvas.height = 1;
		const ctx = canvas.getContext("2d");
		if (!ctx) return "";
		ctx.fillStyle = raw;
		ctx.fillRect(0, 0, 1, 1);
		const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
		return `#${(r ?? 0).toString(16).padStart(2, "0")}${(g ?? 0).toString(16).padStart(2, "0")}${(
			b ?? 0
		)
			.toString(16)
			.padStart(2, "0")}`;
	} catch {
		return "";
	}
}

function useEditorState({
	value,
	onChange,
	disabled,
	language = "plaintext",
	theme,
	size,
	height,
	fullscreen,
	preview,
}: Pick<
	EditorProps,
	| "value"
	| "onChange"
	| "disabled"
	| "language"
	| "theme"
	| "size"
	| "height"
	| "fullscreen"
	| "preview"
>) {
	const [localValue, setLocalValue] = useState(value ?? "");
	const [uncontrolledMode, setUncontrolledMode] = useState<EditorViewMode>(
		preview?.defaultMode ?? "split",
	);
	const PreviewComponent = preview?.component;
	const hasPreview = !!PreviewComponent;
	const controlledMode = preview?.mode;
	const onPreviewModeChange = preview?.onModeChange;
	const effectiveMode: EditorViewMode = hasPreview
		? (controlledMode ?? uncontrolledMode)
		: "edit";
	const showEditorPane = effectiveMode !== "preview";
	const showPreviewPane = hasPreview && effectiveMode !== "edit";
	const isSplitView = showEditorPane && showPreviewPane;
	const fullscreenOption =
		typeof fullscreen === "object" ? fullscreen : undefined;
	const fullscreenMode = fullscreenOption?.mode ?? "fixed";
	const fullscreenState = useFullscreen({
		fullscreen: fullscreenOption?.value,
		defaultFullscreen: fullscreenOption?.defaultValue,
		onFullscreenChange: fullscreenOption?.onChange,
		mode: fullscreenMode,
	});
	const isFixedFullscreen =
		fullscreenState.fullscreen && fullscreenMode === "fixed";
	const isScreenFullscreen =
		fullscreenState.fullscreen && fullscreenMode === "screen";
	const previewScroll = useEditorPreviewScrollSync();
	const monacoEditor = useMonacoEditor({ disabled, theme, previewScroll });
	const hasExplicitHeight = height !== undefined;
	const contentHeight = typeof height === "number" ? `${height}px` : height;
	const contentStyle =
		hasExplicitHeight && !fullscreenState.fullscreen
			? { height: contentHeight }
			: undefined;
	const rootStyle =
		isFixedFullscreen && hasExplicitHeight
			? { height: contentHeight }
			: undefined;

	useEffect(() => {
		setLocalValue(value ?? "");
	}, [value]);

	const handleChange = useCallback(
		(nextValue: string) => {
			if (disabled) return;
			setLocalValue(nextValue);
			onChange?.(nextValue);
		},
		[disabled, onChange],
	);

	const setMode = useCallback(
		(nextMode: EditorViewMode) => {
			const next = hasPreview ? nextMode : "edit";
			if (controlledMode === undefined) setUncontrolledMode(next);
			onPreviewModeChange?.(next);
		},
		[controlledMode, hasPreview, onPreviewModeChange],
	);

	useEffect(() => {
		previewScroll.setSyncEnabled(isSplitView);
	}, [isSplitView, previewScroll.setSyncEnabled]);

	const toolbarContext: EditorToolbarActionContext = {
		value: localValue,
		disabled: disabled ?? false,
		language,
		theme: theme ?? "dark",
		size,
		mode: effectiveMode,
		hasPreview,
		isSplitView,
		fullscreen: fullscreenState.fullscreen,
		fullscreenMode,
		editor: monacoEditor.editorRef.current,
		format: monacoEditor.handleFormat,
		setMode,
		setFullscreen: fullscreenState.setFullscreen,
	};

	return {
		localValue,
		rootRef: fullscreenState.ref,
		fullscreen: fullscreenState.fullscreen,
		isFixedFullscreen,
		isScreenFullscreen,
		setFullscreen: fullscreenState.setFullscreen,
		contentStyle,
		contentFillsParent: fullscreenState.fullscreen || !hasExplicitHeight,
		rootStyle,
		PreviewComponent,
		hasPreview,
		effectiveMode,
		showEditorPane,
		showPreviewPane,
		isSplitView,
		toolbarContext,
		editorRef: monacoEditor.editorRef,
		previewScroll,
		handleChange,
		handleMount: monacoEditor.handleMount,
		handleFormat: monacoEditor.handleFormat,
		setMode,
	};
}

function useMonacoEditor({
	disabled,
	theme,
	previewScroll,
}: {
	disabled?: boolean;
	theme?: EditorTheme;
	previewScroll: ReturnType<typeof useEditorPreviewScrollSync>;
}) {
	const themeRef = useRef(theme ?? "dark");
	const editorRef = useRef<MonacoEditorInstance | null>(null);
	const monacoRef = useRef<Monaco | null>(null);
	const { scrollDisposableRef, syncPreviewFromEditor } = previewScroll;

	useEffect(() => {
		themeRef.current = theme ?? "dark";
	}, [theme]);

	const handleMount = useCallback(
		(editor: MonacoEditorInstance, monaco: Monaco) => {
			editorRef.current = editor;
			monacoRef.current = monaco;
			scrollDisposableRef.current?.dispose();
			scrollDisposableRef.current = editor.onDidScrollChange(() =>
				syncPreviewFromEditor(editor),
			);
			monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
				jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
				allowNonTsExtensions: true,
				target: monaco.languages.typescript.ScriptTarget.Latest,
				moduleResolution:
					monaco.languages.typescript.ModuleResolutionKind.NodeJs,
			});
			if (!hasRegisteredTsxTypes) {
				monaco.languages.typescript.typescriptDefaults.addExtraLib(
					TSX_REACT_TYPES,
					"file:///node_modules/@types/react/index.d.ts",
				);
				hasRegisteredTsxTypes = true;
			}
			applyShadcnTheme(monaco, themeRef.current).catch(() => {});
		},
		[scrollDisposableRef, syncPreviewFromEditor],
	);

	useEffect(() => {
		const monaco = monacoRef.current;
		if (monaco) applyShadcnTheme(monaco, theme ?? "dark").catch(() => {});
	}, [theme]);

	const handleFormat = useCallback(() => {
		if (disabled) return;
		editorRef.current?.getAction("editor.action.formatDocument")?.run();
	}, [disabled]);

	return {
		editorRef,
		handleMount,
		handleFormat,
	};
}

function useEditorPreviewScrollSync() {
	const previewPaneRef = useRef<HTMLElement | null>(null);
	const previewScrollElementRef = useRef<HTMLElement | null>(null);
	const scrollDisposableRef = useRef<{ dispose: () => void } | null>(null);
	const syncSourceRef = useRef<"editor" | "preview" | null>(null);
	const syncEnabledRef = useRef(false);

	const setPreviewScrollElement = useCallback((node: HTMLElement | null) => {
		previewScrollElementRef.current = node;
	}, []);

	const releaseSyncLock = useCallback(() => {
		window.requestAnimationFrame(() => {
			syncSourceRef.current = null;
		});
	}, []);

	const syncPreviewFromEditor = useCallback(
		(editor: MonacoEditorInstance) => {
			if (!syncEnabledRef.current || syncSourceRef.current === "preview")
				return;
			const previewElement =
				previewScrollElementRef.current ?? previewPaneRef.current;
			if (!previewElement) return;

			const editorMaxScrollTop = Math.max(
				editor.getScrollHeight() - editor.getLayoutInfo().height,
				0,
			);
			const previewMaxScrollTop = Math.max(
				previewElement.scrollHeight - previewElement.clientHeight,
				0,
			);
			if (editorMaxScrollTop <= 0 || previewMaxScrollTop <= 0) return;

			syncSourceRef.current = "editor";
			previewElement.scrollTop =
				(editor.getScrollTop() / editorMaxScrollTop) * previewMaxScrollTop;
			releaseSyncLock();
		},
		[releaseSyncLock],
	);

	const handlePreviewScroll = useCallback(
		(event: UIEvent<HTMLElement>, editor: MonacoEditorInstance | null) => {
			if (
				!syncEnabledRef.current ||
				syncSourceRef.current === "editor" ||
				!editor
			)
				return;

			const previewElement = event.currentTarget;
			const previewMaxScrollTop = Math.max(
				previewElement.scrollHeight - previewElement.clientHeight,
				0,
			);
			const editorMaxScrollTop = Math.max(
				editor.getScrollHeight() - editor.getLayoutInfo().height,
				0,
			);
			if (previewMaxScrollTop <= 0 || editorMaxScrollTop <= 0) return;

			syncSourceRef.current = "preview";
			editor.setScrollTop(
				(previewElement.scrollTop / previewMaxScrollTop) * editorMaxScrollTop,
			);
			releaseSyncLock();
		},
		[releaseSyncLock],
	);

	const setSyncEnabled = useCallback((enabled: boolean) => {
		syncEnabledRef.current = enabled;
	}, []);

	useEffect(() => () => scrollDisposableRef.current?.dispose(), []);

	return {
		previewPaneRef,
		scrollDisposableRef,
		setPreviewScrollElement,
		syncPreviewFromEditor,
		handlePreviewScroll,
		setSyncEnabled,
	};
}

export function ProEditor({
	value,
	onChange,
	disabled = false,
	language = "plaintext",
	theme = "dark",
	className,
	height,
	size = "icon",
	toolbar,
	toolbarTitle,
	toolbarMode = true,
	toolbarFormat = true,
	toolbarCopy = true,
	fullscreen,
	preview,
}: EditorProps) {
	const resolvedPreview =
		preview ??
		{
			html: { component: HtmlEditorPreview, defaultMode: "edit" as const },
			markdown: {
				component: MarkdownEditorPreview,
				defaultMode: "edit" as const,
			},
		}[language] ??
		undefined;
	const editor = useEditorState({
		value,
		onChange,
		disabled,
		language,
		theme,
		size,
		height,
		fullscreen,
		preview: resolvedPreview,
	});
	const PreviewComponent = editor.PreviewComponent;
	const defaultToolbarTitle =
		{
			css: "CSS",
			go: "Go",
			html: "HTML",
			java: "Java",
			javascript: "JavaScript",
			json: "JSON",
			markdown: "Markdown",
			python: "Python",
			rust: "Rust",
			shell: "Shell",
			sql: "SQL",
			tsx: "TSX",
			typescript: "TypeScript",
			yaml: "YAML",
		}[language] || language;
	const editorAriaLabel =
		typeof toolbarTitle === "string" ? toolbarTitle : defaultToolbarTitle;
	const previewModeActive = editor.effectiveMode === "preview";

	return (
		<div
			ref={editor.rootRef}
			className={cn(
				"min-h-0",
				editor.contentFillsParent && "h-full",
				editor.isScreenFullscreen && "bg-background",
				className,
			)}
			style={editor.rootStyle}
		>
			<div
				className={cn(
					"rounded-md border border-input overflow-hidden flex flex-col",
					editor.contentFillsParent && "h-full min-h-0",
					editor.isFixedFullscreen &&
						"fixed inset-0 z-50 h-full rounded-none border-0",
					editor.isScreenFullscreen && "h-screen rounded-none border-0",
				)}
			>
				{toolbar !== false && (
					<div
						className={
							"flex min-h-9 w-full flex-col gap-1 border-b border-input bg-background px-2 py-1 md:flex-row md:items-center md:justify-between"
						}
					>
						<span className="px-3 text-sm font-medium text-foreground capitalize">
							{typeof toolbarTitle === "function"
								? (toolbarTitle(editor.toolbarContext) ?? defaultToolbarTitle)
								: (toolbarTitle ?? defaultToolbarTitle)}
						</span>
						<div className="flex flex-wrap items-center justify-end gap-1 md:ml-auto md:shrink-0">
							{typeof toolbar === "function"
								? toolbar(editor.toolbarContext)
								: toolbar}
							{editor.hasPreview && toolbarMode && (
								<>
									<ProEditorToolbarButton
										size={size}
										variant={previewModeActive ? "secondary" : "ghost"}
										tooltip={
											previewModeActive
												? m.pro_action_hidePreview()
												: m.pro_action_preview()
										}
										onClick={() =>
											editor.setMode(previewModeActive ? "edit" : "preview")
										}
									>
										{previewModeActive ? <EyeOff /> : <Eye />}
									</ProEditorToolbarButton>
									<ProEditorToolbarButton
										size={size}
										variant={editor.isSplitView ? "secondary" : "ghost"}
										tooltip={m.pro_editor_split()}
										onClick={() =>
											editor.setMode(
												editor.effectiveMode === "split" ? "edit" : "split",
											)
										}
									>
										<Columns2 />
									</ProEditorToolbarButton>
								</>
							)}
							{toolbarFormat && (
								<ProEditorToolbarButton
									size={size}
									variant="ghost"
									tooltip={m.pro_action_format()}
									disabled={disabled}
									onClick={editor.handleFormat}
								>
									<WandSparkles />
								</ProEditorToolbarButton>
							)}
							{toolbarCopy && (
								<CopyButton
									size={size}
									variant="ghost"
									icon={<Copy />}
									tooltip={m.common_copy()}
									disabled={disabled}
									copy={editor.toolbarContext.value}
								/>
							)}
							{fullscreen !== false && (
								<ProEditorToolbarButton
									size={size}
									variant="ghost"
									tooltip={
										editor.fullscreen
											? m.pro_action_exitFullscreen()
											: m.pro_action_fullscreen()
									}
									onClick={() => editor.setFullscreen(!editor.fullscreen)}
								>
									{editor.fullscreen ? <Minimize2 /> : <Maximize2 />}
								</ProEditorToolbarButton>
							)}
						</div>
					</div>
				)}
				<div
					className={cn(
						"flex min-h-0",
						editor.contentFillsParent && "flex-1",
						editor.isSplitView && "divide-x divide-input",
					)}
					style={editor.contentStyle}
				>
					{editor.showEditorPane && (
						<section
							aria-label={editorAriaLabel}
							className={cn(
								"flex-1 min-w-0",
								editor.isSplitView ? "w-1/2" : "w-full",
							)}
						>
							<Suspense
								fallback={<div className="size-full bg-muted animate-pulse" />}
							>
								<MonacoEditor
									height="100%"
									language={language === "tsx" ? "typescript" : language}
									path={getEditorPath(language)}
									value={editor.localValue}
									theme={theme === "dark" ? "vs-dark" : "vs"}
									onMount={editor.handleMount}
									onChange={(nextValue) => editor.handleChange(nextValue ?? "")}
									options={{
										ariaLabel: editorAriaLabel,
										minimap: { enabled: false },
										fontSize: 14,
										lineNumbers: "on",
										roundedSelection: false,
										scrollBeyondLastLine: false,
										scrollbar: {
											vertical: "auto",
											horizontal: "auto",
											useShadows: false,
											verticalScrollbarSize: 10,
											horizontalScrollbarSize: 10,
										},
										automaticLayout: true,
										readOnly: disabled,
										domReadOnly: disabled,
										padding: { top: 8, bottom: 8 },
									}}
								/>
							</Suspense>
						</section>
					)}

					{editor.showPreviewPane && PreviewComponent && (
						<section
							aria-label={m.common_preview()}
							ref={editor.previewScroll.previewPaneRef}
							onScroll={(event) =>
								editor.previewScroll.handlePreviewScroll(
									event,
									editor.editorRef.current,
								)
							}
							className={cn(
								"h-full overflow-auto bg-background [scrollbar-width:thin] [scrollbar-color:transparent_transparent] hover:[scrollbar-color:rgba(148,163,184,0.45)_transparent] [&::-webkit-scrollbar]:size-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-transparent hover:[&::-webkit-scrollbar-thumb]:bg-muted-foreground/35",
								editor.isSplitView ? "w-1/2" : "w-full",
							)}
						>
							<Suspense
								fallback={
									<div className="p-4 text-sm text-muted-foreground animate-pulse">
										Loading preview...
									</div>
								}
							>
								<PreviewComponent
									content={editor.localValue}
									language={language}
									scrollContainerRef={
										editor.previewScroll.setPreviewScrollElement
									}
									onScroll={(event) =>
										editor.previewScroll.handlePreviewScroll(
											event,
											editor.editorRef.current,
										)
									}
								/>
							</Suspense>
						</section>
					)}
				</div>
			</div>
		</div>
	);
}

function HtmlEditorPreview({ content }: { content: string }) {
	return <HtmlViewer content={content} sandbox="" />;
}

function MarkdownEditorPreview({ content }: { content: string }) {
	return <MarkdownViewer className="p-4" content={content} />;
}

function getEditorPath(language: string) {
	if (language === "tsx") return "file:///index.tsx";
	if (language === "typescript") return "file:///index.ts";
	if (language === "javascript") return "file:///index.jsx";
	return `file:///index.${language}`;
}
