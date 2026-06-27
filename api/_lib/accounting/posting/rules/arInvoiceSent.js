// api/_lib/accounting/posting/rules/arInvoiceSent.js
//
// Customer invoice issued (P4-2; arch §4.1).
//
// Accrual: DR ar_account / CR revenue (per-line)
//          + per-inventory-line FIFO COGS pair (DR cogs / CR inventory) with
//          sentinel "0" amounts that postEvent rewrites after FIFO consume().
// Cash:    none — cash basis recognizes revenue at PAYMENT RECEIPT, not at
//          invoice send. See arPaymentReceived.js for the deferred cash JE.
//
// ──────────────────────────────────────────────────────────────────────────
// consumePlan contract (indexed mode — P4-3 drain)
// ──────────────────────────────────────────────────────────────────────────
//
// For each line that carries `inventory_item_id` + `quantity`, the rule
// emits TWO sentinel-amount JE lines (DR cogs / CR inventory both "0") AND a
// `consumePlan` entry carrying explicit `dr_line_ix` + `cr_line_ix` indices
// (zero-based) into the accrual.lines array. postEvent's consumePlan drain
// (P4-3 indexed-mode branch in posting/index.js):
//   1. Calls inventory_fifo_consume() per plan entry → per-entry cogs_cents.
//   2. Rewrites accrual.lines[dr_line_ix].debit + lines[cr_line_ix].credit
//      with the per-entry consumed cogs (not aggregated).
//   3. Drops any sentinel pair where consumed cogs is zero, then renumbers.
//
// Per-line cogs back-write to ar_invoice_lines.cogs_cents is a handler-side
// responsibility (uses consume_results from postEvent return shape).
//
// Atomicity asymmetry (same as P3-5 negative inventoryAdjustment): consume()
// mutates inventory_layers + inventory_consumption BEFORE the JE persists.
// If persist fails, FIFO ledger leads GL by one event. Accepted tradeoff.

/**
 * @param {import('../types.js').PostingEvent} event
 *   event.data = {
 *     invoice_id: string,                  // ar_invoice.id  (P4-2 normalized name)
 *     customer_id: string,
 *     invoice_number: string,
 *     invoice_date: 'YYYY-MM-DD',
 *     ar_account_id: string,
 *     revenue_account_id: string,          // default revenue account
 *     cogs_account_id?: string,            // required if any line has inventory_item_id
 *     inventory_account_id?: string,       // required if any line has inventory_item_id
 *     // Legacy single-amount path (P3-era compat):
 *     amount?: string,
 *     // Multi-line path (P4-2):
 *     lines?: Array<{
 *       id?: string,                       // ar_invoice_line.id (for cogs back-write)
 *       line_index?: number,
 *       description?: string,
 *       inventory_item_id?: string,
 *       quantity?: number|string,
 *       revenue_account_id?: string,       // per-line override
 *       unit_price_cents?: number|string|bigint,
 *       line_total_cents: number|string|bigint,
 *       line_total?: string,               // decimal-string alternative
 *     }>,
 *   }
 * @returns {import('../types.js').PostingRuleOutput}
 *   { accrual, cash: null,
 *     consumePlan?: Array<{ item_id, qty, consumer_kind:'ar_invoice',
 *       consumer_ref_id, target_line_id?, dr_line_ix, cr_line_ix }> }
 */
export function arInvoiceSent(event) {
  const d = event.data;
  required(d, ["invoice_id", "customer_id", "invoice_number", "invoice_date",
               "ar_account_id"]);

  const useMultiLine = Array.isArray(d.lines) && d.lines.length > 0;

  // ─── Legacy single-amount path (P3 compat) ──────────────────────────────
  if (!useMultiLine) {
    required(d, ["amount", "revenue_account_id"]);
    const accrual = {
      entity_id: event.entity_id,
      basis: "ACCRUAL",
      journal_type: d.journal_type || "ar_invoice",
      posting_date: d.invoice_date,
      source_module: "ar",
      source_table: "ar_invoices",
      source_id: d.invoice_id,
      description: `AR invoice ${d.invoice_number}`,
      created_by_user_id: event.created_by_user_id ?? null,
      bypass_period_lock: event.bypass_period_lock === true,
      lines: [
        {
          line_number: 1,
          account_id: d.ar_account_id,
          debit: d.amount,
          credit: "0",
          memo: `AR invoice ${d.invoice_number}`,
          subledger_type: "customer",
          subledger_id: d.customer_id,
        },
        {
          line_number: 2,
          account_id: d.revenue_account_id,
          debit: "0",
          credit: d.amount,
          memo: `AR invoice ${d.invoice_number}`,
          subledger_type: null,
          subledger_id: null,
        },
      ],
    };
    return { accrual, cash: null };
  }

  // ─── Multi-line path (P4-2) ─────────────────────────────────────────────
  required(d, ["revenue_account_id"]);

  const desc = `AR invoice ${d.invoice_number}`;

  // Build the revenue CR side per line and aggregate AR DR total.
  let arTotalCents = 0n;
  const revenueLines = [];
  const cogsLines = [];     // appended after revenue lines
  const consumePlan = [];
  let anyInventory = false;

  for (let i = 0; i < d.lines.length; i++) {
    const ln = d.lines[i];
    if (ln == null) {
      throw new Error(`arInvoiceSent: lines[${i}] is null`);
    }
    const amountCents = resolveLineTotalCents(ln, i);
    if (amountCents <= 0n) {
      throw new Error(`arInvoiceSent: lines[${i}] line_total must be > 0`);
    }
    arTotalCents += amountCents;

    const revenueAccountId = ln.revenue_account_id || d.revenue_account_id;
    const lineDesc = ln.description || desc;
    const lineIxLabel = ln.line_index != null ? ln.line_index : i + 1;

    revenueLines.push({
      // line_number renumbered below; placeholder here
      _kind: "revenue",
      account_id: revenueAccountId,
      debit: "0",
      credit: fromCents(amountCents),
      memo: lineDesc,
      subledger_type: null,
      subledger_id: null,
    });

    // Inventory line → emit sentinel COGS pair + consumePlan entry
    if (ln.inventory_item_id) {
      anyInventory = true;
      if (ln.quantity == null || ln.quantity === "") {
        throw new Error(
          `arInvoiceSent: lines[${i}] has inventory_item_id but no quantity`,
        );
      }
      if (!d.cogs_account_id) {
        throw new Error(
          `arInvoiceSent: data.cogs_account_id required when any line has inventory_item_id`,
        );
      }
      if (!d.inventory_account_id) {
        throw new Error(
          `arInvoiceSent: data.inventory_account_id required when any line has inventory_item_id`,
        );
      }
      // Final line layout: [headerAr at 0, ...revenueLines (1..d.lines.length),
      // ...cogsLines (DR/CR pairs)]. Before pushing this pair, cogsLines.length
      // is the count of indices already taken by earlier cogs pairs (= 2k).
      const drIx = 1 + d.lines.length + cogsLines.length;
      const crIx = drIx + 1;
      const cogsMemo = `COGS ${d.invoice_number} L${lineIxLabel}`;
      // Per-style COGS routing (#6): use the line's own COGS account when set
      // (stamped from the style's brand bucket), else the invoice-level default.
      const lineCogsAccountId = ln.cogs_account_id || d.cogs_account_id;
      cogsLines.push({
        _kind: "cogs_dr",
        account_id: lineCogsAccountId,
        debit: "0",   // sentinel — rewritten by postEvent after consume()
        credit: "0",
        memo: cogsMemo,
        subledger_type: "item",
        subledger_id: ln.inventory_item_id,
      });
      cogsLines.push({
        _kind: "cogs_cr",
        account_id: d.inventory_account_id,
        debit: "0",
        credit: "0", // sentinel — rewritten by postEvent after consume()
        memo: cogsMemo,
        subledger_type: "item",
        subledger_id: ln.inventory_item_id,
      });
      consumePlan.push({
        item_id: ln.inventory_item_id,
        qty: ln.quantity,
        consumer_kind: "ar_invoice",
        consumer_ref_id: ln.id || d.invoice_id,
        target_line_id: ln.id || null,
        // P15 — draw from the sale's brand pool when the AR post resolved one
        // (only under BRAND_SCOPE_MODE=enforce; null otherwise → all layers).
        partition_id: d.consume_partition_id || null,
        dr_line_ix: drIx,
        cr_line_ix: crIx,
      });
    }
  }

  // DR AR header line — sum of all revenue line credits.
  const headerArLine = {
    _kind: "ar",
    account_id: d.ar_account_id,
    debit: fromCents(arTotalCents),
    credit: "0",
    memo: desc,
    subledger_type: "customer",
    subledger_id: d.customer_id,
  };

  // Assemble: [AR header, ...revenue lines, ...cogs lines].
  // Each consumePlan entry carries dr_line_ix + cr_line_ix that point
  // directly at the sentinel cogs pair below. The indexed-mode drain in
  // postEvent (posting/index.js) rewrites those specific positions and
  // drops any pair whose consumed cogs comes back zero, then renumbers.
  const allLines = [headerArLine, ...revenueLines, ...cogsLines];
  const lines = allLines.map((l, idx) => ({
    line_number: idx + 1,
    account_id: l.account_id,
    debit: l.debit,
    credit: l.credit,
    memo: l.memo,
    subledger_type: l.subledger_type ?? null,
    subledger_id: l.subledger_id ?? null,
  }));

  const accrual = {
    entity_id: event.entity_id,
    basis: "ACCRUAL",
    journal_type: d.journal_type || "ar_invoice",
    posting_date: d.invoice_date,
    source_module: "ar",
    source_table: "ar_invoices",
    source_id: d.invoice_id,
    description: desc,
    created_by_user_id: event.created_by_user_id ?? null,
    bypass_period_lock: event.bypass_period_lock === true,
    lines,
  };

  const output = { accrual, cash: null };
  if (anyInventory && consumePlan.length > 0) {
    output.consumePlan = consumePlan;
  }
  return output;
}

// ────────────────────────────────────────────────────────────────────────────
// helpers
// ────────────────────────────────────────────────────────────────────────────

function required(obj, fields) {
  for (const f of fields) {
    if (obj?.[f] == null || obj[f] === "") {
      throw new Error(`arInvoiceSent: data.${f} is required`);
    }
  }
}

// Accepts either:
//   line_total_cents (number|bigint|string-of-integer)  → use directly
//   line_total       (decimal string e.g. "100.00")     → parse + scale
function resolveLineTotalCents(ln, idx) {
  if (ln.line_total_cents != null && ln.line_total_cents !== "") {
    return toBigIntCents(ln.line_total_cents, `lines[${idx}].line_total_cents`);
  }
  if (ln.line_total != null && ln.line_total !== "") {
    return decimalStringToCents(ln.line_total, `lines[${idx}].line_total`);
  }
  throw new Error(
    `arInvoiceSent: lines[${idx}] requires line_total_cents or line_total`,
  );
}

function toBigIntCents(v, name) {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v) || !Number.isInteger(v)) {
      throw new Error(`arInvoiceSent: ${name} must be integer cents (got ${v})`);
    }
    return BigInt(v);
  }
  if (typeof v === "string") {
    if (!/^-?\d+$/.test(v)) {
      throw new Error(`arInvoiceSent: ${name} must be integer cents string (got ${v})`);
    }
    return BigInt(v);
  }
  throw new Error(`arInvoiceSent: ${name} must be number|string|bigint (got ${typeof v})`);
}

function decimalStringToCents(s, name) {
  const str = typeof s === "string" ? s : String(s);
  if (!/^-?\d+(\.\d+)?$/.test(str)) {
    throw new Error(`arInvoiceSent: ${name} invalid decimal (got ${str})`);
  }
  const [whole, frac = ""] = str.split(".");
  const padded = (frac + "00").slice(0, 2);
  const sign = whole.startsWith("-") ? -1n : 1n;
  const wholeAbs = whole.replace(/^-/, "");
  return sign * (BigInt(wholeAbs) * 100n + BigInt(padded));
}

// bigint cents → "123.45"
function fromCents(cents) {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const whole = abs / 100n;
  const frac = abs % 100n;
  const fracStr = frac.toString().padStart(2, "0");
  return `${neg ? "-" : ""}${whole.toString()}.${fracStr}`;
}
