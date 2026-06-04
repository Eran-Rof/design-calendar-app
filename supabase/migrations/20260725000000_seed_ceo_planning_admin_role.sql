-- M31 / P17 — grant the CEO the planning `admin` role so the buy-plan→Tangerine-PO
-- button (permission: run_writeback) is usable and the flow can be verified.
--
-- Before this, eran@ringoffireclothing.com had NO ip_user_roles row, so:
--   • the Execution panel's "🍊 Create Tangerine POs" button was client-disabled
--     (can(user,'run_writeback') === false), and
--   • the server endpoint 403'd ("User ... has no active roles").
--
-- Idempotent (NOT EXISTS guard — there is no unique on (user_email, role_id)).
-- Reversible: DELETE the row to revoke. The owner can re-scope to a narrower
-- role (e.g. operations_user also carries run_writeback) if preferred.

INSERT INTO ip_user_roles (user_email, role_id, active, note)
SELECT 'eran@ringoffireclothing.com', r.id, true,
       'CEO — seeded for M31 buy-plan→PO (P17 direction-A harden)'
FROM ip_roles r
WHERE r.role_name = 'admin'
  AND NOT EXISTS (
    SELECT 1 FROM ip_user_roles ur
    WHERE lower(ur.user_email) = 'eran@ringoffireclothing.com'
      AND ur.role_id = r.id
  );
