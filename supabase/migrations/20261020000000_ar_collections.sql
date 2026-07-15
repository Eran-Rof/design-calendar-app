-- ════════════════════════════════════════════════════════════════════════════
-- AR Collections workflow — operator tooling on top of open AR.
--
-- Turns the read-only AR Aging report into a managed collections process:
--   • ar_collection_activities — the operator log: notes, calls, emails,
--     promises-to-pay (with amount + date), disputes, escalations. This is
--     OPERATOR data only — it NEVER posts to the GL and NEVER mutates invoices.
--   • ar_collection_status     — per-customer working state: assigned owner,
--     next action date, and an optional manual status override.
--   • v_ar_collections_worklist          — one row per OPEN invoice with aged
--     bucket, days-past-due, last activity, open promise, owner, derived
--     status, and a factored flag (a factored invoice = Rosenthal collects, so
--     it is surfaced-but-badged, not dunned the same way).
--   • v_ar_collections_promises          — the promise-to-pay pipeline
--     (upcoming / due today / broken), latest promise per invoice/customer.
--   • v_ar_collections_customer_rollup   — the account-level roll-up a collector
--     actually works from.
--
-- Fully idempotent: CREATE ... IF NOT EXISTS + CREATE OR REPLACE VIEW.
-- ════════════════════════════════════════════════════════════════════════════

-- ── Activity log ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ar_collection_activities (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id           uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE CASCADE,
  customer_id         uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  -- NULL = customer-level activity; set = invoice-level activity.
  ar_invoice_id       uuid REFERENCES ar_invoices(id) ON DELETE CASCADE,
  activity_type       text NOT NULL CHECK (activity_type IN
                        ('note','call','email','promise_to_pay','dispute','escalation','payment_expected')),
  promise_amount_cents bigint,
  promise_date        date,
  -- Mandatory free-text outcome for EVERY activity (what happened / next step).
  outcome             text NOT NULL,
  created_by_user_id  uuid,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ar_collection_activities_customer
  ON ar_collection_activities (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ar_collection_activities_invoice
  ON ar_collection_activities (ar_invoice_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ar_collection_activities_promises
  ON ar_collection_activities (customer_id, promise_date)
  WHERE activity_type = 'promise_to_pay' AND promise_date IS NOT NULL;

COMMENT ON TABLE ar_collection_activities IS
  'AR Collections operator log — notes/calls/emails/promises/disputes/escalations. Operator data only: never posts GL, never mutates invoices.';

-- ── Per-customer working state ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ar_collection_status (
  entity_id             uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE CASCADE,
  customer_id           uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  assigned_owner_user_id uuid,
  next_action_date      date,
  -- When set, overrides the view-derived status (e.g. force 'watch' / 'in_collections').
  status_override       text CHECK (status_override IN
                          ('current','watch','overdue','promised','disputed','escalated','in_collections')),
  notes                 text,
  updated_by_user_id    uuid,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_id, customer_id)
);

COMMENT ON TABLE ar_collection_status IS
  'AR Collections per-customer working state: assigned owner, next action date, optional manual status override.';

-- Secure default: RLS on, no anon/authenticated policy. The internal API talks
-- to these tables with the service_role (which bypasses RLS); the browser never
-- touches them directly. Matches the P-security-sprint posture on finance tables.
ALTER TABLE ar_collection_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE ar_collection_status     ENABLE ROW LEVEL SECURITY;

-- ── Worklist view: one row per OPEN invoice ─────────────────────────────────
CREATE OR REPLACE VIEW v_ar_collections_worklist AS
WITH open_inv AS (
  SELECT
    i.id                                                        AS ar_invoice_id,
    i.entity_id,
    i.customer_id,
    i.invoice_number,
    i.invoice_date,
    i.due_date,
    i.total_amount_cents,
    COALESCE(i.paid_amount_cents, 0)                            AS paid_amount_cents,
    (i.total_amount_cents - COALESCE(i.paid_amount_cents, 0))   AS open_cents,
    coa.code                                                    AS ar_account_code,
    (CURRENT_DATE - COALESCE(i.due_date, i.invoice_date))       AS days_past_due
  FROM ar_invoices i
  LEFT JOIN gl_accounts coa ON coa.id = i.ar_account_id
  WHERE (i.total_amount_cents - COALESCE(i.paid_amount_cents, 0)) > 0
    AND COALESCE(i.gl_status, '') <> 'draft'
    AND i.reversed_by_invoice_id IS NULL
)
SELECT
  oi.ar_invoice_id,
  oi.entity_id,
  oi.customer_id,
  c.name                                                        AS customer_name,
  c.code                                                        AS customer_code,
  oi.invoice_number,
  oi.invoice_date,
  oi.due_date,
  oi.open_cents,
  oi.total_amount_cents,
  oi.paid_amount_cents,
  oi.days_past_due,
  (COALESCE(oi.ar_account_code, '') = '1107' OR COALESCE(c.is_factored, false)) AS is_factored,
  CASE
    WHEN oi.days_past_due <= 0   THEN 'current'
    WHEN oi.days_past_due <= 30  THEN '1-30'
    WHEN oi.days_past_due <= 60  THEN '31-60'
    WHEN oi.days_past_due <= 90  THEN '61-90'
    WHEN oi.days_past_due <= 120 THEN '91-120'
    ELSE '120+'
  END                                                           AS age_bucket,
  st.assigned_owner_user_id,
  st.next_action_date,
  st.status_override,
  la.last_activity_type,
  la.last_activity_at,
  la.last_activity_outcome,
  pr.promise_amount_cents                                       AS open_promise_amount_cents,
  pr.promise_date                                               AS open_promise_date,
  (pr.promise_date IS NOT NULL AND pr.promise_date <  CURRENT_DATE) AS promise_broken,
  (pr.promise_date IS NOT NULL AND pr.promise_date >= CURRENT_DATE) AS promise_open,
  COALESCE(
    st.status_override,
    CASE
      WHEN la.last_activity_type = 'dispute'    THEN 'disputed'
      WHEN la.last_activity_type = 'escalation' THEN 'escalated'
      WHEN pr.promise_date IS NOT NULL AND pr.promise_date >= CURRENT_DATE THEN 'promised'
      WHEN oi.days_past_due <= 0  THEN 'current'
      WHEN oi.days_past_due <= 60 THEN 'overdue'
      ELSE 'in_collections'
    END
  )                                                             AS collection_status
FROM open_inv oi
JOIN customers c ON c.id = oi.customer_id
LEFT JOIN ar_collection_status st
       ON st.customer_id = oi.customer_id AND st.entity_id = oi.entity_id
LEFT JOIN LATERAL (
  SELECT a.activity_type AS last_activity_type,
         a.created_at    AS last_activity_at,
         a.outcome       AS last_activity_outcome
  FROM ar_collection_activities a
  WHERE a.customer_id = oi.customer_id
    AND (a.ar_invoice_id = oi.ar_invoice_id OR a.ar_invoice_id IS NULL)
  ORDER BY a.created_at DESC
  LIMIT 1
) la ON true
LEFT JOIN LATERAL (
  SELECT a.promise_amount_cents, a.promise_date
  FROM ar_collection_activities a
  WHERE a.customer_id = oi.customer_id
    AND (a.ar_invoice_id = oi.ar_invoice_id OR a.ar_invoice_id IS NULL)
    AND a.activity_type = 'promise_to_pay'
    AND a.promise_date IS NOT NULL
  ORDER BY a.created_at DESC
  LIMIT 1
) pr ON true;

COMMENT ON VIEW v_ar_collections_worklist IS
  'AR Collections worklist: one row per OPEN invoice (open>0, not draft/reversed) with aged bucket, days-past-due, last activity, open promise, owner and derived collection_status. is_factored flags Rosenthal-collected AR.';

-- ── Promise-to-pay pipeline ─────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_ar_collections_promises AS
SELECT
  a.id                                                          AS activity_id,
  a.entity_id,
  a.customer_id,
  c.name                                                        AS customer_name,
  c.code                                                        AS customer_code,
  a.ar_invoice_id,
  i.invoice_number,
  a.promise_amount_cents,
  a.promise_date,
  a.outcome,
  a.created_at,
  a.created_by_user_id,
  (ROW_NUMBER() OVER (
     PARTITION BY a.customer_id, COALESCE(a.ar_invoice_id, '00000000-0000-0000-0000-000000000000'::uuid)
     ORDER BY a.created_at DESC
   ) = 1)                                                       AS is_latest,
  CASE
    WHEN a.promise_date >  CURRENT_DATE THEN 'upcoming'
    WHEN a.promise_date =  CURRENT_DATE THEN 'due_today'
    ELSE 'broken'
  END                                                           AS promise_state
FROM ar_collection_activities a
JOIN customers c ON c.id = a.customer_id
LEFT JOIN ar_invoices i ON i.id = a.ar_invoice_id
WHERE a.activity_type = 'promise_to_pay'
  AND a.promise_date IS NOT NULL;

COMMENT ON VIEW v_ar_collections_promises IS
  'AR Collections promise-to-pay pipeline. is_latest marks the most recent promise per (customer, invoice); promise_state = upcoming/due_today/broken. Filter to is_latest for KPI/broken counting.';

-- ── Customer roll-up: the account view a collector works from ────────────────
CREATE OR REPLACE VIEW v_ar_collections_customer_rollup AS
SELECT
  w.entity_id,
  w.customer_id,
  w.customer_name,
  w.customer_code,
  bool_or(w.is_factored)                                              AS is_factored,
  count(*)                                                            AS open_invoice_count,
  sum(w.open_cents)                                                   AS open_cents,
  sum(w.open_cents) FILTER (WHERE w.age_bucket IN ('61-90','91-120','120+')) AS severely_past_due_cents,
  max(w.days_past_due)                                                AS max_days_past_due,
  max(w.last_activity_at)                                             AS last_activity_at,
  max(w.assigned_owner_user_id::text)::uuid                           AS assigned_owner_user_id,
  max(w.next_action_date)                                            AS next_action_date,
  bool_or(w.promise_open)                                             AS has_open_promise,
  bool_or(w.promise_broken)                                           AS has_broken_promise
FROM v_ar_collections_worklist w
GROUP BY w.entity_id, w.customer_id, w.customer_name, w.customer_code;

COMMENT ON VIEW v_ar_collections_customer_rollup IS
  'AR Collections account roll-up: per-customer open balance, invoice count, severely-past-due exposure, max days past due, owner, promise flags and factored flag.';

-- ── KPI summary (server-side aggregation — one round trip, no 16k-row fetch) ──
CREATE OR REPLACE FUNCTION ar_collections_kpi(p_entity_id uuid DEFAULT rof_entity_id())
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH w AS (
    SELECT * FROM v_ar_collections_worklist WHERE entity_id = p_entity_id AND NOT is_factored
  ),
  wf AS (
    SELECT * FROM v_ar_collections_worklist WHERE entity_id = p_entity_id AND is_factored
  ),
  pr AS (
    SELECT * FROM v_ar_collections_promises WHERE entity_id = p_entity_id AND is_latest
  )
  SELECT jsonb_build_object(
    'ours', jsonb_build_object(
      'open_cents',       COALESCE((SELECT sum(open_cents) FROM w), 0),
      'accounts',         (SELECT count(DISTINCT customer_id) FROM w),
      'invoices',         (SELECT count(*) FROM w),
      'overdue_cents',    COALESCE((SELECT sum(open_cents) FROM w WHERE days_past_due > 0), 0),
      'overdue_accounts', (SELECT count(DISTINCT customer_id) FROM w WHERE days_past_due > 0)
    ),
    'by_bucket', COALESCE((
      SELECT jsonb_object_agg(age_bucket, b) FROM (
        SELECT age_bucket,
               jsonb_build_object('open_cents', sum(open_cents), 'invoices', count(*),
                                  'accounts', count(DISTINCT customer_id)) AS b
        FROM w GROUP BY age_bucket
      ) t
    ), '{}'::jsonb),
    'factored', jsonb_build_object(
      'open_cents', COALESCE((SELECT sum(open_cents) FROM wf), 0),
      'accounts',   (SELECT count(DISTINCT customer_id) FROM wf)
    ),
    'promised_cents',       COALESCE((SELECT sum(promise_amount_cents) FROM pr WHERE promise_state IN ('upcoming','due_today')), 0),
    'promised_count',       (SELECT count(*) FROM pr WHERE promise_state IN ('upcoming','due_today')),
    'broken_promise_cents', COALESCE((SELECT sum(promise_amount_cents) FROM pr WHERE promise_state = 'broken'), 0),
    'broken_promise_count', (SELECT count(*) FROM pr WHERE promise_state = 'broken'),
    'dso', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('month', month, 'days', weighted_days))
      FROM (SELECT month, weighted_days FROM v_dso_dpo_monthly
            WHERE metric = 'DSO' ORDER BY month DESC LIMIT 6) d
    ), '[]'::jsonb)
  );
$$;

COMMENT ON FUNCTION ar_collections_kpi(uuid) IS
  'AR Collections KPI summary: ours vs factored open $, per-bucket breakdown, promised $, broken-promise $, and recent DSO trend from v_dso_dpo_monthly. Aggregated server-side.';
