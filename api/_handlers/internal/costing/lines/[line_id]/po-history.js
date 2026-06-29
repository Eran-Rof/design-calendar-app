// api/internal/costing/lines/:line_id/po-history
//
// GET → past tanda_pos PO history matching the costing line's style,
// ACROSS ALL VENDORS, aggregated to ONE row per PO.
//
// Filters:
//   • po_line_items.item_number ILIKE '<style_code>%'   (catches SKUs under the style)
//   • vendor is NOT filtered — every PO that bought this style is returned,
//     regardless of which vendor it came from.
//
// Includes archived POs — operator wants to see ALL historical pricing
// for the same style regardless of archive state
// (data->>'_archived' is not filtered out).
//
// Grain: ONE row per PO (matching line items grouped by po_id). Returned shape:
//   • po_number
//   • vendor_name    — tanda_pos.vendor_id → vendors.name
//   • qty_ordered    — Σ ordered across matching line items
//   • qty_received   — Σ received across matching line items
//   • unit_price     — quantity-weighted average Σ(unit_price·qty)/Σqty
//                      (falls back to a simple average if qty is missing)
//   • received_date  — date_expected when any line received, else null
//   • planned_ddp    — max line date_expected_delivery, else tanda_pos.date_expected
//   • status / archived

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../../_lib/auth.js";
import { ppkMultiplier } from "../../../../../_lib/prepack.js";

export const config = { maxDuration: 15 };

function getLineId(req) {
  if (req.query && req.query.line_id) return req.query.line_id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("lines");
  return idx >= 0 ? parts[idx + 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const __internalAuth = authenticateInternalCaller(req);
  if (!__internalAuth.ok) return res.status(__internalAuth.status).json({ error: __internalAuth.error });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const lineId = getLineId(req);
  if (!lineId) return res.status(400).json({ error: "Missing line id" });

  // 1. Line — need its style_code.
  const { data: line, error: lineErr } = await admin.from("costing_lines")
    .select("id, style_code")
    .eq("id", lineId).maybeSingle();
  if (lineErr) return res.status(500).json({ error: lineErr.message });
  if (!line) return res.status(404).json({ error: "Line not found" });

  const styleCode = (line.style_code || "").trim();
  if (!styleCode) {
    return res.status(200).json({ rows: [], reason: "no_style_code" });
  }

  // 2. Matching line items ACROSS ALL POs/vendors. ILIKE on item_number
  // catches every SKU under the style (item codes typically prefix with
  // the style code, e.g. RCB1868-CHARCOAL-M). Paginate so a popular style
  // with many SKUs/POs isn't silently truncated by the 1000-row cap.
  const safeStyle = styleCode.replace(/[%_]/g, "\\$&");
  const PAGE = 1000;
  const items = [];
  for (let from = 0; ; from += PAGE) {
    const { data: page, error: itemsErr } = await admin.from("po_line_items")
      .select("po_id, item_number, description, qty_ordered, qty_received, unit_price, date_expected_delivery")
      .ilike("item_number", `${safeStyle}%`)
      .range(from, from + PAGE - 1);
    if (itemsErr) return res.status(500).json({ error: itemsErr.message });
    if (!page || page.length === 0) break;
    items.push(...page);
    if (page.length < PAGE) break;
  }

  if (items.length === 0) {
    return res.status(200).json({ rows: [], reason: "no_pos_for_style" });
  }

  // 3. Load the parent POs (incl. archived) + their vendor names.
  const poIds = [...new Set(items.map((it) => it.po_id).filter(Boolean))];
  const poByUuid = new Map();
  for (let i = 0; i < poIds.length; i += 200) {
    const slice = poIds.slice(i, i + 200);
    const { data: pos, error: posErr } = await admin.from("tanda_pos")
      .select("uuid_id, po_number, vendor_id, date_expected, status, data")
      .in("uuid_id", slice);
    if (posErr) return res.status(500).json({ error: posErr.message });
    (pos || []).forEach((p) => poByUuid.set(p.uuid_id, p));
  }

  const vendorIds = [...new Set([...poByUuid.values()].map((p) => p.vendor_id).filter(Boolean))];
  const vendorName = new Map();
  for (let i = 0; i < vendorIds.length; i += 200) {
    const slice = vendorIds.slice(i, i + 200);
    const { data: vs, error: vErr } = await admin.from("vendors")
      .select("id, name").in("id", slice);
    if (vErr) return res.status(500).json({ error: vErr.message });
    (vs || []).forEach((v) => vendorName.set(v.id, v.name));
  }

  // 4. Aggregate line items → ONE row per PO.
  // PPK explosion: for pack-grain line items the unit_price stored in
  // po_line_items is the PACK price and qty_ordered is in PACKS.
  // We detect the pack multiplier from the item_number (SKU) + description,
  // then:
  //   • qty_ordered_units  = qty_ordered × mult   (true selling units)
  //   • unit_price_per_unit = unit_price  / mult   (per-unit cost)
  // The weighted avg (Σ unit_price_per_unit × qty_units) / Σ qty_units
  // is therefore always in per-unit terms regardless of grain.
  const byPo = new Map(); // po_id → accumulator
  for (const it of items) {
    const po = poByUuid.get(it.po_id);
    if (!po) continue; // orphan line item with no parent PO — skip
    let acc = byPo.get(it.po_id);
    if (!acc) {
      acc = {
        po_id: it.po_id,
        po_number: po.po_number || null,
        vendor_name: po.vendor_id ? (vendorName.get(po.vendor_id) || null) : null,
        status: po.status || null,
        archived: !!(po.data && (po.data._archived === true || po.data._archived === "true")),
        po_date_expected: po.date_expected || null,
        qty_ordered: 0,      // unit-exploded ordered qty
        qty_received: 0,     // unit-exploded received qty
        priceQtySum: 0,      // Σ(per_unit_price · qty_units) for weighted avg
        priceQtyWeight: 0,   // Σ qty_units (where both price & qty present)
        priceSum: 0,         // Σ per_unit_price for fallback simple avg
        priceCount: 0,       // # of lines with a price
        maxPlannedDdp: null,
        anyReceived: false,
        // qty_per_pack: the multiplier of the FIRST pack line encountered
        // (most POs are single-style, so this is representative).
        qty_per_pack: 1,
      };
      byPo.set(it.po_id, acc);
    }

    // Resolve PPK multiplier from SKU (item_number) + description.
    // item_number IS the full SKU (e.g. "RCB1868-CHARCOAL-PPK24-M").
    // color/size are embedded in it but we don't need them separately —
    // ppkMultiplier's identity gate (sku/style/size must contain "PPK")
    // uses the sku param (item_number) which covers all cases here.
    const mult = ppkMultiplier(
      null,              // color — embedded in item_number; not a separate column in po_line_items
      null,              // size  — same
      it.description,    // description
      null,              // style — not a separate column; style is the ILIKE prefix we already filtered on
      it.item_number,    // sku   — the canonical identity signal
    );
    if (mult > 1) acc.qty_per_pack = mult;

    const rawQtyOrd = typeof it.qty_ordered === "number" ? it.qty_ordered : 0;
    const rawQtyRec = typeof it.qty_received === "number" ? it.qty_received : 0;
    const qtyOrd = rawQtyOrd * mult;  // exploded to units
    const qtyRec = rawQtyRec * mult;  // exploded to units
    acc.qty_ordered += qtyOrd;
    acc.qty_received += qtyRec;
    if (qtyRec > 0) acc.anyReceived = true;

    if (typeof it.unit_price === "number") {
      const perUnitPrice = it.unit_price / mult; // divide pack price → per-unit
      acc.priceSum += perUnitPrice;
      acc.priceCount += 1;
      const w = qtyOrd > 0 ? qtyOrd : 0;
      if (w > 0) {
        acc.priceQtySum += perUnitPrice * w;
        acc.priceQtyWeight += w;
      }
    }
    if (it.date_expected_delivery) {
      if (!acc.maxPlannedDdp || it.date_expected_delivery > acc.maxPlannedDdp) {
        acc.maxPlannedDdp = it.date_expected_delivery;
      }
    }
  }

  const rows = [...byPo.values()].map((acc) => {
    let unit_price = null;
    if (acc.priceQtyWeight > 0) {
      unit_price = acc.priceQtySum / acc.priceQtyWeight;
    } else if (acc.priceCount > 0) {
      unit_price = acc.priceSum / acc.priceCount;
    }
    const received_date = acc.anyReceived ? (acc.po_date_expected || null) : null;
    const planned_ddp = acc.anyReceived ? null : (acc.maxPlannedDdp || acc.po_date_expected || null);
    return {
      po_number: acc.po_number,
      po_id: acc.po_id,
      vendor_name: acc.vendor_name,
      qty_ordered: acc.qty_ordered,
      qty_received: acc.qty_received,
      unit_price,
      qty_per_pack: acc.qty_per_pack,
      received_date,
      planned_ddp,
      status: acc.status,
      archived: acc.archived,
    };
  }).sort((a, b) => {
    const da = (a.received_date || a.planned_ddp || "");
    const db = (b.received_date || b.planned_ddp || "");
    return db.localeCompare(da);
  });

  return res.status(200).json({ rows });
}
