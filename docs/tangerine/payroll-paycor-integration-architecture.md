# Tangerine — Payroll: Paycor Integration (M51)

**Module:** M51 Payroll Integration (Paycor adapter). **Added to the roadmap 2026-05-31**, replacing the old "full payroll (build in-house)" stretch item.
**Status:** Architecture only — **awaiting prerequisites (Paycor API/GL-export access) + GL-mapping decisions before code.** Per `feedback-plan-first-then-architecture`, this doc is the deliverable.

---

## 0. Decision

**Do NOT build payroll in-house. Integrate Paycor.** Paycor remains the **system of record** for payroll calculation, tax withholding, multi-state **e-filing**, deposits (EFTPS/state), W-2/W-3, and compliance. Tangerine's job is narrow and accounting-only:

1. **Post each Paycor payroll run to the GL** (wages, employer taxes, withholdings, net pay) — dual-basis.
2. **Reconcile** the payroll bank draw against the posted entry (M8 bank recon).
3. **(Optional) Allocate labor cost by brand** via the M50 allocation engine.

This is the **~1–2 phase** path (vs ~8–10 in-house). It offloads all filing liability to Paycor.

Built behind a **thin `PayrollProvider` interface** with **Paycor as the first concrete adapter** (same pattern as the generic card-processor interface — keeps a future provider swap cheap). Every posting is **`source='paycor'`** (source-tagging rule) and a **manual payroll JE** is always available (manual-fallback rule).

---

## 1. Scope

**In:** pull/import each run's payroll register → map to GL → post a dual-basis JE; employee mapping (Tangerine M30 `employees` ↔ Paycor employee IDs); bank-draw reconciliation; optional brand/department labor allocation; source-tagging; manual fallback.

**Out (Paycor owns):** gross-to-net calc, W-4/withholding, federal + state + local tax, SUI/SDI, e-filing (941/940/W-2/state), tax deposits, pay stubs, direct deposit, garnishment admin.

## 2. Integration mechanism — confirm with Paycor first

Two viable paths; the right one depends on **what your Paycor plan exposes** (this is prerequisite #1):

- **A — Paycor GL export (recommended if available).** Configure the **pay-code → GL-account mapping inside Paycor**; Paycor emits a **per-run GL journal** (file via SFTP, or report/API). Tangerine imports + posts it. Paycor maintains the mapping; least code; least drift.
- **B — Paycor API pull.** If your plan includes API access, pull the payroll register per run and map pay codes → GL in Tangerine. More control, more mapping logic on our side.

> ⚠️ **Paycor API / GL-export access is usually a plan-tier / partner-program gate.** First step is confirming which (A or B) your Paycor subscription allows, and getting credentials (API key/OAuth, or SFTP).

## 3. The payroll journal → Tangerine GL (dual-basis)

A standard run posts (signs shown as DR/CR):

| Side | Account (new payroll accounts to seed) |
|---|---|
| DR | **6xxx Wages & Salaries Expense** (gross) |
| DR | **6xxx Employer Payroll Tax Expense** (employer SS/Medicare, FUTA, SUTA) |
| DR | **6xxx Employer Benefits Expense** (employer-paid benefits) |
| CR | **2xxx Employee Withholding Payable** (FIT, FICA-EE, state/local IT) |
| CR | **2xxx Employer Payroll Tax Payable** |
| CR | **2xxx Benefit / Deduction / Garnishment Payable** |
| CR | **1xxx Net Pay Clearing / Cash** (net pay + the tax/benefit remittances Paycor drafts) |

- **Dual-basis:** accrual JE on the run/pay-period date; cash-basis recognition when Paycor actually drafts the bank (per the M2 dual-basis rule — produce both journals).
- Paycor typically drafts **one combined ACH** (net pay + taxes); the **Net Pay Clearing** account zeroes out when the bank draw reconciles (M8).
- **New GL accounts** (expense + liability) get seeded when chunk 1 builds.

## 4. Brand / labor allocation (M50 tie-in)

Wages/payroll expense accounts can carry an **M50 brand allocation** — e.g., warehouse payroll split across brands by %, or by department→brand mapping. So labor cost flows into per-brand P&L automatically. (Requires M50 chunks B–C.) Optional; not required for the core GL posting.

## 5. Phasing (M51 — 2 chunks, slots after P25 but small enough to pull earlier)

1. **M51-1 — GL posting.** `PayrollProvider` interface + Paycor adapter (import/pull a run), pay-code→GL map, dual-basis JE post, `source='paycor'` tag, payroll GL-account seed, manual-fallback JE entry, bank-draw reconciliation hook.
2. **M51-2 — employee sync + labor allocation + automation.** Map M30 employees ↔ Paycor; brand/department labor allocation via M50; scheduled/auto-pull per run; a payroll register/preview panel.

## 6. Prerequisites / decisions before any code

1. **Paycor access:** does your plan expose **GL export** (path A) or the **API** (path B)? Get the credentials (API key/OAuth or SFTP). *(blocking)*
2. **Pay-code → GL mapping:** the list of Paycor pay/deduction/tax codes and which Tangerine GL accounts each maps to (or configure it in Paycor for path A).
3. **Net-pay account:** dedicated **Net Pay Clearing** account vs post straight to operating Cash.
4. **Labor allocation:** do you want payroll brand-allocated (via M50) on day one, or just consolidated wages first?
5. **Frequency/entities:** pay schedules + whether all employees are under the ROF entity.
