// api/_lib/arSizeEnrich.js
//
// Pure, side-effect-free helpers for the AR historical invoice SIZE ENRICHMENT
// ingest (scripts/enrich-ar-invoice-sizes.mjs). The historical AR backfill stored
// each wholesale invoice as one aggregate "Historical line" per (colour, inseam)
// with a size-NULL SKU link, so the #1883 AR size matrix has nothing to grid. A
// CEO-exported Xoro "Invoice Detail Report" CSV carries the per-SIZE breakdown;
// this module parses it and computes the per-invoice replacement lines while
// CONSERVING the invoice total to the cent (the GL/JE was posted at that total).
//
// Extracted here so the parse / match / verify / distribute logic is unit-tested
// WITHOUT a DB round-trip (the script opens a service-role client + Management API
// at import time). The script imports these; keep it the single source of truth.
//
// Financial invariants this module enforces:
//   • ar_invoice_lines.line_total_cents is FORCED by a BEFORE trigger to
//     quantity * unit_price_cents. The #1883 matrix ALSO only grids a line when
//     unit_price_cents is non-null (else it drops to a flat list). Therefore every
//     size line reuses the aggregate line's OWN unit_price_cents. Because the gate
//     requires Σ(CSV qty) == aggregate.quantity per (colour,inseam) group, we get
//     Σ(qty_i * agg_unit) = agg_qty * agg_unit = aggregate.line_total EXACTLY —
//     the header (maintain_total trigger) is conserved to the cent.
//   • cogs_cents / tax_amount_cents are distributed across the size lines by qty
//     with largest-remainder rounding so their per-group sums are unchanged.
//   • ip_sales_history_wholesale has NO trigger, so its size rows carry the CSV
//     per-line amounts directly, with a balancer reconciliation so Σ net/gross per
//     group equals the original colour row exactly.

import { parseItemNumber, colorMatchKey, resolveStyleToken, canonSize } from "./xoroLineMatch.js";

// ── money / number parsing ──────────────────────────────────────────────────
// Xoro's CSV quotes thousands ("1,237.50") and may carry a UTF-8 BOM on the first
// header cell. Parse a money string to INTEGER CENTS (round half-away-from-zero).
export function parseMoneyCents(raw) {
  const s = String(raw ?? "").replace(/﻿/g, "").replace(/[$,\s]/g, "").trim();
  if (s === "" || s === "-") return 0;
  const n = Number(s);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}
// Parse a plain number (qty). Tolerates quotes/commas/BOM.
export function parseNum(raw) {
  const s = String(raw ?? "").replace(/﻿/g, "").replace(/[,\s]/g, "").trim();
  if (s === "") return NaN;
  return Number(s);
}

// ── CSV parsing (BOM + quoted-field tolerant, RFC-4180-ish) ─────────────────
// Splits the whole file into records of fields, honouring double-quoted fields
// (which may contain commas and escaped "" quotes). Returns string[][].
export function parseCsv(text) {
  const src = String(text ?? "").replace(/^﻿/, "");
  const rows = [];
  let field = "";
  let row = [];
  let inQ = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQ) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') {
      inQ = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n") {
      row.push(field); field = "";
      rows.push(row); row = [];
    } else if (c === "\r") {
      // swallow; \n handles the row break (or EOF below)
    } else {
      field += c;
    }
  }
  // trailing field / row (no final newline)
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// Parse the Invoice Detail Report into structured line objects keyed by header
// name. Returns { header, lines:[{txnDate,itemNumber,description,saleStore,qty,
// amountCents,invoiceNumber,customer,unitPriceCents,paymentStatus, _raw}] }.
export function parseInvoiceDetailCsv(text) {
  const rows = parseCsv(text);
  if (rows.length === 0) return { header: [], lines: [] };
  const header = rows[0].map((h) => h.replace(/^﻿/, "").trim());
  const idx = (name) => header.indexOf(name);
  const cDate = idx("Txn Date"), cItem = idx("Item Number"), cDesc = idx("Description");
  const cStore = idx("Sale Store"), cQty = idx("Qty"), cAmt = idx("Amount");
  const cInv = idx("Invoice Number"), cCust = idx("Customer"), cUnit = idx("Unit Price");
  const cStatus = idx("Invoice Payment Status");
  const lines = [];
  for (let r = 1; r < rows.length; r++) {
    const f = rows[r];
    if (!f || f.length === 0) continue;
    const invoiceNumber = (f[cInv] ?? "").trim();
    const itemNumber = (f[cItem] ?? "").trim();
    if (!invoiceNumber && !itemNumber) continue; // blank line
    lines.push({
      txnDate: (f[cDate] ?? "").trim(),
      itemNumber,
      description: (f[cDesc] ?? "").trim(),
      saleStore: (f[cStore] ?? "").trim(),
      qty: parseNum(f[cQty]),
      amountCents: parseMoneyCents(f[cAmt]),
      invoiceNumber,
      customer: (f[cCust] ?? "").trim(),
      unitPriceCents: parseMoneyCents(f[cUnit]),
      paymentStatus: (f[cStatus] ?? "").trim(),
    });
  }
  return { header, lines };
}

// MM/DD/YYYY → YYYY-MM-DD (ISO date). Returns null on unparseable.
export function usDateToIso(s) {
  const m = String(s ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

// ── (style, colour, inseam) grouping key ────────────────────────────────────
// Each stored aggregate line is per (style, colour, inseam). A wholesale invoice
// commonly bundles MANY styles that share a colourway (Psycho Tuna prebooks:
// PTYT0087/0088/0083 all "Moonless Nights"), so the key MUST include the style —
// keying on colour alone collapses distinct styles into one group and mis-maps.
// A jeans style also embeds the inseam in the Xoro style token (RYB059430 =
// RYB0594 + inseam 30), and the same (style, colour) can appear at two inseams as
// two lines. So the key is (resolved style_id, spelling-tolerant colour, inseam):
// the style_id + inseam come from resolveStyleToken (peels the inseam composite);
// the colour is the ItemNumber's middle segment.
export function csvLineGroupKey(itemNumber, styleByCode) {
  const parsed = parseItemNumber(itemNumber);
  if (!parsed) return null;
  const { styleId, inseam } = resolveStyleToken(styleByCode, parsed.style_code);
  return {
    parsed,
    styleId: styleId || null,
    colorKey: colorMatchKey(parsed.color),
    inseam: inseam == null ? null : String(inseam),
    key: `${styleId || ""}||${colorMatchKey(parsed.color)}||${inseam == null ? "" : inseam}`,
  };
}

// Group the CSV lines of ONE invoice by (colour, inseam). Returns
// Map<key, { colorKey, inseam, lines:[{...csvLine, parsed}] }>.
export function groupInvoiceCsvLines(csvLines, styleByCode) {
  const groups = new Map();
  for (const l of csvLines) {
    const gk = csvLineGroupKey(l.itemNumber, styleByCode);
    if (!gk) continue;
    let g = groups.get(gk.key);
    if (!g) { g = { key: gk.key, colorKey: gk.colorKey, inseam: gk.inseam, lines: [] }; groups.set(gk.key, g); }
    g.lines.push({ ...l, parsed: gk.parsed });
  }
  return groups;
}

// Build the match key for a stored aggregate line from its anchor SKU
// (anchor style_id + colorMatchKey of the SKU colour + the SKU inseam). Must
// mirror csvLineGroupKey's key layout: `${styleId}||${colorKey}||${inseam}`.
export function aggregateGroupKey(anchor) {
  const styleId = anchor?.style_id || "";
  const colorKey = colorMatchKey(anchor?.color);
  const inseam = anchor?.inseam == null || String(anchor.inseam).trim() === "" ? null : String(anchor.inseam).trim();
  return `${styleId}||${colorKey}||${inseam == null ? "" : inseam}`;
}

// Canonical size key for aligning a stored line's size to a CSV line's size
// (letter sizes fold via normalizeSize; numeric waists / kids "S/8" pass through).
export function sizeKeyOf(size) {
  return String(canonSize(String(size ?? "").trim())).toUpperCase();
}

// ── size-grain alignment (Case B: already-exploded historical lines) ─────────
// Some historical invoices were backfilled ONE LINE PER SIZE, but each line links
// a size-NULL SKU whose sku_code embeds the size ("PTBT0007-INDIGO-S/8"). Those
// are candidates (SKU.size IS NULL) yet must NOT be split — they only need
// RE-LINKING to a size-populated SKU. Given the aggregate lines of one
// (style,colour,inseam) group and the CSV lines of the same group, pair them 1:1
// by size (parsed from each aggregate line's anchor sku_code vs each CSV line's
// size). Returns { ok, pairs:[{agg, csv}] } or { ok:false, reason }.
export function alignSizeGrain(aggLines, csvLines) {
  if (aggLines.length !== csvLines.length) return { ok: false, reason: "line-count differs" };
  const csvBySize = new Map();
  for (const c of csvLines) {
    const k = sizeKeyOf(c.parsed.size);
    if (csvBySize.has(k)) return { ok: false, reason: `duplicate CSV size ${k}` };
    csvBySize.set(k, c);
  }
  const pairs = [];
  const used = new Set();
  for (const a of aggLines) {
    const tok = parseItemNumber(a.anchor?.sku_code)?.size;
    const k = sizeKeyOf(tok);
    const c = csvBySize.get(k);
    if (!c || used.has(k)) return { ok: false, reason: `no unique size match for '${tok}'` };
    used.add(k);
    pairs.push({ agg: a, csv: c });
  }
  return { ok: true, pairs };
}

// Build ar_invoice_lines that RE-LINK already-size-grain aggregate lines to
// size-populated SKUs. Carries each aggregate line's OWN quantity / unit price /
// cogs / tax verbatim (so the header is conserved exactly) and only swaps the
// inventory_item_id. pairs[i].itemId = resolved sized SKU for pairs[i].
export function buildRelinkLines(pairs, startLineNumber) {
  const lines = [];
  let ln = startLineNumber;
  for (const p of pairs) {
    const a = p.agg;
    lines.push({
      line_number: ln++,
      description: p.csv?.description || a.description || null,
      inventory_item_id: p.itemId,
      quantity: a.quantity,
      unit_price_cents: a.unit_price_cents,
      tax_amount_cents: a.tax_amount_cents,
      cogs_cents: a.cogs_cents == null ? null : a.cogs_cents,
      revenue_account_id: a.revenue_account_id ?? null,
      cogs_account_id: a.cogs_account_id ?? null,
      brand_id: a.brand_id ?? null,
      channel_id: a.channel_id ?? null,
      source: a.source || "manual",
    });
  }
  return { lines, nextLineNumber: ln };
}

// ── largest-remainder integer distribution ──────────────────────────────────
// Split integer `total` across `weights` (non-negative) so the parts sum EXACTLY
// to total, proportional to the weights, with the largest fractional remainders
// getting the leftover units. Zero-weight sum → spread as evenly as possible.
export function distributeInt(total, weights) {
  const n = weights.length;
  if (n === 0) return [];
  const T = Math.trunc(total);
  const wsum = weights.reduce((a, b) => a + (b > 0 ? b : 0), 0);
  if (wsum <= 0) {
    // even split, remainder to the first cells
    const base = Math.trunc(T / n);
    const out = new Array(n).fill(base);
    let rem = T - base * n;
    for (let i = 0; rem > 0; i = (i + 1) % n) { out[i] += 1; rem--; }
    return out;
  }
  const exact = weights.map((w) => (T * (w > 0 ? w : 0)) / wsum);
  const floors = exact.map((x) => Math.floor(x));
  let assigned = floors.reduce((a, b) => a + b, 0);
  let rem = T - assigned;
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  const out = floors.slice();
  for (let k = 0; k < order.length && rem > 0; k++) { out[order[k].i] += 1; rem--; }
  return out;
}

// ── per-group verification gate ─────────────────────────────────────────────
// Σ CSV qty must EQUAL the aggregate line quantity (exact — this is the structural
// conservation guarantee). Σ CSV amount must be within `tolCents` of the aggregate
// line_total (a SANITY check that the CSV rows belong to this invoice/colour; the
// header stays exact regardless because size lines reuse agg unit price). Returns
// { ok, sumQty, sumAmtCents, aggQty, aggTotalCents, qtyMatch, amtDiffCents, reason }.
export function verifyColorGroup(csvLines, aggLine, tolCents) {
  let sumQty = 0;
  let sumAmtCents = 0;
  for (const l of csvLines) {
    if (!Number.isFinite(l.qty) || !Number.isFinite(l.amountCents)) {
      return { ok: false, reason: "unparseable qty/amount in CSV line", sumQty, sumAmtCents };
    }
    sumQty += l.qty;
    sumAmtCents += l.amountCents;
  }
  const aggQty = Number(aggLine.quantity);
  const aggTotalCents = Number(aggLine.line_total_cents);
  const qtyMatch = Math.abs(sumQty - aggQty) < 1e-6;
  const amtDiffCents = Math.abs(sumAmtCents - aggTotalCents);
  const ok = qtyMatch && amtDiffCents <= tolCents;
  let reason = null;
  if (!qtyMatch) reason = `qty mismatch: CSV Σ=${sumQty} vs aggregate=${aggQty}`;
  else if (amtDiffCents > tolCents) reason = `amount mismatch: CSV Σ=${sumAmtCents}c vs aggregate=${aggTotalCents}c (diff ${amtDiffCents}c > tol ${tolCents}c)`;
  return { ok, sumQty, sumAmtCents, aggQty, aggTotalCents, qtyMatch, amtDiffCents, reason };
}

// ── build the replacement ar_invoice_lines for one (colour,inseam) group ─────
// Reuses the aggregate line's unit_price_cents (matrixable + exact conservation),
// distributes cogs_cents and tax_amount_cents by qty, carries brand/channel/
// revenue/cogs account from the aggregate. `itemIdByCsvIndex[i]` is the resolved
// sized SKU id for csvLines[i]. `startLineNumber` is the first line_number to use.
// Returns { lines:[rowObj], nextLineNumber }.
export function buildSizeLines(csvLines, itemIdByCsvIndex, aggLine, startLineNumber) {
  const aggUnit = Number(aggLine.unit_price_cents);
  const qtys = csvLines.map((l) => l.qty);
  const cogsParts = aggLine.cogs_cents == null ? null : distributeInt(Number(aggLine.cogs_cents), qtys);
  const taxParts = distributeInt(Number(aggLine.tax_amount_cents || 0), qtys);
  const lines = [];
  let ln = startLineNumber;
  for (let i = 0; i < csvLines.length; i++) {
    const l = csvLines[i];
    lines.push({
      line_number: ln++,
      description: l.description || aggLine.description || null,
      inventory_item_id: itemIdByCsvIndex[i],
      quantity: l.qty,
      unit_price_cents: aggUnit,            // trigger sets line_total = qty * aggUnit
      tax_amount_cents: taxParts[i],
      cogs_cents: cogsParts ? cogsParts[i] : null,
      revenue_account_id: aggLine.revenue_account_id ?? null,
      cogs_account_id: aggLine.cogs_account_id ?? null,
      brand_id: aggLine.brand_id ?? null,
      channel_id: aggLine.channel_id ?? null,
      source: aggLine.source || "manual",
    });
  }
  return { lines, nextLineNumber: ln };
}

// ── build CSV-PRICED ar_invoice_lines (reprice / fill passes) ────────────────
// Rebuilds an invoice's lines to EXACTLY the CSV: one line per CSV line, priced at
// the CSV amount so the invoice total becomes the CSV total (used only when the
// caller has gated CSV == GL AR, so this also equals the Xoro GL receivable).
// unit_price_cents = amount/qty when it divides evenly (keeps the line matrixable +
// lets the compute_total trigger reproduce the amount); otherwise unit is NULL and
// line_total_cents carries the exact amount (trigger skips). cogs is distributed
// from the invoice's current total cogs by qty (best-effort metadata; the GL COGS
// is posted independently by the Xoro mirror). `itemIds[i]` is the resolved sized
// SKU for csvLines[i]; `defaults` carries brand/channel/revenue/source.
export function buildRepriceLines(csvLines, itemIds, defaults, startLineNumber) {
  const qtys = csvLines.map((l) => l.qty);
  const totalCogs = defaults.totalCogsCents == null ? null : Number(defaults.totalCogsCents);
  const cogsParts = totalCogs == null ? null : distributeInt(totalCogs, qtys);
  const lines = [];
  let ln = startLineNumber;
  let sumCents = 0;
  for (let i = 0; i < csvLines.length; i++) {
    const l = csvLines[i];
    const amt = Math.round(l.amountCents);
    const q = l.qty;
    const divisible = q > 0 && amt % q === 0;
    sumCents += amt;
    lines.push({
      line_number: ln++,
      description: l.description || null,
      inventory_item_id: itemIds[i],
      quantity: q,
      unit_price_cents: divisible ? amt / q : null, // null → line kept via explicit line_total
      line_total_cents: amt,                        // used when unit null; trigger reproduces it when unit set
      tax_amount_cents: 0,
      cogs_cents: cogsParts ? cogsParts[i] : null,
      revenue_account_id: defaults.revenue_account_id ?? null,
      cogs_account_id: defaults.cogs_account_id ?? null,
      brand_id: defaults.brand_id ?? null,
      channel_id: defaults.channel_id ?? null,
      source: defaults.source || "manual",
    });
  }
  return { lines, nextLineNumber: ln, sumCents };
}

// ── build the ip_sales_history_wholesale size rows for one group ─────────────
// The colour row carries qty/gross/net at colour grain (no DB trigger). Explode to
// size rows using the CSV per-line qty + amount, then reconcile the LAST row so
// Σ qty and Σ net/gross equal the colour row exactly (largest-remainder-free: put
// residual on the balancer). Carries every other column from the colour row.
// `sizeMeta[i]` = { skuId, sourceLineKey } for csvLines[i].
export function buildIshSizeRows(csvLines, sizeMeta, colorRow) {
  const n = csvLines.length;
  if (n === 0) return [];
  const grossTotal = colorRow.gross_amount == null ? null : Number(colorRow.gross_amount);
  const netTotal = colorRow.net_amount == null ? null : Number(colorRow.net_amount);
  const qtyTotal = Number(colorRow.qty);
  // per-line dollar amounts from CSV
  const amts = csvLines.map((l) => l.amountCents / 100);
  const rows = [];
  let sumGross = 0, sumNet = 0, sumQty = 0;
  for (let i = 0; i < n; i++) {
    const l = csvLines[i];
    const gross = grossTotal == null ? null : amts[i];
    const net = netTotal == null ? null : amts[i];
    if (gross != null) sumGross += gross;
    if (net != null) sumNet += net;
    sumQty += l.qty;
    rows.push({
      sku_id: sizeMeta[i].skuId,
      qty: l.qty,
      unit_price: l.qty ? (l.amountCents / 100) / l.qty : (colorRow.unit_price ?? null),
      gross_amount: gross,
      net_amount: net,
      source_line_key: sizeMeta[i].sourceLineKey,
    });
  }
  // reconcile residuals onto the last row (balancer)
  const b = rows[n - 1];
  if (grossTotal != null) b.gross_amount = Number((b.gross_amount + (grossTotal - sumGross)).toFixed(2));
  if (netTotal != null) b.net_amount = Number((b.net_amount + (netTotal - sumNet)).toFixed(2));
  if (Math.abs(sumQty - qtyTotal) > 1e-6) b.qty = Number((b.qty + (qtyTotal - sumQty)).toFixed(4));
  return rows;
}
