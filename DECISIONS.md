# Design Calendar app — decisions log

## 2026-05-20 — GS1 PA Unpacker

Question:  Where to put a tab that ingests Macy's PA (Pack Assortment)
           Excel files and produces a units-by-Style/Color/Size/Channel/Delivery
           breakdown for the design-calendar app.

Choice:    New tab `pa_unpacker` inside the existing GS1 sub-app, between
           "Packing List" and "Label Batches" in the nav. Parser and
           Excel exporter are pure TS modules under `src/gs1/services/`.
           UI is `src/gs1/panels/PAUnpackerPanel.tsx`. Runs entirely
           in-browser via SheetJS (`xlsx` / `xlsx-js-style`) — no server
           round-trip, no Supabase persistence (these files are operational
           workspace, not data of record).

Why:       PA files come from the same buyer (Macy's) as the existing
           Packing List uploads, share the BIFF .xls layout, and the
           operator workflow is "drop file → see breakdown → export
           Excel" — a one-shot operation that doesn't need persistence.
           Putting it next to "Packing List" keeps related Macy's tooling
           together. Following the same parsePackingList.ts style — pure
           function, ArrayBuffer in, structured records + verification
           checks out — keeps the codebase shape consistent.

Rejected   - A standalone page outside GS1: would orphan the tool away
alternatives from the only place operators already think about Macy's
           uploads.
           - Persisting to Supabase: PA files change weekly and the only
           downstream consumer is human eyes / the downloaded Excel.
           Adding tables, migrations, RLS, and a sync cron for one-shot
           Macy's ingest is unjustified weight.
           - Reusing the existing Packing List uploader: PA layout is
           materially different (channel cols in row 11, PPK
           composition in cols 49+, color blocks left-side, R46
           reconciliation row). Merging would balloon
           `parsePackingList.ts` and weaken its existing block-style
           detection. Two narrow parsers > one fragile shared parser.

Verification approach:
           - Unit tests in src/gs1/__tests__/paUnpackerService.test.ts:
             pure helpers + integration tests against the 4 sample files
             (auto-skipped on hosts where samples are missing).
           - Node verification harness scripts/verify-pa-unpacker.mjs
             asserts: 324 records, 16 styles, 10 combos, 0 mismatches.
           - vitest run + vite build pass.
