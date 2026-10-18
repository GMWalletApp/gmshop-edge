import { createFileRoute } from "@tanstack/react-router";
import { AppleIdLoginGuide } from "#/features/guides/apple-id-login";

export const Route = createFileRoute("/(public)/guides/apple-id-login")({
	component: AppleIdLoginGuide,
	head: () => ({
		meta: [
			{ title: "Apple ID 登录 App Store 图文教程" },
			{
				name: "description",
				content: "买到的 Apple ID 怎么登录 App Store：旧版和新版系统两种方法。",
			},
		],
	}),
});
