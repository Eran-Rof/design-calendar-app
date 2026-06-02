# Tangerine P10-8 — Financial reports entity-scoping audit

**Scope.** Walked every financial-report handler under `api/_handlers/internal/`
to verify each respects the per-entity boundary established by P10-1 schema
work and the P10-5 entity switcher (`X-Entity-ID` header on every internal
call). Findings + patches below; every patched report now resolves
`entity_id` through `resolveReportEntityId(admin, req)` — honoring the header
and falling back to ROF for legacy callers.

## Audit table

| Report | Handler | Pre-P10-8 behavior | Verdict | Fix |
|---|---|---|---|---|
| Trial Balance | `api/_handlers/internal/trial-balance/index.js` | `resolveDefaultEntityId(admin)` → always ROF | GAP — silently aggregates only ROF regardless of which entity the switcher selected | Added `resolveReportEntityId(admin, req)` reading `X-Entity-ID`, fallback to ROF |
| Income Statement | `api/_handlers/internal/income-statement/index.js` | Same hardcoded ROF | GAP | Same patch |
| Balance Sheet | `api/_handlers/internal/balance-sheet/index.js` | Same hardcoded ROF | GAP | Same patch |
| Cash Flow | `api/_handlers/internal/cash-flow/index.js` | Same hardcoded ROF | GAP | Same patch |
| GL Detail | `api/_handlers/internal/gl-detail/index.js` | Loads by `account_id` (UUID PK), intrinsically entity-scoped via `gl_accounts (entity_id, code) UNIQUE` | OK at the RPC layer, but no defense-in-depth check against header mismatch | Added `verifyAccountEntity(admin, accountId, req)` — refuses 403 when `X-Entity-ID` disagrees with `gl_accounts.entity_id` |

## Why the gap mattered

The P10-5 switcher attaches `X-Entity-ID` to every `/api/internal/**` call via
`src/utils/internalApiAuth.ts`. Without P10-8 the four core financial
statements ignored the header and computed against ROF only — a SANDBOX
operator opening **Trial Balance** would have seen ROF numbers under the
SANDBOX banner, which is the textbook auditor-smell described in D9: "silent
aggregation across entities is the worst kind."

GL Detail was already correct at the data layer (`account_id` is a UUID PK
under the per-entity COA partition, so the RPC could never return rows from
the wrong entity). The added `verifyAccountEntity` check is belt-and-
suspenders: it stops a stale UI bookmark from drilling into a foreign
entity's account by accident — better to 403 explicitly than to render
ambiguous numbers.

## Resolver shape

Each patched handler exports its own `resolveReportEntityId(admin, req)`
helper (no shared utility — keeps each handler self-contained, matches the
pattern P10-5 set in entity-switch.js). The lookup is:

1. Read `X-Entity-ID` from request headers (case-insensitive).
2. If present, verify the entity exists by primary key. Hit → return.
3. Else fall back to `resolveDefaultEntityId` (lookup by `code='ROF'`).
4. Else 500 — only fires if the entities table is empty.

The handlers continue to pass `p_entity_id` into each report RPC
(`trial_balance`, `income_statement`, `balance_sheet_as_of`,
`cash_flow_indirect`) — those RPCs were already entity-scoped from P5; the
gap was purely in which entity_id the handler chose to forward.

## Tests

`api/_lib/__tests__/p10-8-reports-entity-scoping.test.js` covers, for each
of the four patched handlers + GL Detail:

- header-present → returns the header's entity_id
- header-absent → falls back to ROF
- malformed/missing entity → 500 fallback
- header pointing at a non-existent entity → falls through to ROF (not a
  hard 400; the fallback is friendlier than a flat reject)
- (GL Detail) header mismatch → 403 with explicit error
- (GL Detail) header absent → permissive (legacy clients unaffected)

15 assertions across the suite.

## What was deliberately NOT changed

- **Sales / spend / vendor reports** (`reports/spend.js`, `reports/vendors.js`)
  are aggregations over `payments` and `vendors`, which P10 has not yet
  partitioned to a per-entity model (T10 mirror tables remain shared in
  v1). These will be revisited in the M44 Consol phase (P25).
- **AR/AP aging** (`ar-aging`, `ap-aging`) already filter by entity_id via
  their existing query builders — confirmed at audit time, no patch.
- **Trial balance row sorting** stays string-compare-by-code; entity_id is
  uniform within a single response, so the sort is unaffected.

## Verdict

All five reports now correctly entity-scope. The P10-5 switcher's
`X-Entity-ID` injection now flows end-to-end. Audit closed.
