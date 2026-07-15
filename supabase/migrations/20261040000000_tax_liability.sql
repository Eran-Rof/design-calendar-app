-- ════════════════════════════════════════════════════════════════════════════
-- Sales-Tax / VAT Liability & Filing module (M19)
--
-- Ring of Fire sells wholesale + DTC ecom into the US AND Europe, so it carries
-- live sales-tax (US) and VAT (EU/UK/Nordic) liability. Tax was ALREADY collected
-- and posted upstream in Xoro (the system of record); Tangerine's GL is a faithful
-- 1:1 mirror of Xoro (journal_type 'xoro_gl_mirror'). This module therefore does
-- NOT compute tax rates and posts NOTHING to the GL. It is a liability-tracking +
-- filing-support REPORTING layer that READS the per-jurisdiction tax-payable
-- accounts that already carry the balances and reconciles/reports them so the CEO
-- can see what is owed per jurisdiction and record filings.
--
-- Accounting model (verified in the live COA):
--   • COLLECTED = CREDITS to the tax-payable account (tax charged to customers).
--   • REMITTED  = DEBITS  to the tax-payable account (tax paid to the authority).
--   • NET LIABILITY = collected − remitted (running credit balance).
--   All tax activity is ACCRUAL basis (verified: 0 CASH-basis tax lines).
--
-- GL tax-payable accounts (each → one jurisdiction). NOTE code 2300 is duplicated
-- in the COA (a "Commissions Payable" 2300 also exists), so this seed keys on the
-- account NAME as well as the code to bind the correct row:
--   2300 Sales Tax Payable              → STX  Sales tax (general / unassigned US)
--   2301 Sales Tax (Posted to Sales)    → STXS Sales-tax clearing (nets to zero)
--   2302 New York Tax Payable           → NY   New York, USA
--   2304 DNK Tax Payable                → DK   Denmark (VAT)
--   2306 EU Tax Payable                 → EU   European Union (OSS VAT)
--   2308 GBR Tax Payable                → GB   United Kingdom (VAT)
--   2310 ITA Tax Payable                → IT   Italy (VAT)
--   2312 SWE Tax Payable                → SE   Sweden (VAT)
--   2314 US Tax Payable                 → US   United States (national roll-up)
--
-- Idempotent throughout (IF NOT EXISTS / CREATE OR REPLACE / guarded DO blocks /
-- ON CONFLICT DO NOTHING).
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. tax_jurisdictions — config: jurisdiction → payable account + filing rule ─
CREATE TABLE IF NOT EXISTS tax_jurisdictions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id        uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE CASCADE,
  code             text NOT NULL,                 -- short jurisdiction token (US, NY, EU, DK, GB, IT, SE, STX, STXS)
  label            text NOT NULL,                 -- display label
  country_region   text,                          -- human region, e.g. "United Kingdom (VAT)"
  flag             text,                          -- flag-as-TEXT token (e.g. "US", "GB", "EU") — never an emoji
  gl_account_id    uuid REFERENCES gl_accounts(id) ON DELETE SET NULL,
  gl_account_code  text,                          -- denormalized for display / drill
  filing_frequency text NOT NULL DEFAULT 'quarterly'
                     CHECK (filing_frequency IN ('monthly','quarterly','annual')),
  grace_days       int  NOT NULL DEFAULT 20 CHECK (grace_days >= 0),  -- period end + grace = statutory due date
  is_clearing      boolean NOT NULL DEFAULT false, -- true for the 2301 clearing account (nets to zero, not a real liability)
  sort_order       int  NOT NULL DEFAULT 100,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id uuid,
  CONSTRAINT tax_jurisdictions_entity_code_uk UNIQUE (entity_id, code)
);
COMMENT ON TABLE tax_jurisdictions IS 'Sales-tax / VAT jurisdiction config. Each row binds a jurisdiction to its GL tax-payable account (the authoritative liability source) and a filing frequency. Read-only reporting config — the module posts nothing to the GL.';
COMMENT ON COLUMN tax_jurisdictions.flag IS 'Flag rendered AS TEXT (ISO-ish token like "US","GB","EU","DK") — house rule forbids decorative emoji, so no flag emoji.';
COMMENT ON COLUMN tax_jurisdictions.is_clearing IS 'TRUE for the sales-tax clearing/contra account (code 2301) whose activity nets to zero; excluded from headline liability.';

-- ── 2. tax_filings — the CEO records filings here (draft → filed → paid) ────────
CREATE TABLE IF NOT EXISTS tax_filings (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id          uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE CASCADE,
  jurisdiction_id    uuid NOT NULL REFERENCES tax_jurisdictions(id) ON DELETE CASCADE,
  period_start       date NOT NULL,
  period_end         date NOT NULL,
  tax_collected_cents bigint NOT NULL DEFAULT 0,
  tax_remitted_cents  bigint NOT NULL DEFAULT 0,
  net_due_cents       bigint NOT NULL DEFAULT 0,   -- collected − remitted as recorded on the filing
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','filed','paid')),
  filed_at           timestamptz,
  reference          text,                          -- confirmation / authority reference number
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid,
  CONSTRAINT tax_filings_period_uk UNIQUE (entity_id, jurisdiction_id, period_start, period_end),
  CONSTRAINT tax_filings_period_order CHECK (period_end >= period_start)
);
COMMENT ON TABLE tax_filings IS 'Record of sales-tax / VAT filings per jurisdiction/period. Bookkeeping only — recording a filing here does NOT post a GL remittance (Xoro/bank already books the payment that the mirror reflects as a debit to the payable account).';

CREATE INDEX IF NOT EXISTS tax_filings_jurisdiction_idx ON tax_filings (jurisdiction_id, period_start);

-- ── 3. Seed jurisdictions from the live COA tax-payable accounts ────────────────
-- Bind each jurisdiction to its account by (code, name) to disambiguate the two
-- 2300 accounts. Idempotent: ON CONFLICT (entity_id, code) refreshes the binding.
INSERT INTO tax_jurisdictions
  (entity_id, code, label, country_region, flag, gl_account_id, gl_account_code, filing_frequency, grace_days, is_clearing, sort_order, notes)
SELECT e.id, s.code, s.label, s.country_region, s.flag, ga.id, ga.code, s.filing_frequency, s.grace_days, s.is_clearing, s.sort_order, s.notes
FROM entities e
CROSS JOIN (VALUES
  ('US',   'US Sales Tax',            'United States (national roll-up)', 'US',  '2314', 'US Tax Payable',              'monthly',   20, false,  10, 'National US sales-tax roll-up account. Largest exposure.'),
  ('NY',   'New York Sales Tax',      'New York, USA',                    'US',  '2302', 'New York Tax Payable',        'quarterly', 20, false,  20, 'New York state sales tax.'),
  ('STX',  'Sales Tax (general)',     'United States (unassigned)',       'US',  '2300', 'Sales Tax Payable',           'monthly',   20, false,  30, 'Generic US sales-tax payable not attributed to a specific state.'),
  ('EU',   'EU VAT (OSS)',            'European Union (OSS)',             'EU',  '2306', 'EU Tax Payable',              'quarterly', 20, false,  40, 'EU One-Stop-Shop VAT roll-up (non country-specific EU sales).'),
  ('GB',   'UK VAT',                  'United Kingdom (VAT)',             'GB',  '2308', 'GBR Tax Payable',             'quarterly', 37, false,  50, 'UK VAT — statutory due ~1 month + 7 days after quarter end.'),
  ('DK',   'Denmark VAT',             'Denmark (VAT)',                    'DK',  '2304', 'DNK Tax Payable',             'quarterly', 60, false,  60, 'Danish VAT (moms).'),
  ('IT',   'Italy VAT',               'Italy (VAT)',                      'IT',  '2310', 'ITA Tax Payable',             'quarterly', 30, false,  70, 'Italian VAT (IVA).'),
  ('SE',   'Sweden VAT',              'Sweden (VAT)',                     'SE',  '2312', 'SWE Tax Payable',             'quarterly', 42, false,  80, 'Swedish VAT (moms).'),
  ('STXS', 'Sales Tax clearing',      'United States (clearing)',         'US',  '2301', 'Sales Tax (Posted to Sales)', 'monthly',   20, true,   90, 'Clearing/contra account — activity nets to zero; excluded from headline liability.')
) AS s(code, label, country_region, flag, acct_code, acct_name, filing_frequency, grace_days, is_clearing, sort_order, notes)
JOIN gl_accounts ga ON ga.entity_id = e.id AND ga.code = s.acct_code AND ga.name = s.acct_name
WHERE e.code = 'ROF'
ON CONFLICT (entity_id, code) DO UPDATE
  SET gl_account_id   = EXCLUDED.gl_account_id,
      gl_account_code = EXCLUDED.gl_account_code,
      label           = EXCLUDED.label,
      country_region  = EXCLUDED.country_region,
      flag            = EXCLUDED.flag,
      filing_frequency= EXCLUDED.filing_frequency,
      grace_days      = EXCLUDED.grace_days,
      is_clearing     = EXCLUDED.is_clearing,
      sort_order      = EXCLUDED.sort_order,
      notes           = EXCLUDED.notes,
      updated_at      = now();

-- ── 4. v_tax_liability_by_jurisdiction — per jurisdiction × month, with running liability
-- Collected = credits, Remitted = debits, on the bound payable account (posted,
-- ACCRUAL). Running liability is the cumulative net credit balance through the
-- month. One row per (jurisdiction, month) that had activity.
CREATE OR REPLACE VIEW v_tax_liability_by_jurisdiction AS
WITH monthly AS (
  SELECT
    tj.entity_id,
    tj.id                                            AS jurisdiction_id,
    tj.code                                          AS jurisdiction_code,
    tj.label                                         AS jurisdiction_label,
    tj.country_region,
    tj.flag,
    tj.gl_account_code,
    tj.filing_frequency,
    tj.is_clearing,
    date_trunc('month', je.posting_date)::date       AS period_month,
    ROUND(SUM(jel.credit) * 100)::bigint             AS collected_cents,
    ROUND(SUM(jel.debit)  * 100)::bigint             AS remitted_cents,
    ROUND(SUM(jel.credit - jel.debit) * 100)::bigint AS net_cents
  FROM tax_jurisdictions tj
  JOIN journal_entry_lines jel ON jel.account_id = tj.gl_account_id
  JOIN journal_entries je      ON je.id = jel.journal_entry_id
                              AND je.status = 'posted'
                              AND je.basis  = 'ACCRUAL'
  WHERE tj.status = 'active'
  GROUP BY tj.entity_id, tj.id, tj.code, tj.label, tj.country_region, tj.flag,
           tj.gl_account_code, tj.filing_frequency, tj.is_clearing,
           date_trunc('month', je.posting_date)
)
SELECT
  m.*,
  SUM(m.net_cents) OVER (
    PARTITION BY m.entity_id, m.jurisdiction_id
    ORDER BY m.period_month
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  ) AS running_liability_cents
FROM monthly m;
COMMENT ON VIEW v_tax_liability_by_jurisdiction IS 'Per jurisdiction × month: tax collected (GL credits), remitted (GL debits), net, and running liability (cumulative net credit balance) from the bound tax-payable account. Posted ACCRUAL activity only. Authoritative liability source — sale-level ship-to jurisdiction is not reliably on the invoice, so the tax accounts themselves are the source of truth.';

-- ── 5. v_tax_liability_summary — current liability per jurisdiction (all-time) ──
CREATE OR REPLACE VIEW v_tax_liability_summary AS
SELECT
  tj.entity_id,
  tj.id                                              AS jurisdiction_id,
  tj.code                                            AS jurisdiction_code,
  tj.label                                           AS jurisdiction_label,
  tj.country_region,
  tj.flag,
  tj.gl_account_code,
  tj.filing_frequency,
  tj.grace_days,
  tj.is_clearing,
  tj.sort_order,
  COALESCE(ROUND(SUM(jel.credit) * 100), 0)::bigint             AS collected_cents,
  COALESCE(ROUND(SUM(jel.debit)  * 100), 0)::bigint             AS remitted_cents,
  COALESCE(ROUND(SUM(jel.credit - jel.debit) * 100), 0)::bigint AS net_due_cents,
  MAX(je.posting_date)                               AS last_activity_date
FROM tax_jurisdictions tj
LEFT JOIN journal_entry_lines jel ON jel.account_id = tj.gl_account_id
LEFT JOIN journal_entries je      ON je.id = jel.journal_entry_id
                                 AND je.status = 'posted'
                                 AND je.basis  = 'ACCRUAL'
WHERE tj.status = 'active'
GROUP BY tj.entity_id, tj.id, tj.code, tj.label, tj.country_region, tj.flag,
         tj.gl_account_code, tj.filing_frequency, tj.grace_days, tj.is_clearing, tj.sort_order;
COMMENT ON VIEW v_tax_liability_summary IS 'Current (all-time) tax liability per jurisdiction: collected − remitted = net_due, from the bound GL tax-payable account (posted ACCRUAL). One row per active jurisdiction; last_activity_date drives filing-worklist recency.';

-- ── 6. RLS (anon read-only, mirroring sibling finance tables) ──────────────────
DO $$ BEGIN ALTER TABLE tax_jurisdictions ENABLE ROW LEVEL SECURITY; EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE tax_filings       ENABLE ROW LEVEL SECURITY; EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='tax_jurisdictions' AND policyname='anon_read_tax_jurisdictions') THEN
    CREATE POLICY "anon_read_tax_jurisdictions" ON tax_jurisdictions FOR SELECT TO anon USING (true); END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='tax_filings' AND policyname='anon_read_tax_filings') THEN
    CREATE POLICY "anon_read_tax_filings" ON tax_filings FOR SELECT TO anon USING (true); END IF;
END $$;

NOTIFY pgrst, 'reload schema';
