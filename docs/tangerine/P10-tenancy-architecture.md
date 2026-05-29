# Tangerine P10 — Tenancy / RLS Flip Architecture Pass

Status: **DRAFT** (2026-05-28). Operator review gate before implementation chunks kick off. Auto-merges on CI green per the standing plan-approval-not-implementation rule.

Implements **M1 Tenancy v2** — flipping Tangerine from "scaffolded multi-tenant, effectively single-tenant" to **genuinely multi-tenant with demonstrable isolation**. Every M1-era scaffold (`entities`, `entity_users`, `entity_id` columns, `auth_internal_*` RLS template) is already in the database. P10's job is to turn the safety net live, prove no row leaks between entities, expose entity-switching to the operator, and seed a second sandbox entity to validate the model end-to-end.

This is the prerequisite for SaaS-readiness (P25), per-entity branding theming (P25), per-entity feature flags (P25), and — most importantly today — the auditor signal that Tangerine has demonstrable tenant isolation.

---

## 0. Scope guardrails

**In scope (this phase) — turn the multi-tenant safety net live:**

- **Second seed entity** — a sandbox/dummy entity (`SANDBOX` or operator-chosen code) alongside `ROF`, used as the negative test bed for isolation. Optional second real entity if the operator has one to bring on.
- **Entity-switching UX** — a top-bar dropdown that lets a user with multiple `entity_users` rows flip context. Single-entity users see a static badge instead.
- **Per-user default entity** — landing entity persisted in `user_preferences` (which already has `entity_id`); session-scoped override via the switcher.
- **RLS policy audit framework** — a systematic sweep over every `auth_internal_*` policy in the database, plus a test harness that proves user A on entity A cannot see entity B's data.
- **Per-entity GL chart of accounts** — confirm and harden that COA is already entity-scoped (it is, per P1 `gl_accounts (entity_id, code) UNIQUE`). Add operator-visible "Copy COA from ROF" tooling for new entities.
- **Per-entity period close** — confirm `gl_periods` is entity-scoped (it is). Close ceremony runs per entity independently.
- **Report scoping** — every existing report (Trial Balance, IS, BS, CF, AR Aging, AP Aging, Sales Comps, etc.) explicitly carries the current entity in its filter ribbon and result header. No silent cross-entity aggregation.
- **Cross-entity admin role** — the operator (and the future accountant) gets `entity_users` rows on every entity they administer; the switcher carries them between contexts. One login, multi-entity role table.
- **Per-entity sequence partitioning** — invoice numbers, JE numbers, PO numbers all already include `entity_id` in their UNIQUE constraints. P10 audits + documents the pattern; no schema change for existing tables.
- **`entity_access_audit`** — a denial log capturing every RLS-rejected attempt + every cross-entity switch. Auditor evidence and bug-finder.
- **Backfill `DEFAULT rof_entity_id()`** — extend the PR #463 pattern to the remaining ~11 entity-scoped tables that still don't have the default.
- **Migration / rollout plan** — feature-flag the dropdown until §2 D1 lands, ship as `hidden when only one entity_users row` so day-1 single-entity operators see no UX change.

**Explicitly OUT of scope (deferred to P25 SaaS-readiness):**

- **Per-entity billing / Stripe customer per entity** — P25.
- **Per-entity branding theming live** — `entity_branding` table already exists; wiring it into the runtime UI (logo swap, color theme, custom domain) is P25.
- **Per-entity feature flags** — turn a module on/off per entity. P25.
- **Per-entity Vercel deployment** — subdomain routing, per-entity Vercel env vars. P25.
- **Vendor portal multi-entity** — vendor users already use `entity_vendors` for isolation. Their portal stays as-is; P10 audits but does not extend.
- **Cross-entity reporting / consolidated trial balance** — useful for a future holding-co view, but P10 keeps every report single-entity. Consolidated reporting is M44 Multi-Entity Consol (P25-ish).
- **Per-entity sub-domains** (e.g. `rof.tangerine.app`, `sandbox.tangerine.app`) — P25 SaaS phase.
- **Cross-entity FK enforcement at DB level** — e.g. forbidding a `customers.parent_company_id` that crosses entities. Documented as a code/UI convention in P10; a hard DB CHECK lands when a real cross-entity violation surfaces.
- **Re-keying existing data** — every existing row stays at `entity_id = rof_entity_id()`. No backfill to "split" historical ROF data onto a second entity.

---

## 1. Existing state (one-paragraph map)

After P1-P8 + T10 Shadow Mirror, Tangerine has the full multi-tenant scaffold: `entities` table (with `code`, branding columns, GL-defaults columns), `entity_users` junction, every transactional table has a `NOT NULL entity_id` FK, and every entity-scoped business table carries the canonical 4-policy RLS template (`anon_all_*` for the internal SPA via anon key, `auth_internal_*` scoped via `entity_users`, plus vendor variants where applicable). PR #463 (2026-05-21) added `DEFAULT rof_entity_id()` to `tanda_pos` + `po_line_items`; ~11 other entity-scoped tables still need the default and rely on the caller to supply `entity_id` explicitly. The T3 OAuth provisioning handler at [`api/_handlers/internal/auth/provision.js`](../../api/_handlers/internal/auth/provision.js) auto-creates an `entity_users (auth_id, entity_id=ROF, role='admin')` row on first Microsoft-OAuth sign-in, which is why every signed-in user today bypasses entity_id filtering — they're all on the only entity. Cross-entity leakage is theoretically impossible today simply because there's no second entity to leak to. P10 changes that.

---

## 2. Decisions (DRAFT — operator to confirm)

| # | Decision | Recommendation | Why | Operator confirm? |
|---|---|---|---|---|
| D1 | Number of entities at v1 cutover | **2: `ROF` (existing) + `SANDBOX` (new seed) — sandbox is a dummy with synthetic COA, no real transactions** | Sandbox is the negative test bed for isolation — proves user A on ROF cannot see user B on SANDBOX. A real second business can come anytime after; the schema doesn't care. Avoids forcing a real second-company decision into a technical phase. | ☐ |
| D2 | Entity-switching UX | **Top-bar dropdown next to the user menu — visible only when the signed-in user has ≥2 `entity_users` rows; single-entity users see a static `[ROF]` badge** | Subdomain routing (`rof.tangerine.app`) is heavyweight and forces DNS / Vercel work; URL query (`/tangerine?entity=xyz`) breaks bookmarks. Dropdown is the cheapest reversible primitive and matches QuickBooks / Xero / NetSuite mental model. | ☐ |
| D3 | User-entity binding | **Per-user `default_entity_id` persisted in `user_preferences`; session-scoped override via the switcher, stored in `sessionStorage` (cleared on tab close)** | `user_preferences` already has `entity_id` + `key` — extend the existing row pattern. Session override means switching for a quick lookup doesn't permanently rebind the user; permanent rebind is "Set as default" in the switcher menu. | ☐ |
| D4 | Existing-data handling | **Leave existing rows at `entity_id = rof_entity_id()`. No backfill, no split, no re-key. Every historical row is ROF's history.** | Splitting ROF historical data onto two entities is an accounting fiction with no operational meaning. Existing rows are ROF's. New rows created while switched to SANDBOX get SANDBOX's `entity_id` via the `DEFAULT rof_entity_id()` → `DEFAULT current_entity_id()` swap below. | ☐ |
| D5 | RLS policy audit tooling | **Three-pronged: (a) a SQL one-liner that lists every `pg_policy` against an entity-scoped table and flags any that doesn't reference `entity_id` in `qual` or `with_check`; (b) a test harness creating 2 entities + 2 users, walking every read endpoint, asserting cross-entity reads return 0 rows; (c) a CI gate that fails the build if a new migration adds an entity-scoped table without the canonical 4-policy template** | The SQL probe is the auditor's smoking-gun report. The test harness is the operator's confidence. The CI gate prevents regression. All three together = demonstrable isolation. | ☐ |
| D6 | Cross-entity admin role | **One login per human; `entity_users` carries N rows (one per entity admin'd) with potentially different `role` per row. The switcher honors role-per-entity (admin on ROF, readonly on SANDBOX is supported).** | Forcing operator to maintain two logins for ROF + SANDBOX is hostile UX and creates two MFA setups. The `entity_users` shape already supports multi-row per auth_id; we just need to honor role-per-entity in the role-check helpers (currently they pick the first row). | ☐ |
| D7 | Per-entity GL chart of accounts | **Each entity has its own COA. Schema already enforces this via `gl_accounts (entity_id, code) UNIQUE`. Add a "Copy COA from ROF" wizard in the Stores → New Entity flow that clones every active ROF COA row into the new entity's namespace.** | Two entities can have different COAs (different industries, different reporting needs). Copy-from-ROF is the bootstrap shortcut; operator can edit after. No shared-COA escape hatch — the auditor wants per-entity ledgers, not partitions of one ledger. | ☐ |
| D8 | Per-entity period close | **Independent close per entity. `gl_periods (entity_id, fiscal_year, period_number) UNIQUE` already enforces the partition. The Close panel (P5-1) already accepts `entity_id`; the switcher passes the current entity through.** | A holding-co master close that propagates to subsidiaries is a real-accounting feature (intercompany eliminations etc.), but that's M44 Consol territory (P25). For two unrelated entities, independent close is correct. | ☐ |
| D9 | Report entity scope | **Every existing report shows the **current entity only** in v1. The result header reads `Trial Balance — ROF — May 2026`. Cross-entity / consolidated views are deferred to M44 (P25).** | Silent aggregation across entities is the worst auditor smell — it produces numbers nobody can tie back. Explicit single-entity is the safe default. Consolidated views need intercompany elimination logic, which is its own phase. | ☐ |
| D10 | Migration / rollout plan | **3-stage flip: (a) ship schema + audit framework + dropdown component hidden behind `is_multi_entity` user-pref flag (default off); (b) operator self-toggles for personal testing on SANDBOX; (c) flip flag default to on once §2 D1 lands and parallel-test passes. No big-bang.** | Standard feature-flag rollout. Operator keeps day-to-day workflow unchanged until SANDBOX is ready to receive a test transaction. Lets us ship in pieces without the dropdown surprising the operator mid-workday. | ☐ |
| D11 | T6 global search entity scope | **Search is entity-scoped by default; admin users see an optional "Search all entities" toggle in the palette that surfaces results with an `[ENTITY:CODE]` prefix badge** | T6 indexes `entity_id`; the default search filter already respects RLS. The admin escape hatch is for "where is this PO?" cross-entity lookups during operator-led debug. Non-admin users never see the toggle. | ☐ |
| D12 | T4 favorites + home_route scope | **Per-(user, entity). The same operator can have ROF-favorites and SANDBOX-favorites; switching entities swaps the favorites bar. `user_preferences (user_id, entity_id, key)` already supports this — no migration.** | A favorited ROF panel makes no sense on SANDBOX where the panel might not even have data. Per-entity scoping respects the mental model of "I'm in a different company now." Slight UX cost: rebuilding favorites in a new entity, but that's correct. | ☐ |

---

## 3. Schema deltas

### 3.1 `user_preferences` — extension

```sql
ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS default_entity_id uuid REFERENCES entities(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_user_preferences_default_entity
  ON user_preferences (default_entity_id)
  WHERE default_entity_id IS NOT NULL;
```

The existing `entity_id` column on `user_preferences` is the per-(user, entity) scoping key for prefs like favorites + home_route (already entity-scoped per D12). The new `default_entity_id` is per-user (across entities) and answers "where do I land after sign-in?". Stored on the user's "global" prefs row (entity_id = the default — yes, slightly recursive, but the bootstrap is: on first login, set both to the user's only entity_users row).

### 3.2 `entity_users` — `is_default` deprecated in favor of `user_preferences.default_entity_id`

Considered an `is_default` flag on `entity_users` (with a partial unique index `WHERE is_default = true` per auth_id). Rejected: `user_preferences.default_entity_id` is the right home — preferences live in preferences, not in role rows. `entity_users` stays role-only.

### 3.3 `entity_access_audit` — new (denial log + switch log)

```sql
CREATE TABLE IF NOT EXISTS entity_access_audit (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_id       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  attempted_entity_id uuid REFERENCES entities(id) ON DELETE SET NULL,
  granted_entity_id uuid REFERENCES entities(id) ON DELETE SET NULL,
  event_kind    text NOT NULL CHECK (event_kind IN (
                  'rls_deny','switch','sign_in_default','admin_override'
                )),
  endpoint      text,              -- '/api/internal/ar/invoices' etc.
  request_id    text,
  ip_address    text,
  user_agent    text,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_entity_access_audit_auth ON entity_access_audit (auth_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entity_access_audit_deny ON entity_access_audit (event_kind, created_at DESC)
  WHERE event_kind = 'rls_deny';
```

Filled by:
- **`rls_deny`** — written by the API dispatcher when a query returns 0 rows under RLS but the same query under service-role returns >0. Cheap canary check on read endpoints; not enabled by default in v1 (it doubles read cost) — flag-gated for audit windows.
- **`switch`** — every entity-switcher event, even no-op refreshes. The auditor's evidence trail.
- **`sign_in_default`** — first request post-sign-in, recording which entity the user landed on.
- **`admin_override`** — operator using the "Search all entities" toggle (D11) or any future cross-entity admin gesture.

### 3.4 `current_entity_id()` helper — new SECURITY DEFINER

Companion to `rof_entity_id()`. Returns the current request's effective entity_id, resolved from JWT claim → falls back to user's `default_entity_id` → falls back to `rof_entity_id()` for backwards compat.

```sql
CREATE OR REPLACE FUNCTION current_entity_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim.entity_id', true), '')::uuid,
    (SELECT default_entity_id FROM user_preferences WHERE user_id = auth.uid() AND default_entity_id IS NOT NULL LIMIT 1),
    rof_entity_id()
  );
$$;
```

The internal SPA passes the current entity in a custom `x-tangerine-entity` header that the API dispatcher translates into a per-request `SET LOCAL request.jwt.claim.entity_id = ...` so this helper sees it. Anon-key writes (which today bypass RLS) still resolve to ROF unless an explicit value is supplied — preserving today's behavior for unauthenticated edge cases.

### 3.5 `DEFAULT current_entity_id()` swap — the remaining ~11 entity-scoped tables

PR #463 added `DEFAULT rof_entity_id()` to `tanda_pos` + `po_line_items`. P10 swaps those to `DEFAULT current_entity_id()` (which falls back to ROF) and extends the same default to the other entity-scoped tables that today require the caller to supply `entity_id` explicitly. Exact list resolved from the audit framework below; expected candidates from a CURRENT-SCHEMA scan:

```
ar_invoices, ar_invoice_lines, ar_receipts, ar_receipt_applications,
invoices, invoice_line_items, invoice_payments,
gl_accounts, gl_periods, journal_entries, journal_entry_lines,
bank_accounts, bank_transactions,
inventory_layers, inventory_consumption, inventory_adjustments,
cycle_counts, cycle_count_lines, transfers,
customers, employees, fabric_codes, style_fabric_codes, …
```

Pattern (one migration per logical group):

```sql
ALTER TABLE ar_invoices ALTER COLUMN entity_id SET DEFAULT current_entity_id();
ALTER TABLE ar_invoice_lines ALTER COLUMN entity_id SET DEFAULT current_entity_id();
-- …
```

### 3.6 No per-entity sequence number tables needed

Invoice / JE / PO numbers already partition by `entity_id` in their UNIQUE constraints. The sequence generators (e.g. `ar_invoices.invoice_number`) read MAX per-entity, so two entities can independently use `INV-0001` without collision. No new table needed; P10 documents the pattern and adds a CI assertion that any new numbered table follows it.

### 3.7 `entities.is_sandbox` — new flag

```sql
ALTER TABLE entities
  ADD COLUMN IF NOT EXISTS is_sandbox boolean NOT NULL DEFAULT false;
```

Sandbox entities (a) are excluded from production reports unless explicitly opted in via the report filter, (b) get a distinct visual badge in the switcher (yellow stripe), (c) can be wiped/reseeded by an admin gesture without touching production entities. `SANDBOX` seed row gets `is_sandbox=true`; `ROF` stays `false`.

---

## 4. RLS policy audit framework

The point of P10 is **demonstrable** isolation, not just "we believe it's isolated." Three artifacts, all shipped as code in chunk P10-2:

### 4.1 SQL probe — `audit/list_non_entity_policies.sql`

```sql
-- Every policy on an entity-scoped table where the qual or with_check
-- does NOT reference entity_id. Should return 0 rows post-P10.
WITH entity_scoped_tables AS (
  SELECT c.table_name
  FROM information_schema.columns c
  WHERE c.column_name = 'entity_id'
    AND c.table_schema = 'public'
)
SELECT
  p.tablename,
  p.policyname,
  p.cmd,
  p.roles,
  p.qual,
  p.with_check
FROM pg_policies p
JOIN entity_scoped_tables est ON est.table_name = p.tablename
WHERE p.policyname LIKE 'auth_internal_%'
  AND COALESCE(p.qual, '') NOT LIKE '%entity_id%'
  AND COALESCE(p.with_check, '') NOT LIKE '%entity_id%';
```

The auditor runs this; non-zero rows = bug. Also gated in CI via the same query against the staging DB.

### 4.2 Test harness — `scripts/p10-audit/cross-entity-leak-test.mjs`

Creates two test entities (`AUDIT_A`, `AUDIT_B`), two test users, walks every internal read endpoint, asserts each user sees only their entity's rows. Specifically:

1. Bootstrap: insert 50 test rows on each entity across every entity-scoped table.
2. For user A (`entity_users` on `AUDIT_A` only): hit every `GET /api/internal/*` endpoint, assert returned `entity_id` is always `AUDIT_A`.
3. For user A: attempt to query AUDIT_B rows via service-role + header injection — assert RLS rejects.
4. Symmetric for user B.
5. Teardown: delete test entities (cascades clean up).

Run in CI on every PR that touches a migration. Run manually before any P10 chunk ships.

### 4.3 CI gate — `scripts/p10-audit/policy-template-check.mjs`

Parses every new migration in a PR. For each `CREATE TABLE` that has an `entity_id` column, asserts the migration also contains the canonical 4-policy template (`anon_all_<table>`, `auth_internal_<table>`, plus vendor variants where applicable). Fails the PR check if missing. Prevents regression where a new module forgets RLS.

### 4.4 Missing `DEFAULT current_entity_id()` audit

Companion probe — lists every entity-scoped table whose `entity_id` column has no default:

```sql
SELECT c.table_name
FROM information_schema.columns c
WHERE c.column_name = 'entity_id'
  AND c.table_schema = 'public'
  AND c.column_default IS NULL
ORDER BY c.table_name;
```

Output drives the §3.5 backfill migrations.

---

## 5. UI changes

### 5.1 Top-bar entity switcher

- Component: `<EntitySwitcher>` (new, in `src/tanda/components/`).
- Visible when `entity_users` for the current user has ≥2 rows; otherwise collapsed to a read-only `[ROF]` badge.
- Renders entity `code` + small `is_sandbox` yellow stripe if applicable.
- Click opens menu: list of entities (with role badge), "Set current as default" toggle, "Search all entities" admin toggle (D11).
- Persists current selection in `sessionStorage` under `tangerine.current_entity_id`.

### 5.2 Switch-entity confirmation modal

When the operator clicks a different entity while a form has unsaved changes, modal warns: "You have unsaved changes on the ROF [Customers] panel. Switching entities will discard them. Continue?" — standard dirty-form pattern. Auto-save modules skip the modal.

### 5.3 Per-entity branding swap

P10 wires the header logo + display name only (full theming is P25). On entity switch:
- Header logo swaps to `entity_branding.logo_url` (fallback to default Tangerine logo).
- Page title gets entity name suffix: `Tangerine — ROF` vs `Tangerine — SANDBOX`.
- No color theme swap in v1.

### 5.4 List view titles + report headers

Every list panel title gets a `— <entity_code>` suffix: `Customers — ROF`, `AR Invoices — SANDBOX`. Every report's result header and PDF export carries the entity name. Implemented via a single `<EntityScopedHeader>` helper that reads the current entity from context.

### 5.5 Global search palette (T6)

- Default search results scoped to current entity.
- Admin users see a "Search all entities" toggle; results get an `[ENTITY:CODE]` prefix badge.
- Non-admin users never see the toggle even via DOM hack — the toggle is rendered only when role-check passes.

### 5.6 Favorites bar (T4)

Reads `user_preferences (user_id, entity_id=current_entity, key='favorites')`. Switching entities swaps the favorites bar instantly. No data migration — empty favorites on a new entity is correct.

---

## 6. Implementation chunks

| Chunk | Title | Scope | Depends on |
|---|---|---|---|
| **P10-1** | Schema deltas + `current_entity_id()` helper + `entity_access_audit` table + `entities.is_sandbox` flag + SANDBOX seed | One migration: extends `user_preferences`, creates `entity_access_audit`, creates `current_entity_id()`, seeds `SANDBOX` entity row | — |
| **P10-2** | RLS audit framework — SQL probes + test harness + CI gates | `scripts/p10-audit/*.mjs`, `audit/list_non_entity_policies.sql`, GitHub Action wiring | P10-1 |
| **P10-3** | `DEFAULT current_entity_id()` backfill on the remaining ~11 entity-scoped tables | One migration per table group, idempotent | P10-1 + P10-2 (audit produces the list) |
| **P10-4** | API dispatcher entity-header support — `x-tangerine-entity` → `SET LOCAL request.jwt.claim.entity_id` per-request | `api/_lib/withEntityContext.js` wrapper; applied to every internal handler | P10-1 |
| **P10-5** | `<EntitySwitcher>` component + sessionStorage wiring + dirty-form modal + per-entity favorites/home_route swap | New UI component + integration into top-bar layout + Zustand store updates | P10-4 |
| **P10-6** | Per-entity COA "Copy from ROF" wizard + Entity admin panel (create, edit, deactivate entities) | `src/tanda/InternalEntitiesAdmin.tsx` + RPC `entity_clone_coa(p_from_entity_id, p_to_entity_id)` | P10-3 |
| **P10-7** | Report scoping audit — every existing report (Trial Balance, IS, BS, CF, AR Aging, AP Aging, Sales Comps, ATS, etc.) explicitly filters on current entity + result header shows entity | Sweep across all report panels; mostly title-only changes since queries already use `entity_id` from RLS | P10-4 |
| **P10-8** | T6 global search "Search all entities" admin toggle + result entity badges | `src/tanda/SearchPalette.tsx` extensions | P10-4 + T6 already shipped |
| **P10-9** | User guide chapter on multi-entity + auditor evidence packet template + cross-cutter wiring (notifications on `rls_deny` events, etc.) + memory close-out | Doc + notification rule seeds + final memory update | All above |

Parallel waves:
- **Wave A (after operator confirms §2):** P10-1.
- **Wave B:** P10-2 + P10-4 simultaneously.
- **Wave C:** P10-3 + P10-5 simultaneously (P10-3 is schema-only, P10-5 is UI-only, no cross-contamination).
- **Wave D:** P10-6 + P10-7 + P10-8 simultaneously.
- **Wave E:** P10-9.

Estimated **~3-4 weeks of build** + **~2 weeks of audit / parallel test** with the test harness running every night against staging. Most of the work is sweep-style (find every report, find every panel, add the entity header) rather than novel design — the heavy thinking is concentrated in P10-1's `current_entity_id()` helper and P10-2's audit framework.

---

## 7. Risks + mitigations

| Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|
| Cross-entity data leak (a policy misses `entity_id` check) | **Critical** | Medium pre-audit, Low post-audit | The §4 audit framework — SQL probe + test harness + CI gate — exists specifically to catch this. Auditor receives the probe output as evidence. |
| Performance regression from adding `entity_id` to every query | Low | Low | Every entity-scoped table already has an `entity_id` index (P1 mandated). Adding an `entity_id` filter to an indexed query is near-free; in single-entity-per-user workloads, the planner often picks the index anyway. We benchmark before/after on the heaviest endpoints (ATS, Sales Comps, Trial Balance). |
| Operator confused mid-task by switching entities | Medium | Medium | Dirty-form modal (§5.2) + autosave where possible + clear top-bar visual cue (entity code always visible + sandbox stripe). |
| Existing reports that silently aggregated across entities now show only one entity | Medium | Low (only one entity exists today) | Explicit single-entity is the auditor-correct default. Any operator-discovered case of "I want the old view back" → consolidated reporting is M44 (P25). |
| Cross-entity FKs — e.g. `customers.parent_company_id` spanning entities | Medium | Low | Documented as a code/UI convention: parent_company picker filters to current entity. No DB CHECK in v1 (operator may legitimately want a holding-co customer to roll up subsidiaries later); flag for P25 M44. |
| `current_entity_id()` returns wrong entity due to JWT claim caching | High | Low | `current_setting('request.jwt.claim.entity_id', true)` is per-transaction, not cached. `SET LOCAL` ensures cleanup at txn end. Test harness verifies. |
| Anon-key writes from internal SPA bypass entity context | Medium | Medium | Today's internal SPA uses the anon key, which means RLS is bypassed entirely (the `anon_all_*` policy is permissive). P10 keeps this for now — the entity_id is supplied by the application layer (via `current_entity_id()` default). Phasing out anon-key for internal use is P25 SaaS work. |
| SANDBOX accidentally polluted into production reports | Medium | Low | `entities.is_sandbox` flag + every report filter has a default "exclude sandbox entities" toggle (default on). Hard to turn off accidentally. |
| First-time multi-entity user gets stuck without a default | Low | Low | Sign-in flow checks `user_preferences.default_entity_id`; if NULL, sets to the user's first `entity_users` row. Audited via the `sign_in_default` event in `entity_access_audit`. |

---

## 8. Tests

- **Cross-entity leak harness (the big one)** — §4.2. Two entities, two users, every read endpoint walked. Asserts zero leakage. Run nightly + in CI.
- **Switcher behavior** — single-entity user sees no switcher; multi-entity user sees dropdown; clicking switches; sessionStorage persists; logout clears.
- **Dirty-form modal** — switching entities mid-edit warns; confirmation discards; cancel preserves form state.
- **Default entity resolution** — first-login picks the user's only entity; second-login honors `user_preferences.default_entity_id`; manual override via switcher persists in session only unless "Set as default" clicked.
- **COA clone** — `entity_clone_coa(ROF, AUDIT_A)` produces a row-by-row identical COA on AUDIT_A; existing rows not clobbered if AUDIT_A already has codes.
- **Period close per entity** — closing ROF's May 2026 does not close SANDBOX's; close attempts on the wrong entity require explicit switch.
- **Report headers** — every report includes entity name in its header, PDF export footer, CSV export filename.
- **`entity_access_audit`** — switch events logged; `rls_deny` canary fires when enabled; admin override logged.
- **Performance** — heaviest endpoints (ATS, Sales Comps, Trial Balance) benchmarked before/after; regression threshold = +10ms p95.

---

## 9. References

- [`docs/tangerine/P1-foundation-architecture.md`](./P1-foundation-architecture.md) §3 M1 Tenancy — original tenancy design, RLS template, `entity_users` schema, propagation strategy.
- [`docs/tangerine/CURRENT-SCHEMA.md`](./CURRENT-SCHEMA.md) — `entities`, `entity_branding`, `entity_users`, `user_preferences` current shapes (lines 882-930, 3011-3015).
- [`supabase/migrations/20260528000000_tanda_entity_id_default_fix.sql`](../../supabase/migrations/20260528000000_tanda_entity_id_default_fix.sql) — PR #463 establishing the `rof_entity_id()` helper + `DEFAULT` pattern that P10 extends.
- [`api/_handlers/internal/auth/provision.js`](../../api/_handlers/internal/auth/provision.js) — T3 auto-provisioning handler that currently hard-codes the ROF entity_users insert; P10-4 extends this to honor the user's `default_entity_id`.
- [`docs/tangerine/T4-personalization-architecture.md`](./T4-personalization-architecture.md) — favorites + home_route already entity-scoped via `user_preferences (user_id, entity_id, key)`.
- [`docs/tangerine/T6-global-search-architecture.md`](./T6-global-search-architecture.md) — FTS index includes `entity_id`; P10-8 adds the admin "search all entities" toggle.
- [`docs/tangerine/P11-shopify-architecture.md`](./P11-shopify-architecture.md) — every Shopify table carries `entity_id`; P10 isolation guarantees apply automatically once policies are in place.
- [`docs/tangerine/P9-parallel-run-architecture.md`](./P9-parallel-run-architecture.md) §0 — explicitly defers tenancy flip to P10 (this doc).
- Canonical 4-policy RLS template — search any P3+ migration for `auth_internal_` (example: [`supabase/migrations/20260527110000_p3_chunk11_fabric_codes.sql`](../../supabase/migrations/20260527110000_p3_chunk11_fabric_codes.sql) lines 69-72 and 122-125).

---

## 10. Realistic ETA

**3-4 weeks of build** (P10-1 through P10-9 with parallel waves) + **2 weeks of audit window** (test harness nightly + manual operator validation on SANDBOX) before flipping the dropdown default to on. Total **5-6 calendar weeks** from operator confirmation of §2.

The build is straightforward — the schema is already mostly in place, the RLS template is well-established, and most UI work is sweep-style. The 2-week audit window is the gate: every report walked manually on both ROF and SANDBOX, every cross-entity leak test green for 14 consecutive nights, every operator-facing module visually verified to show the right entity badge. That's the auditor's evidence packet.

If a second real entity (not just SANDBOX) lands during P10, add ~1 week for COA / period / branding setup per entity. Mechanical work, no new architecture.

---

## 11. Operator confirm before chunks ship

Please mark §2 D1-D12 with answers (or push back). Once confirmed I'll kick off P10-1 (Wave A).

**Pre-P10-1 prep work the operator can do in parallel:**
- Decide on the second entity's `code` (sandbox `SANDBOX`? real second company code?).
- Decide on the second entity's `name` (display name shown in switcher + reports).
- If a real second entity is coming, identify the fiscal year start month + COA preferences (or "just copy ROF's COA and we'll edit").

**Post-P10 follow-ons (deferred):**
- P25 SaaS-readiness — per-entity billing, full branding theming, per-entity feature flags, sub-domain routing, per-entity Vercel env vars.
- M44 Multi-Entity Consol — consolidated trial balance, intercompany eliminations, parent-subsidiary reporting.
- Vendor portal multi-entity audit — extend the same RLS template review to vendor-facing tables; currently P10 audits internal-side only.

**Vercel env vars to add before P10-1 ships:** none. P10 is pure schema + UI + RLS; no new secrets.
