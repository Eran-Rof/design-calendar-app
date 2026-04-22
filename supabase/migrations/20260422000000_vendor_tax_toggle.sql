-- 20260422000000_vendor_tax_toggle.sql
--
-- Tax-vendor flag. Set during onboarding Tax step. Drives whether the
-- invoice submission form shows the Tax line (vendors who don't collect
-- sales/VAT tax shouldn't have to fill it in, and it forces tax=0 on
-- submit for those vendors).

ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS is_tax_vendor boolean NOT NULL DEFAULT false;
