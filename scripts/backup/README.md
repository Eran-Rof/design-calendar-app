# Off-provider database backups

Nightly **encrypted, off-provider** logical backups of the prod Supabase
Postgres (`qcvqvxxoperiurauoxmp`). This closes the audit gap flagged in
`docs/tangerine/DR-RUNBOOK.md`: every existing copy (PITR, wal-g physical
backups) lives **inside Supabase**, so a provider-level loss (account, region,
billing) would take all of them at once. This backup lives on GitHub —
different vendor, different blast radius.

> This **complements** Supabase PITR; it does not replace it. PITR is the fast
> path for fat-fingers and bad deploys (~2-minute RPO). This is the insurance
> policy for losing Supabase entirely.

## What runs

`.github/workflows/db-backup.yml` — a scheduled GitHub Actions workflow.

- **When:** nightly `30 8 * * *` (08:30 UTC), after the overnight Xoro fetch +
  recon crons. Also `workflow_dispatch` for on-demand runs.
- **Steps:** `pg_dump -Fc` (public schema) → `openssl` AES-256-CBC (pbkdf2,
  200k iters) encrypt → **verify** (decrypt + `pg_restore --list`, fail if
  unreadable or < 50 table-data sections) → upload artifact → on failure, loud
  `::error::` + best-effort `app_errors(source='cron')` breadcrumb.

## What's backed up

The **`public`** schema in full: every table + data, views, functions/RPCs,
and RLS policies. That is the entire ERP business dataset (GL, AR/AP,
inventory, POs/SOs, planning, masters).

Not included (by design): Supabase-managed schemas (`auth`, `storage`,
`vault`, `realtime`). Those are the platform's responsibility and covered by
Supabase's own backups; app sign-in is Azure SSO, not Supabase auth, so no
business data lives there.

## Where it's stored & retention

**GitHub Actions artifacts**, 30-day retention (tunable via the
`workflow_dispatch` `retention_days` input, or edit the default in the YAML).

**Storage math (measured 2026-07-14):** prod is 5383 MB total (3753 MB heap +
1080 MB indexes). `pg_dump -Fc` excludes indexes and compresses the heap; the
first live run produced a **~346 MiB** encrypted dump (421 table-data
sections, verified). At 30 daily copies that is ~10 GB of Actions storage —
comfortably within a paid GitHub plan. Lower `retention_days` for a smaller
footprint. (Dumps will grow with the dataset; ~346 MiB is the 2026-07 baseline.)

**Retention/prune:** artifact retention handles pruning automatically — GitHub
deletes each artifact when it ages past the retention window. No cron to
maintain.

**Upgrade path (longer / indefinite retention, true 3rd-party object store):**
add an offload step to Cloudflare R2 or Backblaze B2 (both S3-compatible, egress
cheap) after the verify step — e.g. `aws s3 cp "$ENC" s3://tangerine-backups/`
with an `R2_*`/`B2_*` secret set and a bucket lifecycle rule for retention.
Recommended before go-live if regulatory retention > 30 days is required. Left
as a documented follow-up so the shipped baseline stays dependency-free.

## Encryption

Symmetric **AES-256-CBC** with a PBKDF2-derived key (200k iterations, random
salt per file) via `openssl enc`. The passphrase is the GitHub secret
`BACKUP_PASSPHRASE`.

⚠️ **`BACKUP_PASSPHRASE` is the ONLY decryption key.** If it is lost, every
backup is permanently unrecoverable. It must be stored in the CEO password
manager as well as in GitHub secrets (a GitHub secret is write-only — you
cannot read it back).

## How to restore

See **`restore-drill.md`** in this folder — decrypt → `pg_restore --list`
verify → restore into a scratch DB, plus the full provider-loss recovery
procedure.

## Secrets the workflow uses

| Secret | Status | Purpose |
|---|---|---|
| `SUPABASE_DB_PASSWORD` | already set | prod DB password (shared with DB-push workflow) |
| `SUPABASE_PROJECT_REF` | already set | builds the session-pooler connection |
| `BACKUP_PASSPHRASE` | **required** | encryption / recovery key |
| `SUPABASE_DB_URL` | optional | full connection-string override (wins over the constructed pooler URL; use if the project changes region/host) |
| `SUPABASE_SERVICE_ROLE_KEY` | optional | enables the `app_errors` failure breadcrumb; absent → step skipped, run still fails loudly |

The connection uses the **session-mode Supavisor pooler**
(`aws-1-us-west-1.pooler.supabase.com:5432`, user `postgres.<ref>`) because
GitHub runners are IPv4-only and the direct `db.<ref>.supabase.co` host is
IPv6-only. Transaction mode (6543) cannot run `pg_dump`.

## RPO / RTO

| | This off-provider backup | Supabase PITR (existing) |
|---|---|---|
| **RPO** (max data loss) | ≤ 24 h (nightly) | ~2 min, last 7 days |
| **RTO** (time to restore) | ~1–3 h (new project + restore + env repoint) | minutes (in-place) / ~hours (new project) |
| **Blast radius** | GitHub (independent) | Supabase only |
| **Best for** | provider-level loss | fat-finger / bad deploy / corruption |

Use PITR first for anything short of losing Supabase itself; use this when
PITR is unavailable because the provider is the thing that failed.
