-- Reset pack_size = 1 on 104 ip_item_master rows that were wrongly flagged
-- as prepack.
--
-- Operator audit (ppk-audit-2026-05-19.csv) found 32 style_codes where the
-- style itself has no "PPK" suffix (e.g., RCB0975N) but variant rows under
-- it carry size = "PPK60" and pack_size = 60. Every one of these 32 styles
-- already has a proper sibling style with "-PPK" in the code that IS the
-- real prepack (e.g., RCB0975N-PPK). The bare-style variants are spurious
-- duplicates from earlier ingest paths and should not be counted as
-- prepacks anywhere downstream.
--
-- Filter rationale: scoping the UPDATE to (style_code IN list) AND
-- (sku_code NOT LIKE '%PPK%') AND (pack_size > 1) ensures we never touch:
--   - the real -PPK sibling rows (sku_code DOES contain PPK)
--   - regular size variants that already had pack_size = 1
--   - styles outside the audited list

UPDATE ip_item_master
SET pack_size = 1
WHERE style_code IN (
        'RBB1439NFL','RCB0975N','RCB1258','RCB1311NT','RCB1459W',
        'RYB059430','RYB1025','RYO0548B','RYO0590B','RYO0595',
        'RYO0636','RYO0645','RYO0646','RYO0647','RYO0648',
        'RYO0651','RYO0652','RYO0659FP','RYO0660','RYO0660FP',
        'RYO0668','RYO0673','RYO0687FP','RYO0690','RYO0705FP',
        'RYO0711','RYO0720','RYO0722','RYO0724','RYO0725','RYO0728'
      )
  AND sku_code NOT LIKE '%PPK%'
  AND pack_size > 1;
