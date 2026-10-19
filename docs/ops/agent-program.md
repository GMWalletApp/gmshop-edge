# Agent management (GMShop → agent-shop)

`/admin/agents` is available to enabled `root` / `admin` users with the
`operations:read` permission. Mutations also require `operations:update`.
The page displays agent accounting, fee-based rebates, owner-reviewed leaderboard
rewards and pending withdrawals from the same agent-shop rules API as the agent
center. The private owner API displays our actual profit in the rebate window,
never agent retail margin, and explains every tier waiting for profit coverage.

## Server-only binding

The optional Worker secret **`AGENT_SHOP_PROGRAM_TOKEN`** authenticates calls to
`https://lsrai.shop/api/internal/reseller-program/`. It must match agent-shop's
`reseller.program.internal_api_token`. An absent secret fails closed; the token
is never returned to the browser. For Bun, the same named runtime binding is
supported. No secret value belongs in Wrangler vars, project `.env` files,
documentation, logs or source control. Provision it via the approved Agent Switch
secret workflow and the deployment's secret injection process; this PR does not
provision secrets or deploy anything.

All mutation operators are derived server-side as `gmshop:<authenticated user id>`;
opening-fee edits require a reason. The upstream audit retains old/new fee values
and the operator. Recording a withdrawal as paid requires the Alipay transaction
ID and does **not** send a transfer. Verify actual payment first.

Subsite purchase fulfillment supplies the actual order `paid_minor` amount as an
exact decimal `paidAmount`, so future rebates are capped at what was paid rather
than the current catalog price. API-only purchases do not set an opening fee.

## Verification and rollback

Run focused agent-program security/UI tests, the agent-access integration tests,
`bun run typecheck` and `bun run build`. No live payment/email/Telegram smoke test
is authorized. Revert this PR to remove the page and API calls; no GMShop database
migration is introduced. The unused Worker secret may safely remain configured.


## Approved follow-up (2026-10-18 Beijing)

Rebates count from **2026-10-19 00:00 Beijing**, or the later subsite opening,
for 90 days plus the existing seven-day retry grace. Monthly sales and the
leaderboard are unchanged. Both wholesale threshold and actual profit covering
cumulative rebates are required. The panel shows our profit, each tier's gap,
and unknown-cost/mapping order IDs; the agent-facing API exposes none of these.
The companion rebate SMTP transport has a 20-second whole-operation deadline.
Credit emails default on through no-reply@lsrai.shop, to the credited agent only;
failed sends do not block credit and are not automatically retried for that credit.

### Read-only profit endpoint

`POST /api/internal/agent-program/order-profit` requires the server-only Worker
secret **`AGENT_PROGRAM_PROFIT_TOKEN`** (also supported as a Bun binding). It must
match agent-shop's **`RESELLER_PROGRAM_PROFIT_API_TOKEN`** environment variable.
The profit URL defaults to `https://laoshirenvip.com`. Token hashes use constant-time
comparison; an unset token returns 401. No secret values are configured by this PR.

Request: `{ "downstream_order_nos": ["<local lsrai leaf order number>"] }`,
0–500 numbers per call (an empty array is a read-only health check). The read path batches within D1's parameter budget.
Response: `{ "ok": true, "orders": [...] }`; each row has
`downstream_order_no`, `supplier_api_order_id`, `shop_order_id`, decimal integer strings `revenue_minor`,
`true_cost_minor`, `profit_minor`, and `cost_known`. Responses are `no-store`.

Mapping: lsrai parent orders → optional child `orders.parent_id` →
`procurement_orders.local_order_id/local_order_no`; connection via
`connection_id → site_connections.id` identifies GMShop. Its `local_order_no`
exactly matches `supplier_api_orders.downstream_order_no`. Then
`supplier_api_orders.shop_order_id → shop_orders.id → shop_order_items.order_id`.
The caller also checks returned `supplier_api_order_id` equals its stored
`procurement_orders.upstream_order_no` (`supplier_api_orders.id`, the supplier API UUID, distinct from
`shop_orders.id`; not the local numeric external-reference ID). Duplicate downstream numbers across accounts
are ambiguous and marked unknown, rather than combining different buyers.

Revenue is `shop_orders.paid_minor` once per GMShop order (not list price).
Item cost reuses the weekly report's `itemCostSql`: the latest supplied
supplier order total (falling back to the catalog snapshot only if missing),
otherwise allocated reserved/delivered stock cost sum (falling back to the
snapshot only if absent). The snapshot fallback is unit cost × quantity;
actual totals are never multiplied by quantity again. Reuse pricing guard's
`parseCostFactors` / `realCostMinor` to apply `pricing.cost_factors` × fixed
1.01, rounding each item total up to a minor unit. Supplier identity uses fulfilled stock
`stock_entries.procurement_source`, supplemented by supplied
`supplier_orders.binding_snapshot_json.normalizedApiOrigin` for Aisou. Unknown
or mixed sources use the highest applicable factor. Missing/zero item cost,
missing items/order, ambiguous mapping or unsupported currency marks cost unknown
and returns zero as an unknown-profit sentinel; agent-shop counts that order
as a loss of its full net revenue, never as zero contribution. Known negative
profit stays negative. There are no writes,
notifications, procurement requests, or new cron jobs on this endpoint.

Agent-shop subtracts refunded platform revenue while retaining full incurred
cost. The profit contract exposes no recorded supplier-side cost recovery, so
none is assumed. Unknown-cost or unmapped counted orders contribute negative
net platform revenue. Internal agents/detail expose `unknown_profit_order_count`
and positive `unknown_profit_assumed_loss`, shown beside our profit. It resolves
all batches (including an empty health check for local-only runs) before crediting anything, and fails the entire rebate run closed on
missing token, API errors or invalid/incomplete responses. Its durable daily
owner warning uses the existing owner notification channel. The owner UI shows
null/unavailable profit honestly rather than inferring it from wholesale.

Tests use local migrated D1, SQLite, synthetic HTTP and fake mailers only.
No production data, true unmapped-order inventory, live email or online cross-site
verification was read/performed. No GMShop schema migration is added; agent-shop
adds a small daily-warning claim table through its existing AutoMigrate.
