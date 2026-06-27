-- 20260907000000_fabric_mill_contacts.sql
--
-- Fabric Mill Master: add a multi-contact `contacts` jsonb array (up to 5
-- contacts, each {name,email,phone,title}). Mirrors the customers.contacts /
-- factor_master.contacts pattern. The pre-existing single contact_name /
-- contact_email columns are left in place (kept as a primary contact).
--
-- Idempotent.

ALTER TABLE fabric_mill_master
  ADD COLUMN IF NOT EXISTS contacts jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN fabric_mill_master.contacts IS
  'Up to 5 additional contacts for this fabric mill; array of {name,email,phone,title} objects. Edited via the shared ContactList UI.';
