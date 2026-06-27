-- Per-style GL routing (operator #6).
--
-- Each style posts its sales to the GL accounts for its Xoro brand bucket
-- (ROF Brands / Boys / PT / Private Label). We store the resolved revenue / COGS
-- / returns account on the style; posting resolves an order/invoice LINE's
-- account as: style → customer default → entity default.
--
-- All three are nullable FK → gl_accounts. Backfilled from the Xoro item GL
-- export (BasePartNumber → bucket). Additive + idempotent.

ALTER TABLE style_master
  ADD COLUMN IF NOT EXISTS revenue_account_id uuid REFERENCES gl_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cogs_account_id    uuid REFERENCES gl_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS returns_account_id uuid REFERENCES gl_accounts(id) ON DELETE SET NULL;

COMMENT ON COLUMN style_master.revenue_account_id IS 'Per-style sales revenue GL account (brand bucket). Posting precedence: style → customer.default_revenue_account_id → entity default.';
COMMENT ON COLUMN style_master.cogs_account_id    IS 'Per-style COGS GL account (brand bucket). Posting precedence: style → customer.default_cogs_account_id → entity default.';
COMMENT ON COLUMN style_master.returns_account_id IS 'Per-style sales-returns GL account (brand bucket), used by credit-memo / returns posting.';

-- Per-line COGS routing: an AR invoice line carries its own COGS account (from
-- the line's style), mirroring the existing per-line revenue_account_id. The
-- arInvoiceSent rule uses ln.cogs_account_id ?? invoice-level cogs_account_id.
ALTER TABLE ar_invoice_lines
  ADD COLUMN IF NOT EXISTS cogs_account_id uuid REFERENCES gl_accounts(id) ON DELETE SET NULL;

COMMENT ON COLUMN ar_invoice_lines.cogs_account_id IS 'Per-line COGS GL account (from the line style). Posting uses this when set, else the invoice-level cogs_account_id.';
