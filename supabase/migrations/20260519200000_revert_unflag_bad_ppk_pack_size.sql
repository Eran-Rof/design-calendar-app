-- Revert migration 20260519180000_unflag_bad_ppk_pack_size.sql.
--
-- That migration set pack_size = 1 on 104 bare-style rows whose size column
-- said "PPK60" / "PPK48" / "PPK24", on the theory that the real PPK lived in
-- a separate "-PPK" sibling style. Operator clarification (2026-05-19):
--
--   "the size having ppk or pk does make it a ppk flagged item"
--
-- i.e., the classification rule for "is this row a PPK" is:
--   style_code ILIKE '%PPK%'  OR  size ILIKE '%PPK%'  OR  size ILIKE '%PK%'
--
-- Under that rule, every row I touched yesterday IS legitimately a PPK
-- (its size says PPK60 / 48 / 24), so the pack_size=1 update created an
-- internal inconsistency: the row reads as PPK by size but as a singleton
-- by quantity. Both bare and -PPK sibling rows should be flagged PPK.
--
-- This migration restores pack_size from the size column.
--   PPK60 -> 60, PPK48 -> 48, PPK24 -> 24
-- by stripping the leading "PPK" and casting to int. Scoped to the same
-- 31 styles + same sku filter as the original migration so we touch only
-- rows we previously broke.

UPDATE ip_item_master
SET pack_size = CAST(REGEXP_REPLACE(size, '^PPK', '', 'i') AS INT)
WHERE style_code IN (
        'RBB1439NFL','RCB0975N','RCB1258','RCB1311NT','RCB1459W',
        'RYB059430','RYB1025','RYO0548B','RYO0590B','RYO0595',
        'RYO0636','RYO0645','RYO0646','RYO0647','RYO0648',
        'RYO0651','RYO0652','RYO0659FP','RYO0660','RYO0660FP',
        'RYO0668','RYO0673','RYO0687FP','RYO0690','RYO0705FP',
        'RYO0711','RYO0720','RYO0722','RYO0724','RYO0725','RYO0728'
      )
  AND sku_code NOT LIKE '%PPK%'
  AND size ILIKE 'PPK%'
  AND pack_size = 1
  AND REGEXP_REPLACE(size, '^PPK', '', 'i') ~ '^[0-9]+$';
