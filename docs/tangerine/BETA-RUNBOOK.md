# Beta Runbook — running beta users on PRODUCTION safely

> Operator guide for the beta-guardrails feature (3 chunks): **A** — the beta
> window (`beta_config`) + automatic tagging registry (`beta_created_docs`) +
> ZZ-BETA master records; **B** — the restricted `beta` RBAC role; **C** — the
> **Beta Data** admin screen (Admin group) with the window toggle, tagged-doc
> review, and the safe cleanup engine.
>
> The premise: beta users work on the LIVE production database. These guardrails
> make that survivable — everything they create is tagged while the window is
> open, they can never post or void, and after the beta the tagged rows are
> reviewed and removed through a guarded engine that refuses anything that has
> entered the books.

---

## Before the beta (pre-flight)

1. **Record a PITR restore point.** Supabase dashboard → project → Database →
   Backups / Point-in-time. Note the timestamp; after you start the window,
   `beta_config.started_at` is the canonical reference — record both together
   (they should be within minutes of each other). PITR is the disaster lever
   only; normal cleanup goes through the Beta Data screen.
2. **Assign the `beta` role** to each beta user in **Admin → User Access**
   (pick the user, set Role = `beta`). The role is read/write/export
   everywhere and **never post/void** — a beta user cannot put anything into
   the GL. Do NOT hand out admin or accountant to beta users.
3. **Verify `RBAC_MODE=enforce`** is set in the Vercel production environment
   (it has been live since 2026-07-08 — just confirm nobody flipped it). With
   enforcement off, the `beta` role's post/void denial is not applied.
4. **Verify the ZZ-BETA masters exist** (chunk A seeds them): the ZZ-BETA
   customer/vendor/style sandbox records beta users should transact against.
   Steer beta users toward them in your kickoff notes.
5. **Start the window**: Admin → **Beta Data** → *Start beta window* (add a
   note describing the cohort). Starting flips `beta_config.active`; from that
   moment the AFTER-INSERT triggers tag every new document/master row into
   `beta_created_docs` automatically, with the creating user and timestamp.

## During the beta

- **Tagging is automatic.** No operator action needed; the registry fills as
  beta users create documents (whoever creates them — the window is global,
  which is also why real staff work during the window shows up in the registry;
  that is expected and is what the review step is for).
- **Spot-check weekly** in Admin → Beta Data: the summary shows per-table
  totals; the outstanding table shows each tagged doc with a LIVE dry-run
  eligibility verdict. Nothing on this screen writes anything until you run a
  cleanup.
- If a beta user reports a 403 on post/void — that is the design, not a bug.

## Ending the beta

1. Admin → Beta Data → **End beta window**. Tagging stops; the registry keeps
   everything already tagged.
2. **Review the outstanding list.** Every row carries a verdict:
   - `deletable` — safe to remove (unposted, unpaid, unreferenced).
   - `refused` — with the reason (`posted — reverse instead`, `has payments`,
     `has receipts`, `has shipments/allocations`, `still referenced (…)`,
     `protected table`). Refused rows are never touched.
   - `already gone` — the row was deleted by other means; cleanup just marks
     the registry entry.
3. **Run the cleanup** on reviewed selections (checkboxes → *Clean up
   selected* → confirm modal lists exactly what will delete vs refuse). The
   engine re-checks every row against live data at delete time, deletes
   children-first (only the doc's own lines table), and stamps
   `cleaned_at`/`cleanup_note` on the registry. Per-row outcomes are shown
   after the run.
4. **Posted test documents get REVERSED, not deleted.** Anything the engine
   refuses as `posted — reverse instead` goes through the normal
   reversal/void flow in its own module, with a reason (T11 requires one on
   every posting/void). The GL history stays intact — that is the point.
5. **ZZ-BETA masters STAY.** They are permanent sandbox fixtures for the next
   beta round; do not delete them (they will typically refuse anyway as
   `still referenced` once documents have touched them).
6. When the outstanding list is empty (or everything left is intentionally
   kept), the beta is closed. Keep the registry rows — `cleaned_at` +
   `cleanup_note` are the audit trail of what was removed, by whom, when.

## What the cleanup engine will NEVER do

- Delete a posted document (AR/AP invoice, receipt, payment, JE) — refuse.
- Delete a paid/applied document — refuse.
- Delete a PO with receipts or an SO with shipments/allocations — refuse.
- Touch `journal_entry_lines`, any `gl_*` table, any `*_ledger` table,
  `xoro_gl_mirror`, `row_changes`, or the beta tables themselves — refuse.
- Cascade beyond a document's own lines table — anything else still
  referencing a row makes the database refuse the delete (surfaced as
  `still referenced (<constraint>)`).
- Bulk SQL. Every delete is a per-row operation through the normal service
  path, so audit triggers fire normally.

## Code map

- Window + registry (chunk A): `beta_config`, `beta_created_docs` + tagging
  triggers; ZZ-BETA seed.
- `beta` role (chunk B): RBAC seed — read/write/export everywhere, no
  post/void anywhere; not granted `beta_data`.
- Screen: `src/tanda/InternalBetaData.tsx` (Admin → Beta Data).
- API: `api/_handlers/internal/beta-data/index.js`
  (`GET` review payload; `POST` `start_window` / `end_window` / `cleanup`).
- Engine: `api/_lib/betaData.js` (pure verdicts unit-tested in
  `api/_lib/__tests__/betaData.test.js`).
- Migration (chunk C): `supabase/migrations/20266100000000_beta_data_module_and_cleanup_cols.sql`
  (registry cleanup columns + `beta_data` module_key — admin-only via the
  admin-derivation view).
- User guide: `docs/tangerine/user-guide/24-user-access-rbac.md` (Beta section).
