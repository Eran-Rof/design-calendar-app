-- ════════════════════════════════════════════════════════════════════════════
-- #1758 service_role statement_timeout 8s → 60s (month-close checks died cold)
--
-- CEO hit "close_run_auto_checks failed: canceling statement due to statement
-- timeout" running the Aug-2024 close checks. Diagnosis (prod, 2026-07-14):
--   • close_run_auto_checks takes ~0.66s WARM but ~18s COLD — the first
--     heavyweight read of the day pulls the full mirror-scale ledger
--     (695k journal_entry_lines + indexes) from disk. Query plans are fine
--     (AR tie 0.85s, gl_balanced 0.51s warm); this is buffer-cache, not a
--     missing index.
--   • The API path runs via PostgREST as service_role, which had NO explicit
--     statement_timeout → it inherited authenticator's 8s. 18s cold > 8s → kill.
--
-- Fix: give service_role (server-side only — the key never reaches a browser;
-- anon stays 3s, authenticated stays 8s) a 60s ceiling. PostgREST applies the
-- impersonated role's settings per-request, so this takes effect immediately
-- for /api/internal handlers. This also protects the other intentionally
-- heavyweight accounting RPCs (gl_post_year_end_close, recon views, tie-outs)
-- from the same cold-cache death. Vercel-side run-checks.js already allows
-- maxDuration 60.
--
-- Idempotent: ALTER ROLE ... SET overwrites.
-- ════════════════════════════════════════════════════════════════════════════
ALTER ROLE service_role SET statement_timeout = '60s';

NOTIFY pgrst, 'reload config';
