// api/internal/costing/lines/:line_id/po-history
//
// GET → past tanda_pos line-items matching the costing line's style + vendor.
//
// Filters:
//   • po_line_items.item_number ILIKE '<style_code>%'   (catches SKUs under the style)
//   • tanda_pos.vendor_id = costing_line_vendors.vendor_id  (line's selected vendor)
//
// Includes archived POs — operator wants to see ALL historical pricing
// for the same item from the same vendor regardless of archive state
// (data->>'_archived' is not filtered out).
//
// Returned shape per row:
//   • po_number
//   • received_date   — date_expected when received, else null
//   • planned_ddp     — date_expected_delivery from po_line_items, else
//                       tanda_pos.date_expected fallback
//   • unit_price
//   • item_number     — the matched SKU
//   • qty_ordered / qty_received  (for context in the popover)

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../../_lib/auth.js";

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

  // 1. Line — need its style_code + the selected vendor's id.
  const { data: line, error: lineErr } = await admin.from("costing_lines")
    .select("id, style_code, selected_vendor_quote_id")
    .eq("id", lineId).maybeSingle();
  if (lineErr) return res.status(500).json({ error: lineErr.message });
  if (!line) return res.status(404).json({ error: "Line not found" });

  const styleCode = (line.style_code || "").trim();
  if (!styleCode) {
    return res.status(200).json({ rows: [], reason: "no_style_code" });
  }

  // 2. Vendor id from the selected costing_line_vendors row.
  let vendorId = null;
  if (line.selected_vendor_quote_id) {
    const { data: quote } = await admin.from("costing_line_vendors")
      .select("vendor_id")
      .eq("id", line.selected_vendor_quote_id).maybeSingle();
    vendorId = quote?.vendor_id || null;
  }
  if (!vendorId) {
    return res.status(200).json({ rows: [], reason: "no_selected_vendor" });
  }

  // 3. Pull tanda_pos rows for that vendor (incl. archived).
  const { data: pos, error: posErr } = await admin.from("tanda_pos")
    .select("uuid_id, po_number, date_expected, date_order, status, data")
    .eq("vendor_id", vendorId)
    .order("date_expected", { ascending: false, nullsFirst: false })
    .limit(500);
  if (posErr) return res.status(500).json({ error: posErr.message });
  if (!pos || pos.length === 0) {
    return res.status(200).json({ rows: [], reason: "no_pos_for_vendor" });
  }

  const poByUuid = new Map(pos.map((p) => [p.uuid_id, p]));
  const poIds = pos.map((p) => p.uuid_id);

  // 4. Matching line items in one batched query. ILIKE on item_number
  // catches every SKU under the style (item codes typically prefix with
  // the style code, e.g. RCB1868-CHARCOAL-M).
  const safeStyle = styleCode.replace(/[%_]/g, "\\$&");
  const { data: items, error: itemsErr } = await admin.from("po_line_items")
    .select("po_id, item_number, description, qty_ordered, qty_received, unit_price, line_total, date_expected_delivery")
    .in("po_id", poIds)
    .ilike("item_number", `${safeStyle}%`)
    .limit(500);
  if (itemsErr) return res.status(500).json({ error: itemsErr.message });

  const rows = (items || []).map((it) => {
    const po = poByUuid.get(it.po_id);
    const archived = !!(po && po.data && (po.data._archived === true || po.data._archived === "true"));
    const received = typeof it.qty_received === "number" && it.qty_received > 0;
    return {
      po_number: po?.po_number || null,
      po_id: it.po_id,
      item_number: it.item_number,
      description: it.description,
      qty_ordered: it.qty_ordered,
      qty_received: it.qty_received,
      unit_price: it.unit_price,
      received_date: received ? (po?.date_expected || null) : null,
      planned_ddp: !received ? (it.date_expected_delivery || po?.date_expected || null) : null,
      status: po?.status || null,
      archived,
    };
  }).sort((a, b) => {
    const da = (a.received_date || a.planned_ddp || "");
    const db = (b.received_date || b.planned_ddp || "");
    return db.localeCompare(da);
  });

  return res.status(200).json({ rows });
}
