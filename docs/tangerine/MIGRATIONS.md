# Tangerine — applying migrations

The Tangerine P1 build adds 18 migrations under `supabase/migrations/`. These do NOT auto-apply on Vercel deploys. They have to be run against the Supabase project explicitly.

## Two paths

### Option A — Supabase dashboard (one-shot, simplest)

1. Open the Supabase dashboard for the project that backs your Vercel deploy.
2. Navigate to **SQL Editor → New query**.
3. Paste the entire contents of [`apply-all-p1-migrations.sql`](apply-all-p1-migrations.sql).
4. Click **Run**.
5. Watch the Results panel for `NOTICE` messages — they confirm row counts (e.g. "Tangerine 4.5: flipped 247 item rows to is_apparel=true").
6. Refresh `https://design-calendar-app.vercel.app/tangerine`. All 6 panels should now load.

The bundle is idempotent (uses `IF NOT EXISTS`, `DROP IF EXISTS`, `COALESCE`, `ON CONFLICT DO NOTHING` throughout). Re-running it is safe — already-applied chunks no-op.

### Option B — Supabase CLI (preferred for ongoing work)

```bash
npm install -g supabase           # one-time
supabase login                    # one-time, opens browser
supabase link --project-ref <ref> # one-time per project
supabase db push                  # applies any new migrations in supabase/migrations/
```

Run `supabase db push` after every Tangerine PR merges. Tracks applied migrations in `supabase_migrations.schema_migrations` so it never double-applies.

## What the 18 migrations do

| # | File | Adds / changes |
|---|---|---|
| 1 | `20260521010000_p1_entities_extensions.sql` | `entities` table: code, currency, fiscal_year, basis, lock, country, metadata cols |
| 2 | `20260521010100_p1_entity_users.sql` | New `entity_users` junction (auth.users ↔ entities) |
| 3 | `20260521010200_p1_entity_id_propagation.sql` | Adds `entity_id` to 13 transactional + master tables; backfills to ROF |
| 4 | `20260521010300_p1_rls_entity_scope.sql` | Canonical `auth_internal_*` RLS policies on all 13 |
| 5 | `20260521020000_p1_gl_accounts.sql` | `gl_accounts` (COA) table |
| 6 | `20260521020100_p1_gl_periods.sql` | `gl_periods` + 120-row bootstrap (FY 2021–2030 × 12) |
| 7 | `20260521020200_p1_journal_entries.sql` | `journal_entries` + lines + triggers (balance/period/control/postable/immutability) |
| 8 | `20260521020300_p1_gl_subledger_balances_view.sql` | Read-only balance aggregation view |
| 9 | `20260521020400_p1_gl_rls.sql` | GL RLS + closed-period trigger |
| 10 | `20260521030000_p1_gl_post_rpc.sql` | `gl_post_journal_entry` + `gl_link_sibling_je` RPCs |
| 11 | `20260521040000_p1_style_master.sql` | `style_master` table + backfill |
| 12 | `20260521040100_p1_ip_item_master_matrix.sql` | 5 matrix dim cols on `ip_item_master` + style_id FK + style_code sync trigger |
| 13 | `20260521040200_p1_category_3level.sql` | 3-level taxonomy on `ip_category_master` |
| 14 | `20260522010000_p1_chunk4_5_apparel_check.sql` | Bottoms-heuristic backfill + `apparel_dims_required` CHECK |
| 15 | `20260522020000_p1_vendors_erp_extensions.sql` | `vendors` ERP cols: code, tax_id, payment_terms, GL FKs, status, address, etc |
| 16 | `20260522020100_p1_entity_vendors_code.sql` | Per-entity `vendor_code` override |
| 17 | `20260522020200_p1_customers_promotion.sql` | RENAME `ip_customer_master` → `customers` + ERP cols + view alias |
| 18 | `20260526010000_p1_t1fix_ensure_rof_entity.sql` | T1-fix: defensive ROF code assignment |

## How to know which migrations are already applied

Run this in Supabase dashboard:

```sql
-- Check each chunk's signature column/table/view
SELECT
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='entities' AND column_name='code')      AS chunk1_entities,
  EXISTS (SELECT 1 FROM information_schema.tables  WHERE table_name='entity_users')                          AS chunk1_entity_users,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='invoices' AND column_name='entity_id') AS chunk1_propagation,
  EXISTS (SELECT 1 FROM information_schema.tables  WHERE table_name='gl_accounts')                          AS chunk2_gl_accounts,
  EXISTS (SELECT 1 FROM information_schema.tables  WHERE table_name='gl_periods')                           AS chunk2_gl_periods,
  EXISTS (SELECT 1 FROM information_schema.tables  WHERE table_name='journal_entries')                      AS chunk2_journal_entries,
  EXISTS (SELECT 1 FROM information_schema.routines WHERE routine_name='gl_post_journal_entry')             AS chunk3_post_rpc,
  EXISTS (SELECT 1 FROM information_schema.tables  WHERE table_name='style_master')                         AS chunk4_style_master,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='ip_item_master' AND column_name='inseam') AS chunk4_matrix,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='vendors' AND column_name='code')       AS chunk6_vendors,
  EXISTS (SELECT 1 FROM information_schema.tables  WHERE table_name='customers')                            AS chunk6_customers,
  EXISTS (SELECT 1 FROM entities WHERE code='ROF')                                                          AS t1fix_rof_exists;
```

Every column should return `true`. If any returns `false`, that chunk's migrations haven't applied — run the bundle.

## Going forward

For P2+ chunks, append the same workflow: every new migration in `supabase/migrations/` needs to be applied either via Option A (paste new files into dashboard) or Option B (`supabase db push`). The Option B path is strongly recommended — it tracks state automatically.

A future improvement (not yet built) is a GitHub Action that runs `supabase db push` on every merge to `main`, eliminating the manual step entirely.
