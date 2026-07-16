// api/_lib/xoro-mirror/ar-sizegrain.js
//
// Size-grain explosion for the AR mirror (T10-2 extension).
//
// PROBLEM (root cause from #1817): ar_invoice_lines inherit style+color-grain
// ip_item_master items because the AR mirror reads ip_sales_history_wholesale,
// whose feeds (Excel sales ingest + xoro-sales-sync) BOTH roll SKUs up to
// style+color grain (canonStyleColor) so they align with the planning grid.
// So the color x size matrix in the AR invoice expander can't place the line.
//
// This module adds a SIZE-GRAIN PATH that does NOT touch the planning grain:
// when a size-grain SOURCE has per-size lines for an invoice, we EXPLODE the
// one style+color ar_invoice_line into per-size ar_invoice_lines pointing at
// true size-grain ip_item_master items, preserving the exact line total to the
// cent (remainder distributed to the last size).
//
// SIZE-GRAIN SOURCE (evidence-picked — see PR notes): raw_xoro_payloads rows
// with endpoint='sales-history' are the raw Xoro `invoice/getinvoice` response,
// already mirrored locally. Each record carries invoiceHeader.InvoiceNumber +
// invoiceItemLineArr[] whose ItemNumber is the FULL size-grain SKU
// (e.g. "PTYG0001H-Black-XXL"), with Qty / UnitPrice / TotalAmount / Discount.
// Coverage grows as the sales-history raw-payload ingest widens; invoices with
// no coverage are left as style+color rollups (honest no-op).
//
// ⚠️ TRIGGER SAFETY (#1674): every exploded ar_invoice_lines INSERT sets
// line_total_cents explicitly and sets unit_price_cents = NULL UNLESS
// quantity*unit_price_cents reproduces the line total exactly — otherwise the
// BEFORE trigger ar_invoice_lines_compute_total_trg would recompute
// line_total_cents := quantity*unit_price_cents and clobber a discounted net.
//
// IDEMPOTENCY: exploded lines point at size-grain items, so a re-run sees the
// invoice already resolved and finds nothing rollup-grain left to explode. The
// nightly AR mirror additionally delete+reinserts all source='xoro_mirror'
// lines each run, so re-running reproduces the same exploded set.

import { canonSku, canonStyleColor, parseSizeSuffix, buildItemRow, parseStyleColor } from "../sku-canon.js";

/**
 * Integer largest-remainder allocation: split `total` (integer) across the
 * given non-negative integer weights so the parts sum EXACTLY to total.
 * Floor each proportional share, then hand the leftover one-by-one to the
 * entries with the largest fractional remainder (ties: earlier index first).
 * When all weights are zero, split as evenly as possible.
 *
 * @param {number} total    integer to distribute (may be 0 or negative-safe? total>=0 expected)
 * @param {number[]} weights non-negative numbers
 * @returns {number[]} integer parts, same length as weights, summing to total
 */
export function allocateProportional(total, weights) {
  const n = weights.length;
  if (n === 0) return [];
  const T = Math.round(Number(total) || 0);
  const w = weights.map((x) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Number(x) : 0));
  const sumW = w.reduce((a, b) => a + b, 0);
  const parts = new Array(n).fill(0);
  if (T === 0) return parts;

  if (sumW === 0) {
    // Even split: base to all, remainder to the first (T mod n) entries.
    const base = Math.trunc(T / n);
    let rem = T - base * n;
    for (let i = 0; i < n; i++) { parts[i] = base + (rem > 0 ? 1 : 0); if (rem > 0) rem--; }
    return parts;
  }

  const frac = [];
  let assigned = 0;
  for (let i = 0; i < n; i++) {
    const exact = (T * w[i]) / sumW;
    const floor = Math.floor(exact);
    parts[i] = floor;
    assigned += floor;
    frac.push({ i, r: exact - floor });
  }
  let leftover = T - assigned;
  frac.sort((a, b) => (b.r - a.r) || (a.i - b.i));
  for (let k = 0; k < frac.length && leftover > 0; k++) { parts[frac[k].i] += 1; leftover--; }
  return parts;
}

/**
 * Normalize one raw Xoro `invoice/getinvoice` record (as stored in
 * raw_xoro_payloads.payload.data[]) into size-grain source lines.
 *
 * @param {object} rec  { invoiceHeader, invoiceItemLineArr }
 * @returns {{invoice_number:string|null, lines: Array<object>}}
 *   each line: { item_number, canon_sku, style_color, size, qty,
 *                gross_cents, discount_cents, net_cents, line_key }
 */
export function normalizeInvoicePayloadLines(rec) {
  const header = rec?.invoiceHeader ?? rec ?? {};
  const invoice_number = (header.InvoiceNumber ?? header.InvoiceNo ?? "").toString().trim() || null;
  const arr = Array.isArray(rec?.invoiceItemLineArr) ? rec.invoiceItemLineArr
            : Array.isArray(rec?.InvoiceItemLineArr) ? rec.InvoiceItemLineArr : [];
  const lines = [];
  for (const il of arr) {
    const itemNumber = (il.ItemNumber ?? il.Sku ?? il.ItemCode ?? "").toString().trim();
    if (!itemNumber) continue;
    const canon = canonSku(itemNumber);
    if (!canon) continue;
    const qty = num(il.Qty ?? il.QtyInvoiced ?? il.QtyShipped) ?? 0;
    const gross = num(il.TotalAmount ?? il.LineAmount);
    const discount = num(il.Discount ?? il.DiscountAmount) ?? 0;
    const unit = num(il.EffectiveUnitPrice ?? il.UnitPrice);
    const grossCents = gross != null ? Math.round(gross * 100)
                     : (unit != null ? Math.round(unit * qty * 100) : 0);
    const discountCents = Math.round((discount || 0) * 100);
    const netCents = grossCents - discountCents;
    const lineKey = (il.Id ?? il.SoLineId ?? il.LineNumber ?? `${canon}`).toString();
    lines.push({
      item_number: itemNumber,
      canon_sku: canon,
      style_color: canonStyleColor(itemNumber),
      size: parseSizeSuffix(itemNumber),
      qty,
      gross_cents: grossCents,
      discount_cents: discountCents,
      net_cents: netCents,
      line_key: lineKey,
    });
  }
  return { invoice_number, lines };
}

function num(raw) {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Explode ONE style+color rollup ar_invoice_line into per-size lines, given the
 * size-grain source lines for the SAME style+color and a resolver that maps a
 * source line's canon size SKU → an ip_item_master id.
 *
 * Invariants (asserted by tests):
 *   - sum(out.line_total_cents) === rollup.line_total_cents  (cents-exact)
 *   - sum(out.quantity)         === rollup.quantity          (when rollup.quantity set)
 *   - unit_price_cents is set ONLY when quantity*unit === line_total_cents
 *     (else null, to disarm the compute trigger — #1674)
 *
 * @param {object}   rollup     { line_number, line_total_cents, quantity, description }
 * @param {object[]} sizeLines  normalized source lines (net_cents, qty, canon_sku, size)
 * @param {(sl:object)=>string|null} resolveItemId
 * @returns {object[]|null}  exploded ar_invoice_lines-shaped rows, or null if it
 *          can't explode (no size lines, or a size item couldn't be resolved).
 */
export function composeExplodedLines(rollup, sizeLines, resolveItemId) {
  if (!Array.isArray(sizeLines) || sizeLines.length === 0) return null;
  // Collapse duplicate size SKUs (a style+color may appear on multiple source
  // lines) into one entry per canon_sku, summing qty + net weight.
  const bySku = new Map();
  for (const sl of sizeLines) {
    const key = sl.canon_sku;
    const cur = bySku.get(key) || { canon_sku: key, size: sl.size, qty: 0, net_cents: 0, item_number: sl.item_number };
    cur.qty += Number(sl.qty) || 0;
    cur.net_cents += Number(sl.net_cents) || 0;
    bySku.set(key, cur);
  }
  const entries = [...bySku.values()];

  const itemIds = entries.map((e) => resolveItemId(e));
  if (itemIds.some((id) => !id)) return null; // couldn't resolve every size → bail (keep rollup)

  const totalCents = Math.round(Number(rollup.line_total_cents) || 0);
  // Weight by net amount; fall back to qty when all nets are zero.
  const netWeights = entries.map((e) => Math.max(0, e.net_cents));
  const weights = netWeights.some((x) => x > 0) ? netWeights : entries.map((e) => Math.max(0, e.qty));
  const centParts = allocateProportional(totalCents, weights);

  const hasQty = rollup.quantity != null && Number.isFinite(Number(rollup.quantity));
  const qtyTotal = hasQty ? Number(rollup.quantity) : entries.reduce((a, e) => a + (Number(e.qty) || 0), 0);
  const qtyIsInt = Number.isInteger(qtyTotal);
  const qtyWeights = entries.map((e) => Math.max(0, e.qty));
  const qtyParts = qtyIsInt
    ? allocateProportional(qtyTotal, qtyWeights)
    : entries.map((e) => e.qty); // non-integer rollup qty: pass source qtys through

  const out = [];
  for (let i = 0; i < entries.length; i++) {
    const cents = centParts[i];
    const qty = qtyParts[i];
    // unit_price_cents only when it reproduces the total exactly (trigger-safe).
    let unit = null;
    if (qty && Number.isInteger(qty) && qty !== 0 && cents % qty === 0) {
      unit = cents / qty;
    }
    out.push({
      line_number: rollup.line_number, // caller re-numbers within the invoice
      inventory_item_id: itemIds[i],
      description: rollup.description ?? null,
      quantity: qty,
      unit_price_cents: unit,
      line_total_cents: cents,
      source: rollup.source || "xoro_mirror",
      _size: entries[i].size,
      _canon_sku: entries[i].canon_sku,
    });
  }
  return out;
}

/**
 * Load size-grain source lines from raw_xoro_payloads for a set of invoice
 * numbers. Returns Map(invoice_number → normalized size lines[]).
 *
 * Reads the endpoint's rows and normalizes in JS, filtering to the requested
 * invoices. Paginated in SMALL pages: legacy full-payload rows run several MB
 * of jsonb each, and reading them all in one PostgREST response contributed to
 * the 07-15/16 prod DB outages. Rows written by ar-payload-ingest (#1824) are
 * slim (whitelisted fields), but page defensively either way.
 */
export async function loadSizeSourceFromRawPayloads(supabase, invoiceNumbers) {
  const want = new Set((invoiceNumbers || []).filter(Boolean));
  const out = new Map();
  if (want.size === 0) return out;
  const PAGE = 3;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("raw_xoro_payloads")
      .select("payload")
      .eq("endpoint", "sales-history")
      .range(from, from + PAGE - 1);
    if (error || !Array.isArray(data)) return out;
    for (const row of data) {
      const recs = Array.isArray(row?.payload?.data) ? row.payload.data
                 : Array.isArray(row?.payload) ? row.payload : [];
      for (const rec of recs) {
        const { invoice_number, lines } = normalizeInvoicePayloadLines(rec);
        if (!invoice_number || !want.has(invoice_number) || lines.length === 0) continue;
        const prev = out.get(invoice_number) || [];
        out.set(invoice_number, prev.concat(lines));
      }
    }
    if (data.length < PAGE) break;
  }
  return out;
}

/**
 * Resolve (or create) size-grain ip_item_master ids for a set of canonical
 * size SKUs. Returns Map(canon_sku → id). Missing SKUs are inserted as minimal
 * stubs via buildItemRow (which parses + sets size). If a stub insert collides
 * with the logical-SKU unique constraint (a duplicate fragment of an existing
 * sized twin), we fall back to the existing row for that sku_code.
 *
 * @param {object} supabase
 * @param {string} entity_id
 * @param {Iterable<string>} canonSkus
 * @returns {Promise<Map<string,string>>}
 */
export async function resolveOrCreateSizeItems(supabase, entity_id, canonSkus) {
  const skus = [...new Set([...canonSkus].filter(Boolean))];
  const map = new Map();
  if (skus.length === 0) return map;

  const { data: existing } = await supabase
    .from("ip_item_master")
    .select("id, sku_code")
    .in("sku_code", skus);
  for (const r of existing || []) map.set(r.sku_code, r.id);

  const missing = skus.filter((s) => !map.has(s));
  if (missing.length === 0) return map;

  const rows = missing.map((s) => {
    const row = buildItemRow(s);
    if (entity_id) row.entity_id = entity_id;
    return row;
  });
  const { data: created, error } = await supabase
    .from("ip_item_master")
    .insert(rows)
    .select("id, sku_code");
  if (!error && Array.isArray(created)) {
    for (const r of created) map.set(r.sku_code, r.id);
  } else if (error) {
    // A MULTI-ROW insert aborts WHOLESALE when ANY row violates
    // uq_ip_item_master_logical_sku (#1825 finding: private-label SKUs whose
    // color can't be parsed collide per (style, '', size) — one collision was
    // poisoning resolution for every OTHER sku in the batch, skipping ~97% of
    // otherwise-explodable invoices). Fall back to per-row inserts so a
    // collision only leaves ITS OWN sku unresolved.
    for (const row of rows) {
      const { data: one } = await supabase
        .from("ip_item_master")
        .insert(row)
        .select("id, sku_code")
        .maybeSingle();
      if (one) map.set(one.sku_code, one.id);
    }
  }
  // Re-read anything still unmapped (collision fell back to an existing row,
  // or a partial insert): resolve by sku_code, else by logical twin.
  const stillMissing = missing.filter((s) => !map.has(s));
  if (stillMissing.length > 0) {
    const { data: reread } = await supabase
      .from("ip_item_master")
      .select("id, sku_code")
      .in("sku_code", stillMissing);
    for (const r of reread || []) map.set(r.sku_code, r.id);
  }
  return map;
}

/**
 * Given an invoice's rollup ar_invoice_lines (each carrying the resolved
 * style+color sku_code) and the invoice's size-grain source lines, produce the
 * FINAL ar_invoice_lines set: each rollup line that maps to size source is
 * replaced by its exploded per-size lines; unmatched rollups pass through
 * unchanged. Line numbers are re-sequenced 1..N. Returns { lines, exploded,
 * kept } counts. `resolveItemId(sizeLineEntry)` resolves a size item id.
 *
 * @returns {{lines: object[], explodedRollups: number, keptRollups: number}}
 */
export function buildExplodedInvoiceLines(rollupLines, sizeSourceLines, resolveItemId) {
  // Bucket source lines by style+color so each rollup finds its own sizes.
  const byStyleColor = new Map();
  for (const sl of sizeSourceLines || []) {
    const k = sl.style_color;
    if (!byStyleColor.has(k)) byStyleColor.set(k, []);
    byStyleColor.get(k).push(sl);
  }

  const out = [];
  let explodedRollups = 0;
  let keptRollups = 0;
  for (const rl of rollupLines) {
    const key = rl._style_color ?? null;
    const sizeLines = key ? byStyleColor.get(key) : null;
    const exploded = sizeLines ? composeExplodedLines(rl, sizeLines, resolveItemId) : null;
    if (exploded && exploded.length > 0) {
      explodedRollups++;
      for (const e of exploded) out.push(e);
    } else {
      keptRollups++;
      out.push({ ...rl });
    }
  }
  // Re-sequence line numbers.
  out.forEach((l, i) => { l.line_number = i + 1; });
  return { lines: out, explodedRollups, keptRollups };
}

export { canonStyleColor, parseStyleColor };
