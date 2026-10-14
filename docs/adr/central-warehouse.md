# Central catalog and warehouse

## Decision

GMShop Edge is the only catalog, sellable-inventory, wholesale-price, and order authority. `lsrai.shop` consumes the signed Supplier API through one `gmshop-edge` adapter. The redemption Worker remains a narrow vault for encrypted 86 keys, customer-code leases, and activation status.

## Ownership

| Data | Authority |
|---|---|
| Product names, descriptions, media, SKU structure | GMShop Edge |
| Agent purchase price and export allowlist | GMShop Edge Supplier API settings |
| Agent and subsite markup/visibility | `lsrai.shop` |
| Direct sellable inventory and delivered customer codes | GMShop Edge |
| Raw 86 keys, validation, leases, activation attempts | redemption Worker |

Only explicit `supplier_export_listings.enabled = 1` entries are exported. Test products stay disabled. The downstream sync reuses the existing mapping and markup system; no second catalog service is introduced.

## 86 flow

1. The owner opens **86 Redemption Inventory** in GMShop admin.
2. **Quick restock** sends raw upstream keys directly from the authenticated server function to the redemption Worker. Responses contain counts only.
3. **Generate sellable codes** requests an idempotent code batch from the redemption Worker and inserts encrypted `CDK + redemption URL` delivery entries into the chosen existing GMShop SKU. The stored host does not matter: storefront orders are shown `https://redeem.laoshirenvip.com` and supplier-API (reseller) orders `https://redeem.lsrai.shop`, decided per order when content is revealed, emailed or returned (`src/features/redeem-warehouse/redeem-host.ts`).
4. Main-store and Supplier API orders allocate those central stock entries atomically.
5. The customer redeems the issued code; the redemption Worker leases a matching 86 key only when the customer starts redemption.

## Ablation

Removed after implementation:

- configurable redemption-service URLs; the server uses the single owned direct origin;
- a redundant redemption `/products` endpoint; aggregate inventory already carries the seven SKU definitions;
- automatic export of every local-stock product; export is now explicit and the test product remains private;
- callbacks in the first `lsrai.shop` integration; order polling is sufficient and avoids another public trust boundary;
- a new catalog or warehouse database; existing GMShop catalog and stock tables remain authoritative;
- a second admin login; all central controls use existing GMShop RBAC and audit logs.

Retained because removal breaks a required invariant:

- redemption D1 separation, which limits exposure of raw upstream keys;
- idempotent batch-code issuance and replay receipts;
- the thin `gmshop-edge` protocol adapter and persistent UUID-to-local-ID registry;
- explicit export prices, since the main-store retail price is not the agent purchase price.

## Acceptance

- typecheck, formatter/linter, unit, integration, Worker and Bun builds pass;
- empty-D1 migrations pass;
- admin GUI is verified in both locales and at desktop/mobile widths;
- read-only catalog sync produces no duplicate live products;
- one owned synthetic order proves idempotency and delivery formatting;
- production completion still requires one real paid agent order and one real 86 redemption, each with downstream order, central deduction, delivery, and customer-visible readback.
