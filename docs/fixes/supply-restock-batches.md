# Philippines quick-restock batches

## Failure and smallest fix

The Philippines vault rejects more than five keys per import. The supply modal
sent the entire textarea in one request and hid the error behind a generic toast.
Split PH submissions in the browser into sequential batches of five (maximum
100 keys overall). Each batch uses the existing authenticated restock endpoint,
completes both vault validation and storefront-code generation, then advances.
Do not wrap all batches in one long server request or parallelize supplier checks.
Other SKU routes are unchanged.

Show confirmed batch/import/storefront counts in the modal and page. Stop on
transport errors, rejected/quarantined keys, or incomplete storefront generation.
Disable automatic retries; the failed batch may have committed upstream. Preserve
existing duplicate-key checks, storefront fingerprints, and batch request refs.
A new submission of already-imported keys must not mint additional storefront
codes. Recovery of an uncertain batch requires authoritative inventory readback,
not an automatic replay or a blanket "generate codes" action.

D1 mutation metadata also includes trigger writes. Count freshly generated stock
rows by their new IDs instead of adding `meta.changes`; audit/replay/counter
writes are not sold goods. Integration tests compare the returned count with the
actual rows, including re-submission of the same 30 synthetic keys.

## Verification and ablation

- Regression: old one-request behavior rejects 30 keys with `input.batch_too_large`.
- Unit cases: 30 = 6 × 5; remainder; blanks; sequential operation; distinct refs;
  uncertain/partial stop; duplicates; overall limits; unchanged non-PH routes.
- D1 integration: real restock server functions, empty migrated database, synthetic
  vault, 30 actual storefront inserts, replay yields zero additional rows.
- No new queue, database table, dependency, credential, server batch endpoint,
  automatic recovery, supplier purchase, email, or production mutation.
- A full browser acceptance check and production deployment must be reported
  separately from local test results.

## Local verification

54 focused restock, authorization, client-boundary, query-plan and queue tests pass.
Typecheck, Biome, Workers and Bun builds pass. Browser checks use synthetic
transport with the real page in Chinese desktop and English dark mobile views.
The full local supplier-fulfillment suite timed out; release CI remains required.

Wait 3.3 seconds between PH batches: the shared verifier cooldown is 3.1 seconds,
and the vault only spaces calls within each individual batch. A fake-clock
regression verifies no second request before the cooldown expires.
