// api/_lib/accounting/tieouts.js
//
// Daily subledger → control-account tie-out engine (2026-07-08 accounting
// audit: "best-in-class books are continuously proven, not proven once").
//
// Compares the cumulative GL balance of each CONTROL account (SUM of
// journal_entry_lines debit − credit across ALL posted ACCRUAL JEs — read
// from v_trial_balance, which is exactly that rollup) against the total the
// corresponding SUBLEDGER says it should be:
//
//   AR classes (assets — net-DEBIT balance expected):
//     1105 AR - Credit Card    ┐  open ar_invoices balance
//     1107 AR - Factored       ├  (total_amount_cents − paid_amount_cents)
//     1108 AR - House          ┘  grouped by ar_invoices.ar_account_id
//   AP (liability — net-CREDIT balance expected):
//     2000 Accounts Payable    —  invoices (vendor bills) with
//                                 gl_status='posted', unpaid balance
//                                 (total_amount_cents − paid_amount_cents)
//
// Sign convention: gl_cents is reported on the account's NORMAL side
// (net debit for AR, net credit for AP) so a healthy tie-out is always
// gl_cents === subledger_cents, diff_cents = gl_cents − subledger_cents.
//
// ⚠️ v_trial_balance column names debit_cents / credit_cents are a historical
// misnomer — journal_entry_lines.debit/credit are numeric(18,2) DOLLARS, and
// the view just SUMs them. dollarsToCents() converts at the boundary.
//
// AR subledger population: every ar_invoices row except gl_status in
// (draft, pending_approval, void, reversed) — those are by definition not in
// the GL. 'unposted' IS included: Xoro-mirrored invoices carry
// gl_status='unposted' yet their day totals ARE in the GL via the routed
// daily AR summary JE (api/_lib/xoro-mirror/ar-routed-summary.js), and the
// per-invoice AR history backfill (posted_historical) is replacing the
// summary-era rows. Until that backfill completes, AR diffs are EXPECTED —
// the monitor screaming until history lands is the point.
//
// Pure functions throughout; runControlTieouts is the only DB-touching
// orchestrator (takes a supabase client so tests can pass a double).

export const AR_CONTROL_CODES = ["1105", "1107", "1108"];
export const AP_CONTROL_CODE = "2000";
export const CONTROL_CODES = [...AR_CONTROL_CODES, AP_CONTROL_CODE];

// Alert when |diff| > $0.01 (i.e. strictly more than one cent).
export const TOLERANCE_CENTS = 1;

// ar_invoices gl_status values that have no GL representation at all.
export const AR_EXCLUDED_GL_STATUSES = ["draft", "pending_approval", "void", "reversed"];

/**
 * Convert a NUMERIC-ish DOLLAR amount to integer cents without float drift.
 * Tolerates null, number primitives, and strings like "-1234.5" / "1234.56".
 * (PostgREST serializes numeric as a JSON number or string depending on
 * config — handle both.) Unparseable values → 0.
 */
export function dollarsToCents(v) {
  if (v == null) return 0;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return 0;
    return Math.round(v * 100);
  }
  const s = String(v).replace(/[$,\s]/g, "");
  const m = /^(-?)(\d+)(?:\.(\d{1,}))?$/.exec(s);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  const whole = Number(m[2]);
  const fracRaw = (m[3] || "").padEnd(2, "0");
  // Round anything past 2 decimals (numeric(18,2) shouldn't have any).
  const frac = Math.round(Number(`${fracRaw.slice(0, 2)}.${fracRaw.slice(2) || "0"}`));
  return sign * (whole * 100 + frac);
}

/** Integer-cents coercion for bigint-cents columns. */
export function intCents(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/**
 * Net GL balance in cents for one v_trial_balance row, reported on the
 * account's normal side. side='debit' → SUM(debit)−SUM(credit);
 * side='credit' → SUM(credit)−SUM(debit). Missing row (no postings) → 0.
 */
export function glNetCents(tbRow, side) {
  const d = dollarsToCents(tbRow?.debit_cents ?? 0);
  const c = dollarsToCents(tbRow?.credit_cents ?? 0);
  return side === "credit" ? c - d : d - c;
}

/**
 * Group open AR balance (total − paid, cents) by ar_account_id.
 * Rows with a null ar_account_id can't tie to a control account — their
 * total is reported separately so the operator can see it inside any diff.
 */
export function sumArOpenByAccountId(invoiceRows) {
  const byAccountId = new Map();
  let unmapped_cents = 0;
  for (const r of invoiceRows || []) {
    const open = intCents(r.total_amount_cents) - intCents(r.paid_amount_cents);
    if (open === 0) continue;
    if (!r.ar_account_id) {
      unmapped_cents += open;
      continue;
    }
    byAccountId.set(r.ar_account_id, (byAccountId.get(r.ar_account_id) || 0) + open);
  }
  return { byAccountId, unmapped_cents };
}

/**
 * AP subledger rollup over POSTED vendor bills: unpaid balance plus the
 * total paid so far. paid_total_cents === 0 across every posted bill is the
 * "payments ledger not live yet" signal (AP payments aren't posted yet —
 * bills only ever accrue), which downgrades the AP tie-out to
 * 'pending_payments' instead of alerting.
 */
export function sumApOpenPosted(billRows) {
  let open_cents = 0;
  let paid_total_cents = 0;
  let bills = 0;
  for (const r of billRows || []) {
    open_cents += intCents(r.total_amount_cents) - intCents(r.paid_amount_cents);
    paid_total_cents += intCents(r.paid_amount_cents);
    bills += 1;
  }
  return { open_cents, paid_total_cents, bills };
}

/** $ formatter for alert bodies: cents → "$1,234.56" / "-$0.02". */
export function formatUsd(cents) {
  const n = Number(cents) || 0;
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const whole = Math.floor(abs / 100).toLocaleString("en-US");
  return `${sign}$${whole}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * Assemble the tie-out rows.
 *
 * @param {object} p
 * @param {Map<string,string>} p.accountIdByCode  code → gl_accounts.id
 * @param {Map<string,object>} p.tbRowByCode      code → v_trial_balance row
 * @param {Map<string,number>} p.arByAccountId    ar_account_id → open cents
 * @param {{open_cents:number, paid_total_cents:number, bills:number}} p.ap
 * @returns {Array<{account_code:string, side:'debit'|'credit', gl_cents:number,
 *          subledger_cents:number, diff_cents:number,
 *          status:'ok'|'break'|'pending_payments', waived:string|null}>}
 */
export function buildTieoutRows({ accountIdByCode, tbRowByCode, arByAccountId, ap }) {
  const rows = [];

  for (const code of AR_CONTROL_CODES) {
    const gl_cents = glNetCents(tbRowByCode.get(code), "debit");
    const accountId = accountIdByCode.get(code);
    const subledger_cents = (accountId && arByAccountId.get(accountId)) || 0;
    const diff_cents = gl_cents - subledger_cents;
    rows.push({
      account_code: code,
      side: "debit",
      gl_cents,
      subledger_cents,
      diff_cents,
      status: Math.abs(diff_cents) <= TOLERANCE_CENTS ? "ok" : "break",
      waived: null,
    });
  }

  // AP 2000 — WAIVED while the payments ledger is empty. Vendor-bill JEs
  // only ever CREDIT 2000 (per-bill posting, #1662); until invoice_payments
  // start relieving it, GL 2000 = all-time billed while the subledger's
  // "unpaid balance" would eventually diverge the moment Xoro marks bills
  // paid without a Tangerine payment JE. sum(paid_amount_cents)=0 across
  // posted bills ⇒ report 'pending_payments' (with the diff, for the JSON
  // summary) instead of alerting.
  {
    const gl_cents = glNetCents(tbRowByCode.get(AP_CONTROL_CODE), "credit");
    const subledger_cents = ap?.open_cents || 0;
    const diff_cents = gl_cents - subledger_cents;
    const withinTolerance = Math.abs(diff_cents) <= TOLERANCE_CENTS;
    const pendingPayments = (ap?.paid_total_cents || 0) === 0;
    rows.push({
      account_code: AP_CONTROL_CODE,
      side: "credit",
      gl_cents,
      subledger_cents,
      diff_cents,
      status: withinTolerance ? "ok" : pendingPayments ? "pending_payments" : "break",
      waived: !withinTolerance && pendingPayments ? "pending_payments" : null,
    });
  }

  return rows;
}

const PAGE = 1000; // PostgREST silently caps at 1000 rows — always paginate.

async function fetchAllPages(admin, buildQuery) {
  const out = [];
  let offset = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await buildQuery(admin).range(offset, offset + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = data || [];
    out.push(...rows);
    if (rows.length < PAGE) break;
    offset += rows.length;
  }
  return out;
}

/**
 * Orchestrator: run every control-account tie-out for an entity.
 * Returns { rows, meta } where rows is buildTieoutRows() output and meta
 * carries the context an operator needs to read a diff.
 */
export async function runControlTieouts(admin, entity_id) {
  // 1. Control accounts (id ↔ code).
  const { data: accts, error: aErr } = await admin
    .from("gl_accounts")
    .select("id, code, name, is_control")
    .eq("entity_id", entity_id)
    .in("code", CONTROL_CODES);
  if (aErr) throw new Error(`gl_accounts read failed: ${aErr.message}`);
  const accountIdByCode = new Map((accts || []).map((a) => [a.code, a.id]));
  const nameByCode = new Map((accts || []).map((a) => [a.code, a.name]));

  // 2. GL side: cumulative posted ACCRUAL balances from v_trial_balance
  //    (one row per account — SUM(jel.debit)/SUM(jel.credit) over
  //    je.status='posted', grouped by basis).
  const { data: tb, error: tbErr } = await admin
    .from("v_trial_balance")
    .select("code, debit_cents, credit_cents")
    .eq("entity_id", entity_id)
    .eq("basis", "ACCRUAL")
    .in("code", CONTROL_CODES);
  if (tbErr) throw new Error(`v_trial_balance read failed: ${tbErr.message}`);
  const tbRowByCode = new Map((tb || []).map((r) => [r.code, r]));

  // 3. AR subledger: open balance per ar_account_id.
  const arRows = await fetchAllPages(admin, (a) =>
    a
      .from("ar_invoices")
      .select("ar_account_id, total_amount_cents, paid_amount_cents")
      .eq("entity_id", entity_id)
      .not("gl_status", "in", `(${AR_EXCLUDED_GL_STATUSES.join(",")})`)
      .order("id", { ascending: true }),
  );
  const { byAccountId: arByAccountId, unmapped_cents: ar_unmapped_cents } =
    sumArOpenByAccountId(arRows);

  // 4. AP subledger: unpaid balance of POSTED vendor bills.
  const apRows = await fetchAllPages(admin, (a) =>
    a
      .from("invoices")
      .select("total_amount_cents, paid_amount_cents")
      .eq("entity_id", entity_id)
      .eq("gl_status", "posted")
      .order("id", { ascending: true }),
  );
  const ap = sumApOpenPosted(apRows);

  const rows = buildTieoutRows({ accountIdByCode, tbRowByCode, arByAccountId, ap });
  return {
    rows,
    meta: {
      account_names: Object.fromEntries(nameByCode),
      ar_invoices_considered: arRows.length,
      ar_unmapped_cents,
      ap_posted_bills: ap.bills,
      ap_paid_total_cents: ap.paid_total_cents,
      missing_accounts: CONTROL_CODES.filter((c) => !accountIdByCode.get(c)),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// CASH mirror tie-out (bank reconciliation mirror, 2026-07)
//
// Proves GL cash/CC balances against the Xoro bank mirror
// (bank_transactions, source='xoro_mirror') AS OF the last month Xoro
// reconciled against physical bank statements (RECONCILED_THROUGH from
// api/_lib/bank-mirror/mirror.js). Unlike the control tie-outs above,
// this is an AS-OF comparison, so it reads dated journal_entry_lines
// directly (v_trial_balance is an all-time rollup and can't be dated).
//
// Sign convention matches the P6 recon RPC: balances on the account's
// NORMAL side (DEBIT-normal DR−CR, CREDIT-normal CR−DR) so a credit card
// reads positive-owed on both sides.
//
// KNOWN ONE-SIDEDNESS: the mirror carries Xoro's PAYMENTS register only —
// AR receipts (deposits) exist in neither the mirror nor the GL yet
// (ar_receipts is empty). Both sides being outflow-only means this
// tie-out proves mirror⇄GL agreement, while absolute balances stay
// negative until the deposit side (AR receipts backfill or Plaid) lands.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Run the cash-mirror tie-out for every mirrored bank account.
 * Returns { rows, meta } shaped like runControlTieouts:
 * rows[]: {account_code, name, kind, side, gl_cents, subledger_cents
 *          (= mirror balance), diff_cents, status: 'ok'|'break', as_of}.
 */
export async function runCashMirrorTieouts(admin, entity_id, { asOf } = {}) {
  const { RECONCILED_THROUGH, MIRROR_ACCOUNTS } = await import("../bank-mirror/mirror.js");
  const cutoff = asOf || RECONCILED_THROUGH;

  const specByCode = new Map(MIRROR_ACCOUNTS.map((s) => [s.code, s]));
  const { data: banks, error: bErr } = await admin
    .from("bank_accounts")
    .select("id, name, account_kind, gl_account_id, gl_accounts!inner(code, name, normal_balance, entity_id)")
    .eq("entity_id", entity_id)
    .eq("feed_source", "xoro_mirror")
    .eq("is_active", true);
  if (bErr) throw new Error(`bank_accounts read failed: ${bErr.message}`);

  const rows = [];
  for (const b of banks || []) {
    const gl = b.gl_accounts;
    const spec = specByCode.get(gl.code);
    const side = gl.normal_balance === "CREDIT" ? "credit" : "debit";
    const sign = side === "credit" ? -1 : 1;

    // Mirror balance through cutoff.
    let mirror_cents = 0;
    {
      const txns = await fetchAllPages(admin, (a) =>
        a
          .from("bank_transactions")
          .select("amount_cents")
          .eq("bank_account_id", b.id)
          .eq("source", "xoro_mirror")
          .lte("posted_date", cutoff)
          .order("id", { ascending: true }),
      );
      for (const t of txns) mirror_cents += sign * intCents(t.amount_cents);
    }

    // GL balance through cutoff (posted ACCRUAL lines; debit/credit are DOLLARS).
    let gl_cents = 0;
    {
      const lines = await fetchAllPages(admin, (a) =>
        a
          .from("journal_entry_lines")
          .select("debit, credit, journal_entries!inner(posting_date, status, basis, entity_id)")
          .eq("account_id", b.gl_account_id)
          .eq("journal_entries.status", "posted")
          .eq("journal_entries.basis", "ACCRUAL")
          .eq("journal_entries.entity_id", entity_id)
          .lte("journal_entries.posting_date", cutoff)
          .order("id", { ascending: true }),
      );
      for (const l of lines) gl_cents += sign * (dollarsToCents(l.debit) - dollarsToCents(l.credit));
    }

    const diff_cents = gl_cents - mirror_cents;
    rows.push({
      account_code: gl.code,
      name: gl.name,
      kind: spec?.tieout || b.account_kind,
      side,
      gl_cents,
      subledger_cents: mirror_cents,
      diff_cents,
      status: Math.abs(diff_cents) <= TOLERANCE_CENTS ? "ok" : "break",
      as_of: cutoff,
    });
  }
  rows.sort((a, b) => a.account_code.localeCompare(b.account_code));
  return {
    rows,
    meta: {
      as_of: cutoff,
      mirrored_accounts: rows.length,
      note: "mirror carries Xoro payments register only — deposits absent from BOTH sides until AR receipts/Plaid land",
    },
  };
}
