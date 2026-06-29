// api/_lib/gs1/mintForStyle.js
//
// Server-side: mint one unique UPC-A per (style, color, size) for a style, on
// opt-in at style creation. Reuses the GS1 company prefix in company_settings
// and the atomic `gs1_claim_next_item_reference()` RPC (the same counter the
// pack-GTIN minter uses) so every minted number is globally unique and never
// recycled.
//
// Grain: upc_item_master is (style_no, color, size). For a NEW style we
// enumerate:
//   sizes  = the style's size_scale sizes (ordered)  [fallback: distinct SKU sizes]
//   colors = distinct colors on the style's existing ip_item_master SKUs
// then mint a UPC for every (color × size) cell that doesn't already have one.
//
// A brand-new style usually has no colors/SKUs yet (colors arrive with the
// first PO/sync). In that case nothing is minted and we report skipped=true
// with a reason — the operator can re-trigger later, and existing Xoro/Excel
// UPCs are never disturbed.
//
// Idempotent: we read existing upc_item_master rows for the style first and
// skip any (color, size) that already has a UPC, so re-running never duplicates.

import { buildUpcAFromSettings, maxUpcItemReference } from "./upc.js";

// Normalize a size token the same way the matrix view does (letter sizes →
// canonical), so we don't fork "S"/"SML"/"SMALL" into three UPCs. Lightweight
// copy of styleMatrix.normalizeSize to avoid a cross-import here.
const LETTER_SIZE_CANON = {
  XS: "XSMALL", XSM: "XSMALL", "X-SMALL": "XSMALL", XSMALL: "XSMALL",
  S: "SMALL", SM: "SMALL", SML: "SMALL", SMALL: "SMALL",
  M: "MEDIUM", MD: "MEDIUM", MED: "MEDIUM", MEDIUM: "MEDIUM",
  L: "LARGE", LG: "LARGE", LRG: "LARGE", LARGE: "LARGE",
  XL: "XLARGE", XLG: "XLARGE", "X-LARGE": "XLARGE", XLARGE: "XLARGE",
  XXL: "2XLARGE", "2X": "2XLARGE", "2XL": "2XLARGE", XXLARGE: "2XLARGE", "2XLARGE": "2XLARGE",
  XXXL: "3XLARGE", "3X": "3XLARGE", "3XL": "3XLARGE", "3XLARGE": "3XLARGE",
};
function normalizeSize(raw) {
  if (raw == null) return raw;
  return LETTER_SIZE_CANON[String(raw).trim().toUpperCase()] || String(raw).trim();
}

const cellKey = (color, size) =>
  `${String(color).trim().toUpperCase()}|${normalizeSize(size).toUpperCase()}`;

/**
 * Mint UPC-A codes for a freshly-created style.
 *
 * @param {object} admin     supabase service-role client
 * @param {string} entityId
 * @param {object} style     { id, style_code, size_scale_id, description }
 * @returns {Promise<{minted:number, skipped:boolean, reason?:string, upcs?:string[]}>}
 */
export async function mintUpcsForStyle(admin, entityId, style) {
  // 1. GS1 prefix must be configured, else we'd mint invalid barcodes.
  const { data: settings } = await admin
    .from("company_settings")
    .select("gs1_prefix, prefix_length, gtin_indicator_digit, next_item_reference_counter")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!settings || !settings.gs1_prefix || !settings.prefix_length) {
    return { minted: 0, skipped: true, reason: "No GS1 company prefix configured (company_settings)." };
  }

  // 2. Sizes from the scale (ordered); fall back to distinct SKU sizes.
  let sizes = [];
  if (style.size_scale_id) {
    const { data: scale } = await admin
      .from("size_scales").select("sizes").eq("id", style.size_scale_id).maybeSingle();
    if (Array.isArray(scale?.sizes)) sizes = scale.sizes.filter(Boolean).map((s) => String(s));
  }

  // 3. Colors (and any fallback sizes) from the style's existing SKUs.
  const { data: skuRows } = await admin
    .from("ip_item_master")
    .select("color, size")
    .eq("entity_id", entityId)
    .eq("style_id", style.id);
  const skus = skuRows || [];

  if (sizes.length === 0) {
    const seen = new Set();
    for (const s of skus) {
      const sz = s.size ? normalizeSize(s.size) : null;
      if (sz && !seen.has(sz)) { seen.add(sz); sizes.push(sz); }
    }
  }
  const colors = [...new Set(skus.map((s) => s.color).filter(Boolean))];

  if (colors.length === 0) {
    return {
      minted: 0,
      skipped: true,
      reason: "Style has no colors yet — UPCs will be available to mint once color SKUs exist.",
    };
  }
  if (sizes.length === 0) {
    return { minted: 0, skipped: true, reason: "Style has no sizes (assign a size scale first)." };
  }

  // 4. Existing UPCs for this style → skip cells already covered (idempotent).
  const { data: existing } = await admin
    .from("upc_item_master")
    .select("color, size")
    .eq("style_no", style.style_code);
  const covered = new Set((existing || []).map((r) => cellKey(r.color, r.size)));

  // 5. Build the list of (color, size) cells that still need a UPC.
  const want = [];
  for (const color of colors) {
    for (const rawSize of sizes) {
      const size = normalizeSize(rawSize);
      const k = cellKey(color, size);
      if (covered.has(k)) continue;
      covered.add(k); // de-dup within this run too
      want.push({ color, size });
    }
  }
  if (want.length === 0) return { minted: 0, skipped: false, upcs: [] };

  // Guard the finite UPC space (e.g. prefix length 7 → 9999 references total).
  const maxRef = maxUpcItemReference(settings.prefix_length);
  const remaining = maxRef - (Number(settings.next_item_reference_counter) - 1);
  if (remaining < want.length) {
    return {
      minted: 0,
      skipped: true,
      reason: `Not enough GS1 item references remaining (${Math.max(remaining, 0)} left, need ${want.length}).`,
    };
  }

  // 6. Mint: claim one atomic reference per cell, build the UPC, insert.
  // Each claim is its own RPC round-trip so the counter advances atomically and
  // no two mints share a number. Inserts use upsert on the unique `upc` so a
  // race can't create a duplicate row.
  const minted = [];
  for (const cell of want) {
    let itemRef;
    try {
      const { data: ref, error: rpcErr } = await admin.rpc("gs1_claim_next_item_reference");
      if (rpcErr) throw rpcErr;
      itemRef = Array.isArray(ref) ? Number(ref[0]) : Number(ref);
      if (!Number.isFinite(itemRef)) throw new Error("counter RPC returned a non-numeric value");
    } catch (e) {
      // Stop on counter failure but report what was minted so far.
      return { minted: minted.length, skipped: minted.length === 0, reason: `counter error: ${e.message}`, upcs: minted };
    }

    const upc = buildUpcAFromSettings(settings, itemRef);
    const { error: insErr } = await admin
      .from("upc_item_master")
      .upsert(
        {
          upc,
          style_no: style.style_code,
          color: cell.color,
          size: cell.size,
          description: style.description || null,
          source_method: "gs1",
        },
        { onConflict: "upc", ignoreDuplicates: true },
      );
    // sku_id is auto-resolved by the upc_item_master_set_sku_id trigger.
    if (!insErr) minted.push(upc);
  }

  return { minted: minted.length, skipped: false, upcs: minted };
}
