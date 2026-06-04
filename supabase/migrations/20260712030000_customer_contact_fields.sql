-- 20260712030000_customer_contact_fields.sql
-- Adds customer contact-profile fields not yet present on the customers table.
-- All six columns are optional free-text. Existing columns (name, country,
-- email/phone are NOT on the table yet — this migration is the first to add them.
-- Idempotent: each statement uses ADD COLUMN IF NOT EXISTS.

ALTER TABLE customers ADD COLUMN IF NOT EXISTS contact_name  text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS contact_title text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS email         text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS phone         text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS website       text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS wechat_id     text;

NOTIFY pgrst, 'reload schema';
