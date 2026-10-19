import {
	agentAccessProducts,
	agentAccessRefundPolicy,
} from "#/features/agent-access/products";
import type { SupportedLocale } from "#/lib/locales";

type Policy = {
	delivery: string;
	deliveryTime: string;
	coverage: string;
	warranty: string;
	restrictions: string;
};

type ProductLocalization = {
	name: string;
	description: string;
};

type SellableItemLocalization = {
	name: string;
	policy: Policy;
};

const automatic = "24/7 automatic delivery";
const standardDeliveryTime =
	"The recharge code and recharge link are issued automatically after payment, usually within 1 minute; view them on the order page.";
const immediate = standardDeliveryTime;
const manual = "Processed online after payment confirmation";
const manualDeliveryTime =
	"Usually completed within 1–30 minutes. During peak periods, delivery may take longer but will not exceed 3 hours. Track delivery status and contents on the order page.";

const productEnglish: Record<string, ProductLocalization> = {
	[agentAccessProducts.subsite.productId]: {
		name: "One-time hosted storefront access",
		description:
			"A hosted storefront with a system subdomain and console. No purchasing credit. For your own verified account only; existing access must not be purchased again.",
	},
	[agentAccessProducts.api.productId]: {
		name: "One-time API access",
		description:
			"API access and secure credential claim for supported integrations. No purchasing credit or hosted storefront. For your own verified account only.",
	},
	"2a794b89-3bb9-49d4-8691-0d13a1606869": {
		name: "ChatGPT Membership Recharge",
		description:
			"ChatGPT Go, Plus, Pro, and Business (team plan) subscription recharge. Select a plan to review its delivery, coverage, and warranty terms.",
	},
	"afb8af99-86af-463e-a76f-fcea2edd22dd": {
		name: "Official Codex Credits",
		description:
			"Official Codex credit CDKs. Not API relay balance, phone verification, or a pre-made account. Select a credit amount to review delivery and restrictions.",
	},
	"ba540b83-388d-45d1-9dcb-25c3da3f9956": {
		name: "Claude Membership Recharge",
		description:
			"Claude Pro and Claude Max membership recharge. Select a plan to review eligibility, warranty, and restrictions.",
	},
	"3e60e88d-a0bd-4723-bc9e-ff45f6dafa16": {
		name: "X Subscription｜4-in-1｜X Premium + Grok + Grok Bot + Cursor",
		description: `The new official X subscription (launched October 2026) includes 4 products in one plan: X Premium, Grok, Grok Bot, and Cursor. Billed monthly through an official card payment; the bill is sent to your email. 30-day subscription warranty.

Before you recharge
· No replacement: the account must not have any active membership.
· Accounts with unpaid bills that have not cancelled renewal cannot be recharged.
· Some accounts get declined. You can retry; if it keeps failing, use another account.

What the 4-in-1 includes
· X Premium: blue checkmark, creator tools, fewer ads.
· Grok: chat, voice, image and video generation.
· Grok Bot: a team of AI assistants (Premium tier and above).
· Cursor: AI coding tool, both local and cloud agents.
Grok and Cursor share one weekly usage pool.

Which tier
· Plus (official $8/month): base usage (1x). Cursor can only use Grok models; no Grok Bot. Good for trying it out.
· Premium (official $30/month): 4x Plus usage, with all SuperGrok, Cursor Pro, and X Premium+ benefits. Enough for most people.
· Super (official $100/month): everything in Premium, 15x Plus usage. For heavy daily use.
· Ultra (official $200/month): everything in Premium, 50x Plus usage. For intensive coding and agent tasks.
Note: third-party models in Cursor (such as Claude or GPT) are not counted in the subscription and are billed separately by the official service.

How delivery works
1. After payment you automatically receive an "order CDK"; copy it from the order details.
2. Send the order CDK to the site's live support.
3. Support delivers the recharge code and recharge link, usually within 1–30 minutes.
The order CDK is only used to claim your code from support; it cannot be redeemed directly.

How to activate
1. Open the recharge link from support.
2. Sign in to the account you want to recharge, enter the code, and submit.
3. Once activated, sign in to X, Grok, or Cursor to see the tier's benefits.
If anything goes wrong, send a screenshot to live support.

Notes
· Each code can be used once; do not share it.
· Usage multiples are the official comparison with Plus; exact limits are not published and follow official rules.

After-sales
30-day warranty against subscription drops: contact support from the order page.
Account bans are not covered. No refunds after the code is delivered.`,
	},
	"e5c81556-03be-43fd-bf3f-e248c16cc34d": {
		name: "Claude Relay Compute｜Standard / Enterprise Fast Lines",
		description: `Claude Relay Compute｜The easiest way to use Claude

The simplest, fastest way to use Claude models.
No account bans, network setup, or risk controls to worry about: redeem and start using it.

What you get
- Compute credit arrives instantly after redemption; pay as you go, no monthly fee
- Official, unmodified Claude models, never downgraded
- Works with Claude Code, Cursor, Cline, and other popular clients

Which line
- Standard line: best value for daily development and long tasks
- Enterprise fast line: choose it for faster responses and higher stability

How to use
1. A code is issued automatically after payment
2. Open the redemption page in your order and enter the code to add credit
3. Create a key, choose a line, and paste it into your client

Notes
- Credit is a shared balance for both lines, charged at the selected line's rate
- Codes are digital goods and are not refundable once delivered
- If redemption fails, contact us through Support`,
	},
	"c70d10e8-b781-4782-bc98-1f034bcd069a": {
		name: "Apple ID｜US / Japan / Turkey｜Aged account",
		description: `Accounts registered over a year ago, one buyer per account, with security questions; you can change the password yourself. Delivered automatically after payment, for downloading and buying apps from other regions on the App Store.

Which region
· US: the widest app selection; ChatGPT, Claude, Gemini, Grok, and other AI apps can all be downloaded and purchased in-app. If unsure, choose US.
· Japan: the Japanese App Store, for apps and games listed there.
· Turkey: the Turkish App Store, where many subscriptions are priced lower (actual prices follow the App Store).

What you receive
One line of account details on the order page:
Apple ID: xxx@xx.com | Password: xxxx | Security answers Friend: xxx Job: xxx Parents: xxx | Birthday: xxxx/xx/xx | Region: xx | Registered: xxxx/xx/xx
The three answers match Apple's questions:
· Friend → What was the name of your best friend as a teenager?
· Job → What was your first job?
· Parents → Where did your parents meet?
Answer whichever question Apple asks; answers are case-sensitive.

How to use (iPhone / iPad)
1. Open the App Store, tap your avatar, scroll down, and tap "Sign Out". This only signs out of the App Store; your iCloud, photos, and contacts are unaffected.
2. Tap "Sign In" on the same page and enter the delivered Apple ID and password. Answer security questions as above if asked; accept updated terms if prompted.
3. Search for and download the apps you need.
4. Switch back to your own account afterwards; downloaded apps keep working. Sign in to this account again when an app needs an update.

Change the password first (strongly recommended)
1. Open https://account.apple.com in a browser and sign in with the delivered details, answering security questions if needed.
2. Go to "Sign-In and Security" → "Password" and set a new password only you know.
3. For extra safety, also replace the security questions and account email with your own.
After that, only you can sign in.

Important
· Sign in only in the App Store, never in the Apple Account (iCloud) at the top of Settings. Signing in to iCloud can lock the account and even the device.
· Do not change the account's country or region.
· Do not enter a wrong password repeatedly; it can trigger a lock.
· The account has no balance. In-app purchases need a gift card or local payment method for that region.
· Downloads and in-app purchases work; each app sets its own subscription rules, so not every subscription is guaranteed.
· Each account is sold to one customer only; do not resell or share the details.

After-sales
3-day warranty: if the delivered details fail to sign in (wrong password, locked account) within 3 days, contact support from the order page with a screenshot for a free replacement after verification.
Not covered: problems after you change the password or security questions, locks caused by signing in to iCloud, changing the region, or bans for violating Apple's rules.
No no-reason refunds after delivery.`,
	},
	"64812c48-9026-4ef7-874d-b332d2a39b1a": {
		name: "Gemini Pro｜18 months｜Activation link",
		description: `An 18-month Gemini Pro activation link. Delivered automatically after payment; open it with your own Google account to claim. Only the link is sold; no Google account is included.

Before you buy
- The account must sign in normally and have no subscription at all: no Gemini subscription, Google One / AI plan, family-shared plan, or free trial. This cannot stack with an existing subscription; do not order if you are not eligible.
- Activation depends on Google's review of the account, region, and eligibility at the time; the official page decides.
- Only the link is sold. Account registration and one-on-one tutoring are not provided; beginners should buy with care.

How to activate
1. Make sure your network can reach Google services.
2. Sign in to the Google account to activate in your browser and confirm it is the right one.
3. Open the activation link on the order page and check the plan, term, and conditions shown.
4. Follow the page to claim, then confirm in the account's subscription page. If the benefits differ from the product, stop and contact support.

Use the link within 24 hours of delivery; do not keep it for long or share the full link.

FAQ
- "Not available in your location": related to the account's region or eligibility; do not retry repeatedly. If the region is wrong, request a correction on Google's official page; approval is up to Google.
- Gemini will not open or says no permission: confirm you are signed in to the right account; availability depends on region, age, and account type.
- The page keeps loading or fails: check your network and browser extensions and retry in a private window; if it still fails, keep a screenshot and do not resubmit.
- Whether Antigravity and similar features work follows the claimed plan; not guaranteed for every account.

After-sales
The warranty covers the link's validity for 24 hours after delivery: if it says "already used" or "expired" in that time, contact support from the order page with the order number and a screenshot for a replacement after verification. Requests must be made within 24 hours of delivery. Unsupported regions, missing permissions, risk controls, disabled or banned accounts are not covered, and the subscription's duration after activation is not guaranteed.`,
	},
	"2ee356de-fe69-4641-94c3-1dfea19b6967": {
		name: "Muse AI account｜1 billion tokens",
		description: `A ready-made Muse AI account with 1 billion tokens of creation credit for AI image and video generation, from short clips to videos over an hour long. Delivered automatically after payment: the account email and sign-in access to that email.

How to use
1. View the delivered account email and its sign-in details on the order page.
2. Open https://muse.ai and enter the delivered account email.
3. Sign in to the delivered email, find the verification email, and enter its code on muse.ai.
4. After signing in, open Settings to see the 1 billion tokens.

Notes
- If no verification email arrives, check the spam folder first.
- Never share the email verification code; do not publish the account or email details.
- Tokens are usage credit, not a fixed number of images or minutes of video; actual usage and limits follow Muse's rules.

After-sales
24-hour warranty. Sign in and check soon after delivery; if anything is wrong, contact support from the order page within 24 hours with the order number and a screenshot.`,
	},
	"a9f6b8c4-e302-5c1a-8947-780785672b32": {
		name: "Codex long-term SMS number｜US｜20–30 days",
		description: `A long-term US phone number, valid for about 20–30 days after you take it (as shown on the number page). The warranty covers receiving the first verification code; later bindings are not covered.

How to use
1. Open the number page from your order in Safari, Chrome, or Edge (not WeChat's built-in browser).
2. Enter the CDK you received, then copy the assigned +1 US number.
3. Enter the number on the Codex / OpenAI phone verification page and send the SMS.
4. Return to the number page and tap "Get code"; codes can be delayed, so wait about 1 minute.

Number page: https://sms.kkdos.store/

FAQ
- "Number recently used": a platform risk control; wait about 1 hour before binding again or switch to a stable network.
- Cannot send SMS to the number: switch numbers yourself on the number page.
- Too many verification requests: stop clicking, wait, or switch to a stable network before retrying.
- "Linked to the maximum number of accounts": this number cannot be used further; switch numbers.
- No code after checking: wait about 1 minute first, then switch numbers. Numbers cannot be switched after a code is received.
- Out of switches or under maintenance: contact support.

Restrictions: no Google mailbox verification, no sign-ups on other platforms, and the number cannot be used as a phone-number login. No no-reason refunds after redemption or after a code is received.`,
	},
	"cdccd3bc-4504-5521-8761-332c99910c9f": {
		name: "Codex one-time SMS number｜US｜1 use",
		description: `A US phone number only for the SMS verification of your first Codex sign-in. One-time use: each purchase can receive one verification code.

How to use
1. Open the number page from your order in Safari, Chrome, or Edge (not WeChat's built-in browser).
2. Enter the CDK you received, then copy the assigned +1 US number.
3. Enter the number on the Codex / OpenAI phone verification page and send the SMS.
4. Return to the number page and tap "Get code"; codes can be delayed, so wait about 1 minute.

Number page: https://sms.leadbee.cn/

FAQ
- "Number recently used": a platform risk control; switch to a stable network or another number.
- Cannot send SMS to the number: switch numbers yourself on the number page.
- Too many verification requests: stop clicking, wait, or switch to a stable network before retrying.
- "Linked to the maximum number of accounts": this number cannot be used further; switch numbers.
- No code after checking: wait about 1 minute first, then switch numbers. Numbers cannot be switched after a code is received.
- Out of switches or under maintenance: contact support.

Restrictions: no Google mailbox verification, no sign-ups on other platforms, and the number cannot be used as a phone-number login. No no-reason refunds after redemption or after a code is received.`,
	},
	"643ba58d-3441-4ac5-b2e4-4a4007f24cc0": {
		name: "Price difference top-up",
		description: `Each unit covers ¥50 of price difference; choose the quantity you need.
For example, to cover ¥150, order 3 units.
After paying, send this order number to support.`,
	},
};

function policy(
	delivery: string,
	deliveryTime: string,
	coverage: string,
	warranty: string,
	restrictions: string,
): Policy {
	return { delivery, deliveryTime, coverage, warranty, restrictions };
}

const iosCoverage =
	"Replacement supported; redemption resets the subscription to 30 days and remaining time does not stack.";
const subscriptionWarranty =
	"30-day subscription warranty; if the subscription drops, it is settled by days used.";
const free = "No replacement; the account must currently be on Free";
const noSubscription =
	"Only accounts with no Go, Plus, or Pro subscription; leave any Team workspace first; wait 2–3 days after a mobile-channel subscription expires";
const kycExcluded =
	"Policy violations, bans, KYC, phone-binding issues, or self-cancelled subscriptions are not covered.";
const pro500Warranty =
	"Verified subscription drops are refunded for the remaining days; banned or disabled accounts are not covered.";
const pro500Restrictions =
	"$500 is the plan tier, not the store price. Redeem the delivered code at its recharge link.";
const businessRestrictions =
	"Auto-renewal is off by default, so you will not be charged at expiry; contact the store's support to add seats; policy violations, bans, and account risk controls are not covered.";
const codexPolicy = policy(
	automatic,
	immediate,
	"Requires an account with an existing subscription (such as Plus or Pro); Free accounts are not supported.",
	"Credits cannot be returned or exchanged after they arrive.",
	"GPT Free accounts cannot buy; bans, regional issues, disclosure, or user error are not covered.",
);
const claudeRestrictions =
	"Bans are not covered; no refund when Billing arrears or refunds, a hidden organization ban, or an account that cannot send messages blocks delivery; do not buy unless you understand account risk controls.";
const claudeMaxRestrictions = `New accounts cannot recharge 5X / 20X; the account must be registered for at least one month, or the subscription may not arrive. This cannot be checked in advance, so confirm before recharging.

Important｜Claude Max identity verification (KYC)
Claude Max 5X / 20X always requires KYC identity verification. This is Claude's official requirement and unrelated to our recharge. We only recharge the subscription; KYC is the buyer's responsibility and we do not complete or guarantee it. Do not order if you cannot complete it yourself.

${claudeRestrictions}`;
const claudePolicy = (restrictions: string) =>
	policy(
		automatic,
		immediate,
		"Your current Claude subscription must expire before recharge.",
		subscriptionWarranty,
		restrictions,
	);
const appleIdPolicy = (region: string) =>
	policy(
		"Delivered automatically after payment: Apple ID, password, security answers, and birthday",
		"Automatic, usually within 1 minute; view it on the order page",
		`${region} Apple ID for one buyer, registered over a year ago, with security questions; you can change the password; downloads and in-app purchases work on the App Store`,
		"3-day warranty: a free replacement after verification if the delivered details cannot sign in within 3 days",
		"Sign in only in the App Store, never to iCloud in Settings; do not change the country or region; the account has no balance",
	);
const computePolicy = (amount: string) =>
	policy(
		"Code and redemption link issued automatically after payment",
		"Automatic, usually within 1 minute; view it on the order page",
		`A ¥${amount} Claude compute card, credited 1:1 with no bonus; shared balance for both the standard and enterprise fast lines, charged at the selected line's rate`,
		"Not refundable.",
		"Each code can be redeemed once; keep it safe and do not share it.",
	);
const xPolicy = (tier: string) =>
	policy(
		"An order CDK is issued automatically after payment; send it to live support, who delivers the recharge code and link",
		"Order CDK issued automatically; support usually delivers the code within 1–30 minutes",
		`X 4-in-1 ${tier}: X Premium + Grok + Grok Bot + Cursor`,
		"30-day warranty against subscription drops; bans are not covered; no refunds after the code is delivered",
		"No replacement: the account must have no active membership; accounts with unpaid bills that have not cancelled renewal cannot be recharged; some accounts get declined, retry or use another account",
	);
const smsDelivery =
	"A CDK and redemption link are issued automatically after payment; take your number on the number page.";

const sellableItemEnglish: Record<string, SellableItemLocalization> = {
	[agentAccessProducts.subsite.itemId]: {
		name: "One-time activation",
		policy: policy(
			"Automatic activation after payment",
			"Track progress on the order page; failures are retried or referred to support",
			"Access has no scheduled expiry. Purchasing credit is not included.",
			agentAccessRefundPolicy["en-US"],
			"For your own verified account only. Do not repurchase existing access.",
		),
	},
	[agentAccessProducts.api.itemId]: {
		name: "One-time activation",
		policy: policy(
			"Automatic activation after payment",
			"Track progress on the order page; failures are retried or referred to support",
			"API access only; no hosted storefront or purchasing credit.",
			agentAccessRefundPolicy["en-US"],
			"Test your own integration before taking live orders.",
		),
	},
	"983f6e73-061e-419d-a7d5-8ac5ec5648ab": {
		name: "ChatGPT Go｜1 month",
		policy: policy(
			automatic,
			immediate,
			iosCoverage,
			subscriptionWarranty,
			"Account bans, sharing, frequent IP changes, and account-level risk controls are not covered.",
		),
	},
	"362d3add-4901-4b4c-b6a9-27aea63473e4": {
		name: "ChatGPT Plus｜Philippines｜1 month",
		policy: policy(
			automatic,
			immediate,
			`${free}; confirm the current subscription has expired before purchase.`,
			subscriptionWarranty,
			"Bans, incorrect information, and region or account issues are not covered.",
		),
	},
	"efc0cc87-b7ed-4bd5-b792-e9f455fda8eb": {
		name: "ChatGPT Plus｜iOS｜1 month",
		policy: policy(
			automatic,
			immediate,
			iosCoverage,
			subscriptionWarranty,
			"Bans are not covered; use a normally registered, healthy account.",
		),
	},
	"f8c7ee24-239c-43a1-abe7-9dd40c53de21": {
		name: "ChatGPT Pro 100｜iOS｜1 month",
		policy: policy(
			automatic,
			immediate,
			iosCoverage,
			subscriptionWarranty,
			"Bans and account-level risk controls are not covered.",
		),
	},
	"bf88dfff-914a-4413-b4a9-19d56d30feca": {
		name: "ChatGPT Pro 100｜Philippines｜1 month",
		policy: policy(
			automatic,
			immediate,
			`${free}; confirm the current subscription has expired before purchase.`,
			subscriptionWarranty,
			kycExcluded,
		),
	},
	"21859feb-e4d5-469f-9ca8-11fa4b9e5d18": {
		name: "ChatGPT Pro 100｜Chile｜1 month",
		policy: policy(
			automatic,
			immediate,
			`${free}; ${noSubscription}.`,
			subscriptionWarranty,
			"Policy violations, bans, KYC, zero-cost subscriptions, or self-cancelled subscriptions are not covered.",
		),
	},
	"0829de43-da22-420c-9866-38c83dd420f0": {
		name: "ChatGPT Pro 200｜Philippines new｜1 month",
		policy: policy(
			automatic,
			immediate,
			`${free}; confirm the current subscription has expired before purchase.`,
			subscriptionWarranty,
			kycExcluded,
		),
	},
	"624bf652-debb-48f4-ab98-6b9daab2a6ea": {
		name: "ChatGPT Pro 200｜Philippines renewal｜1 month",
		policy: policy(
			automatic,
			"The code is issued automatically. Buy and submit one day before the current subscription expires; it renews for 1 month when the current term ends.",
			"The account must currently be on Pro 200; Philippines bill of PHP 8,919.64; buy one day before expiry and it renews when the current term ends; no upgrades.",
			"",
			"Philippines Pro renewals only (bill of PHP 8,919.64); no upgrades; do not share the code.",
		),
	},
	"208c2e9c-3594-4be9-9c71-22ac8b09aad4": {
		name: "ChatGPT Pro 200｜iOS｜1 month",
		policy: policy(
			automatic,
			immediate,
			iosCoverage,
			subscriptionWarranty,
			"Bans and account-level risk controls are not covered.",
		),
	},
	"030582df-98c1-5b87-914d-28ddc606e163": {
		name: "ChatGPT Pro 500｜Philippines｜1 month",
		policy: policy(
			automatic,
			immediate,
			`${free}; ${noSubscription}.`,
			pro500Warranty,
			pro500Restrictions,
		),
	},
	"521968d1-5c64-45bf-a4bc-7df906dcc1cb": {
		name: "ChatGPT Pro 500｜Chile｜1 month",
		policy: policy(
			automatic,
			immediate,
			`${free}; ${noSubscription}.`,
			pro500Warranty,
			pro500Restrictions,
		),
	},
	"ceab0998-9dc1-4f3e-94e4-a8332a311eaf": {
		name: "ChatGPT Business｜2 Standard seats｜1 month",
		policy: policy(
			automatic,
			immediate,
			"The account must currently be on Free; an official ChatGPT Business workspace, not a promo-code shared team: your account becomes the workspace owner with 2 Standard seats (one for you, one to invite); a Standard seat offers about 1.25x the usage of Plus in rolling 5-hour windows; ChatGPT and Codex are both included.",
			subscriptionWarranty,
			businessRestrictions,
		),
	},
	"30754dc5-5ba6-4923-9527-62dd91b8e19e": {
		name: "ChatGPT Business｜Premium + Standard seat｜1 month",
		policy: policy(
			automatic,
			immediate,
			"The account must currently be on Free; an official ChatGPT Business workspace, not a promo-code shared team: your account becomes the workspace owner with 2 seats; 1 Premium seat: 5x the usage of a Standard seat (mainly Codex and ChatGPT Work) with no 5-hour limit; 1 Standard seat: about 1.25x the usage of Plus with a 5-hour window; assign seat types under Workspace Settings → Members.",
			subscriptionWarranty,
			businessRestrictions,
		),
	},
	"7f76a172-d963-43a4-8297-d4d7550f4670": {
		name: "Codex｜250 credits",
		policy: codexPolicy,
	},
	"1572316f-0649-43d5-b86f-2c551f10833e": {
		name: "Codex｜500 credits",
		policy: codexPolicy,
	},
	"902c0f18-1c50-4b75-9cc2-62e432716e0c": {
		name: "Codex｜1,000 credits",
		policy: codexPolicy,
	},
	"ea366d71-6d3b-4e0d-8551-242a3a1ca483": {
		name: "Codex｜2,500 credits",
		policy: codexPolicy,
	},
	"efa6e9ae-f8a6-4cf7-b99c-72e51e68dace": {
		name: "Claude Pro｜1 month",
		policy: claudePolicy(claudeRestrictions),
	},
	"d3a2050e-1c65-4c7e-9ad7-3c8892ef412e": {
		name: "Claude Max 5X｜1 month",
		policy: claudePolicy(claudeMaxRestrictions),
	},
	"34c18e6b-c4d5-4289-9c6b-ab47fa027182": {
		name: "Claude Max 20X｜1 month",
		policy: claudePolicy(claudeMaxRestrictions),
	},
	"b17f05d4-f109-46f2-888a-6f633519d9e7": {
		name: "Plus｜1 month (official $8 tier)",
		policy: xPolicy(
			"Plus｜1 month (official $8 tier); base usage; Cursor is limited to Grok models; no Grok Bot",
		),
	},
	"091ab8e6-6c3f-48e5-be52-268bea8e87e9": {
		name: "Premium｜1 month (official $30 tier)",
		policy: xPolicy(
			"Premium｜1 month (official $30 tier); 4x Plus usage, with all SuperGrok, Cursor Pro, and X Premium+ benefits",
		),
	},
	"0c4fb0ae-f770-4957-87c7-95b5c53d42e8": {
		name: "Super｜1 month (official $100 tier)",
		policy: xPolicy(
			"Super｜1 month (official $100 tier); everything in Premium, 15x Plus usage",
		),
	},
	"f3abb17f-5c93-40c6-a8e2-ef80cdfca7d2": {
		name: "Ultra｜1 month (official $200 tier)",
		policy: xPolicy(
			"Ultra｜1 month (official $200 tier); everything in Premium, 50x Plus usage",
		),
	},
	"e8ff14e3-76a5-46e0-b6d3-1c217130bd99": {
		name: "Claude compute card｜¥50",
		policy: computePolicy("50"),
	},
	"1f30100a-84bb-4b93-a192-dc0d94aa0b9d": {
		name: "Claude compute card｜¥100",
		policy: computePolicy("100"),
	},
	"2244cfa4-fc8d-4cb3-b63c-e7cf3841c51a": {
		name: "Claude compute card｜¥200",
		policy: computePolicy("200"),
	},
	"bb584d1c-4444-4581-a2e1-5ddeab2f0f87": {
		name: "Claude compute card｜¥500",
		policy: computePolicy("500"),
	},
	"d387ff70-1566-444a-9c75-fe4934df7d47": {
		name: "US Apple ID｜Aged account (over 1 year)",
		policy: appleIdPolicy("US"),
	},
	"f77910c4-435b-482f-b656-87693852527b": {
		name: "Japan Apple ID｜Aged account (over 1 year)",
		policy: appleIdPolicy("Japan"),
	},
	"3d992ebc-cae7-4eaa-bb1c-c9a886c73d6b": {
		name: "Turkey Apple ID｜Aged account (over 1 year)",
		policy: appleIdPolicy("Turkey"),
	},
	"39d831df-4919-49a4-8896-8ccfdbd33d83": {
		name: "Gemini Pro｜18 months｜Activation link",
		policy: policy(
			"Delivered automatically after payment: a Gemini Pro activation link (no Google account included)",
			"Automatic, usually within 1 minute; use the link within 24 hours of delivery",
			"An 18-month Gemini Pro activation link; the account must have no existing subscription",
			"The link is guaranteed valid for 24 hours after delivery; a replacement is issued after verification if it is already used or expired",
			"Cannot stack with an existing subscription; unsupported regions, missing permissions, risk controls, disabled or banned accounts are not covered; the subscription's duration after activation is not guaranteed",
		),
	},
	"13336b9c-102f-4886-87bc-76397aad8936": {
		name: "Muse AI account｜1 billion tokens",
		policy: policy(
			"Delivered automatically after payment: the account email and sign-in access to that email",
			"Automatic, usually within 1 minute; view it on the order page",
			"A ready-made Muse AI account with 1 billion tokens for AI image and video generation",
			"24-hour warranty; sign in and check soon after delivery",
			"Tokens are usage credit, not a fixed number of images or minutes of video; never share the email verification code or publish the account details",
		),
	},
	"a39b3590-0952-5886-9076-a9cd879c1975": {
		name: "Codex long-term SMS number｜US｜20–30 days",
		policy: policy(
			smsDelivery,
			"Automatic; the number stays valid for about 20–30 days after you take it, as shown on the number page.",
			"A long-term US number; the warranty covers receiving the first code. You can usually try binding a 2nd and 3rd account after that, but later bindings are not covered.",
			"Covers receiving the first code; switch numbers yourself on the number page if one is blocked.",
			"Wait at least 5 minutes between two code requests; risk controls or bans from rapid repeated requests are not covered.",
		),
	},
	"25a7ae5b-f437-5461-bfca-669870e3b887": {
		name: "Codex one-time SMS number｜US｜1 use",
		policy: policy(
			smsDelivery,
			"Automatic; code speed depends on live scheduling.",
			"A US number only for the phone verification of your first Codex sign-in; each purchase can receive one code.",
			"A code that never arrives is not counted; switch numbers yourself on the number page if one cannot verify.",
			"No Google mailbox verification, other platform sign-ups, or phone-number login; no no-reason refunds after redemption or after a code is received.",
		),
	},
	"fa15cfc1-24e9-4466-b6ec-749fae177160": {
		name: "Price difference｜¥50 per unit",
		policy: policy("", "", "", "", ""),
	},
	"d0000000-0000-4000-8000-000000000002": {
		name: "Test 1 — automatic delivery",
		policy: policy(
			automatic,
			"Delivered immediately after payment confirmation; view the test content on the order page.",
			"For payment and delivery workflow testing only.",
			"Test products do not include after-sales benefits.",
			"For testing only; purchase one item per order.",
		),
	},
	"d0000000-0000-4000-8000-000000000003": {
		name: "Test 2 — fast online delivery",
		policy: policy(
			manual,
			manualDeliveryTime,
			"For payment and delivery workflow testing only.",
			"Test products do not include after-sales benefits.",
			"For testing only; purchase one item per order.",
		),
	},
};

export function localizeProduct(
	id: string,
	locale: SupportedLocale,
	fallback: ProductLocalization,
) {
	return locale === "en-US" ? (productEnglish[id] ?? fallback) : fallback;
}

export function localizeSellableItem(
	id: string,
	locale: SupportedLocale,
	fallback: SellableItemLocalization,
	fulfillmentSource?: "local" | "manual" | "supplier",
) {
	if (locale !== "en-US") return fallback;
	const localized = sellableItemEnglish[id] ?? fallback;
	if (fulfillmentSource !== "manual") return localized;
	return {
		...localized,
		policy: {
			...localized.policy,
			delivery: manual,
			deliveryTime: manualDeliveryTime,
		},
	};
}
