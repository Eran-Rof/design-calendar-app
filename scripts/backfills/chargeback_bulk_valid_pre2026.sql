-- Bulk sign-off of pre-2026 factor chargebacks -- EXECUTED on prod 07/20/2026.
--
-- CEO directive (07/20/2026): accounting including the factor accounts is fully
-- reconciled through 2025, so every still-open chargeback with cb_date before
-- 2026-01-01 is dispositioned 'valid'. Result: 5,566 rows (net -$594,530.51,
-- cb_date 2025-07-01..2025-12-29) marked valid; 362 rows (all 2026) left open.
--
-- Safety: guarded to disposition='open' only, so operator-set dispositions are
-- never clobbered and a re-run matches 0 rows (idempotent). Appends the
-- standard status_history entry ({at,by,field,from,to,note}) in the exact shape
-- PATCH /api/internal/chargebacks/:id writes, actor 'system:bulk-2025-signoff'.
WITH upd AS (
  UPDATE factor_chargebacks
  SET disposition = 'valid',
      disposition_reason = 'Bulk sign-off: accounting including factor accounts fully reconciled through 2025 (CEO directive 07/20/2026)',
      disposition_at = now(),
      updated_by = 'system:bulk-2025-signoff',
      updated_at = now(),
      status_history = COALESCE(status_history, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
        'at', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'by', 'system:bulk-2025-signoff',
        'field', 'disposition',
        'from', 'open',
        'to', 'valid',
        'note', 'Bulk sign-off: accounting including factor accounts fully reconciled through 2025 (CEO directive 07/20/2026)'
      ))
  WHERE disposition = 'open'
    AND cb_date < DATE '2026-01-01'
  RETURNING 1
)
SELECT COUNT(*) AS rows_marked_valid FROM upd;
