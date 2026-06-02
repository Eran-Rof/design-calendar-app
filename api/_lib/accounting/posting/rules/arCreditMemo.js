// api/_lib/accounting/posting/rules/arCreditMemo.js
//
// Customer credit memo (P4-2; arch §4.4).
//
// Credit memos reduce the customer's AR balance and reverse the recognized
// revenue. They are the inverse of arInvoiceSent — same line shape, but with
// the DR/CR swapped:
//
// Accrual: CR ar_account (reduces customer's open AR)
//          DR revenue (per-line; reverses the recognized revenue)
//          For inventory-return lines (line.inventory_item_id set):
//            DR inventory_asset_account  (put goods back on the books)
//            CR cogs_account             (reverse the COGS hit)
//          Plus an inventoryLayers[] entry per return line so postEvent's
//          P3-4 layer-creation drain re-adds the qty to FIFO.
//          source_kind='credit_memo_return' (NEW value — see schema-coord note).
//
// Cash:    null
//   Cash impact happens only if the ORIGINAL invoice was already paid (cash
//   was already received + recognized as revenue in the cash book). The
//   refund flow (returning cash to the customer) is owned by a separate
//   event 'ar_credit_refund' that arch §4.4 defers to a later chunk. P4-2
//   leaves a TODO for the refund cash twin.
//
// ──────────────────────────────────────────────────────────────────────────
// Cost basis for return layers
// ──────────────────────────────────────────────────────────────────────────
// The arch (§4.4) recommends pulling the latest open layer's cost for the
// item as the return layer's unit_cost. Since the rule itself is a pure
// data-producer (sync, no DB), the AR credit-memo HANDLER (P4-3 / P4-4)
// performs the cost lookup and passes it on each line as
// `return_unit_cost_cents`. The rule trusts that field; if missing for a
// return line, the rule errors out so the handler is forced to surface a
// resolution UI rather than silently zero-cost the return.
//
// ──────────────────────────────────────────────────────────────────────────
// Schema coordination — inventory_layers.source_kind
// ──────────────────────────────────────────────────────────────────────────
// The current `inventory_layers_source_kind_check` constraint (P3-3 schema)
// only allows {ap_invoice, adjustment, opening_balance, transfer_in}.
// P4-1's migration MUST extend this to include 'credit_memo_return' before
// P4-2 inventoryLayers[] writes go live in prod. If P4-1 forgot it, the
// constraint will reject the insert; the rule still emits the layer entry
// (correctness first), and the postEvent drain logs a layer_create_error.
// The PR description for P4-2 must call this out explicitly so P4-1 is
// updated in lockstep.

/**
 * @param {import('../types.js').PostingEvent} event
 *   event.data = {
 *     credit_memo_id: string,              // ar_invoices.id where invoice_kind='customer_credit_memo'
 *     customer_id: string,
 *     credit_memo_number: string,
 *     posting_date: 'YYYY-MM-DD',
 *     original_invoice_id?: string,        // optional — informational; standalone credits allowed
 *     ar_account_id: string,
 *     revenue_account_id: string,
 *     cogs_account_id?: string,            // required if any line is inventory-return
 *     inventory_account_id?: string,       // required if any line is inventory-return
 *     lines: Array<{
 *       id?: string,
 *       line_index?: number,
 *       description?: string,
 *       inventory_item_id?: string,        // when set, this is an inventory-return line
 *       quantity?: number|string,          // required when inventory_item_id set
 *       return_unit_cost_cents?: number|string|bigint,   // REQUIRED when inventory_item_id set; handler resolves from latest layer
 *       revenue_account_id?: string,       // per-line override
 *       unit_price_cents?: number|string|bigint,
 *       line_total_cents: number|string|bigint,
 *       line_total?: string,
 *     }>,
 *   }
 *   event.bypass_period_lock?: boolean
 * @returns {import('../types.js').PostingRuleOutput}
 *   { accrual, cash: null, inventoryLayers?: [...] }
 */
export function arCreditMemo(event) {
  const d = event.data;
  required(d, ["credit_memo_id", "customer_id", "credit_memo_number",
               "posting_date", "ar_account_id", "revenue_account_id"]);

  if (!Array.isArray(d.lines) || d.lines.length === 0) {
    throw new Error(`arCreditMemo: data.lines must be a non-empty array`);
  }

  const desc = d.original_invoice_id
    ? `AR credit memo ${d.credit_memo_number} (vs invoice ${d.original_invoice_id})`
    : `AR credit memo ${d.credit_memo_number}`;
  const journalType = d.journal_type || "ar_credit_memo";
  const bypassPeriodLock = event.bypass_period_lock === true;

  // ─── Build the revenue DR side per line + inventory return pair if applicable ───
  let arTotalCents = 0n;
  const revenueLines = [];
  const inventoryReturnLines = [];  // DR inventory / CR cogs pairs
  const inventoryLayers = [];
  let anyInventory = false;

  for (let i = 0; i < d.lines.length; i++) {
    const ln = d.lines[i];
    if (ln == null) {
      throw new Error(`arCreditMemo: lines[${i}] is null`);
    }
    const amountCents = resolveLineTotalCents(ln, i);
    if (amountCents <= 0n) {
      throw new Error(`arCreditMemo: lines[${i}] line_total must be > 0`);
    }
    arTotalCents += amountCents;

    const revenueAccountId = ln.revenue_account_id || d.revenue_account_id;
    const lineDesc = ln.description || desc;
    const lineIxLabel = ln.line_index != null ? ln.line_index : i + 1;

    // DR revenue (reverses prior revenue recognition)
    revenueLines.push({
      _kind: "revenue_dr",
      account_id: revenueAccountId,
      debit: fromCents(amountCents),
      credit: "0",
      memo: lineDesc,
      subledger_type: null,
      subledger_id: null,
    });

    // Inventory-return line
    if (ln.inventory_item_id) {
      anyInventory = true;
      if (ln.quantity == null || ln.quantity === "") {
        throw new Error(
          `arCreditMemo: lines[${i}] has inventory_item_id but no quantity`,
        );
      }
      if (ln.return_unit_cost_cents == null || ln.return_unit_cost_cents === "") {
        throw new Error(
          `arCreditMemo: lines[${i}] has inventory_item_id but no return_unit_cost_cents ` +
          `(handler must resolve from latest open layer before invoking rule)`,
        );
      }
      if (!d.cogs_account_id) {
        throw new Error(
          `arCreditMemo: data.cogs_account_id required when any line has inventory_item_id`,
        );
      }
      if (!d.inventory_account_id) {
        throw new Error(
          `arCreditMemo: data.inventory_account_id required when any line has inventory_item_id`,
        );
      }
      const qty = Number(ln.quantity);
      if (!Number.isFinite(qty) || qty <= 0) {
        throw new Error(`arCreditMemo: lines[${i}].quantity must be > 0`);
      }
      const unitCostCents = toBigIntCents(ln.return_unit_cost_cents, `lines[${i}].return_unit_cost_cents`);
      if (unitCostCents < 0n) {
        throw new Error(`arCreditMemo: lines[${i}].return_unit_cost_cents must be >= 0`);
      }
      // Total return cost = qty × unit_cost_cents (BigInt math)
      const qtyScaled = BigInt(Math.trunc(qty * 10000));
      const returnCostCents = (qtyScaled * unitCostCents) / 10000n;
      const returnCostStr = fromCents(returnCostCents);
      const returnMemo = `Return ${d.credit_memo_number} L${lineIxLabel}`;

      // DR inventory_asset  (puts goods back on the books)
      inventoryReturnLines.push({
        _kind: "inv_dr",
        account_id: d.inventory_account_id,
        debit: returnCostStr,
        credit: "0",
        memo: returnMemo,
        subledger_type: "item",
        subledger_id: ln.inventory_item_id,
      });
      // CR cogs              (reverses the COGS recognized at the original invoice send)
      inventoryReturnLines.push({
        _kind: "cogs_cr",
        account_id: d.cogs_account_id,
        debit: "0",
        credit: returnCostStr,
        memo: returnMemo,
        subledger_type: "item",
        subledger_id: ln.inventory_item_id,
      });
      // New inventory layer at the resolved cost. source_kind requires
      // P4-1 to extend the CHECK constraint (see top-of-file note).
      inventoryLayers.push({
        item_id: ln.inventory_item_id,
        qty,
        unit_cost_cents: ln.return_unit_cost_cents,
        source_kind: "credit_memo_return",
        source_credit_memo_id: d.credit_memo_id,
        // Re-using source_adjustment_id slot as a generic source-ref pointer
        // is wrong (it's an FK to inventory_adjustments). The handler resolves
        // the proper FK at insert time; for the drain we pass a soft ref via
        // notes and leave the FK columns null.
        received_at: d.posting_date,
        notes: `credit memo ${d.credit_memo_number} L${lineIxLabel}`,
      });
    }
  }

  // CR AR header line — sum of all revenue debits.
  const headerArLine = {
    _kind: "ar_cr",
    account_id: d.ar_account_id,
    debit: "0",
    credit: fromCents(arTotalCents),
    memo: desc,
    subledger_type: "customer",
    subledger_id: d.customer_id,
  };

  // Assemble: [AR header CR, ...revenue DRs, ...inventory-return DR/CR pairs]
  const allLines = [headerArLine, ...revenueLines, ...inventoryReturnLines];
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
    journal_type: journalType,
    posting_date: d.posting_date,
    source_module: "ar",
    source_table: "ar_invoices",
    source_id: d.credit_memo_id,
    description: desc,
    created_by_user_id: event.created_by_user_id ?? null,
    bypass_period_lock: bypassPeriodLock,
    lines,
  };

  // TODO: when the ORIGINAL invoice had a cash-side JE (cash payment already
  // received), the credit memo should ALSO emit a cash twin that mirrors the
  // refund. This requires the handler to look up original_invoice.cash_je_id;
  // when set, the cash JE has shape:
  //   DR revenue / CR bank_account_id  (refund)
  // P4-2 scope leaves this as null and defers the refund cash twin to a
  // future arCreditRefund event. The accrual side covers the AR/revenue
  // reversal regardless of payment state.

  const output = { accrual, cash: null };
  if (anyInventory && inventoryLayers.length > 0) {
    output.inventoryLayers = inventoryLayers;
  }
  return output;
}

// ────────────────────────────────────────────────────────────────────────────
// helpers
// ────────────────────────────────────────────────────────────────────────────

function required(obj, fields) {
  for (const f of fields) {
    if (obj?.[f] == null || obj[f] === "") {
      throw new Error(`arCreditMemo: data.${f} is required`);
    }
  }
}

function resolveLineTotalCents(ln, idx) {
  if (ln.line_total_cents != null && ln.line_total_cents !== "") {
    return toBigIntCents(ln.line_total_cents, `lines[${idx}].line_total_cents`);
  }
  if (ln.line_total != null && ln.line_total !== "") {
    return decimalStringToCents(ln.line_total, `lines[${idx}].line_total`);
  }
  throw new Error(
    `arCreditMemo: lines[${idx}] requires line_total_cents or line_total`,
  );
}

function toBigIntCents(v, name) {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v) || !Number.isInteger(v)) {
      throw new Error(`arCreditMemo: ${name} must be integer cents (got ${v})`);
    }
    return BigInt(v);
  }
  if (typeof v === "string") {
    if (!/^-?\d+$/.test(v)) {
      throw new Error(`arCreditMemo: ${name} must be integer cents string (got ${v})`);
    }
    return BigInt(v);
  }
  throw new Error(`arCreditMemo: ${name} must be number|string|bigint (got ${typeof v})`);
}

function decimalStringToCents(s, name) {
  const str = typeof s === "string" ? s : String(s);
  if (!/^-?\d+(\.\d+)?$/.test(str)) {
    throw new Error(`arCreditMemo: ${name} invalid decimal (got ${str})`);
  }
  const [whole, frac = ""] = str.split(".");
  const padded = (frac + "00").slice(0, 2);
  const sign = whole.startsWith("-") ? -1n : 1n;
  const wholeAbs = whole.replace(/^-/, "");
  return sign * (BigInt(wholeAbs) * 100n + BigInt(padded));
}

function fromCents(cents) {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const whole = abs / 100n;
  const frac = abs % 100n;
  const fracStr = frac.toString().padStart(2, "0");
  return `${neg ? "-" : ""}${whole.toString()}.${fracStr}`;
}
