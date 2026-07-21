// api/_lib/spineSnapshot.js
//
// Pure, side-effect-free helpers for the spine on-hand sync's by-size snapshot
// writer (scripts/sync-onhand-spine.mjs). Extracted here so the aggregation and
// the prune predicate are unit-testable WITHOUT a DB/network round-trip (the
// script itself opens a PostgREST/Mgmt-API connection at import time). The
// script imports these — keep it the single source of truth, do NOT fork copies.
//
// Covers:
//   • cellKey             — the canonical (item_id, warehouse_code) map key, so
//                           buildSnapshotUpserts, the script's upsertKeys set and
//                           pruneReason never drift on the separator
//   • csvDateFromName     — parse snapshot_date from postAD_invrest_YYYYMMDD*.csv
//   • buildSnapshotUpserts — aggregate resolved REST cells to one upsert row per
//                            (item_id, warehouse_code) for tangerine_size_onhand
//   • pruneReason         — decide if an EXISTING snapshot row is now superseded
//                            (same cell re-written today) or sold-through (a
//                            spine-mapped item that dropped out of today's feed)

// Canonical composite key for a (item_id, warehouse_code) cell. A pipe is safe:
// item_ids are UUIDs and warehouse names ('ROF Main', 'ROF - ECOM', 'Psycho Tuna
// Ecom') never contain one.
export const cellKey = (itemId, warehouse) => `${itemId}|${warehouse}`;

// Parse the snapshot date (YYYY-MM-DD) from a postAD_invrest_YYYYMMDD*.csv path
// or bare filename. Returns null when the name carries no date.
export function csvDateFromName(pathOrName) {
  const base = String(pathOrName || "").split(/[\\/]/).pop() || "";
  const m = base.match(/postAD_invrest_(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// Aggregate resolved REST cells into one upsert row per (item_id, warehouse).
//   cells      — array of raw records
//   resolveFn  — cell -> { sku, store, qty } | falsy (skip). Pass null/identity
//                when cells are already { sku, store, qty }.
//   csvDate    — 'YYYY-MM-DD' stamped onto every row as snapshot_date
// Quantities are summed per (sku, store) and rounded; only qty_on_hand > 0 rows
// survive. Returns [{ item_id, warehouse_code, snapshot_date, qty_on_hand }].
export function buildSnapshotUpserts(cells, resolveFn, csvDate) {
  const agg = new Map(); // cellKey -> { item_id, warehouse_code, qty }
  for (const c of cells || []) {
    const r = resolveFn ? resolveFn(c) : c;
    if (!r || !r.sku || !r.store) continue;
    const q = Number(r.qty) || 0;
    if (q <= 0) continue;
    const k = cellKey(r.sku, r.store);
    const prev = agg.get(k);
    if (prev) prev.qty += q;
    else agg.set(k, { item_id: r.sku, warehouse_code: r.store, qty: q });
  }
  const out = [];
  for (const v of agg.values()) {
    const qty = Math.round(v.qty);
    if (qty <= 0) continue;
    out.push({ item_id: v.item_id, warehouse_code: v.warehouse_code, snapshot_date: csvDate, qty_on_hand: qty });
  }
  return out;
}

// Prune predicate: given an EXISTING snapshot row and today's write context,
// return why it should be pruned, or null to keep it.
//   row         — { item_id, warehouse_code, snapshot_date, source? }
//   upsertKeys  — Set of cellKey(item_id, warehouse_code) written at csvDate
//   allowedSkus — Set of spine-mapped item_ids (UPC-spine ∪ private-label)
//   feedItems   — Set of item_ids present (resolved) in today's feed
//   csvDate     — today's snapshot_date ('YYYY-MM-DD')
// Only rows OLDER than csvDate are prunable. A row is:
//   'superseded'   — the same (item, warehouse) got a fresh row today, OR
//   'sold-through' — its item is spine-mapped but absent from today's feed
//                    (truth became 0 — mirror of retire-soldthrough semantics).
// Non-spine items absent from the feed are KEPT (coverage gaps retain last known
// data). Rows from a different source are never touched.
export function pruneReason(row, { upsertKeys, allowedSkus, feedItems, csvDate }) {
  if (!row) return null;
  if (row.source != null && row.source !== "xoro_rest") return null;
  // 'YYYY-MM-DD' strings compare lexically = chronologically.
  if (!(String(row.snapshot_date) < String(csvDate))) return null;
  if (upsertKeys.has(cellKey(row.item_id, row.warehouse_code))) return "superseded";
  if (allowedSkus.has(row.item_id) && !feedItems.has(row.item_id)) return "sold-through";
  return null;
}
