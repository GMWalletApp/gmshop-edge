import { CalendarIcon, Check, ChevronDown, ChevronUp } from "lucide-react";
import {
	Popover as PopoverPrimitive,
	Select as SelectPrimitive,
} from "radix-ui";
import { cn } from "#/lib/utils.ts";
import { m } from "#/paraglide/messages";
import { getLocale } from "#/paraglide/runtime";
import { FieldCalendar } from "../shared/calendar";
import {
	FieldClearAction,
	FieldPopoverContent,
	fieldShellClassName,
	fieldTriggerClassName,
} from "../shared/field";

export function DateTimePicker({
	value,
	onChange,
	disabled,
	placeholder = m.pro_field_pickDateTime(),
	className,
}: {
	value?: Date;
	onChange?: (date: Date | undefined) => void;
	disabled?: boolean;
	placeholder?: string;
	className?: string;
}) {
	const [hour, minute, second] = value
		? [value.getHours(), value.getMinutes(), value.getSeconds()]
		: [0, 0, 0];
	const timeDisabled = !value || disabled;

	function handleTimeChange(h: number, m: number, s: number) {
		if (!value) return;
		const d = new Date(value);
		d.setHours(h, m, s);
		onChange?.(d);
	}

	return (
		<PopoverPrimitive.Root data-slot="field-popover">
			<div className={cn("group/date-field relative w-full", className)}>
				<PopoverPrimitive.Trigger data-slot="field-popover-trigger" asChild>
					<button
						type="button"
						disabled={disabled}
						className={cn(
							fieldTriggerClassName,
							!value && "text-muted-foreground",
							value && !disabled && "pr-3",
						)}
					>
						<CalendarIcon className="mr-2 size-4" />
						<span className="min-w-0 flex-1 truncate text-left">
							{value ? formatPickedDateTime(value) : placeholder}
						</span>
						<span className="relative flex size-4 shrink-0 items-center justify-center">
							{value && !disabled && (
								<FieldClearAction
									label={m.pro_field_clearDateTime()}
									onClear={() => onChange?.(undefined)}
									className="pointer-events-none absolute inset-0 z-10 opacity-0 group-hover/date-field:pointer-events-auto group-hover/date-field:opacity-100 group-focus-within/date-field:pointer-events-auto group-focus-within/date-field:opacity-100"
								/>
							)}
						</span>
					</button>
				</PopoverPrimitive.Trigger>
			</div>
			<FieldPopoverContent className="w-auto p-0" align="start">
				<FieldCalendar
					mode="single"
					selected={value}
					onSelect={(day) => {
						if (!day) {
							onChange?.(undefined);
							return;
						}

						const nextValue = new Date(day);
						nextValue.setHours(hour, minute, second);
						onChange?.(nextValue);
					}}
				/>
				<div className="flex items-center gap-1 border-t p-3">
					<TimeSegmentSelect
						value={hour}
						max={23}
						disabled={timeDisabled}
						onChange={(next) => handleTimeChange(next, minute, second)}
					/>
					<span>:</span>
					<TimeSegmentSelect
						value={minute}
						max={59}
						disabled={timeDisabled}
						onChange={(next) => handleTimeChange(hour, next, second)}
					/>
					<span>:</span>
					<TimeSegmentSelect
						value={second}
						max={59}
						disabled={timeDisabled}
						onChange={(next) => handleTimeChange(hour, minute, next)}
					/>
				</div>
			</FieldPopoverContent>
		</PopoverPrimitive.Root>
	);
}

function formatPickedDateTime(value: Date) {
	return new Intl.DateTimeFormat(getLocale(), {
		dateStyle: "long",
		timeStyle: "medium",
		hourCycle: "h23",
	}).format(value);
}

export function TimePicker({
	value,
	onChange,
	disabled,
	className,
}: {
	value?: string;
	onChange?: (value: string | undefined) => void;
	disabled?: boolean;
	className?: string;
}) {
	const [hourValue, minuteValue, secondValue] = value?.split(":") ?? [];
	const hour = Number(hourValue) || 0;
	const minute = Number(minuteValue) || 0;
	const second = Number(secondValue) || 0;

	function emit(nextHour: number, nextMinute: number, nextSecond: number) {
		onChange?.(
			`${String(nextHour).padStart(2, "0")}:${String(nextMinute).padStart(2, "0")}:${String(nextSecond).padStart(2, "0")}`,
		);
	}

	return (
		<div
			className={cn(
				fieldShellClassName,
				"group/date-field relative w-fit gap-1",
				value && !disabled && "pr-3",
				disabled && "pointer-events-none opacity-50",
				className,
			)}
		>
			<TimeSegmentSelect
				variant="inline"
				value={hour}
				max={23}
				disabled={disabled}
				onChange={(next) => emit(next, minute, second)}
			/>
			<span className="text-muted-foreground">:</span>
			<TimeSegmentSelect
				variant="inline"
				value={minute}
				max={59}
				disabled={disabled}
				onChange={(next) => emit(hour, next, second)}
			/>
			<span className="text-muted-foreground">:</span>
			<TimeSegmentSelect
				variant="inline"
				value={second}
				max={59}
				disabled={disabled}
				onChange={(next) => emit(hour, minute, next)}
			/>
			<span className="relative flex size-4 shrink-0 items-center justify-center">
				{value && !disabled && (
					<FieldClearAction
						label={m.pro_field_clearTime()}
						onClear={() => onChange?.(undefined)}
						className="pointer-events-none absolute inset-0 z-10 opacity-0 group-hover/date-field:pointer-events-auto group-hover/date-field:opacity-100 group-focus-within/date-field:pointer-events-auto group-focus-within/date-field:opacity-100"
					/>
				)}
			</span>
		</div>
	);
}

function TimeSegmentSelect({
	variant = "popover",
	value,
	max,
	disabled,
	onChange,
}: {
	variant?: "popover" | "inline";
	value: number;
	max: number;
	disabled?: boolean;
	onChange: (value: number) => void;
}) {
	return (
		<SelectPrimitive.Root
			data-slot="time-segment-select"
			value={String(value)}
			disabled={disabled}
			onValueChange={(next) => onChange(Number(next))}
		>
			<SelectPrimitive.Trigger
				data-slot="time-segment-trigger"
				className={cn(
					fieldTriggerClassName,
					variant === "popover"
						? "h-8 w-14 border border-input bg-background px-2 shadow-xs focus-visible:ring-[3px] dark:bg-input/30 dark:hover:bg-input/50"
						: "h-7 w-14 justify-center border-0 bg-transparent px-1 shadow-none focus-visible:ring-0 dark:bg-transparent dark:hover:bg-transparent",
				)}
			>
				<SelectPrimitive.Value data-slot="time-segment-value" />
			</SelectPrimitive.Trigger>
			<SelectPrimitive.Portal>
				<SelectPrimitive.Content
					data-slot="time-segment-content"
					position="item-aligned"
					className={
						"relative z-50 max-h-(--radix-select-content-available-height) min-w-[4rem] origin-(--radix-select-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-md border bg-popover text-popover-foreground shadow-md data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
					}
				>
					<SelectPrimitive.ScrollUpButton
						data-slot="time-segment-scroll-up-button"
						className="flex cursor-default items-center justify-center py-1"
					>
						<ChevronUp className="size-4" />
					</SelectPrimitive.ScrollUpButton>
					<SelectPrimitive.Viewport className="p-1">
						{Array.from({ length: max + 1 }, (_, option) => `${option}`).map(
							(option) => (
								<SelectPrimitive.Item
									key={option}
									value={option}
									data-slot="time-segment-item"
									className={
										"relative flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
									}
								>
									<span
										data-slot="time-segment-item-indicator"
										className="absolute right-2 flex size-3.5 items-center justify-center"
									>
										<SelectPrimitive.ItemIndicator>
											<Check className="size-4" />
										</SelectPrimitive.ItemIndicator>
									</span>
									<SelectPrimitive.ItemText>
										{option.padStart(2, "0")}
									</SelectPrimitive.ItemText>
								</SelectPrimitive.Item>
							),
						)}
					</SelectPrimitive.Viewport>
					<SelectPrimitive.ScrollDownButton
						data-slot="time-segment-scroll-down-button"
						className="flex cursor-default items-center justify-center py-1"
					>
						<ChevronDown className="size-4" />
					</SelectPrimitive.ScrollDownButton>
				</SelectPrimitive.Content>
			</SelectPrimitive.Portal>
		</SelectPrimitive.Root>
	);
}
