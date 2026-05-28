# Tangerine ERP — User Guide (P1)

The operator + accountant guide for the 6 admin panels shipped in Tangerine Phase 1: **Style Master · Vendor Master · Customer Master · Chart of Accounts · Periods · Journal Entries**. Tangerine has its own URL and top nav at **`/tangerine`** — separate from the Tanda PO WIP app.

## Who this is for

| Persona | Primary panels |
|---|---|
| **Internal operator** (CEO, ops manager, merchandiser) | 🎨 Style · 🏭 Vendor · 🤝 Customer · 🗓️ Periods (view-only) |
| **External accountant** (contractor or CPA firm) | 📒 Chart of Accounts · 🗓️ Periods (status changes) · 📓 Journal Entries |

Login is the same for both; access to the data inside each panel is gated by Row-Level Security on the underlying tables.

## Table of contents

1. [Getting started](01-getting-started.md) — how to log in, where the panels live in the menu, 10-minute smoke test
2. [Master data](02-master-data.md) — Style, Vendor, Customer Master CRUD flows
3. [Accounting](03-accounting.md) — Chart of Accounts, Periods, Journal Entries
4. [Concepts](04-concepts.md) — multi-entity, dual-basis accounting, control accounts, matrix dimensions, PII handling, audit immutability
5. [Workflows](05-workflows.md) — end-to-end recipes (initial COA setup, monthly close, manual adjustment, vendor/customer onboarding, JE reversal)
6. [Troubleshooting](06-troubleshooting.md) — error reference, recovery patterns
7. [Approvals (M27)](07-approvals.md) — P2: configure approval rules, approve / reject from the inbox
8. [Notifications (M28)](08-notifications.md) — P2: in-app inbox + email channel; preferences per (kind, channel)
9. [Documents (M29)](09-documents.md) — P2: attach files to vendors / customers; signed-URL downloads
10. [Employees (M30)](10-employees.md) — P2: HR/identity layer + v_audit_user_resolved view for display names
11. [Inventory operations (M37)](11-inventory-operations.md) — P3: read-only Inventory Transfers panel (skeleton); grows as P3-5 / P3-6 ship
12. [Mobile Scanner (M39)](12-scanner.md) — P3: back-end contract for the native scanner apps + read-only troubleshooting view
13. [Accounts Payable (M3)](13-accounts-payable.md) — P3: vendor bill lifecycle (draft → posted → paid → void), approval gate, payments ledger
14. [Payment Terms](14-payment-terms.md) — P3: structured payment terms master + `compute_due_date` helper
15. [Fabric Codes (P3 / Chunk 11)](15-fabric-codes.md) — textile-specific master + many-to-many junction to Style Master; precursor to M42 PIM. Seeded with 9 common apparel fabrics.
16. [Accounts Receivable (M4)](16-accounts-receivable.md) — **P4 COMPLETE (2026-05-27 night)** — invoices, receipts (multi-application with sibling-linked accrual+cash JEs), aging report, daily overdue cron, customer credit-limit gate, and historical backfill (Aug 2024 onward). All four AR admin panels live under **💼 Accounting** in the top-nav group dropdown.

## 30-second quickstart

1. **URL:** `https://<your-domain>/tangerine`
2. **Top nav:** 6 module buttons across the top — 🎨 Style · 🏭 Vendor · 🤝 Customer · 📒 COA · 🗓️ Periods · 📓 Journal Entries. Click any one to open that panel.
3. **Other apps:** click the **🧩 Apps ▾** button on the right of the top nav to launch Design Calendar, PO WIP, ATS, Tech Packs, GS1, Planning, or Vendor Portal.
4. **First time?** Run the smoke test in [01-getting-started.md § Quickstart smoke test](01-getting-started.md#quickstart-smoke-test-10-minutes)

## Conventions in this guide

- **`code-style`** = exact field / column / value names
- 🟢 / 🟡 / 🔴 = period status colors (open / soft_close / closed)
- "(Chunk N)" tags indicate which implementation chunk shipped the feature, for cross-referencing the architecture doc
- Mermaid diagrams render natively on GitHub; if you're viewing this in another renderer, you may see raw code blocks instead
- Screenshots in `screenshots/` show real UI state from the production deploy (PII redacted where applicable)

## Related docs

- [`../P1-foundation-architecture.md`](../P1-foundation-architecture.md) — the full architectural spec for P1 (schemas, RLS, posting service, trigger semantics). Reference when you need to understand *why* a behavior exists.
- [`../P2-cross-cutters-architecture.md`](../P2-cross-cutters-architecture.md) — P2 (Approvals · Notifications · Documents · HR/Employees) architecture pass. Implementation in progress; user-guide chapters land alongside each chunk's UI.
- [`../accountant-coa-request-email.md`](../accountant-coa-request-email.md) — forwardable email template asking the accountant for the canonical COA list (gates the first Chart of Accounts seeding).

## P2 progress

- **P2-1 + P2-2 (merged 2026-05-27):** M27 Workflow/Approvals complete — schema, library, JE posting guard, and admin UI for both rules and inbox. See chapter 7. Dormant until rules are defined.
- **P2-3 + P2-4 (merged 2026-05-27):** M28 Notifications complete — schema, dispatcher library, admin UI (inbox + preferences), and email cron worker. See chapter 8. Dormant until a downstream caller invokes `notificationsAPI.enqueue`.
- **P2-5 + P2-6 (merged 2026-05-27):** M29 Document Management complete — schema, library, reusable `DocumentAttachmentList` component embedded in Vendor + Customer Master edit modals. See chapter 9. **Operator must create the `tangerine-documents` Supabase Storage bucket once** before uploads work (see MIGRATIONS.md).
- **P2-7 + P2-8 (merged 2026-05-27):** M30 HR/Employee Master complete — schema, view, admin panel. See chapter 10. Seed inserts EB001/CEO for ROF entity.

**P2 cross-cutters phase is feature-complete pending auto-apply.** All schemas, libraries, UI panels, and reusable components have shipped. Outstanding items are operational: (a) DB password sync to unblock auto-apply on the schema migrations; (b) one-time Supabase Storage bucket creation for M29.

## How this guide stays current

Per the project's "memorize at every chunk completion" rule (see `feedback_memorize_each_chunk.md` in memory): every future Tangerine chunk that adds or changes a UI surface MUST update the matching section of this guide in the same PR. Stale docs are a bug.

If you read something here that doesn't match what you see in the UI, please flag it — that's the chunk owner's failure to update the guide alongside the code.

## Feedback

Spotted an error in this guide? Missing a workflow? Open a Github issue against the design-calendar-app repo or DM the developer.
