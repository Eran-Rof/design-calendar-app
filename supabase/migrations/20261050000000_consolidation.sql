-- ════════════════════════════════════════════════════════════════════════════
-- Multi-entity Consolidation — CONSOLIDATED FINANCIALS + INTERCOMPANY ELIMINATIONS
--
-- The re-rate flagged "no multi-entity consolidation" as absent. Tangerine hosts
-- three entities in `entities`: ROF (Ring of Fire — LIVE, ~99k posted JEs),
-- SAG (Syndicated Apparel Group — DORMANT, 0 JEs today, 49 COA stub accounts)
-- and SANDBOX (negative test bed — never consolidated).
--
-- Consolidation is a pure READ / reporting layer over the per-entity GLs (each a
-- faithful Xoro mirror). It does NOT post plug/heuristic GL entries. Instead it:
--   1. SUMS the member entities' standalone statements (trial_balance /
--      income_statement / balance_sheet_as_of — already single-entity), and
--   2. Applies INTERCOMPANY ELIMINATIONS as reporting adjustments driven by a
--      config of account pairs (intercompany_elimination_rules) — never GL rows.
--
-- Because SAG is dormant, every SAG-referencing elimination nets to $0 today, so
-- the consolidated statements == the standalone ROF statements. The framework is
-- correct for N entities and activates automatically the moment SAG posts its
-- side of an intercompany balance (the matched_min amount becomes non-zero).
--
-- Balancing invariant: each entity's trial balance already nets to zero, and
-- every elimination emits a balanced debit+credit pair (same amount), so the
-- consolidated trial balance ALWAYS nets to zero (debits = credits).
--
-- Objects:
--   consolidation_groups          — a reporting group (e.g. "ROF Consolidated").
--   consolidation_members         — which entities roll up into a group.
--   intercompany_elimination_rules— account pairs eliminated on consolidation.
--   consol_member_entities()      — resolve a group's included, non-SANDBOX members.
--   consol_leg_net_cents()        — an account's net (debit−credit) cents in scope.
--   consol_elim_amount_cents()    — a rule's elimination amount for a given scope.
--   consolidated_trial_balance()  — Σ member TBs − eliminations (long/by-entity).
--   consolidated_income_statement() — Σ member P&Ls − P&L eliminations.
--   consolidated_balance_sheet()  — Σ member BSs − BS eliminations.
--
-- Idempotent throughout (IF NOT EXISTS / CREATE OR REPLACE / guarded seeds).
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. Config tables ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS consolidation_groups (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,
  name          text NOT NULL,
  description   text,
  base_currency text NOT NULL DEFAULT 'USD',
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE consolidation_groups IS 'A consolidation reporting group (e.g. "ROF Consolidated"). Consolidated statements = Σ member entities − intercompany eliminations.';

CREATE TABLE IF NOT EXISTS consolidation_members (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id      uuid NOT NULL REFERENCES consolidation_groups(id) ON DELETE CASCADE,
  entity_id     uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  include       boolean NOT NULL DEFAULT true,
  display_order int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_id, entity_id)
);
COMMENT ON TABLE consolidation_members IS 'Which entities roll up into a consolidation group. include=false keeps the row but drops it from the roll-up. SANDBOX is always excluded by consol_member_entities() regardless of membership.';

CREATE TABLE IF NOT EXISTS intercompany_elimination_rules (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id          uuid NOT NULL REFERENCES consolidation_groups(id) ON DELETE CASCADE,
  rule_code         text NOT NULL,
  rule_name         text NOT NULL,
  reason            text NOT NULL,
  -- The elimination books DR debit_account / CR credit_account for `amount`.
  -- To remove an intercompany receivable (debit-normal) you CREDIT it; to remove
  -- the matching payable (credit-normal) you DEBIT it. Either leg's account may
  -- be NULL when the counterpart entity has not yet booked its side (treated as
  -- a $0 balance → matched_min elimination is $0 until both sides exist).
  debit_entity_id   uuid REFERENCES entities(id) ON DELETE CASCADE,
  debit_account_id  uuid REFERENCES gl_accounts(id) ON DELETE SET NULL,
  credit_entity_id  uuid REFERENCES entities(id) ON DELETE CASCADE,
  credit_account_id uuid REFERENCES gl_accounts(id) ON DELETE SET NULL,
  amount_method     text NOT NULL DEFAULT 'matched_min'
                    CHECK (amount_method IN ('matched_min','debit_leg','credit_leg','fixed')),
  fixed_amount_cents bigint,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_id, rule_code)
);
COMMENT ON TABLE intercompany_elimination_rules IS 'Intercompany account pairs eliminated on consolidation (reporting adjustments — never GL postings). amount_method: matched_min = LEAST(|debit leg|,|credit leg|) → self-balancing and $0 until both sides book; debit_leg/credit_leg = |one leg|; fixed = fixed_amount_cents. Each rule emits a balanced DR/CR pair so the consolidated TB always ties.';

CREATE INDEX IF NOT EXISTS idx_consol_members_group ON consolidation_members(group_id);
CREATE INDEX IF NOT EXISTS idx_consol_elim_group ON intercompany_elimination_rules(group_id);

-- ── 2. Member resolver (excludes SANDBOX and include=false) ──────────────────
CREATE OR REPLACE FUNCTION public.consol_member_entities(p_group_id uuid)
RETURNS TABLE(entity_id uuid, entity_code text, entity_name text, display_order int)
LANGUAGE sql STABLE AS $$
  SELECT cm.entity_id, e.code, e.name, cm.display_order
  FROM consolidation_members cm
  JOIN entities e ON e.id = cm.entity_id
  WHERE cm.group_id = p_group_id
    AND cm.include = true
    AND e.code <> 'SANDBOX'
  ORDER BY cm.display_order, e.code;
$$;

-- ── 3. Elimination amount engine ─────────────────────────────────────────────
-- Net (debit − credit) cents an account moved in [p_from, p_to]. p_from NULL =
-- cumulative through p_to (balance-sheet as-of semantics). NULL account → 0.
CREATE OR REPLACE FUNCTION public.consol_leg_net_cents(
  p_entity_id uuid, p_account_id uuid, p_basis text, p_from date, p_to date
) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT COALESCE(ROUND((SUM(jel.debit) - SUM(jel.credit)) * 100)::bigint, 0)
  FROM journal_entries je
  JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
  WHERE p_account_id IS NOT NULL
    AND je.status = 'posted'
    AND je.entity_id = p_entity_id
    AND je.basis = upper(p_basis)
    AND jel.account_id = p_account_id
    AND (p_from IS NULL OR je.posting_date >= p_from)
    AND (p_to   IS NULL OR je.posting_date <= p_to);
$$;

-- The elimination amount (cents, always ≥ 0) for one rule over a given scope.
CREATE OR REPLACE FUNCTION public.consol_elim_amount_cents(
  p_rule_id uuid, p_basis text, p_from date, p_to date
) RETURNS bigint LANGUAGE plpgsql STABLE AS $$
DECLARE r RECORD; d bigint; c bigint; amt bigint;
BEGIN
  SELECT * INTO r FROM intercompany_elimination_rules WHERE id = p_rule_id;
  IF NOT FOUND OR NOT r.is_active THEN RETURN 0; END IF;
  d := consol_leg_net_cents(r.debit_entity_id,  r.debit_account_id,  p_basis, p_from, p_to);
  c := consol_leg_net_cents(r.credit_entity_id, r.credit_account_id, p_basis, p_from, p_to);
  amt := CASE r.amount_method
    WHEN 'matched_min' THEN LEAST(abs(d), abs(c))
    WHEN 'debit_leg'   THEN abs(d)
    WHEN 'credit_leg'  THEN abs(c)
    WHEN 'fixed'       THEN COALESCE(r.fixed_amount_cents, 0)
    ELSE 0 END;
  RETURN GREATEST(COALESCE(amt, 0), 0);
END $$;

-- ── 4. Consolidated Trial Balance (long / by-entity + elimination rows) ──────
CREATE OR REPLACE FUNCTION public.consolidated_trial_balance(
  p_group_id uuid, p_basis text, p_from date, p_to date
) RETURNS TABLE(
  bucket text, entity_id uuid, entity_code text,
  account_id uuid, code text, name text, account_type text, normal_balance text,
  debit_cents bigint, credit_cents bigint, net_debit_cents bigint, net_credit_cents bigint
) LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF upper(p_basis) NOT IN ('ACCRUAL','CASH') THEN
    RAISE EXCEPTION 'consolidated_trial_balance: p_basis must be ACCRUAL or CASH, got %', p_basis USING ERRCODE='22023';
  END IF;

  RETURN QUERY
  SELECT 'ENTITY'::text, m.entity_id, m.entity_code,
         tb.account_id, tb.code, tb.name, tb.account_type, tb.normal_balance,
         tb.debit_cents, tb.credit_cents, tb.net_debit_cents, tb.net_credit_cents
  FROM consol_member_entities(p_group_id) m
  CROSS JOIN LATERAL trial_balance(m.entity_id, upper(p_basis), p_from, p_to) tb;

  RETURN QUERY
  WITH elim AS (
    SELECT r.id AS rule_id,
           r.debit_entity_id, r.debit_account_id,
           r.credit_entity_id, r.credit_account_id,
           consol_elim_amount_cents(r.id, upper(p_basis), p_from, p_to) AS amt
    FROM intercompany_elimination_rules r
    WHERE r.group_id = p_group_id AND r.is_active
  )
  SELECT 'ELIM'::text, e.debit_entity_id, ee.code,
         ga.id, ga.code, ga.name, ga.account_type, ga.normal_balance,
         e.amt, 0::bigint, e.amt, (-e.amt)
  FROM elim e
  JOIN gl_accounts ga ON ga.id = e.debit_account_id
  LEFT JOIN entities ee ON ee.id = e.debit_entity_id
  WHERE e.amt > 0
  UNION ALL
  SELECT 'ELIM'::text, e.credit_entity_id, ee.code,
         ga.id, ga.code, ga.name, ga.account_type, ga.normal_balance,
         0::bigint, e.amt, (-e.amt), e.amt
  FROM elim e
  JOIN gl_accounts ga ON ga.id = e.credit_account_id
  LEFT JOIN entities ee ON ee.id = e.credit_entity_id
  WHERE e.amt > 0;
END $$;

-- ── 5. Consolidated Income Statement ─────────────────────────────────────────
DROP FUNCTION IF EXISTS public.consolidated_income_statement(uuid,text,date,date);
CREATE FUNCTION public.consolidated_income_statement(
  p_group_id uuid, p_basis text, p_from date, p_to date
) RETURNS TABLE(
  bucket text, entity_id uuid, entity_code text,
  account_type text, account_subtype text, account_id uuid, code text, name text, amount_cents bigint
) LANGUAGE plpgsql STABLE AS $$
BEGIN
  -- Entity legs sourced inline (rather than via income_statement()) so each row
  -- carries account_id for the by-entity → GL-detail drill.
  RETURN QUERY
  SELECT 'ENTITY'::text, je.entity_id, m.entity_code,
         ga.account_type, ga.account_subtype, ga.id, ga.code, ga.name,
         ROUND(SUM(
           CASE
             WHEN ga.account_type = 'revenue'        THEN jel.credit - jel.debit
             WHEN ga.account_type = 'contra_revenue' THEN jel.debit  - jel.credit
             WHEN ga.account_type = 'expense'        THEN jel.debit  - jel.credit
           END) * 100)::bigint
  FROM consol_member_entities(p_group_id) m
  JOIN journal_entries je      ON je.entity_id = m.entity_id
  JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
  JOIN gl_accounts ga          ON ga.id = jel.account_id
  WHERE je.status = 'posted'
    AND je.basis = upper(p_basis)
    AND je.posting_date BETWEEN p_from AND p_to
    AND ga.account_type IN ('revenue','contra_revenue','expense')
  GROUP BY je.entity_id, m.entity_code, ga.account_type, ga.account_subtype, ga.id, ga.code, ga.name;

  RETURN QUERY
  WITH elim AS (
    SELECT r.id AS rule_id,
           r.debit_entity_id, r.debit_account_id,
           r.credit_entity_id, r.credit_account_id,
           consol_elim_amount_cents(r.id, upper(p_basis), p_from, p_to) AS amt
    FROM intercompany_elimination_rules r
    WHERE r.group_id = p_group_id AND r.is_active
  ),
  legs AS (
    SELECT e.debit_entity_id AS entity_id, e.debit_account_id AS account_id, e.amt
    FROM elim e WHERE e.amt > 0 AND e.debit_account_id IS NOT NULL
    UNION ALL
    SELECT e.credit_entity_id, e.credit_account_id, e.amt
    FROM elim e WHERE e.amt > 0 AND e.credit_account_id IS NOT NULL
  )
  -- Reduce the P&L contribution of every intercompany P&L leg by the eliminated
  -- amount (revenue and expense both drop, so net income is unaffected — an
  -- at-cost intra-group recharge/sale washes out).
  SELECT 'ELIM'::text, l.entity_id, ee.code,
         ga.account_type, ga.account_subtype, ga.id, ga.code, ga.name, (-l.amt)::bigint
  FROM legs l
  JOIN gl_accounts ga ON ga.id = l.account_id
  LEFT JOIN entities ee ON ee.id = l.entity_id
  WHERE ga.account_type IN ('revenue','contra_revenue','expense');
END $$;

-- ── 6. Consolidated Balance Sheet (as-of) ────────────────────────────────────
DROP FUNCTION IF EXISTS public.consolidated_balance_sheet(uuid,text,date);
CREATE FUNCTION public.consolidated_balance_sheet(
  p_group_id uuid, p_basis text, p_as_of date
) RETURNS TABLE(
  bucket text, entity_id uuid, entity_code text,
  account_type text, account_id uuid, code text, name text, balance_cents bigint
) LANGUAGE plpgsql STABLE AS $$
BEGIN
  -- Entity legs sourced inline (rather than via balance_sheet_as_of()) so each
  -- row carries account_id for the by-entity → GL-detail drill.
  RETURN QUERY
  SELECT 'ENTITY'::text, je.entity_id, m.entity_code,
         ga.account_type, ga.id, ga.code, ga.name,
         ROUND(SUM(
           CASE
             WHEN ga.normal_balance = 'DEBIT'  THEN jel.debit - jel.credit
             WHEN ga.normal_balance = 'CREDIT' THEN jel.credit - jel.debit
           END) * 100)::bigint
  FROM consol_member_entities(p_group_id) m
  JOIN journal_entries je      ON je.entity_id = m.entity_id
  JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
  JOIN gl_accounts ga          ON ga.id = jel.account_id
  WHERE je.status = 'posted'
    AND je.basis = upper(p_basis)
    AND je.posting_date <= p_as_of
    AND ga.account_type IN ('asset','contra_asset','liability','equity')
  GROUP BY je.entity_id, m.entity_code, ga.account_type, ga.id, ga.code, ga.name;

  RETURN QUERY
  WITH elim AS (
    SELECT r.id AS rule_id,
           r.debit_entity_id, r.debit_account_id,
           r.credit_entity_id, r.credit_account_id,
           consol_elim_amount_cents(r.id, upper(p_basis), NULL, p_as_of) AS amt
    FROM intercompany_elimination_rules r
    WHERE r.group_id = p_group_id AND r.is_active
  ),
  legs AS (
    SELECT e.debit_entity_id AS entity_id, e.debit_account_id AS account_id, e.amt
    FROM elim e WHERE e.amt > 0 AND e.debit_account_id IS NOT NULL
    UNION ALL
    SELECT e.credit_entity_id, e.credit_account_id, e.amt
    FROM elim e WHERE e.amt > 0 AND e.credit_account_id IS NOT NULL
  )
  -- Reduce each intercompany BS account's balance by the eliminated amount. A
  -- matched receivable (asset) and payable (liability) both drop by the same
  -- amount, so the accounting equation stays balanced.
  SELECT 'ELIM'::text, l.entity_id, ee.code,
         ga.account_type, ga.id, ga.code, ga.name, (-l.amt)::bigint
  FROM legs l
  JOIN gl_accounts ga ON ga.id = l.account_id
  LEFT JOIN entities ee ON ee.id = l.entity_id
  WHERE ga.account_type IN ('asset','contra_asset','liability','equity');
END $$;

-- ── 7. Seed: the ROF Consolidated group + members + intercompany rules ───────
-- Group.
INSERT INTO consolidation_groups (code, name, description)
SELECT 'ROF_CONSOLIDATED', 'ROF Consolidated',
       'Ring of Fire + Syndicated Apparel Group consolidated financials. SAG is dormant today, so consolidated = ROF standalone until SAG posts activity.'
WHERE NOT EXISTS (SELECT 1 FROM consolidation_groups WHERE code = 'ROF_CONSOLIDATED');

-- Members: ROF (order 0) + SAG (order 1). SANDBOX intentionally NOT a member.
INSERT INTO consolidation_members (group_id, entity_id, include, display_order)
SELECT g.id, e.id, true, CASE e.code WHEN 'ROF' THEN 0 ELSE 1 END
FROM consolidation_groups g
CROSS JOIN entities e
WHERE g.code = 'ROF_CONSOLIDATED'
  AND e.code IN ('ROF','SAG')
  AND NOT EXISTS (
    SELECT 1 FROM consolidation_members cm WHERE cm.group_id = g.id AND cm.entity_id = e.id
  );

-- Intercompany elimination rules. Legs referencing SAG accounts that do not yet
-- exist are left NULL (dormant → $0 elimination) and should be pointed at SAG's
-- real counterpart account once SAG books its side.
DO $$
DECLARE
  g_id     uuid;
  rof_id   uuid;
  sag_id   uuid;
  a_rof_1452 uuid; -- Loan Receivable - SAG (asset, DR)
  a_rof_2504 uuid; -- Loan Payable - Syndicated (liability, CR)
  a_rof_6112 uuid; -- Payroll Charged to SAG (expense, DR)
  a_sag_1300 uuid; -- Inventory — Ring of Fire (asset, DR)
BEGIN
  SELECT id INTO g_id   FROM consolidation_groups WHERE code = 'ROF_CONSOLIDATED';
  SELECT id INTO rof_id FROM entities WHERE code = 'ROF';
  SELECT id INTO sag_id FROM entities WHERE code = 'SAG';
  SELECT id INTO a_rof_1452 FROM gl_accounts WHERE entity_id = rof_id AND code = '1452';
  SELECT id INTO a_rof_2504 FROM gl_accounts WHERE entity_id = rof_id AND code = '2504';
  SELECT id INTO a_rof_6112 FROM gl_accounts WHERE entity_id = rof_id AND code = '6112';
  SELECT id INTO a_sag_1300 FROM gl_accounts WHERE entity_id = sag_id AND code = '1300-ROF';

  -- Rule 1: ROF Loan Receivable - SAG (1452) ↔ SAG's loan payable to ROF.
  INSERT INTO intercompany_elimination_rules
    (group_id, rule_code, rule_name, reason,
     debit_entity_id, debit_account_id, credit_entity_id, credit_account_id, amount_method)
  SELECT g_id, 'IC_LOAN_RECV_SAG', 'IC Loan — ROF receivable from SAG',
    'Eliminate ROF ''Loan Receivable - SAG'' (1452) against SAG''s loan payable to ROF. Set the debit leg to SAG''s payable account once SAG books it; matched_min keeps this $0 while SAG is dormant.',
    sag_id, NULL, rof_id, a_rof_1452, 'matched_min'
  WHERE g_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM intercompany_elimination_rules WHERE group_id = g_id AND rule_code = 'IC_LOAN_RECV_SAG');

  -- Rule 2: ROF Loan Payable - Syndicated (2504) ↔ SAG's loan receivable from ROF.
  INSERT INTO intercompany_elimination_rules
    (group_id, rule_code, rule_name, reason,
     debit_entity_id, debit_account_id, credit_entity_id, credit_account_id, amount_method)
  SELECT g_id, 'IC_LOAN_PAY_SAG', 'IC Loan — ROF payable to SAG',
    'Eliminate ROF ''Loan Payable - Syndicated'' (2504) against SAG''s loan receivable from ROF. Set the credit leg to SAG''s receivable account once SAG books it.',
    rof_id, a_rof_2504, sag_id, NULL, 'matched_min'
  WHERE g_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM intercompany_elimination_rules WHERE group_id = g_id AND rule_code = 'IC_LOAN_PAY_SAG');

  -- Rule 3: SAG Inventory — Ring of Fire (1300-ROF) ↔ ROF's intercompany balance.
  INSERT INTO intercompany_elimination_rules
    (group_id, rule_code, rule_name, reason,
     debit_entity_id, debit_account_id, credit_entity_id, credit_account_id, amount_method)
  SELECT g_id, 'IC_INV_SAG_FROM_ROF', 'IC Inventory — SAG stock from ROF',
    'Eliminate SAG ''Inventory — Ring of Fire'' (1300-ROF) against ROF''s intercompany transfer/payable clearing account (unrealised-profit elimination once SAG transacts). Point the debit leg at ROF''s clearing account when SAG goes live.',
    rof_id, NULL, sag_id, a_sag_1300, 'matched_min'
  WHERE g_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM intercompany_elimination_rules WHERE group_id = g_id AND rule_code = 'IC_INV_SAG_FROM_ROF');

  -- Rule 4: ROF Payroll Charged to SAG (6112) ↔ SAG payroll reimbursement.
  INSERT INTO intercompany_elimination_rules
    (group_id, rule_code, rule_name, reason,
     debit_entity_id, debit_account_id, credit_entity_id, credit_account_id, amount_method)
  SELECT g_id, 'IC_PAYROLL_SAG', 'IC Payroll — ROF recharge to SAG',
    'Eliminate ROF ''Payroll Charged to SAG'' (6112) against SAG''s payroll-reimbursement income/expense — an at-cost intra-group recharge that washes out on consolidation. Point the debit leg at SAG''s reimbursement account when SAG goes live.',
    sag_id, NULL, rof_id, a_rof_6112, 'matched_min'
  WHERE g_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM intercompany_elimination_rules WHERE group_id = g_id AND rule_code = 'IC_PAYROLL_SAG');
END $$;

-- ── 8. RLS (deny anon; service_role bypasses — panel reads via /api service key)
DO $$ BEGIN ALTER TABLE consolidation_groups           ENABLE ROW LEVEL SECURITY; EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE consolidation_members          ENABLE ROW LEVEL SECURITY; EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE intercompany_elimination_rules ENABLE ROW LEVEL SECURITY; EXCEPTION WHEN others THEN NULL; END $$;

-- ── 9. Grants ────────────────────────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION public.consol_member_entities(uuid)                 TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.consol_leg_net_cents(uuid,uuid,text,date,date) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.consol_elim_amount_cents(uuid,text,date,date) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.consolidated_trial_balance(uuid,text,date,date)   TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.consolidated_income_statement(uuid,text,date,date) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.consolidated_balance_sheet(uuid,text,date)     TO service_role, authenticated;

NOTIFY pgrst, 'reload schema';
