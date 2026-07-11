// api/_lib/accounting/apBillPosting.js
//
// Pure composition core for per-bill AP GL posting (Xoro-mirrored bills).
//
// Why per-bill: the old daily AP summary (composeApSummaryPayload) credited
// control account 2000 with no vendor subledger, so the post-guard trigger
// rejected it — zero AP JEs ever posted (confirmed in prod during the
// 2026-07-08 re-rate). Per-bill posting with a vendor subledger makes the AP
// control account tie out to the bill subledger by construction.
//
// Routing model (#xoro-account-truth 2026-07-11 — the bill feed now carries
// the GL account XORO posted each line to; per CEO directive that account is
// the 100% source of truth). Precedence for the expense side:
//   bill line's own Xoro account (invoice_line_items.expense_account_id,
//   resolved at ingest by xoroAccountMap.js) > vendor default expense
//   account > 8007 Uncategorized Expense.
//   - item-linked lines (inventory_item_id resolved)  → DR Inventory 1201
//     (purchases build inventory; the per-invoice AR history posts COGS that
//     relieves it — coherent periodic-inventory model)
//   - non-item lines WITH a resolved Xoro account     → DR that account
//     (one JE line per distinct account)
//   - non-item lines without one + tax/rounding plug  → DR the vendor's
//     default expense account when one is set (vendors.
//     default_gl_expense_account_id, passed as accounts.vendorExpense),
//     else DR Uncategorized Expense 8007 (operator re-routes later;
//     nothing silently disappears)
//   - CR Accounts Payable 2000, subledger vendor       (control account)
// Credit memos (negative totals) post with the directions flipped.
//
// journal_type 'ap_invoice_historical' rides the P4 period-lock bypass so
// bills dated into soft/hard-closed months still post during the backfill.

export const AP_BILL_ACCOUNT_CODES = ["1201", "8007", "2000"];

/**
 * Integer-cents split of a bill's lines into goods (item-linked) vs other.
 * Non-goods cents are additionally bucketed by the line's resolved Xoro
 * expense account (expense_account_id; null key = no resolved account) so
 * the composer can honor bill-level account truth. `allowedAccountIds`
 * (optional Set) drops ids the caller could not validate (postable,
 * non-control, active, this entity) back into the null bucket.
 */
export function splitBillLineCents(lines, allowedAccountIds = null) {
  let goods = 0n;
  let other = 0n;
  const other_by_account = new Map();
  for (const l of lines || []) {
    const qty = Number(l.quantity ?? l.qty ?? 0) || 0;
    const unit = Number(l.unit_cost_cents ?? 0) || 0;
    const cents = BigInt(Math.round(qty * unit));
    if (l.inventory_item_id) { goods += cents; continue; }
    other += cents;
    let key = l.expense_account_id || null;
    if (key && allowedAccountIds && !allowedAccountIds.has(key)) key = null;
    other_by_account.set(key, (other_by_account.get(key) || 0n) + cents);
  }
  return { goods_cents: goods, other_cents: other, other_by_account };
}

function dollars(centsBig) {
  const neg = centsBig < 0n;
  const abs = neg ? -centsBig : centsBig;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

/**
 * Compose the gl_post_journal_entry payload for one bill.
 * Returns null when the bill nets to zero (nothing to post).
 *
 * @param {object} p
 * @param {string} p.entity_id
 * @param {object} p.bill    invoices row: id, invoice_number, vendor_id,
 *                           posting/invoice date fields, total_amount_cents
 * @param {bigint} p.goods_cents  from splitBillLineCents
 * @param {bigint} p.other_cents  from splitBillLineCents
 * @param {Map<string|null,bigint>} [p.other_by_account]  from
 *                                   splitBillLineCents — non-goods cents per
 *                                   resolved Xoro expense account. When
 *                                   present, each non-null account gets its
 *                                   own JE line (bill account truth beats
 *                                   the vendor default); the null bucket +
 *                                   tax/rounding plug fall through to
 *                                   vendorExpense/fallbackExpense.
 * @param {object} p.accounts     { inventory, fallbackExpense, ap,
 *                                   vendorExpense? } (uuids). vendorExpense
 *                                   (nullable) is the bill vendor's default
 *                                   expense account; when present it takes
 *                                   the unresolved non-item/plug line
 *                                   instead of fallbackExpense.
 */
export function composeApBillJe({ entity_id, bill, goods_cents, other_cents, other_by_account, accounts }) {
  const total = BigInt(Math.round(Number(bill.total_amount_cents) || 0));
  if (total === 0n) return null;
  if (!bill.vendor_id) return null; // 2000 is control — a vendor subledger is mandatory

  // Tax + rounding remainder goes to the fallback expense line so the JE
  // always balances to the bill total exactly.
  const plug = total - (goods_cents + other_cents);

  const posting_date = bill.posting_date || bill.invoice_date;
  const lines = [];
  let n = 1;
  const addSigned = (account_id, cents, memo) => {
    if (cents === 0n) return;
    lines.push({
      line_number: n++,
      account_id,
      debit: cents > 0n ? dollars(cents) : "0",
      credit: cents < 0n ? dollars(-cents) : "0",
      memo,
    });
  };
  addSigned(accounts.inventory, goods_cents, `Goods — bill ${bill.invoice_number}`);
  // Expense side. Precedence: line's own Xoro account > vendor default >
  // 8007. Cents with a resolved account post to it directly; everything
  // else (unresolved lines + tax/rounding plug) takes the fallback route.
  let routed = 0n;
  if (other_by_account instanceof Map) {
    for (const [acctId, cents] of other_by_account) {
      if (!acctId || cents === 0n) continue;
      addSigned(acctId, cents, `Xoro-classified — bill ${bill.invoice_number}`);
      routed += cents;
    }
  }
  const expense_cents = (other_cents - routed) + plug;
  addSigned(accounts.vendorExpense || accounts.fallbackExpense, expense_cents, `Non-item/tax — bill ${bill.invoice_number}`);
  // AP side: negated total (credit for a normal bill, debit for a credit memo).
  if (total !== 0n) {
    lines.push({
      line_number: n++,
      account_id: accounts.ap,
      debit: total < 0n ? dollars(-total) : "0",
      credit: total > 0n ? dollars(total) : "0",
      memo: `AP — bill ${bill.invoice_number}`,
      subledger_type: "vendor",
      subledger_id: bill.vendor_id,
    });
  }
  if (lines.length < 2) return null;

  return {
    entity_id,
    basis: "ACCRUAL",
    journal_type: "ap_invoice_historical",
    posting_date,
    source_module: "ap",
    source_table: "invoices",
    source_id: bill.id,
    description: `Xoro AP bill ${bill.invoice_number}`,
    audit_reason: `Per-bill AP GL posting from Xoro bill feed (re-rate 2026-07-08 remediation) — bill ${bill.invoice_number}`,
    lines,
  };
}
