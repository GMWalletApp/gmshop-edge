import {
	CircleCheck,
	Laptop,
	Moon,
	RotateCcw,
	Settings,
	Sun,
} from "lucide-react";
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";
import type { ComponentProps, ReactNode, SVGProps } from "react";
import { IconDir } from "#/assets/custom/icon-dir";
import { IconLayoutCompact } from "#/assets/custom/icon-layout-compact";
import { IconLayoutDefault } from "#/assets/custom/icon-layout-default";
import { IconLayoutFull } from "#/assets/custom/icon-layout-full";
import { IconSidebarFloating } from "#/assets/custom/icon-sidebar-floating";
import { IconSidebarInset } from "#/assets/custom/icon-sidebar-inset";
import { IconSidebarSidebar } from "#/assets/custom/icon-sidebar-sidebar";
import { IconThemeDark } from "#/assets/custom/icon-theme-dark";
import { IconThemeLight } from "#/assets/custom/icon-theme-light";
import { IconThemeSystem } from "#/assets/custom/icon-theme-system";
import { Button } from "#/components/ui/button";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from "#/components/ui/sheet";
import { useSidebar } from "#/components/ui/sidebar";
import { type Direction, useDirection } from "#/context/direction-provider";
import { type Collapsible, useLayout } from "#/context/layout-provider";
import { useTheme } from "#/context/theme-provider";
import { cn } from "#/lib/utils";
import { m } from "#/paraglide/messages";

type ConfigDrawerProps = ComponentProps<typeof Sheet> & {
	trigger?: ReactNode;
};

export function ConfigDrawer({ trigger, ...props }: ConfigDrawerProps) {
	const { setOpen } = useSidebar();
	const { resetDir } = useDirection();
	const { resetTheme, resetFont } = useTheme();
	const { resetLayout } = useLayout();

	const handleReset = () => {
		setOpen(true);
		resetDir();
		resetTheme();
		resetFont();
		resetLayout();
	};

	return (
		<Sheet {...props}>
			{trigger ? (
				<SheetTrigger asChild>{trigger}</SheetTrigger>
			) : props.open === undefined ? (
				<SheetTrigger asChild>
					<Button
						size="icon"
						variant="ghost"
						aria-label={m.layout_config_open()}
						className="rounded-full"
					>
						<Settings aria-hidden="true" />
					</Button>
				</SheetTrigger>
			) : null}
			<SheetContent className="flex flex-col sm:max-w-md">
				<SheetHeader className="pb-0 text-start">
					<SheetTitle>{m.layout_config_title()}</SheetTitle>
					<SheetDescription>{m.layout_config_description()}</SheetDescription>
				</SheetHeader>
				<div className="space-y-6 overflow-y-auto px-4">
					<ThemeConfig />
					<FontConfig />
					<SidebarConfig />
					<LayoutConfig />
					<DirConfig />
				</div>
				<SheetFooter className="gap-2">
					<Button
						variant="destructive"
						onClick={handleReset}
						aria-label={m.layout_config_resetAll()}
					>
						{m.common_reset()}
					</Button>
				</SheetFooter>
			</SheetContent>
		</Sheet>
	);
}

function SectionTitle({
	title,
	showReset = false,
	onReset,
	resetAriaLabel,
	className,
}: {
	title: string;
	showReset?: boolean;
	onReset?: () => void;
	resetAriaLabel?: string;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"mb-2 flex items-center gap-2 text-sm font-semibold text-muted-foreground",
				className,
			)}
		>
			{title}
			{showReset && onReset && (
				<Button
					type="button"
					size="icon"
					variant="secondary"
					className="size-4 rounded-full"
					onClick={onReset}
					aria-label={resetAriaLabel}
				>
					<RotateCcw className="size-3" />
				</Button>
			)}
		</div>
	);
}

function RadioGroupItem({
	item,
	isTheme = false,
}: {
	item: {
		value: string;
		label: string;
		icon: (props: SVGProps<SVGSVGElement>) => React.ReactElement;
	};
	isTheme?: boolean;
}) {
	return (
		<RadioGroupPrimitive.Item
			value={item.value}
			className={cn("group outline-none", "transition duration-200 ease-in")}
			aria-label={m.layout_config_selectOption({ label: item.label })}
			aria-describedby={`${item.value}-description`}
		>
			<div
				className={cn(
					"relative rounded-[6px] ring-[1px] ring-border",
					"group-data-[state=checked]:shadow-2xl group-data-[state=checked]:ring-primary",
					"group-focus-visible:ring-2",
				)}
				role="img"
				aria-hidden="false"
				aria-label={m.layout_config_optionPreview({ label: item.label })}
			>
				<CircleCheck
					className={cn(
						"size-6 fill-primary stroke-white",
						"group-data-[state=unchecked]:hidden",
						"absolute top-0 right-0 translate-x-1/2 -translate-y-1/2",
					)}
					aria-hidden="true"
				/>
				<item.icon
					className={cn(
						!isTheme &&
							"fill-primary stroke-primary group-data-[state=unchecked]:fill-muted-foreground group-data-[state=unchecked]:stroke-muted-foreground",
					)}
					aria-hidden="true"
				/>
			</div>
			<div
				className="mt-1 flex items-center justify-center gap-1 text-xs"
				id={`${item.value}-description`}
				aria-live="polite"
			>
				{isTheme ? <ThemeOptionIcon value={item.value} /> : null}
				{item.label}
			</div>
		</RadioGroupPrimitive.Item>
	);
}

function ThemeOptionIcon({ value }: { value: string }) {
	const className = "size-3.5 text-muted-foreground";

	if (value === "light")
		return <Sun className={className} aria-hidden="true" />;
	if (value === "dark")
		return <Moon className={className} aria-hidden="true" />;

	return <Laptop className={className} aria-hidden="true" />;
}

export function ThemeConfig() {
	const { defaultTheme, theme, setTheme } = useTheme();

	return (
		<div>
			<SectionTitle
				title={m.layout_config_theme()}
				showReset={theme !== defaultTheme}
				onReset={() => setTheme(defaultTheme)}
				resetAriaLabel={m.layout_config_themeReset()}
			/>
			<RadioGroupPrimitive.Root
				value={theme}
				onValueChange={(value) => setTheme(value as "auto" | "light" | "dark")}
				className="grid w-full max-w-md grid-cols-3 gap-4"
				aria-label={m.layout_config_themeSelect()}
				aria-describedby="theme-description"
			>
				{[
					{
						value: "auto",
						label: m.layout_config_themeAuto(),
						icon: IconThemeSystem,
					},
					{
						value: "light",
						label: m.layout_config_themeLight(),
						icon: IconThemeLight,
					},
					{
						value: "dark",
						label: m.layout_config_themeDark(),
						icon: IconThemeDark,
					},
				].map((item) => (
					<RadioGroupItem key={item.value} item={item} isTheme />
				))}
			</RadioGroupPrimitive.Root>
			<div id="theme-description" className="sr-only">
				{m.layout_config_themeDescription()}
			</div>
		</div>
	);
}

function FontConfig() {
	const { defaultFont, font, setFont } = useTheme();

	return (
		<div>
			<SectionTitle
				title={m.layout_config_font()}
				showReset={font !== defaultFont}
				onReset={() => setFont(defaultFont)}
				resetAriaLabel={m.layout_config_fontReset()}
			/>
			<RadioGroupPrimitive.Root
				value={font}
				onValueChange={(value) =>
					setFont(value as "inter" | "manrope" | "noto")
				}
				className="grid w-full max-w-md grid-cols-3 gap-3"
				aria-label={m.layout_config_fontSelect()}
				aria-describedby="font-description"
			>
				{[
					{
						value: "inter",
						label: "Inter",
						className: "font-[var(--font-inter)]",
					},
					{
						value: "manrope",
						label: "Manrope",
						className: "font-[var(--font-manrope)]",
					},
					{
						value: "noto",
						label: "Noto Sans",
						className: "font-[var(--font-noto)]",
					},
				].map((item) => (
					<RadioGroupPrimitive.Item
						key={item.value}
						value={item.value}
						className="group outline-none"
						aria-label={m.layout_config_selectOption({ label: item.label })}
					>
						<div
							className={cn(
								"relative flex h-20 flex-col justify-between rounded-[6px] border bg-card p-3 text-start transition",
								"group-data-[state=checked]:border-primary group-data-[state=checked]:shadow-sm",
								"group-focus-visible:ring-2 group-focus-visible:ring-ring",
								item.className,
							)}
						>
							<CircleCheck
								className={cn(
									"absolute top-2 right-2 size-5 fill-primary stroke-white",
									"group-data-[state=unchecked]:hidden",
								)}
								aria-hidden="true"
							/>
							<span className="text-2xl leading-none">Aa</span>
							<span className="text-xs text-muted-foreground">
								{item.label}
							</span>
						</div>
					</RadioGroupPrimitive.Item>
				))}
			</RadioGroupPrimitive.Root>
			<div id="font-description" className="sr-only">
				{m.layout_config_fontDescription()}
			</div>
		</div>
	);
}

function SidebarConfig() {
	const { defaultVariant, variant, setVariant } = useLayout();

	return (
		<div className="max-md:hidden">
			<SectionTitle
				title={m.layout_config_sidebar()}
				showReset={defaultVariant !== variant}
				onReset={() => setVariant(defaultVariant)}
				resetAriaLabel={m.layout_config_sidebarReset()}
			/>
			<RadioGroupPrimitive.Root
				value={variant}
				onValueChange={(value) =>
					setVariant(value as "inset" | "floating" | "sidebar")
				}
				className="grid w-full max-w-md grid-cols-3 gap-4"
				aria-label={m.layout_config_sidebarSelect()}
				aria-describedby="sidebar-description"
			>
				{[
					{
						value: "inset",
						label: m.layout_config_sidebarInset(),
						icon: IconSidebarInset,
					},
					{
						value: "floating",
						label: m.layout_config_sidebarFloating(),
						icon: IconSidebarFloating,
					},
					{
						value: "sidebar",
						label: m.layout_config_sidebarStandard(),
						icon: IconSidebarSidebar,
					},
				].map((item) => (
					<RadioGroupItem key={item.value} item={item} />
				))}
			</RadioGroupPrimitive.Root>
			<div id="sidebar-description" className="sr-only">
				{m.layout_config_sidebarDescription()}
			</div>
		</div>
	);
}

function LayoutConfig() {
	const { open, setOpen } = useSidebar();
	const { defaultCollapsible, collapsible, setCollapsible } = useLayout();
	const radioState = open ? "default" : collapsible;

	return (
		<div className="max-md:hidden">
			<SectionTitle
				title={m.layout_config_layout()}
				showReset={radioState !== "default"}
				onReset={() => {
					setOpen(true);
					setCollapsible(defaultCollapsible);
				}}
				resetAriaLabel={m.layout_config_layoutReset()}
			/>
			<RadioGroupPrimitive.Root
				value={radioState}
				onValueChange={(value) => {
					if (value === "default") {
						setOpen(true);
						return;
					}
					setOpen(false);
					setCollapsible(value as Collapsible);
				}}
				className="grid w-full max-w-md grid-cols-3 gap-4"
				aria-label={m.layout_config_layoutSelect()}
				aria-describedby="layout-description"
			>
				{[
					{
						value: "default",
						label: m.layout_config_layoutDefault(),
						icon: IconLayoutDefault,
					},
					{
						value: "icon",
						label: m.layout_config_layoutCompact(),
						icon: IconLayoutCompact,
					},
					{
						value: "offcanvas",
						label: m.layout_config_layoutFull(),
						icon: IconLayoutFull,
					},
				].map((item) => (
					<RadioGroupItem key={item.value} item={item} />
				))}
			</RadioGroupPrimitive.Root>
			<div id="layout-description" className="sr-only">
				{m.layout_config_layoutDescription()}
			</div>
		</div>
	);
}

function DirConfig() {
	const { defaultDir, dir, setDir } = useDirection();

	return (
		<div>
			<SectionTitle
				title={m.layout_config_direction()}
				showReset={defaultDir !== dir}
				onReset={() => setDir(defaultDir)}
				resetAriaLabel={m.layout_config_directionReset()}
			/>
			<RadioGroupPrimitive.Root
				value={dir}
				onValueChange={(value) => setDir(value as Direction)}
				className="grid w-full max-w-md grid-cols-2 gap-4"
				aria-label={m.layout_config_directionSelect()}
				aria-describedby="direction-description"
			>
				{[
					{
						value: "ltr",
						label: m.layout_config_directionLtr(),
						icon: (props: SVGProps<SVGSVGElement>) => (
							<IconDir dir="ltr" {...props} />
						),
					},
					{
						value: "rtl",
						label: m.layout_config_directionRtl(),
						icon: (props: SVGProps<SVGSVGElement>) => (
							<IconDir dir="rtl" {...props} />
						),
					},
				].map((item) => (
					<RadioGroupItem key={item.value} item={item} />
				))}
			</RadioGroupPrimitive.Root>
			<div id="direction-description" className="sr-only">
				{m.layout_config_directionDescription()}
			</div>
		</div>
	);
}
