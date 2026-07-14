# Restore drill — off-provider encrypted backup

Exact, copy-pasteable steps to prove (or perform) a restore from a
`db-backup-*` artifact produced by `.github/workflows/db-backup.yml`.

The nightly workflow already runs a **cheap** integrity check every run
(decrypt + `pg_restore --list`). This drill is the **full** rehearsal: it
actually restores the data into a scratch database and verifies it. Run it
**at least quarterly** (alongside `npm run dr:drill`, which covers the GL
subset via the Management API) and after any change to the backup workflow.

## Prerequisites

- `pg_restore` / `pg_dump` **v17** (server is PostgreSQL 17.x). On macOS:
  `brew install postgresql@17`. On Debian/Ubuntu: PGDG `postgresql-client-17`.
- `openssl` (any modern build with `-pbkdf2`).
- The **`BACKUP_PASSPHRASE`** value (from the CEO password manager — it is a
  GitHub secret and cannot be read back out of GitHub).
- A **scratch** Postgres to restore into. Options:
  - A local Docker Postgres: `docker run -d --name pg17 -e POSTGRES_PASSWORD=pw -p 5433:5432 postgres:17`
  - A throwaway Supabase project (Dashboard → New project), or the staging
    project `jrcnpfpopwjanwmzwmsc`. **Never restore into prod.**

## 1. Download the latest encrypted backup

```bash
# List recent backup runs and grab the newest artifact.
gh run list --workflow "Off-provider DB backup" --limit 5
gh run download <run-id> --name "db-backup-<STAMP>" --dir ./_restore
cd ./_restore
ls -lh   # tangerine-qcvqvxxoperiurauoxmp-<STAMP>.dump.enc
```

## 2. Decrypt

```bash
export BACKUP_PASSPHRASE='...'   # from the password manager
ENC=tangerine-qcvqvxxoperiurauoxmp-<STAMP>.dump.enc
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -in "$ENC" -out backup.dump -pass env:BACKUP_PASSPHRASE
```

If this fails with `bad decrypt`, the passphrase is wrong — there is no
recovery path other than the correct passphrase. This is why the passphrase
must live in the password manager, not only in GitHub.

## 3. Verify the archive is well-formed (no DB needed)

```bash
pg_restore --list backup.dump | head -40
pg_restore --list backup.dump | grep -c 'TABLE DATA'   # expect the full ERP (>=50)
```

## 4. Restore into the scratch DB

```bash
# Example against the local Docker Postgres from the prereqs:
export SCRATCH="postgresql://postgres:pw@localhost:5433/postgres"

# Fresh target schema. --no-owner --no-privileges drops role/grant references
# (anon/authenticated/service_role) that only exist inside a real Supabase
# project, so the restore lands cleanly into plain Postgres.
pg_restore --verbose --no-owner --no-privileges \
  --clean --if-exists \
  --dbname "$SCRATCH" backup.dump
```

Non-fatal warnings about missing roles / extensions are expected in a plain
Postgres target and do **not** mean the data failed to load. Add
`--exit-on-error` only when restoring into a real Supabase project (where the
roles exist) and you want a hard stop on any error.

## 5. Verify the data

```bash
psql "$SCRATCH" -c "select count(*) from public.journal_entry_lines;"
psql "$SCRATCH" -c "select coalesce(sum(debit),0)::numeric(18,2) dr,
                           coalesce(sum(credit),0)::numeric(18,2) cr
                    from public.journal_entry_lines;"
# dr must equal cr (the books balance), and both must match the value in
# docs/tangerine/DR-RUNBOOK.md's drill log / a fresh prod probe.
psql "$SCRATCH" -c "select count(*) from public.gl_accounts;"
psql "$SCRATCH" -c "select count(*) from public.ip_item_master;"
```

## 6. Tear down

```bash
docker rm -f pg17     # or drop the throwaway Supabase project
cd .. && rm -rf ./_restore
```

## Full production recovery (provider-loss scenario)

If Supabase itself is gone (the reason this backup exists):

1. Create a **new** Supabase project (any region). Note its ref + DB password.
2. Decrypt (step 2) the most recent good artifact.
3. Restore into the new project with `--no-owner --no-privileges` against its
   session-pooler connection string (Dashboard → Settings → Database).
4. Re-apply migrations if any post-dated the backup:
   `supabase db push --linked` (grants/policies re-assert cleanly).
5. Repoint Vercel env + GitHub secrets (`VITE_SUPABASE_URL`, anon/service keys,
   `SUPABASE_PROJECT_REF`, `SUPABASE_DB_PASSWORD`) at the new project.
6. Update `POOLER_HOST` in `.github/workflows/db-backup.yml` (or set the
   `SUPABASE_DB_URL` secret) to the new project's region.

Record every real restore in the DR-RUNBOOK log.
