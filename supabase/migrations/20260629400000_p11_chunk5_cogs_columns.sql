-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P11-5 — Shopify per-line COGS posting columns
--
-- Adds the cogs_je_id back-pointer to shopify_orders so the COGS posting
-- service (api/_lib/shopify/post-order-cogs.js) can stamp the JE id after
-- FIFO consume succeeds. Mirrors the existing je_id / ar_invoice_id
-- back-pointers added in P11-1.
--
-- COGS posts AFTER the AR JE (P11-3) lands. The two are kept on separate
-- JEs by D5 (see P11-shopify-architecture.md §4.1):
--   - shopify_orders.je_id        → AR JE (revenue + tax)         — P11-3
--   - shopify_orders.cogs_je_id   → COGS JE (DR 5000 / CR 1300)   — P11-5
--
-- Idempotency on the COGS post is checked via shopify_orders.cogs_je_id
-- IS NULL — once stamped, the service short-circuits with
-- status='already_posted'.
--
-- ON DELETE SET NULL so a future JE void/reversal that drops the row
-- doesn't strand a dangling FK reference.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE shopify_orders
  ADD COLUMN IF NOT EXISTS cogs_je_id uuid REFERENCES journal_entries(id) ON DELETE SET NULL;

NOTIFY pgrst, 'reload schema';
