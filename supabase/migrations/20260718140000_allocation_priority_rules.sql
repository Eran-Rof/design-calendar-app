-- Configurable allocation priority rules (singleton per entity).
-- The auto-allocate engine fills competing SO lines in PRIORITY order. The order
-- of the three criteria (factor-approved / credit-card / oldest) and the
-- within-tier tie-break (order date vs requested ship date) are operator-set
-- here. A missing row = the historical default (factor → card → oldest, by
-- order date). The hard factor-credit gate (a factored SO with no approval is
-- never allocated) is independent of this ordering and always applies.

CREATE TABLE IF NOT EXISTS allocation_priority_rules (
  entity_id      uuid PRIMARY KEY DEFAULT coalesce(current_entity_id(), rof_entity_id())
                   REFERENCES entities(id) ON DELETE CASCADE,
  priority_order text[] NOT NULL DEFAULT ARRAY['factor_approved', 'credit_card', 'oldest']::text[],
  tie_break      text NOT NULL DEFAULT 'order_date' CHECK (tie_break IN ('order_date', 'ship_date')),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     text
);

ALTER TABLE allocation_priority_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS anon_all_allocation_priority_rules ON allocation_priority_rules;
CREATE POLICY anon_all_allocation_priority_rules ON allocation_priority_rules FOR ALL USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';
