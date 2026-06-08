// api/_lib/rfqLineRevision.js
//
// When a costing line is edited after its RFQ was generated, we re-sync the
// vendor-visible fields onto the linked rfq_line_items and record WHICH ones
// changed (so the vendor portal can flag the line "Revised" and green-highlight
// the exact cells that moved).
//
// VENDOR_VISIBLE_FIELDS are the rfq_line_items columns the vendor actually sees.
// diffVendorFields(current, next) returns the subset whose value changed.

export const VENDOR_VISIBLE_FIELDS = [
  "target_price",
  "quantity",
  "fabric_code",
  "fit",
  "bottom_closure",
  "size_scale_label",
  "waist_type",
  "style_code",
  "color",
];

// Normalize for comparison: numbers compared numerically, blank/undefined → null,
// strings trimmed. Avoids false "changed" from "" vs null or 5 vs "5.0".
function norm(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  const n = Number(v);
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(n) && /^-?\d*\.?\d+$/.test(v.trim())) return n;
  return String(v).trim();
}

/**
 * @param {Object} current  the existing rfq_line_items row (subset of fields)
 * @param {Object} next     the proposed new values (same keys)
 * @param {string[]} [fields] which fields to compare (defaults to all vendor-visible)
 * @returns {string[]} names of changed fields (subset of `fields`)
 */
export function diffVendorFields(current, next, fields = VENDOR_VISIBLE_FIELDS) {
  const changed = [];
  for (const f of fields) {
    // Only consider a field if `next` actually carries a value for it (the edit
    // touched it / it's derivable) — undefined in `next` means "leave as-is".
    if (!(f in next)) continue;
    if (norm(current?.[f]) !== norm(next[f])) changed.push(f);
  }
  return changed;
}
