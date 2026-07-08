// api/_lib/accounting/posting/rules/apInvoiceReceived.js
//
// Vendor bill recognized (accrual side only). Cash basis recognizes expense
// at PAYMENT, not at bill receipt, so the cash JE for this event is null.
//
// Accrual: DR expense_account (or inventory_account, per line) / CR ap_account
// Cash:    none
//
// Two payload shapes are supported:
//   1. Single-amount (legacy/simple): event.data.amount + expense_account_id +
//      ap_account_id. Produces one DR line + one CR AP line.
//   2. Multi-line (arch §3.2/§3.5): event.data.lines = [{ amount,
//      expense_account_id, inventory_item_id?, inventory_account_id?, memo? }].
//      Produces one DR line per input line + one CR AP line for the total.
//      Lines with inventory_item_id MUST also carry inventory_account_id
//      (the gl_accounts.id for inventory).
//
// P3-4 (FIFO ↔ AP integration, arch §4.5): inventory lines that ALSO carry
// `qty` + `unit_cost_cents` produce a pending `inventoryLayers[]` entry on the
// rule output. The posting service consumes this list AFTER the JE persists
// successfully and calls fifo.createLayer() for each one. If a line has
// inventory_item_id but no qty/unit_cost_cents, no layer is queued (the JE
// still posts) — this preserves backwards compatibility with the multi-line
// path that pre-dates the FIFO wiring.

/**
 * @param {import('../types.js').PostingEvent} event
 *   event.data = {
 *     invoice_id: string,
 *     vendor_id: string,
 *     invoice_number: string,
 *     invoice_date: 'YYYY-MM-DD',
 *     ap_account_id: string,
 *     // EITHER (single-amount path):
 *     amount?: string,                 // decimal string
 *     expense_account_id?: string,
 *     // OR (multi-line path):
 *     lines?: Array<{
 *       amount: string,
 *       expense_account_id: string,
 *       inventory_item_id?: string,    // when set, this is an inventory line
 *       inventory_account_id?: string, // required when inventory_item_id set
 *       qty?: number|string,           // optional — when set with inventory_item_id + unit_cost_cents, queues a FIFO layer (P3-4)
 *       unit_cost_cents?: number|string|bigint, // optional — see qty
 *       memo?: string,
 *     }>,
 *   }
 * @returns {import('../types.js').PostingRuleOutput} also carries optional
 *   `inventoryLayers: Array<{item_id, qty, unit_cost_cents, source_invoice_id, received_at, ...}>`
 *   when any line had inventory_item_id + qty + unit_cost_cents (P3-4).
 */
export function apInvoiceReceived(event) {
  const d = event.data;
  required(d, ["invoice_id", "vendor_id", "invoice_number", "invoice_date", "ap_account_id"]);

  const desc = `AP invoice ${d.invoice_number}`;
  const useMultiLine = Array.isArray(d.lines) && d.lines.length > 0;

  let drLines;
  let totalCents;
  const inventoryLayers = [];
  // Manufacturing (M5b): a PART line stocks a part_master part into its OWN FIFO
  // pool (1207 Inventory-Parts, subledger=part). Drained by postEvent's
  // partInventoryLayers branch — parts are kept separate from style inventory.
  const partInventoryLayers = [];

  if (useMultiLine) {
    drLines = [];
    totalCents = 0n;
    let lineNumber = 1;
    for (const ln of d.lines) {
      if (!ln || ln.amount == null || ln.amount === "") {
        throw new Error(`apInvoiceReceived: each line requires amount`);
      }
      const isPartLine = !!ln.part_id;
      if (isPartLine) {
        if (!ln.part_inventory_account_id) {
          throw new Error(`apInvoiceReceived: part line requires part_inventory_account_id`);
        }
      } else if (ln.inventory_item_id) {
        if (!ln.inventory_account_id) {
          throw new Error(`apInvoiceReceived: inventory line requires inventory_account_id`);
        }
      } else if (!ln.expense_account_id) {
        throw new Error(`apInvoiceReceived: expense line requires expense_account_id`);
      }

      const accountId = isPartLine ? ln.part_inventory_account_id
        : ln.inventory_item_id ? ln.inventory_account_id : ln.expense_account_id;
      const memo = ln.memo || desc;
      const subType = isPartLine ? "part" : ln.inventory_item_id ? "item" : null;
      const subId = isPartLine ? ln.part_id : (ln.inventory_item_id || null);

      drLines.push({
        line_number: lineNumber++,
        account_id: accountId,
        debit: ln.amount,
        credit: "0",
        memo,
        subledger_type: subType,
        subledger_id: subId,
      });
      totalCents += toCents(ln.amount);

      // M5b: queue a PART FIFO layer for a part line with qty + unit_cost_cents.
      if (isPartLine && ln.qty != null && ln.qty !== "" && ln.unit_cost_cents != null && ln.unit_cost_cents !== "") {
        partInventoryLayers.push({
          part_id: ln.part_id,
          qty: ln.qty,
          unit_cost_cents: ln.unit_cost_cents,
          source_kind: "ap_invoice",
          source_invoice_id: d.invoice_id,
          location_id: ln.location_id || d.receiving_location_id || null,
          received_at: d.invoice_date,
          notes: ln.memo || null,
        });
      }

      // P3-4: queue a FIFO layer for any inventory line that supplied qty +
      // unit_cost_cents. Lines without these stay JE-only (legacy behavior).
      if (
        !isPartLine && ln.inventory_item_id &&
        ln.qty != null && ln.qty !== "" &&
        ln.unit_cost_cents != null && ln.unit_cost_cents !== ""
      ) {
        inventoryLayers.push({
          item_id: ln.inventory_item_id,
          qty: ln.qty,
          unit_cost_cents: ln.unit_cost_cents,
          source_invoice_id: d.invoice_id,
          partition_id: d.receiving_partition_id || null, // P15 brand stock pool
          received_at: d.invoice_date, // YYYY-MM-DD — fifo.createLayer accepts ISO; PG casts to timestamptz
          notes: ln.memo || null,
        });
      }
    }

    // CR AP total
    drLines.push({
      line_number: lineNumber,
      account_id: d.ap_account_id,
      debit: "0",
      credit: fromCents(totalCents),
      memo: desc,
      subledger_type: "vendor",
      subledger_id: d.vendor_id,
    });
  } else {
    // Single-amount path
    required(d, ["amount", "expense_account_id"]);
    drLines = [
      {
        line_number: 1,
        account_id: d.expense_account_id,
        debit: d.amount,
        credit: "0",
        memo: desc,
        subledger_type: null,
        subledger_id: null,
      },
      {
        line_number: 2,
        account_id: d.ap_account_id,
        debit: "0",
        credit: d.amount,
        memo: desc,
        subledger_type: "vendor",
        subledger_id: d.vendor_id,
      },
    ];
  }

  // Vendor credit memo (#3B): reverse every line — the expense lines now CREDIT
  // (offsetting the expense) and the AP control line DEBITs (reducing the payable
  // / recording a vendor receivable). A non-inventory credit (e.g. recovering a
  // personal portion of an expense) just flips DR/CR. Inventory credit memos
  // (returns to vendor) would need a FIFO consume, not a layer — so we DROP the
  // queued layers here and leave inventory returns to a dedicated path.
  const isCredit = d.invoice_kind === "vendor_credit_memo";
  if (isCredit) {
    for (const ln of drLines) {
      const d0 = ln.debit, c0 = ln.credit;
      ln.debit = c0;
      ln.credit = d0;
    }
    inventoryLayers.length = 0;
    partInventoryLayers.length = 0;
  }

  const accrual = {
    entity_id: event.entity_id,
    basis: "ACCRUAL",
    journal_type: isCredit ? "ap_credit_memo" : "ap_invoice",
    posting_date: d.invoice_date,
    source_module: "ap",
    source_table: "invoices",
    source_id: d.invoice_id,
    description: isCredit ? `AP credit memo ${d.invoice_number}` : desc,
    created_by_user_id: event.created_by_user_id ?? null,
    lines: drLines,
  };

  // inventoryLayers / partInventoryLayers are omitted when empty to keep parity
  // with rules that don't emit them (manualEntry, apInvoicePaid, etc).
  const out = { accrual, cash: null };
  if (inventoryLayers.length > 0) out.inventoryLayers = inventoryLayers;
  if (partInventoryLayers.length > 0) out.partInventoryLayers = partInventoryLayers;
  return out;
}

function required(obj, fields) {
  for (const f of fields) {
    if (obj?.[f] == null || obj[f] === "") {
      throw new Error(`apInvoiceReceived: data.${f} is required`);
    }
  }
}

// Money math in BigInt cents — decimal-string -> bigint(cents) -> decimal-string.
function toCents(amountStr) {
  const s = typeof amountStr === "string" ? amountStr : String(amountStr);
  if (!/^-?\d+(\.\d+)?$/.test(s)) {
    throw new Error(`apInvoiceReceived: invalid amount: ${amountStr}`);
  }
  const [whole, frac = ""] = s.split(".");
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
