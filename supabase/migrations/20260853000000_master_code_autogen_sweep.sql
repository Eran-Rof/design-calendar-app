-- Master-data `code` autogen + lock sweep (#1162).
--
-- Makes the `code` column AUTO-GENERATED and IMMUTABLE across a defined set of
-- Tangerine masters, following the buyer_scope_master autocode pattern
-- (mig 20260851000000): a BEFORE INSERT trigger assigns <PREFIX>-NNNNN and a
-- BEFORE UPDATE freeze (`NEW.code := OLD.code`) means an operator can never
-- change it. A UNIQUE backstop guards the generated code.
--
-- TWO GROUPS (operator-confirmed):
--
--  GROUP A — codes are pure internal keys (nothing FKs to the text value).
--    Existing rows are REWRITTEN to <PREFIX>-NNNNN and the trigger ALWAYS
--    assigns (ignores any supplied code).
--      season_master            SEASON   (per-entity)
--      fabric_mill_master       MILL     (per-entity)
--      adjustment_reason_master ADJR     (per-entity)
--      adjustment_type_master   ADJT     (per-entity) — already ADJT-NNNNN, no rewrite needed
--      transfer_reason_master   XFRR     (per-entity) — already XFRR-NNNNN, keep prefix
--      rma_reason_master        RMAR     (per-entity)
--      compliance_document_types CDOC    (GLOBAL — no entity_id)
--
--  GROUP B — codes are meaningful / possibly-referenced (carrier ABF/AMAZON,
--    factor names, EDI provider codes, PL DEFAULT). Existing codes are
--    PRESERVED exactly; the trigger only auto-fills when the supplied code is
--    null/blank. Update still freezes the value.
--      carrier_master      CARR  (per-entity)
--      factor_master       FACT  (per-entity)
--      tpl_providers       TPL   (per-entity)
--      price_lists         PL    (per-entity)
--      product_categories  PCAT  (per-entity)
--
-- Scoping: every target except compliance_document_types is entity-scoped with
-- a UNIQUE(entity_id, code) — numbering + uniqueness are PER ENTITY.
-- compliance_document_types is global.
--
-- The backfill is UPDATE-only and Group B has no backfill, so row counts are
-- unchanged by this migration (verified with a count guardrail around apply).

-- ============================================================================
-- Shared trigger functions: one for ALWAYS-assign (Group A), one for
-- ASSIGN-IF-BLANK (Group B). Both freeze the code on UPDATE. Each takes the
-- prefix from the trigger's first argument (TG_ARGV[0]); the second argument
-- (TG_ARGV[1] = 'entity' | 'global') controls whether the MAX() is scoped to
-- NEW.entity_id.
-- ============================================================================

CREATE OR REPLACE FUNCTION master_code_always() RETURNS trigger AS $$
DECLARE
  v_prefix text := TG_ARGV[0];
  v_scope  text := TG_ARGV[1];
  v_seq    integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW.code := OLD.code;                 -- immutable
    RETURN NEW;
  END IF;
  -- INSERT: ALWAYS auto-assign, ignoring any supplied code.
  IF v_scope = 'entity' THEN
    EXECUTE format(
      'SELECT COALESCE(MAX((substring(code FROM %L))::int), 0) + 1 FROM %I WHERE entity_id IS NOT DISTINCT FROM $1',
      '^' || v_prefix || '-([0-9]+)$', TG_TABLE_NAME
    ) INTO v_seq USING NEW.entity_id;
  ELSE
    EXECUTE format(
      'SELECT COALESCE(MAX((substring(code FROM %L))::int), 0) + 1 FROM %I',
      '^' || v_prefix || '-([0-9]+)$', TG_TABLE_NAME
    ) INTO v_seq;
  END IF;
  NEW.code := v_prefix || '-' || lpad(v_seq::text, 5, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION master_code_if_blank() RETURNS trigger AS $$
DECLARE
  v_prefix text := TG_ARGV[0];
  v_scope  text := TG_ARGV[1];
  v_seq    integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW.code := OLD.code;                 -- immutable
    RETURN NEW;
  END IF;
  -- INSERT: preserve a supplied code; auto-assign only when null/blank.
  IF NEW.code IS NOT NULL AND btrim(NEW.code) <> '' THEN
    RETURN NEW;
  END IF;
  IF v_scope = 'entity' THEN
    EXECUTE format(
      'SELECT COALESCE(MAX((substring(code FROM %L))::int), 0) + 1 FROM %I WHERE entity_id IS NOT DISTINCT FROM $1',
      '^' || v_prefix || '-([0-9]+)$', TG_TABLE_NAME
    ) INTO v_seq USING NEW.entity_id;
  ELSE
    EXECUTE format(
      'SELECT COALESCE(MAX((substring(code FROM %L))::int), 0) + 1 FROM %I',
      '^' || v_prefix || '-([0-9]+)$', TG_TABLE_NAME
    ) INTO v_seq;
  END IF;
  NEW.code := v_prefix || '-' || lpad(v_seq::text, 5, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- GROUP A backfills — rewrite ALL existing rows to <PREFIX>-NNNNN, numbered
-- per entity (PARTITION BY entity_id) in current display order. UPDATE-only:
-- never inserts/deletes a row.
-- ============================================================================

-- season_master → SEASON-NNNNN (per entity)
WITH ordered AS (
  SELECT id, row_number() OVER (PARTITION BY entity_id ORDER BY sort_order, created_at) AS rn
  FROM season_master
)
UPDATE season_master b SET code = 'SEASON-' || lpad(o.rn::text, 5, '0'), updated_at = now()
FROM ordered o WHERE o.id = b.id;

-- fabric_mill_master → MILL-NNNNN (per entity)
WITH ordered AS (
  SELECT id, row_number() OVER (PARTITION BY entity_id ORDER BY sort_order, created_at) AS rn
  FROM fabric_mill_master
)
UPDATE fabric_mill_master b SET code = 'MILL-' || lpad(o.rn::text, 5, '0'), updated_at = now()
FROM ordered o WHERE o.id = b.id;

-- adjustment_reason_master → ADJR-NNNNN (per entity)
WITH ordered AS (
  SELECT id, row_number() OVER (PARTITION BY entity_id ORDER BY sort_order, created_at) AS rn
  FROM adjustment_reason_master
)
UPDATE adjustment_reason_master b SET code = 'ADJR-' || lpad(o.rn::text, 5, '0'), updated_at = now()
FROM ordered o WHERE o.id = b.id;

-- adjustment_type_master → already ADJT-NNNNN; re-stamp to guarantee the exact
-- ^ADJT-[0-9]+$ shape the trigger expects (per entity, current order).
WITH ordered AS (
  SELECT id, row_number() OVER (PARTITION BY entity_id ORDER BY sort_order, created_at) AS rn
  FROM adjustment_type_master
)
UPDATE adjustment_type_master b SET code = 'ADJT-' || lpad(o.rn::text, 5, '0'), updated_at = now()
FROM ordered o WHERE o.id = b.id;

-- transfer_reason_master → keep XFRR prefix (already XFRR-NNNNN), re-stamp.
WITH ordered AS (
  SELECT id, row_number() OVER (PARTITION BY entity_id ORDER BY sort_order, created_at) AS rn
  FROM transfer_reason_master
)
UPDATE transfer_reason_master b SET code = 'XFRR-' || lpad(o.rn::text, 5, '0'), updated_at = now()
FROM ordered o WHERE o.id = b.id;

-- rma_reason_master → RMAR-NNNNN (per entity)
WITH ordered AS (
  SELECT id, row_number() OVER (PARTITION BY entity_id ORDER BY sort_order, created_at) AS rn
  FROM rma_reason_master
)
UPDATE rma_reason_master b SET code = 'RMAR-' || lpad(o.rn::text, 5, '0'), updated_at = now()
FROM ordered o WHERE o.id = b.id;

-- compliance_document_types → CDOC-NNNNN (GLOBAL; no entity_id, no updated_at;
-- only document_type_id (uuid) is FK'd, nothing references the text code).
WITH ordered AS (
  SELECT id, row_number() OVER (ORDER BY sort_order, created_at) AS rn
  FROM compliance_document_types
)
UPDATE compliance_document_types b SET code = 'CDOC-' || lpad(o.rn::text, 5, '0')
FROM ordered o WHERE o.id = b.id;

-- ============================================================================
-- UNIQUE backstops (per-entity or global to match the existing constraint).
-- ============================================================================
CREATE UNIQUE INDEX IF NOT EXISTS uq_season_master_code_autogen            ON season_master            (entity_id, code);
CREATE UNIQUE INDEX IF NOT EXISTS uq_fabric_mill_master_code_autogen       ON fabric_mill_master       (entity_id, code);
CREATE UNIQUE INDEX IF NOT EXISTS uq_adjustment_reason_master_code_autogen ON adjustment_reason_master (entity_id, code);
CREATE UNIQUE INDEX IF NOT EXISTS uq_adjustment_type_master_code_autogen   ON adjustment_type_master   (entity_id, code);
CREATE UNIQUE INDEX IF NOT EXISTS uq_transfer_reason_master_code_autogen   ON transfer_reason_master   (entity_id, code);
CREATE UNIQUE INDEX IF NOT EXISTS uq_rma_reason_master_code_autogen        ON rma_reason_master        (entity_id, code);
CREATE UNIQUE INDEX IF NOT EXISTS uq_compliance_document_types_code_autogen ON compliance_document_types (code);
CREATE UNIQUE INDEX IF NOT EXISTS uq_carrier_master_code_autogen           ON carrier_master           (entity_id, code);
CREATE UNIQUE INDEX IF NOT EXISTS uq_factor_master_code_autogen            ON factor_master            (entity_id, code);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tpl_providers_code_autogen            ON tpl_providers            (entity_id, code);
CREATE UNIQUE INDEX IF NOT EXISTS uq_price_lists_code_autogen              ON price_lists              (entity_id, code);
CREATE UNIQUE INDEX IF NOT EXISTS uq_product_categories_code_autogen       ON product_categories       (entity_id, code);

-- ============================================================================
-- Triggers — GROUP A (always-assign + freeze).
-- ============================================================================
DROP TRIGGER IF EXISTS season_master_code_trg ON season_master;
CREATE TRIGGER season_master_code_trg BEFORE INSERT OR UPDATE ON season_master
  FOR EACH ROW EXECUTE FUNCTION master_code_always('SEASON', 'entity');

DROP TRIGGER IF EXISTS fabric_mill_master_code_trg ON fabric_mill_master;
CREATE TRIGGER fabric_mill_master_code_trg BEFORE INSERT OR UPDATE ON fabric_mill_master
  FOR EACH ROW EXECUTE FUNCTION master_code_always('MILL', 'entity');

DROP TRIGGER IF EXISTS adjustment_reason_master_code_trg ON adjustment_reason_master;
CREATE TRIGGER adjustment_reason_master_code_trg BEFORE INSERT OR UPDATE ON adjustment_reason_master
  FOR EACH ROW EXECUTE FUNCTION master_code_always('ADJR', 'entity');

DROP TRIGGER IF EXISTS adjustment_type_master_code_trg ON adjustment_type_master;
CREATE TRIGGER adjustment_type_master_code_trg BEFORE INSERT OR UPDATE ON adjustment_type_master
  FOR EACH ROW EXECUTE FUNCTION master_code_always('ADJT', 'entity');

DROP TRIGGER IF EXISTS transfer_reason_master_code_trg ON transfer_reason_master;
CREATE TRIGGER transfer_reason_master_code_trg BEFORE INSERT OR UPDATE ON transfer_reason_master
  FOR EACH ROW EXECUTE FUNCTION master_code_always('XFRR', 'entity');

DROP TRIGGER IF EXISTS rma_reason_master_code_trg ON rma_reason_master;
CREATE TRIGGER rma_reason_master_code_trg BEFORE INSERT OR UPDATE ON rma_reason_master
  FOR EACH ROW EXECUTE FUNCTION master_code_always('RMAR', 'entity');

DROP TRIGGER IF EXISTS compliance_document_types_code_trg ON compliance_document_types;
CREATE TRIGGER compliance_document_types_code_trg BEFORE INSERT OR UPDATE ON compliance_document_types
  FOR EACH ROW EXECUTE FUNCTION master_code_always('CDOC', 'global');

-- ============================================================================
-- Triggers — GROUP B (assign-if-blank + freeze). Existing codes preserved.
-- ============================================================================
DROP TRIGGER IF EXISTS carrier_master_code_trg ON carrier_master;
CREATE TRIGGER carrier_master_code_trg BEFORE INSERT OR UPDATE ON carrier_master
  FOR EACH ROW EXECUTE FUNCTION master_code_if_blank('CARR', 'entity');

DROP TRIGGER IF EXISTS factor_master_code_trg ON factor_master;
CREATE TRIGGER factor_master_code_trg BEFORE INSERT OR UPDATE ON factor_master
  FOR EACH ROW EXECUTE FUNCTION master_code_if_blank('FACT', 'entity');

DROP TRIGGER IF EXISTS tpl_providers_code_trg ON tpl_providers;
CREATE TRIGGER tpl_providers_code_trg BEFORE INSERT OR UPDATE ON tpl_providers
  FOR EACH ROW EXECUTE FUNCTION master_code_if_blank('TPL', 'entity');

DROP TRIGGER IF EXISTS price_lists_code_trg ON price_lists;
CREATE TRIGGER price_lists_code_trg BEFORE INSERT OR UPDATE ON price_lists
  FOR EACH ROW EXECUTE FUNCTION master_code_if_blank('PL', 'entity');

DROP TRIGGER IF EXISTS product_categories_code_trg ON product_categories;
CREATE TRIGGER product_categories_code_trg BEFORE INSERT OR UPDATE ON product_categories
  FOR EACH ROW EXECUTE FUNCTION master_code_if_blank('PCAT', 'entity');

NOTIFY pgrst, 'reload schema';
