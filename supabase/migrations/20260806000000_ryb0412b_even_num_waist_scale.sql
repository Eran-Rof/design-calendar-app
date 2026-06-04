-- Assign RYB0412B (Delano Belted Mess Cargo — a PANT) to the Even-Num-Waist 28-42
-- size scale, mirroring the RYB0412 base style (operator request 2026-06-01).
-- Idempotent: re-running is a no-op (IS DISTINCT FROM guard).

UPDATE style_master
SET size_scale_id = (SELECT id FROM size_scales WHERE code = 'EVEN-NUM-WAIST' LIMIT 1),
    updated_at = now()
WHERE style_code = 'RYB0412B'
  AND size_scale_id IS DISTINCT FROM (SELECT id FROM size_scales WHERE code = 'EVEN-NUM-WAIST' LIMIT 1);
