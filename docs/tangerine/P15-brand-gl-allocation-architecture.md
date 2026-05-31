# Tangerine — Brand-Allocated GL Accounts + Allocation Engine (architecture)

**Phase:** P15 Brand Master extension (new module — **M50 GL Brand Allocation**, added to the roadmap per CEO 2026-05-31).
**Status:** Architecture only — **awaiting CEO sign-off before schema.** Per `feedback-plan-first-then-architecture`, this doc is the deliverable.
**Supersedes:** the earlier C4 "operator hands over a brand-specific expense-account list + we flip brand_id NOT NULL" plan. Brand attribution on the P&L is now **account-driven + allocation-driven**, controlled by the operator per-account in the COA UI — no list needed.

---

## 0. The idea in one paragraph

A P&L account (revenue, COGS, returns, expense) can be associated with one or more **brands**. When **>1 brand** is selected on an account, an **allocation window** opens to set a **% split across those brands (must total 100%)**. The account then has **brand-child accounts** (`6000-ROF`, `6000-PT`, …); a posting to the parent is **auto-split** into brand lines by the allocation %. The split is **editable per-JE** at entry time. Income Statements render each split account as a **header → brand children → subtotal**. Single-brand accounts just post to that brand. Default brand for any posting is **ROF (Wholesale)**.

This *is* the **GL cost-allocation engine** (directly-attributable when one brand; %-allocated when shared) — integrated at the account level.

---

## 1. Confirmed decisions (CEO 2026-05-31)

1. **Scope:** ALL P&L accounts (revenue, COGS, returns, expenses) can be brand-tagged + split.
2. **Parent stays postable + requires allocation.** Multi-brand accounts carry an allocation rule; you enter against the parent, the engine splits to children.
3. **Allocation by %**, set in a window on GL creation when >1 brand is chosen; **editable**; **always totals 100%**.
4. **JE-entry override:** users can adjust the allocation for a specific entry.
5. **Brand children:** suffix the code + append the brand to the name — `6000-PT` / "Marketing — Psycho Tuna".
6. **Income-statement presentation:** `6000 — Marketing` header → brand children rows → `6000 — Marketing Total` subtotal.
7. **Default brand = ROF Wholesale** (brand ROF, channel Wholesale).
8. **Cost-allocation module → added to the roadmap** (this doc = its architecture).
9. **General UX pattern:** every selection control should let the user **mark a choice as default** (the brand default = ROF Wholesale is the first instance). Tracked as a small cross-cutter (§7), not a blocker here.

---

## 2. Schema

```
brand_account_allocations
  account_id     uuid  FK gl_accounts(id)        -- the PARENT P&L account
  brand_id       uuid  FK brand_master(id)
  pct            numeric(7,4) NOT NULL           -- 0–100; SUM per account = 100
  is_default     boolean NOT NULL DEFAULT false  -- the default brand for this acct
  PRIMARY KEY (account_id, brand_id)
  -- CHECK: enforced in app + a deferred trigger asserting SUM(pct)=100 per account
```

- **Brand-child accounts** live in the existing `gl_accounts` table: `parent_account_id` FK (new nullable col) + `brand_id` (new nullable col) + code `{parent.code}-{BRAND}` + name `{parent.name} — {Brand Name}`. `is_postable` already exists (or add it): children postable, multi-brand parent becomes a **roll-up** for *reporting* but still the **entry point** for posting (the engine redirects).
- A single-brand account: one allocation row at 100%, one child (or the account itself carries the brand).
- `gl_accounts` gets `brand_rollup boolean` (true on a parent that splits) so reports know to render header/subtotal.

## 3. Posting / allocation engine

When a JE (or AR/AP/expense posting) targets a **brand-rollup parent**:
1. Look up its `brand_account_allocations` (or the **per-JE override** if supplied).
2. Expand the one input line of amount `A` into N lines: for each brand `b`, amount = `round(A × pct_b)`, posted to child `{code}-{b}`, tagged `brand_id = b`. **Penny-rounding residual** goes to the largest-share brand so the split foots to `A` exactly.
3. Each generated line also carries `brand_id` (consistent with the C1 dimension + C3 reports).

Single-brand account → one line to that brand's child, `brand_id` set. No window.

**Per-JE override:** the JE entry UI shows the account's default allocation and lets the user edit the %s for *that* entry (still must total 100). Override is stored on the JE line set (e.g. `je_line_allocation` snapshot) so the entry is reproducible/audited.

## 4. COA UI (InternalCOA / account create+edit)

- **Brand multi-select** on each P&L account (uses `<SearchableSelect>` multi / checkbox list; defaults to **ROF Wholesale**, markable default per §7).
- Selecting **>1 brand** opens the **Allocation editor**: a % field per selected brand, live "must total 100%" validation, **editable**, with an "even split" quick button.
- On save: upsert `brand_account_allocations`, generate/retire brand-child `gl_accounts`, set `brand_rollup`.
- Retiring a brand from an account is **soft** (children with history aren't deleted; flagged inactive) — GL history is immutable.

## 5. Income Statement presentation

For each brand-rollup parent: render a **group** — `CODE — Name` header, one row per brand child (its period balance), then `CODE — Name Total` subtotal (sum of children). Non-split accounts render as today. Brand-filtered IS (C4) shows only the selected brand's child rows + a single total.

## 6. Balance Sheet (unchanged, confirmed)

BS + Cash Flow stay **consolidated (all brands)**; equity/retained-earnings = the **combined income of all brands' P&Ls**. No brand-split on the BS — assets/liabilities aren't brand-allocated.

## 7. Cross-cutter: "mark as default" on selections

A small reusable pattern so any dropdown/multi-select can flag a default choice (brand default = ROF Wholesale is instance #1). Likely a thin extension of `<SearchableSelect>` + a per-key `user_preferences`/master `is_default` convention. Scoped in its own pass; the brand default ships with this module.

## 8. Rollout chunks

1. **A — schema:** `brand_account_allocations`, `gl_accounts.parent_account_id/brand_id/brand_rollup`, allocation-sum trigger, seed ROF-Wholesale default.
2. **B — COA UI:** brand multi-select + allocation % editor + child-account generation.
3. **C — posting engine:** allocated-account line expansion (+ penny-rounding) in the JE/AP/AR posting services, gated; per-JE override.
4. **D — Income Statement:** header/children/subtotal rendering + brand-filtered variant (this completes C4's P&L side).
5. **E — defaults cross-cutter** (§7), if not folded into B.

Each chunk = one PR, gated/inert where it changes posting behavior (no live double-posting until switched on).

## 9. Open items for sign-off

1. **Penny-rounding** residual → largest-share brand (proposed) — OK?
2. **Existing balances** on a newly-split account: leave historical postings on the parent (consolidated) and only split NEW postings going forward? (Proposed — no retro-split of posted history.)
3. **AR/AP interplay:** revenue/COGS on AR invoices already carry `brand_id` (single brand per invoice line). Do invoice-driven P&L postings use the **invoice's brand directly** (bypassing the account allocation), and the allocation rule applies only to **manually-posted / shared** entries (rent, G&A)? (Proposed — invoice brand wins when known; allocation rule is the fallback for shared costs.)
4. **Account code collisions:** `{code}-{BRAND}` must be unique — confirm the brand-code suffix set (ROF/PT/DEPARTED/FORTKNOX/BLUERISE/AXECROWN/MPLEPIC/MPLSUNSTONE/PL/ROHM) is fine in account numbers.
