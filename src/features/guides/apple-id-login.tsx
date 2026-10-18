import type { ReactNode } from "react";

export const appleIdLoginGuidePath = "/guides/apple-id-login";

/** Hand-drawn iPhone mockups; no third-party screenshots. */
function Phone({ label, children }: { label: string; children: ReactNode }) {
	return (
		<figure className="flex w-full max-w-[220px] flex-col items-center gap-2">
			<div className="w-full overflow-hidden rounded-[2rem] border-[6px] border-neutral-900 bg-neutral-100 text-neutral-900 shadow-lg">
				<div className="flex items-center justify-between px-4 pt-2 pb-1 font-semibold text-[10px]">
					<span>9:41</span>
					<span className="h-3 w-12 rounded-full bg-neutral-900" />
					<span>100%</span>
				</div>
				<div className="h-[340px] space-y-2 overflow-hidden px-3 pb-3 text-[11px]">
					{children}
				</div>
			</div>
			<figcaption className="text-center text-muted-foreground text-xs leading-5">
				{label}
			</figcaption>
		</figure>
	);
}

function Row({
	children,
	hit,
	blue,
}: {
	children: ReactNode;
	hit?: boolean;
	blue?: boolean;
}) {
	return (
		<div
			className={`flex items-center justify-between rounded-lg bg-white px-2.5 py-2 ${blue ? "text-blue-600" : ""} ${hit ? "ring-2 ring-red-500" : ""}`}
		>
			<span>{children}</span>
			{!blue && <span className="text-neutral-400">›</span>}
		</div>
	);
}

function Tap({ children }: { children: ReactNode }) {
	return (
		<span className="rounded bg-red-500 px-1.5 py-0.5 font-bold text-[10px] text-white">
			{children}
		</span>
	);
}

function Steps({ children }: { children: ReactNode }) {
	return (
		<div className="flex flex-wrap justify-center gap-5 sm:justify-start">
			{children}
		</div>
	);
}

export function AppleIdLoginGuide() {
	return (
		<article className="mx-auto max-w-3xl space-y-10 px-5 py-12 sm:py-16">
			<header className="space-y-4">
				<h1 className="font-bold text-3xl leading-tight sm:text-4xl">
					Apple ID 登录 App Store 图文教程
				</h1>
				<p className="text-muted-foreground leading-7">
					买到的 Apple ID 只用来登录 App Store 下载
					App。全程不要在「设置」最上面的 Apple
					账户（iCloud）里登录买到的账号，你自己的
					iCloud、照片、通讯录都不会受影响。
				</p>
				<div className="rounded-2xl border-2 border-amber-400 bg-amber-50 p-4 text-amber-950 text-sm leading-7 dark:bg-amber-950 dark:text-amber-50">
					先试「方法一」。如果在 App Store
					里拉到底找不到「退出登录」，说明系统是新版界面，直接看「方法二」，不要反复尝试。
				</div>
				<nav className="space-y-1 text-sm underline underline-offset-4">
					<a className="block" href="#method-1">
						方法一：在 App Store 里退出再登录（旧版界面）
					</a>
					<a className="block" href="#method-2">
						方法二：从「设置 → 媒体与购买项目」登录（新版界面）
					</a>
					<a className="block" href="#after-login">
						登录时弹出的提示怎么选
					</a>
					<a className="block" href="#faq">
						常见问题
					</a>
				</nav>
			</header>

			<section id="method-1" className="scroll-mt-24 space-y-5 border-t pt-8">
				<h2 className="font-semibold text-xl">
					方法一：在 App Store 里退出再登录（旧版界面）
				</h2>
				<ol className="list-decimal space-y-2 pl-5 text-muted-foreground leading-7">
					<li>打开 App Store，点右上角的头像。</li>
					<li>在账户页面一直往下拉到最底部，点「退出登录」。</li>
					<li>回到页面最上方，输入买到的 Apple ID 和密码，点「登录」。</li>
				</ol>
				<Steps>
					<Phone label="① 打开 App Store，点右上角头像">
						<div className="flex items-center justify-between pt-1">
							<span className="font-bold text-lg">Today</span>
							<span className="flex size-7 items-center justify-center rounded-full bg-blue-500 text-white ring-2 ring-red-500 ring-offset-2">
								头像
							</span>
						</div>
						<div className="h-36 rounded-xl bg-gradient-to-br from-sky-400 to-indigo-500" />
						<div className="h-24 rounded-xl bg-gradient-to-br from-amber-300 to-rose-400" />
					</Phone>
					<Phone label="② 拉到最底部，点「退出登录」">
						<div className="pt-1 text-center font-semibold">账户</div>
						<Row>已购项目</Row>
						<Row>订阅</Row>
						<Row blue>兑换充值卡或代码</Row>
						<Row>个性化推荐</Row>
						<div className="py-2 text-center text-neutral-400">⋯ 往下拉 ⋯</div>
						<Row blue hit>
							退出登录 <Tap>点这里</Tap>
						</Row>
					</Phone>
					<Phone label="③ 输入买到的账号和密码，点「登录」">
						<div className="pt-1 text-center font-semibold">账户</div>
						<div className="space-y-1.5 rounded-lg bg-white p-2.5 ring-2 ring-red-500">
							<div className="border-b pb-1.5 text-neutral-400">
								Apple ID：买到的账号
							</div>
							<div className="text-neutral-400">密码：买到的密码</div>
						</div>
						<div className="rounded-lg bg-blue-600 py-2 text-center text-white">
							登录
						</div>
					</Phone>
				</Steps>
			</section>

			<section id="method-2" className="scroll-mt-24 space-y-5 border-t pt-8">
				<h2 className="font-semibold text-xl">
					方法二：从「设置 → 媒体与购买项目」登录（新版界面）
				</h2>
				<p className="rounded-xl bg-muted/50 p-4 text-muted-foreground text-sm leading-7">
					进「设置」不会登录 iCloud。这里只是在「媒体与购买项目」里换掉 App
					Store 用的账号。不要退出设置最上面你自己的
					iCloud，也不要在那里登录买到的账号。
				</p>
				<ol className="list-decimal space-y-2 pl-5 text-muted-foreground leading-7">
					<li>打开「设置」，点最上面你自己的账户名。</li>
					<li>点「媒体与购买项目」。</li>
					<li>
						在弹出的菜单里点「退出登录」（如果进到了账户设置页面，就拉到最底部点「退出登录」）。
					</li>
					<li>
						再点一次「媒体与购买项目」，在弹窗里选「不是
						xxx？」，然后输入买到的账号和密码登录。
					</li>
				</ol>
				<Steps>
					<Phone label="① 设置 → 点最上面的账户名">
						<div className="pt-1 font-bold text-lg">设置</div>
						<Row hit>
							<span className="font-semibold">你的名字</span>
							<span className="block text-[9px] text-neutral-400">
								Apple 账户、iCloud 等
							</span>
						</Row>
						<Row>飞行模式</Row>
						<Row>无线局域网</Row>
						<Row>蓝牙</Row>
						<Row>通用</Row>
					</Phone>
					<Phone label="② 点「媒体与购买项目」">
						<div className="pt-1 text-center font-semibold">Apple 账户</div>
						<Row>个人信息</Row>
						<Row>登录与安全</Row>
						<Row>付款与配送</Row>
						<Row>iCloud（不要动）</Row>
						<Row hit>
							媒体与购买项目 <Tap>点这里</Tap>
						</Row>
						<Row>查找</Row>
					</Phone>
					<Phone label="③ 点「退出登录」，退出旧的 App Store 账号">
						<div className="pt-1 text-center font-semibold">Apple 账户</div>
						<Row>个人信息</Row>
						<Row>登录与安全</Row>
						<div className="mt-8 overflow-hidden rounded-xl bg-white text-center shadow-xl">
							<div className="border-b py-2 text-blue-600">查看账户</div>
							<div className="border-b py-2 text-blue-600">密码设置</div>
							<div className="py-2 font-semibold text-red-600 ring-2 ring-red-500 ring-inset">
								退出登录
							</div>
						</div>
						<div className="rounded-xl bg-white py-2 text-center font-semibold text-blue-600">
							取消
						</div>
					</Phone>
					<Phone label="④ 再点「媒体与购买项目」，选「不是 xxx？」后登录买到的账号">
						<div className="pt-1 text-center font-semibold">Apple 账户</div>
						<div className="mt-6 space-y-2 rounded-xl bg-white p-3 text-center shadow-xl">
							<div className="font-semibold">
								要使用“你的名字”的身份设置媒体与购买项目吗？
							</div>
							<div className="rounded-lg bg-blue-600 py-1.5 text-white">
								继续
							</div>
							<div className="rounded-lg bg-neutral-100 py-1.5 text-blue-600 ring-2 ring-red-500">
								不是“你的名字”？
							</div>
							<div className="py-1 text-blue-600">取消</div>
						</div>
					</Phone>
				</Steps>
			</section>

			<section
				id="after-login"
				className="scroll-mt-24 space-y-5 border-t pt-8"
			>
				<h2 className="font-semibold text-xl">登录时弹出的提示怎么选</h2>
				<ul className="list-disc space-y-2 pl-5 text-muted-foreground leading-7">
					<li>
						<strong className="text-foreground">要求回答安全问题</strong>
						：按订单里给的密保答案填写，注意大小写。
						「朋友」对应“你少年时代最好的朋友叫什么名字？”，「工作」对应“你的第一份工作是什么？”，「父母」对应“你的父母是在哪里认识的？”
					</li>
					<li>
						<strong className="text-foreground">
							弹出「Apple ID 安全」，让你升级双重认证
						</strong>
						：不想绑手机号，点「其他选项」→「不升级」跳过。想绑也可以，点「继续」按提示绑定你自己的手机号，以后登录要收验证码。
					</li>
					<li>
						<strong className="text-foreground">提示条款与条件已更新</strong>
						：点「同意」即可。
					</li>
				</ul>
				<Steps>
					<Phone label="不想绑手机：点「其他选项」→「不升级」">
						<div className="flex h-full flex-col items-center justify-between rounded-xl bg-white p-3 text-center">
							<div className="space-y-2 pt-6">
								<div className="text-3xl">🔒</div>
								<div className="font-bold text-sm">Apple ID 安全</div>
								<div className="text-neutral-500">使用双重认证保护你的账户</div>
							</div>
							<div className="w-full space-y-1.5">
								<div className="rounded-lg bg-blue-600 py-1.5 text-white">
									继续
								</div>
								<div className="rounded-lg py-1.5 text-blue-600 ring-2 ring-red-500">
									其他选项 → 不升级
								</div>
							</div>
						</div>
					</Phone>
				</Steps>
			</section>

			<section id="faq" className="scroll-mt-24 space-y-4 border-t pt-8">
				<h2 className="font-semibold text-xl">常见问题</h2>
				<dl className="space-y-4 text-muted-foreground leading-7">
					<div>
						<dt className="font-semibold text-foreground">
							提示账号或密码错误
						</dt>
						<dd>
							检查是否多复制了空格；确认是在 App Store
							或「媒体与购买项目」里登录，不是在设置最上面登录。
						</dd>
					</div>
					<div>
						<dt className="font-semibold text-foreground">提示无法登录</dt>
						<dd>
							多半是网络问题。切换 Wi-Fi
							和蜂窝数据再试，或开飞行模式等几分钟后再连网。不要短时间内反复输错密码，容易锁号。
						</dd>
					</div>
					<div>
						<dt className="font-semibold text-foreground">
							搜不到想要的 App，或下载时要填账单地址
						</dt>
						<dd>
							先确认这个 App 在该地区上架。免费 App
							遇到账单地址页面时，付款方式选「无」再填地址即可；付费 App
							需要用对应地区的礼品卡充值。
						</dd>
					</div>
					<div>
						<dt className="font-semibold text-foreground">
							下载完了怎么换回自己的账号
						</dt>
						<dd>
							按同样的步骤退出，再登录你自己的账号。已下载的 App
							照常使用，以后更新这个 App 时再登录买到的账号。
						</dd>
					</div>
				</dl>
				<p className="rounded-xl bg-muted/50 p-4 text-sm leading-7">
					还是登录不上？打开你的订单页联系在线客服，附上报错截图，质保期内核实后免费换号。
				</p>
			</section>
		</article>
	);
}
