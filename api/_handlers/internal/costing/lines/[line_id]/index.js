// api/internal/costing/lines/:line_id
//
// GET    — single line detail
// PUT    — patch line (editable cost/margin/metadata columns)
// DELETE — remove line (cascades to quotes + compliance)

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../../_lib/auth.js";
import { vendorTargetForMode } from "../../../../../_lib/costingVendorTarget.js";

export const config = { maxDuration: 15 };

const EDITABLE = [
  "sort_order",
  "style_master_id", "style_code", "style_name", "description", "picture_url",
  "size_scale_id", "size_scale_label", "fabric_code", "fabric_codes", "fit", "color",
  "bottom_closure", "waist_type", "waste_type",
  "category_id", "sub_category_id", "style_state",
  "comment", "remarks",
  "status",
  "target_qty", "target_cost", "avg_cost", "sell_target", "sell_price",
  "priced_date", "fob_cost", "duty_rate", "freight", "insurance", "other_costs",
  "landed_cost", "margin_pct",
  "selected_vendor_quote_id",
  "ly_qty", "ly_unit_cost", "ly_unit_price", "ly_total_margin", "ly_margin_pct",
  "t3_qty", "t3_unit_cost", "t3_unit_price", "t3_total_cost", "t3_margin_pct",
  "comp_refreshed_at",
];

function getLineId(req) {
  if (req.query && req.query.line_id) return req.query.line_id;
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("lines");
  return idx >= 0 ? parts[idx + 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();

  const __internalAuth = authenticateInternalCaller(req);
  if (!__internalAuth.ok) return res.status(__internalAuth.status).json({ error: __internalAuth.error });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const lineId = getLineId(req);
  if (!lineId) return res.status(400).json({ error: "Missing line id" });

  if (req.method === "GET") {
    const { data, error } = await admin.from("costing_lines").select("*").eq("id", lineId).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Line not found" });
    return res.status(200).json(data);
  }

  if (req.method === "PUT") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const updates = {};
    for (const f of EDITABLE) {
      if (body && Object.prototype.hasOwnProperty.call(body, f)) updates[f] = body[f];
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: "No editable fields in body" });

    const { data, error } = await admin.from("costing_lines")
      .update(updates).eq("id", lineId).select("*").maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Line not found" });

    // Sync rfq_line_items.target_price whenever the vendor's COST BASIS changes
    // so the RFQ (and Compare Quotes) reflects the current target, not the stale
    // generation snapshot. The vendor target is the cost they quote against —
    // Tgt DDP cost (DDP projects) or FOB cost (FOB/Landed) — NEVER the sell price.
    const COST_FIELDS = ["target_cost", "fob_cost"];
    const hasCostChange = COST_FIELDS.some(f => Object.prototype.hasOwnProperty.call(updates, f));
    if (hasCostChange && data.project_id) {
      const toNum = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
      let isDdp = false;
      try {
        const { data: proj } = await admin.from("costing_projects")
          .select("payment_terms_name").eq("id", data.project_id).maybeSingle();
        isDdp = !!proj?.payment_terms_name && /DDP/i.test(proj.payment_terms_name);
      } catch { /* default to FOB basis */ }
      const newRef = vendorTargetForMode(isDdp, data.target_cost, data.fob_cost);
      if (newRef !== null) {
        // Path A: exact FK (new RFQs generated after migration 20260719000000)
        await admin.from("rfq_line_items").update({ target_price: newRef })
          .eq("costing_line_id", lineId);

        // Path B: legacy rows where costing_line_id is null (older RFQs). Match via
        // the project's rfqs; only update rows whose target_price == target_cost
        // (the original snapshot) so we don't clobber any manual overrides.
        const { data: rfqRows } = await admin.from("rfqs")
          .select("id").eq("source_costing_project_id", data.project_id);
        const rfqIds = (rfqRows || []).map(r => r.id);
        if (rfqIds.length > 0) {
          const { data: legItems } = await admin.from("rfq_line_items")
            .select("id, target_price").in("rfq_id", rfqIds).is("costing_line_id", null);
          const oldRef = toNum(data.target_cost);
          const legIds = (legItems || [])
            .filter(i => oldRef === null || toNum(i.target_price) === oldRef)
            .map(i => i.id);
          if (legIds.length > 0) {
            await admin.from("rfq_line_items").update({ target_price: newRef }).in("id", legIds);
          }
        }
      }
    }

    return res.status(200).json(data);
  }

  if (req.method === "DELETE") {
    const { error } = await admin.from("costing_lines").delete().eq("id", lineId);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(204).end();
  }

  return res.status(405).json({ error: "Method not allowed" });
}
