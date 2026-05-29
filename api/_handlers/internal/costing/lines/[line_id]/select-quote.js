// api/internal/costing/lines/:line_id/select-quote
//
// POST { quote_id }
//
// Selects a vendor quote as the winning one for a costing line:
//   1. Demote any currently-selected quote on this line back to 'received'
//      (so the partial unique index allows the swap).
//   2. Promote the new quote to status='selected'.
//   3. Stamp costing_lines.selected_vendor_quote_id.
//
// Chunk 8 will extend this handler to ALSO write the quoted cost into
// ip_item_avg_cost.standard_unit_price for every SKU under the style.
// The TODO comment below marks the insertion point.

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
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const __internalAuth = authenticateInternalCaller(req);
  if (!__internalAuth.ok) return res.status(__internalAuth.status).json({ error: __internalAuth.error });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const lineId = getLineId(req);
  if (!lineId) return res.status(400).json({ error: "Missing line id" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  const { quote_id } = body || {};
  if (!quote_id) return res.status(400).json({ error: "quote_id is required" });

  // Verify quote belongs to this line.
  const { data: quote } = await admin.from("costing_line_vendors")
    .select("id, costing_line_id, quoted_cost")
    .eq("id", quote_id).maybeSingle();
  if (!quote) return res.status(404).json({ error: "Quote not found" });
  if (quote.costing_line_id !== lineId) {
    return res.status(409).json({ error: "Quote does not belong to this line" });
  }

  // 1. Demote any currently-selected quote (other than this one) on this line.
  await admin.from("costing_line_vendors")
    .update({ status: "received" })
    .eq("costing_line_id", lineId)
    .eq("status", "selected")
    .neq("id", quote_id);

  // 2. Promote the new quote.
  const { error: promoteErr } = await admin.from("costing_line_vendors")
    .update({ status: "selected" }).eq("id", quote_id);
  if (promoteErr) return res.status(500).json({ error: promoteErr.message });

  // 3. Stamp the back-pointer.
  const { data: line, error: lineErr } = await admin.from("costing_lines")
    .update({ selected_vendor_quote_id: quote_id })
    .eq("id", lineId).select("*").maybeSingle();
  if (lineErr) return res.status(500).json({ error: lineErr.message });

  // TODO(chunk8): write quote.quoted_cost into ip_item_avg_cost.standard_unit_price
  // for every SKU under this style. Resolve SKUs via ip_item_master join on style_code.
  // Audit row to ip_item_avg_cost_audit if it exists.

  return res.status(200).json({ line, selected_quote_id: quote_id });
}
