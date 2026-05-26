# Tangerine ERP — User Guide (P1)

The operator + accountant guide for the 6 admin panels shipped in Tangerine Phase 1: **Style Master · Vendor Master · Customer Master · Chart of Accounts · Periods · Journal Entries**. All panels live in the `/tanda` app under the **"Analytics & Admin"** sidebar group.

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

## 30-second quickstart

1. **URL:** `https://<your-domain>/tanda`
2. **Menu:** left sidebar → **Analytics & Admin** group → scroll to the 6 emoji entries (🎨 🏭 🤝 📒 🗓️ 📓)
3. **First time?** Run the smoke test in [01-getting-started.md § Quickstart smoke test](01-getting-started.md#quickstart-smoke-test-10-minutes)

## Conventions in this guide

- **`code-style`** = exact field / column / value names
- 🟢 / 🟡 / 🔴 = period status colors (open / soft_close / closed)
- "(Chunk N)" tags indicate which implementation chunk shipped the feature, for cross-referencing the architecture doc
- Mermaid diagrams render natively on GitHub; if you're viewing this in another renderer, you may see raw code blocks instead
- Screenshots in `screenshots/` show real UI state from the production deploy (PII redacted where applicable)

## Related docs

- [`../P1-foundation-architecture.md`](../P1-foundation-architecture.md) — the full architectural spec for P1 (schemas, RLS, posting service, trigger semantics). Reference when you need to understand *why* a behavior exists.
- [`../accountant-coa-request-email.md`](../accountant-coa-request-email.md) — forwardable email template asking the accountant for the canonical COA list (gates the first Chart of Accounts seeding).

## How this guide stays current

Per the project's "memorize at every chunk completion" rule (see `feedback_memorize_each_chunk.md` in memory): every future Tangerine chunk that adds or changes a UI surface MUST update the matching section of this guide in the same PR. Stale docs are a bug.

If you read something here that doesn't match what you see in the UI, please flag it — that's the chunk owner's failure to update the guide alongside the code.

## Feedback

Spotted an error in this guide? Missing a workflow? Open a Github issue against the design-calendar-app repo or DM the developer.
