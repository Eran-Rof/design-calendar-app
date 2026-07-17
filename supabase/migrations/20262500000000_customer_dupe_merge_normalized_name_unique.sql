-- ════════════════════════════════════════════════════════════════════════════
-- Customer duplicate merge (final 3 pairs) + normalized-name unique guard
-- ════════════════════════════════════════════════════════════════════════════
-- #1824 wired matchCustomer.js (normalizedNameKey = uppercase + strip all
-- non-alphanumerics) into the sales importers so NEW normalized-name duplicates
-- can no longer be forked. #1816 (mig 20261400000000) merged the ALL-CAPS mirror
-- duplicates, but 3 LIVE groups remained — each a pair of legitimate CUST-NNNNN
-- accounts whose names collapse to the same normalized key:
--
--   DMODA      : "D Moda"       CUST-00028 (keeper)  <-  "Dmoda"      CUST-00034
--   USAPPAREL  : "U.S. Apparel" CUST-00167 (keeper)  <-  "US Apparel" CUST-00172
--   VETINC     : "Vet Inc"      CUST-00177 (keeper)  <-  "Vet Inc."   CUST-00178
--
-- Keeper rule (verified live 2026-07-16): the row with more AR/SO/receipt
-- activity; tie-break to the OLDER (lower-numbered) CUST code. D Moda and
-- U.S. Apparel pairs were both zero-activity (older code wins); Vet Inc
-- (CUST-00177) carried 1 invoice + 1 receipt vs Vet Inc.'s 1 SO, so it wins on
-- activity as well as being the lower code.
--
-- Those live pairs are exactly what blocked the planned partial unique index on
-- (entity_id, normalized-name) WHERE deleted_at IS NULL. This migration:
--   1. merges each pair (dynamic FK repoint of every column referencing
--      customers(id), mirroring #1816) and soft-deletes the loser, recording the
--      loser's code/name on the keeper for provenance;
--   2. creates customer_name_key(text) — the SQL twin of matchCustomer.js's
--      normalizedNameKey — and the partial unique index that uses it.
-- The merges run BEFORE the index so the index build no longer collides.
-- Idempotent + additive: re-running skips already-tombstoned losers, and the
-- function/index use CREATE OR REPLACE / IF NOT EXISTS.

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Merge the 3 remaining duplicate pairs (explicit keeper <- loser targeting)
-- ────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  pair   RECORD;
  fk     RECORD;
  moved  bigint;
  dupe   customers%ROWTYPE;
  keep   customers%ROWTYPE;
BEGIN
  FOR pair IN
    SELECT * FROM (VALUES
      -- (keeper_id, loser_id)
      ('85a40a42-d7a2-49fe-9323-d131ad37e1c4'::uuid, 'be534c64-0a78-41f1-971c-65fa8378bc65'::uuid), -- D Moda      <- Dmoda
      ('b77b9ef0-d743-4d26-aa5b-ee1343339b66'::uuid, '25dffc3e-d606-4ff4-b80a-4436860bda83'::uuid), -- U.S. Apparel<- US Apparel
      ('347985f6-b31b-40f6-b40b-5a9db2fe9203'::uuid, '8c31485b-8775-44b8-95ab-1a47e5855986'::uuid)  -- Vet Inc     <- Vet Inc.
    ) AS p(keeper_id, dupe_id)
  LOOP
    -- Look up the loser REGARDLESS of deleted_at so a re-run can still backfill
    -- provenance (below) even after the loser has been tombstoned.
    SELECT * INTO dupe FROM customers WHERE id = pair.dupe_id;
    IF NOT FOUND THEN
      RAISE NOTICE 'Loser % absent — skipping', pair.dupe_id;
      CONTINUE;
    END IF;
    SELECT * INTO keep FROM customers WHERE id = pair.keeper_id AND deleted_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Keeper % is missing or soft-deleted — aborting merge', pair.keeper_id;
    END IF;

    -- Record provenance on the keeper FIRST (before the loser is tombstoned), and
    -- idempotently: append the loser's name to aliases (so search/dedup still
    -- finds the old spelling) and stash a merge note in attributes.merged_customers.
    -- COALESCE(...) guards against the containment test returning NULL when the
    -- key is absent (NULL would make NOT (...) exclude the row and silently skip).
    UPDATE customers k
    SET aliases = (
          SELECT ARRAY(SELECT DISTINCT a FROM unnest(k.aliases || ARRAY[dupe.name]) AS a WHERE a IS NOT NULL AND a <> '')
        ),
        attributes = jsonb_set(
          COALESCE(k.attributes, '{}'::jsonb),
          '{merged_customers}',
          COALESCE(k.attributes->'merged_customers', '[]'::jsonb)
            || jsonb_build_object(
                 'id', dupe.id::text,
                 'code', dupe.code,
                 'customer_code', dupe.customer_code,
                 'name', dupe.name,
                 'merged_at', now()
               ),
          true
        ),
        updated_at = now()
    WHERE k.id = pair.keeper_id
      AND NOT COALESCE(
            k.attributes->'merged_customers' @> jsonb_build_array(jsonb_build_object('id', dupe.id::text)),
            false);

    -- The rest (FK repoint + soft-delete) runs only while the loser is still live;
    -- a re-run after the merge finds it tombstoned and skips straight through.
    IF dupe.deleted_at IS NOT NULL THEN
      RAISE NOTICE 'Loser % (%) already tombstoned — provenance ensured, skipping repoint', dupe.name, dupe.code;
      CONTINUE;
    END IF;

    RAISE NOTICE 'Merging customer % (%) -> keeper % (%)',
      dupe.name, dupe.code, keep.name, keep.code;

    -- Repoint every FK column that references customers(id), except the
    -- self-referential parent pointer (handled explicitly below).
    FOR fk IN
      SELECT tc.table_schema, tc.table_name, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name
       AND tc.table_schema = ccu.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND ccu.table_name = 'customers'
        AND ccu.column_name = 'id'
        AND NOT (tc.table_name = 'customers' AND kcu.column_name = 'parent_customer_id')
    LOOP
      BEGIN
        EXECUTE format(
          'UPDATE %I.%I SET %I = $1 WHERE %I = $2',
          fk.table_schema, fk.table_name, fk.column_name, fk.column_name
        ) USING pair.keeper_id, pair.dupe_id;
        GET DIAGNOSTICS moved = ROW_COUNT;
        IF moved > 0 THEN
          RAISE NOTICE '  repointed % row(s) in %.%(%)',
            moved, fk.table_schema, fk.table_name, fk.column_name;
        END IF;
      EXCEPTION WHEN unique_violation THEN
        -- A conflicting keeper row already exists in a per-customer-unique table;
        -- leave the loser's row rather than fail the whole merge.
        RAISE NOTICE '  SKIPPED %.%(%) — unique conflict on repoint',
          fk.table_schema, fk.table_name, fk.column_name;
      END;
    END LOOP;

    -- Re-parent any customer that pointed at the loser.
    UPDATE customers SET parent_customer_id = pair.keeper_id
    WHERE parent_customer_id = pair.dupe_id;

    -- Soft-delete the loser so it disappears from pickers/search and can never be
    -- re-attached by the matchCustomer guard (which considers live rows only).
    UPDATE customers
    SET deleted_at = now(),
        status = 'inactive',
        active = false,
        updated_at = now()
    WHERE id = pair.dupe_id AND deleted_at IS NULL;
  END LOOP;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Normalized customer-name key + partial unique index
-- ────────────────────────────────────────────────────────────────────────────
-- PARITY REQUIREMENT: this function MUST stay byte-for-byte equivalent to
-- normalizedNameKey() in api/_lib/customers/customerCodeKey.js —
--   JS:  String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "")
--   SQL: uppercase first, then strip every char that is not ASCII A-Z or 0-9.
-- If you change one side, change the other (and the parity unit test in
-- test/customers/matchCustomer.test.js). IMMUTABLE so it is index-usable.
CREATE OR REPLACE FUNCTION public.customer_name_key(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT regexp_replace(upper(COALESCE(p_name, '')), '[^A-Z0-9]', '', 'g');
$$;

COMMENT ON FUNCTION public.customer_name_key(text) IS
  'Normalized customer-name dedup key: uppercase + strip all non-alphanumerics. SQL twin of normalizedNameKey() in api/_lib/customers/customerCodeKey.js — keep the two in lockstep. Backs customers_entity_name_key_uniq.';

-- One live customer per (entity, normalized name). The 3 merges above cleared the
-- only groups that violated this, so the build succeeds. Soft-deleted tombstones
-- are excluded so a merged-away spelling never blocks a legitimate future rename.
CREATE UNIQUE INDEX IF NOT EXISTS customers_entity_name_key_uniq
  ON customers (entity_id, public.customer_name_key(name))
  WHERE deleted_at IS NULL;

COMMENT ON INDEX customers_entity_name_key_uniq IS
  'Guards against normalized-name duplicate customers (uppercase + strip non-alphanumerics) per entity, among live rows. Enforced in-DB as the backstop to the matchCustomer.js importer guard (#1824).';
