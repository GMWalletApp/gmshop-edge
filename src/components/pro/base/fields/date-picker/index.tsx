"use client";

import { CalendarIcon } from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { cn } from "#/lib/utils.ts";
import { m } from "#/paraglide/messages";
import { getLocale } from "#/paraglide/runtime";
import { FieldCalendar } from "../shared/calendar";
import {
	FieldClearAction,
	FieldPopoverContent,
	fieldTriggerClassName,
} from "../shared/field";

export function DatePicker({
	value,
	onChange,
	disabled,
	placeholder = m.pro_field_pickDate(),
	className,
}: {
	value?: Date;
	onChange?: (date: Date | undefined) => void;
	disabled?: boolean;
	placeholder?: string;
	className?: string;
}) {
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
							{value ? formatPickedDate(value, "long") : placeholder}
						</span>
						<span className="relative flex size-4 shrink-0 items-center justify-center">
							{value && !disabled && (
								<FieldClearAction
									label={m.pro_field_clearDate()}
									onClear={() => onChange?.(undefined)}
									className="pointer-events-none absolute inset-0 z-10 opacity-0 group-hover/date-field:pointer-events-auto group-hover/date-field:opacity-100 group-focus-within/date-field:pointer-events-auto group-focus-within/date-field:opacity-100"
								/>
							)}
						</span>
					</button>
				</PopoverPrimitive.Trigger>
			</div>
			<FieldPopoverContent className="w-auto p-0" align="start">
				<FieldCalendar mode="single" selected={value} onSelect={onChange} />
			</FieldPopoverContent>
		</PopoverPrimitive.Root>
	);
}

export function DateRangePicker({
	value,
	onChange,
	disabled,
	placeholder = m.pro_field_pickDateRange(),
	className,
}: {
	value?: { from?: Date; to?: Date };
	onChange?: (value: { from?: Date; to?: Date } | undefined) => void;
	disabled?: boolean;
	placeholder?: string;
	className?: string;
}) {
	const from = value?.from;
	const to = value?.to;

	return (
		<PopoverPrimitive.Root data-slot="field-popover">
			<div className={cn("group/date-field relative w-full", className)}>
				<PopoverPrimitive.Trigger data-slot="field-popover-trigger" asChild>
					<button
						type="button"
						disabled={disabled}
						className={cn(
							fieldTriggerClassName,
							!from && "text-muted-foreground",
							from && !disabled && "pr-3",
						)}
					>
						<CalendarIcon className="mr-2 size-4" />
						<span className="min-w-0 flex-1 truncate text-left">
							{getDateRangeLabel(from, to, placeholder)}
						</span>
						<span className="relative flex size-4 shrink-0 items-center justify-center">
							{from && !disabled && (
								<FieldClearAction
									label={m.pro_field_clearDateRange()}
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
					mode="range"
					selected={{ from, to }}
					onSelect={(range) => {
						if (!range) {
							onChange?.(undefined);
							return;
						}
						onChange?.({ from: range.from, to: range.to });
					}}
					numberOfMonths={2}
				/>
			</FieldPopoverContent>
		</PopoverPrimitive.Root>
	);
}

function getDateRangeLabel(
	from: Date | undefined,
	to: Date | undefined,
	placeholder: string,
) {
	if (from && to)
		return `${formatPickedDate(from, "medium")} - ${formatPickedDate(to, "medium")}`;
	if (from) return formatPickedDate(from, "medium");
	return placeholder;
}

function formatPickedDate(value: Date, dateStyle: "long" | "medium") {
	return new Intl.DateTimeFormat(getLocale(), { dateStyle }).format(value);
}
