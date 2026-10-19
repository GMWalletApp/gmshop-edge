import { getLocale } from "#/paraglide/runtime";

// Channel names are stored in Chinese; English shoppers see the brand names.
const englishNames: Array<[RegExp, string]> = [
	[/支付宝/, "Alipay"],
	[/微信/, "WeChat Pay"],
];

export function paymentChannelLabel(name: string) {
	if (getLocale() !== "en-US") return name;
	return englishNames.find(([pattern]) => pattern.test(name))?.[1] ?? name;
}
