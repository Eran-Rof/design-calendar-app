-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine — Style Master Sweep (operator asks #5 / #6 / #7 / #12)
--
-- Five changes in one migration, all idempotent so re-running on a partially
-- applied schema is safe:
--
--   1. Add three nullable text classifier columns to style_master:
--        group_name, category_name, sub_category_name.
--      We use *_name suffix because `category_id` already exists as a uuid FK
--      to ip_category_master — these new columns are operator-typed labels
--      that don't FK anywhere (yet). A later chunk can promote them to
--      lookup tables if a finite known set emerges.
--
--   2. Create the style_notes table — append-only log of operator comments
--      attached to a single style_master row, with author + timestamp.
--
--   3. Backfill style_master.style_name where blank. Derive from
--      description (first 60 chars of the trimmed description, title-cased)
--      because no other source exists in our data (verified: ip_item_master
--      has no style_name column; the original P1 backfill in
--      20260521040000_p1_style_master.sql only populated description from
--      ip_item_master.description, and no nightly Xoro sync writes
--      style_name). Operator can overwrite via the admin UI any time.
--      Rows whose description is itself blank get a fallback of style_code
--      so the column is never NULL after this sweep.
--
--   4. Normalize style_master.gender_code values to the six-letter canonical
--      set { M, B, C, G, W, U } and replace the existing CHECK constraint
--      (which still allowed legacy "WMS") with the new set.
--      Mapping rules:
--        existing M     -> M
--        existing WMS   -> W   (women's = W under the new scheme)
--        existing B     -> B
--        existing C     -> C
--        existing G     -> G
--        existing U     -> U
--        anything else  -> left as NULL (operator will fix in the UI)
--      A follow-up sweep may normalize other tables (ip_item_master, etc.).
--
--   5. Reload PostgREST so the new columns / table are visible to the API
--      layer immediately.
-- ════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Group / category / sub-category classifier columns
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE style_master
  ADD COLUMN IF NOT EXISTS group_name        text,
  ADD COLUMN IF NOT EXISTS category_name     text,
  ADD COLUMN IF NOT EXISTS sub_category_name text;

COMMENT ON COLUMN style_master.group_name IS
  'Operator-typed top-level classifier (e.g. Apparel, Accessories). Nullable text — not FK to a lookup table yet.';
COMMENT ON COLUMN style_master.category_name IS
  'Operator-typed mid-level classifier (e.g. Tops, Bottoms). Distinct from the legacy category_id uuid FK; this column is the display label operators edit directly.';
COMMENT ON COLUMN style_master.sub_category_name IS
  'Operator-typed leaf-level classifier (e.g. T-Shirts, Tanks). Nullable text.';

CREATE INDEX IF NOT EXISTS idx_style_master_group_name
  ON style_master (entity_id, group_name) WHERE group_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_style_master_category_name
  ON style_master (entity_id, category_name) WHERE category_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_style_master_sub_category_name
  ON style_master (entity_id, sub_category_name) WHERE sub_category_name IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. style_notes — append-only log per style_master row
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS style_notes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  style_id          uuid NOT NULL REFERENCES style_master(id) ON DELETE CASCADE,
  note_text         text NOT NULL,
  created_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by_email  text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT style_notes_text_not_blank CHECK (length(btrim(note_text)) > 0)
);

COMMENT ON TABLE  style_notes IS
  'Append-only operator notes attached to a single style_master row. UI surface lives in the Style Master edit modal.';
COMMENT ON COLUMN style_notes.created_by IS
  'auth.users.id of the author; ON DELETE SET NULL preserves the note when an operator is removed.';
COMMENT ON COLUMN style_notes.created_by_email IS
  'Snapshot of the author email at insert time so the UI can render it without joining auth.users.';

CREATE INDEX IF NOT EXISTS idx_style_notes_style_id_created_at
  ON style_notes (style_id, created_at DESC);

ALTER TABLE style_notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_all_style_notes" ON style_notes;
CREATE POLICY "anon_all_style_notes" ON style_notes
  FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_internal_style_notes" ON style_notes;
CREATE POLICY "auth_internal_style_notes" ON style_notes
  FOR ALL TO authenticated
  USING (
    style_id IN (
      SELECT sm.id FROM style_master sm
      JOIN entity_users eu ON eu.entity_id = sm.entity_id
      WHERE eu.auth_id = auth.uid()
    )
  )
  WITH CHECK (
    style_id IN (
      SELECT sm.id FROM style_master sm
      JOIN entity_users eu ON eu.entity_id = sm.entity_id
      WHERE eu.auth_id = auth.uid()
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Backfill style_master.style_name where currently NULL/blank
-- ─────────────────────────────────────────────────────────────────────────────
-- Source-of-truth investigation: ip_item_master has no style_name column,
-- and nothing in the nightly Xoro pipeline writes one. The only seed for
-- style_master came from the P1 backfill which populated description from
-- ip_item_master.description. So the only field we can derive style_name
-- from today is description; operator will refine via the UI.
--
-- We take the first 60 chars of the trimmed description (or the style_code
-- if description is blank) and lightly title-case it so list views look
-- presentable. Existing non-blank style_name rows are untouched.
--
-- Coverage check (uncomment to verify after apply):
--   SELECT COUNT(*) FILTER (WHERE style_name IS NULL OR btrim(style_name) = '') AS still_blank,
--          COUNT(*) AS total
--     FROM style_master
--    WHERE deleted_at IS NULL;
UPDATE style_master
   SET style_name = LEFT(
     COALESCE(
       NULLIF(btrim(initcap(description)), ''),
       style_code
     ),
     60
   )
 WHERE (style_name IS NULL OR btrim(style_name) = '');

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Gender code normalize — six-letter canonical set { M, B, C, G, W, U }
-- ─────────────────────────────────────────────────────────────────────────────
-- Map the legacy "WMS" value to the new "W"; everything else is already
-- in the canonical set or is NULL. Anything outside the six new codes is
-- nulled out so the new CHECK constraint can be applied cleanly.
UPDATE style_master
   SET gender_code = CASE
     WHEN gender_code = 'WMS' THEN 'W'
     WHEN gender_code IN ('M','B','C','G','W','U') THEN gender_code
     ELSE NULL
   END;

-- Swap the existing CHECK constraint for one that enforces the new set.
DO $$
BEGIN
  ALTER TABLE style_master DROP CONSTRAINT IF EXISTS style_master_gender_check;
EXCEPTION
  WHEN undefined_object THEN NULL;
END$$;

DO $$
BEGIN
  ALTER TABLE style_master
    ADD CONSTRAINT style_master_gender_check
    CHECK (gender_code IS NULL OR gender_code IN ('M','B','C','G','W','U'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_table  THEN NULL;
END$$;

COMMENT ON COLUMN style_master.gender_code IS
  'M=Mens | B=Boys | C=Child | G=Girls | W=Womens | U=Unisex. Canonical set adopted 2026-05-29. Legacy WMS rows were rewritten to W.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Reload PostgREST schema cache
-- ─────────────────────────────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
