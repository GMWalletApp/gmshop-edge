/**
 * Calendar parts of `date` in Asia/Shanghai, the time zone Alipay and WeChat
 * Pay expect in their expiry fields. `h23` avoids the "24:00" hour some
 * runtimes emit at midnight, and `en-CA` yields zero-padded numeric parts.
 */
export function shanghaiDateTimeParts(date: Date) {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: "Asia/Shanghai",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	}).formatToParts(date);
	const value = Object.fromEntries(
		parts.map((part) => [part.type, part.value]),
	);
	return {
		year: value.year ?? "",
		month: value.month ?? "",
		day: value.day ?? "",
		hour: value.hour ?? "",
		minute: value.minute ?? "",
		second: value.second ?? "",
	};
}
