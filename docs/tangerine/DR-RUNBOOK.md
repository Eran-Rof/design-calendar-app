# Disaster Recovery Runbook — Tangerine (prod Supabase `qcvqvxxoperiurauoxmp`)

> Established 2026-07-08 (audit remediation). Owner: operator (CEO). Review after any
> plan/infra change; drill at least **quarterly** (`npm run dr:drill`).

## Current posture (verified 2026-07-08)

| Layer | State | RPO (max data loss) |
|---|---|---|
| **PITR** (point-in-time recovery) | **ENABLED 2026-07-08**, 7-day retention ($100/mo add-on) | ~2 minutes, any point in the last 7 days |
| Daily physical backups (wal-g) | ON (automatic, ~10:54 UTC daily) | ≤ 24 h, beyond the PITR window |
| **Off-provider encrypted backup** | **ENABLED 2026-07-14** — GitHub Actions `db-backup.yml`, nightly 08:30 UTC, `pg_dump -Fc` → AES-256 → artifact (30-day). Lives on GitHub, NOT Supabase. | ≤ 24 h, survives a **provider-level** Supabase loss |
| Compute | Micro (watch: upgrade if pooler saturation appears) | — |
| Staging twin | `jrcnpfpopwjanwmzwmsc` (schema kept in sync by apply-migration.mjs) | drill target |

> **Provider-loss recovery** (Supabase account/region gone): the off-provider
> backup is the only copy that survives. Restore procedure + drill:
> `scripts/backup/restore-drill.md`; storage/RPO/RTO + encryption details:
> `scripts/backup/README.md`. Passphrase (`BACKUP_PASSPHRASE`) lives in the CEO
> password manager — without it the backups are undecryptable.

## Restore paths (in order of preference)

### A. Fat-finger / bad deploy / data corruption → PITR **restore-in-place**
⚠️ DESTRUCTIVE: replaces the whole database at the chosen instant. Steps:
1. **Freeze writers**: pause Vercel crons (comment `crons` in vercel.json + deploy, or pause the project), tell the office PC operator to skip the 21:00 fetch.
2. Supabase Dashboard → Database → Backups → **Point in Time** → pick the timestamp *just before* the incident → restore. (API equivalent: `POST /v1/projects/{ref}/database/backups/restore-pitr`.)
3. After restore: run `npm run sync-health` + `npm run audit:pos` + spot-check the trial balance; re-run any Xoro syncs for the gap window (mirror + backfill-range are idempotent).
4. Unfreeze crons. Write down what/when/why in this file's log (below).

### B. Full project loss / forensic copy → **restore to a NEW project**
Dashboard → Backups → restore to new project (choose PITR point or a daily physical backup). Then repoint `VITE_SUPABASE_URL` / keys in Vercel env + GitHub secrets. Slowest path (~hours incl. env swap) — only for total loss.

### C. Surgical (one table / a few rows)
Restore to a NEW project (path B) at the pre-incident instant, copy the affected rows back into prod via the Management API, delete the scratch project. Never PITR-in-place for a single table.

## The drill — `npm run dr:drill` (`scripts/dr-drill.mjs`)
Extracts the books (gl_accounts, journal_entries, journal_entry_lines) from prod, restores into an isolated `dr_drill_<date>` schema on staging, verifies row counts + the **debit/credit checksum to the cent**, and times it. Non-destructive.

| Date | Result | Time | Notes |
|---|---|---|---|
| 2026-07-08 | **PASS** | 11.5 s | 501 accts / 24 JEs / 85 lines; DR=CR=$547,032.58 reproduced exactly |

> The **full off-provider backup** (all public tables, not just the GL subset)
> has its own drill: `scripts/backup/restore-drill.md`. The nightly workflow
> also self-verifies every run (decrypt + `pg_restore --list`).

## Known gaps / follow-ups
- ~~**No local `pg_dump`** → full-fidelity logical dumps rely on Supabase's own backups.~~ **CLOSED 2026-07-14:** a nightly off-provider `pg_dump -Fc` now runs on GitHub Actions (`.github/workflows/db-backup.yml`), encrypted + verified, stored as an artifact off Supabase. Restore drill: `scripts/backup/restore-drill.md`. (A local operator-machine `pg_dump` is no longer required for provider-loss defence, though installing PG17 client tools is still handy for ad-hoc restore drills.)
- **Staging `DATABASE_URL` is stale** (`db.<ref>.supabase.co` no longer resolves — IPv6-only). Use the pooler hostname or the Management API query endpoint (what the drill does).
- **21:00 Xoro fetch is a single-PC dependency** (Mac launchd fallback disabled since 2026-05-11). Operator action: re-enable the Mac agent as warm standby. Sync Health alarms if a night is missed, but alarms ≠ redundancy.
- Restore-in-place has never been exercised (it is inherently destructive); rely on the dashboard flow above and rehearse path B into a scratch project once before cutover if time allows.
