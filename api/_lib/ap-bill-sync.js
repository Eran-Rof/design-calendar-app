// api/_lib/ap-bill-sync.js
//
// Pure parsing/mapping core for POST /api/ap/sync-bills — the REST AP-bill
// ingest from Xoro's bill/getbill (the nightly rof_xoro_project
// scripts/rest_ap_sync.py downloads bills and POSTs the gzipped CSV here).
//
// The CSV is one row per (bill, line). The pre-agreed column contract
// (do NOT change without coordinating with rest_ap_sync.py):
//
//   Bill Number, Bill Date, Due Date, Vendor Code, Vendor Name, Currency,
//   Item Number, Description, Qty, Unit Price, Amount, Bill Status,
//   Payment Status
//
// This module is IO-free so it's unit-testable; the handler owns formidable,
// gunzip, Supabase, and vendor resolution.

// Round a money string/number to integer cents. Returns 0 for blank/NaN so a
// missing line amount never NULLs total_amount_cents (NOT NULL, default 0).
export function toCents(amount) {
  if (amount == null || amount === "") return 0;
  const n = Number(String(amount).replace(/[$,]/g, ""));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

// Round to a 2-dp number for the legacy numeric columns (subtotal/total).
export function toMoney(cents) {
  return Math.round(cents) / 100;
}

function str(v) {
  return v == null ? "" : String(v).trim();
}

// Xoro emits 'MM/DD/YYYY' (already split off any time component upstream).
// Returns 'YYYY-MM-DD' or null. The 0001 sentinel = "no date".
export function toIsoDate(raw) {
  const s = str(raw);
  if (!s || s.startsWith("01/01/0001")) return null;
  const datePart = s.split(" ")[0];
  const m = datePart.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const [, mm, dd, yyyy] = m;
    return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  }
  // Already ISO?
  if (/^\d{4}-\d{2}-\d{2}/.test(datePart)) return datePart.slice(0, 10);
  return null;
}

// Map Xoro's derived Payment Status + the bill total to our invoices.status
// + paid_amount_cents.
//   Paid     -> status 'paid',     paid = total
//   Partial  -> status 'approved', paid = 0  (CSV carries no paid amount)
//   else     -> status 'approved', paid = 0
// We treat every real posted Xoro bill as at least 'approved' (it already
// cleared Xoro's AP). 'approved' is a valid invoices.status enum value.
export function mapPaymentStatus(paymentStatus, totalCents) {
  const ps = str(paymentStatus).toLowerCase();
  if (ps === "paid") return { status: "paid", paid_amount_cents: totalCents };
  return { status: "approved", paid_amount_cents: 0 };
}

// Group the line-grain CSV rows into one bill per Bill Number.
//
// Returns an array of:
//   {
//     invoice_number, invoice_date, due_date, vendor_name, vendor_code,
//     currency, bill_status, payment_status,
//     total_cents,
//     lines: [{ line_index, item_number, description, qty, unit_price,
//               line_total_cents }],
//   }
//
// Header fields are taken from the first row seen for each bill. A row with
// no Item Number and no Amount/Qty is treated as header-only (no line
// pushed) but still establishes the bill. Bill order follows first-seen.
export function parseBillRows(csvRows) {
  const byNumber = new Map();
  for (const r of csvRows || []) {
    const invoice_number = str(r["Bill Number"]);
    if (!invoice_number) continue; // unkeyed row — skip

    let bill = byNumber.get(invoice_number);
    if (!bill) {
      bill = {
        invoice_number,
        invoice_date: toIsoDate(r["Bill Date"]),
        due_date: toIsoDate(r["Due Date"]),
        vendor_name: str(r["Vendor Name"]),
        vendor_code: str(r["Vendor Code"]),
        currency: str(r["Currency"]) || "USD",
        bill_status: str(r["Bill Status"]),
        payment_status: str(r["Payment Status"]),
        total_cents: 0,
        lines: [],
      };
      byNumber.set(invoice_number, bill);
    }

    const itemNumber = str(r["Item Number"]);
    const qtyRaw = str(r["Qty"]);
    const amountRaw = str(r["Amount"]);
    const isHeaderOnly = !itemNumber && !qtyRaw && !amountRaw;
    if (isHeaderOnly) continue;

    const line_total_cents = toCents(amountRaw);
    bill.total_cents += line_total_cents;
    bill.lines.push({
      line_index: bill.lines.length,
      item_number: itemNumber || null,
      description: str(r["Description"]) || null,
      qty: qtyRaw === "" ? null : Number(qtyRaw),
      unit_price: str(r["Unit Price"]) === "" ? null : Number(String(r["Unit Price"]).replace(/[$,]/g, "")),
      line_total_cents,
    });
  }
  return Array.from(byNumber.values());
}

// Build the invoices-table payload for one parsed bill + a resolved
// vendor_id. entity_id is intentionally omitted — the column DEFAULTs to
// COALESCE(current_entity_id(), rof_entity_id()), which resolves to ROF
// under the service-role client. nowIso is injected so the function stays
// pure/testable (no Date.now()).
export function buildInvoicePayload(bill, vendor_id, nowIso) {
  const pay = mapPaymentStatus(bill.payment_status, bill.total_cents);
  return {
    vendor_id,
    invoice_number: bill.invoice_number,
    invoice_date: bill.invoice_date,
    due_date: bill.due_date,
    currency: bill.currency || "USD",
    subtotal: toMoney(bill.total_cents),
    tax: 0,
    total: toMoney(bill.total_cents),
    total_amount_cents: bill.total_cents,
    paid_amount_cents: pay.paid_amount_cents,
    status: pay.status,
    paid_at: pay.status === "paid" ? nowIso : null,
    source: "xoro_ap",
    invoice_kind: "vendor_bill",
    xoro_ap_id: bill.invoice_number,
    xoro_last_synced_at: nowIso,
    notes: bill.bill_status ? `Xoro bill status: ${bill.bill_status}` : null,
  };
}

// Build invoice_line_items rows for a parsed bill given its invoice_id.
// Only sku-free header fields are written — inventory_item_id /
// expense_account_id stay NULL (the CSV's Item Number is a SKU string we do
// not reconcile here; line_index + invoice_id are the only NOT NULL cols).
export function buildLineRows(bill, invoice_id) {
  return bill.lines.map((l) => ({
    invoice_id,
    line_index: l.line_index,
    description: l.description,
    quantity: l.qty,
    quantity_invoiced: l.qty,
    unit_price: l.unit_price,
    line_total: toMoney(l.line_total_cents),
  }));
}
