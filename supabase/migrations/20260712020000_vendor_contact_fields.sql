-- 20260712020000_vendor_contact_fields.sql
-- Adds vendor contact-profile fields that are not yet present on the vendors
-- table. All four columns are optional free-text. Existing columns (name,
-- country, contact, email, address, tax_id, etc.) are left untouched.

ALTER TABLE vendors ADD COLUMN IF NOT EXISTS phone        text;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS website      text;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS wechat_id    text;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS contact_title text;

NOTIFY pgrst, 'reload schema';
