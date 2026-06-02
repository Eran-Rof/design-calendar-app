-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P1 / Chunk 6.5
-- Mark `ip_vendor_master` as deprecated.
--
-- Per arch §7.2, `vendors` is the canonical M35 vendor master. Chunk 6 added
-- the ERP-grade columns (code, payment_terms, GL FK defaults, etc.) to
-- vendors. `ip_vendor_master` continues to exist for backward compatibility
-- with planning-side reads + the FK from ip_item_master.vendor_id.
--
-- Chunk 6.5 (2026-05-27) closes the deferral by:
-- 1. Documenting the deprecation via COMMENT ON TABLE
-- 2. Updating scripts/seed-demo-celebpink.mjs to stop writing to
--    ip_vendor_master (only writes to vendors)
--
-- The actual table → view conversion is intentionally deferred to P10
-- RLS-flip phase, when multi-tenant work touches these tables anyway. That
-- migration will need to:
--   a) Backfill missing vendors rows from ip_vendor_master.portal_vendor_id
--   b) Re-FK ip_item_master.vendor_id from ip_vendor_master(id) → vendors(id)
--   c) DROP TABLE ip_vendor_master, CREATE VIEW ip_vendor_master with
--      INSTEAD OF triggers for write-through (or kill it entirely once all
--      planning code reads from vendors).
-- ════════════════════════════════════════════════════════════════════════════

COMMENT ON TABLE ip_vendor_master IS
  'DEPRECATED 2026-05-27 (Tangerine 6.5). The canonical vendor master is now `vendors`. New code MUST write to vendors. Reads from ip_vendor_master are tolerated for backward compatibility with planning-side code; this table will be converted to a view (or dropped) in P10 once all FKs are migrated and write-paths are exclusive on vendors.';
