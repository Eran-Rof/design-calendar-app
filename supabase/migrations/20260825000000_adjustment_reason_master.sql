-- Adjustment Reason Master: named reasons for inventory adjustments.
-- Operators manage these in Tangerine -> Inventory -> Adjustment Reasons.
CREATE TABLE IF NOT EXISTS adjustment_reason_master (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL DEFAULT rof_entity_id(),
  code text NOT NULL,
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT adjustment_reason_master_entity_code_unique UNIQUE (entity_id, code)
);
CREATE INDEX IF NOT EXISTS adjustment_reason_master_entity_id_idx ON adjustment_reason_master(entity_id);
