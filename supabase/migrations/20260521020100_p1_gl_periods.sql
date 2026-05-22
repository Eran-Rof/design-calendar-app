-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P1 / Chunk 2 / Migration 6
-- gl_periods: 12 calendar-month accounting periods per fiscal year per entity.
-- Bootstrap 5 historical + 5 forward years × 12 periods for every entity that
-- exists at migration time (= RoF only today).
-- Architecture: docs/tangerine/P1-foundation-architecture.md §4.1
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS gl_periods (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id            uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  fiscal_year          smallint NOT NULL,
  period_number        smallint NOT NULL,
  starts_on            date NOT NULL,
  ends_on              date NOT NULL,
  status               text NOT NULL DEFAULT 'open',
  soft_closed_at       timestamptz,
  closed_at            timestamptz,
  closed_by_user_id    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gl_periods_unique UNIQUE (entity_id, fiscal_year, period_number),
  CONSTRAINT gl_periods_period_check CHECK (period_number BETWEEN 1 AND 12),
  CONSTRAINT gl_periods_range_check  CHECK (ends_on >= starts_on),
  CONSTRAINT gl_periods_status_check CHECK (status IN ('open','soft_close','closed'))
);

CREATE INDEX IF NOT EXISTS idx_gl_periods_entity_status ON gl_periods (entity_id, status);
CREATE INDEX IF NOT EXISTS idx_gl_periods_range         ON gl_periods (entity_id, starts_on, ends_on);

COMMENT ON TABLE gl_periods IS '12 calendar-month accounting periods per fiscal year per entity. Status flow: open → soft_close (entries blocked, accountant adjustments allowed) → closed (no writes).';

-- ════════════════════════════════════════════════════════════════════════════
-- Bootstrap periods for every existing entity.
-- 10 years total = 5 historical (FY currentYear-4 ... FY currentYear) + 4 forward.
-- Indexed by fiscal_year_start_month from the entity.
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  e             record;
  current_year  smallint := EXTRACT(YEAR FROM CURRENT_DATE)::smallint;
  start_fy      smallint;
  end_fy        smallint;
  fy            smallint;
  pn            smallint;
  fy_start_m    smallint;
  p_start       date;
  p_end         date;
BEGIN
  FOR e IN SELECT id, fiscal_year_start_month FROM entities LOOP
    fy_start_m := e.fiscal_year_start_month;
    start_fy   := current_year - 5;
    end_fy     := current_year + 4;

    FOR fy IN start_fy..end_fy LOOP
      FOR pn IN 1..12 LOOP
        p_start := make_date(fy, fy_start_m, 1)
                   + ((pn - 1) || ' month')::interval;
        p_end   := (p_start + interval '1 month' - interval '1 day')::date;

        INSERT INTO gl_periods (entity_id, fiscal_year, period_number, starts_on, ends_on, status)
        VALUES (e.id, fy, pn, p_start::date, p_end, 'open')
        ON CONFLICT (entity_id, fiscal_year, period_number) DO NOTHING;
      END LOOP;
    END LOOP;
  END LOOP;
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Helper function: find the period a posting_date falls into for an entity.
-- Used by the journal_entries posting trigger to validate posting_date.
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION gl_find_period(p_entity_id uuid, p_date date)
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT id FROM gl_periods
   WHERE entity_id = p_entity_id
     AND p_date BETWEEN starts_on AND ends_on
   LIMIT 1;
$$;

COMMENT ON FUNCTION gl_find_period(uuid, date) IS 'Locate the gl_periods row whose [starts_on, ends_on] contains the date for an entity. Used by journal_entries posting trigger.';
