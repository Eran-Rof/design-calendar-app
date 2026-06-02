// api/internal/costing/lines/:line_id/quotes/:quote_id
//
// PUT    — patch vendor quote (editable cost/status/notes/etc)
// DELETE — remove vendor quote

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../../../_lib/auth.js";

export const config = { maxDuration: 15 };

const EDITABLE = ["vendor_id","quoted_cost","currency","lead_time_days","moq","quoted_date","valid_until","status","notes"];

function getIds(req) {
  if (req.query && req.query.quote_id) return { lineId: req.query.line_id, quoteId: req.query.quote_id };
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const lineIdx = parts.lastIndexOf("lines");
  const qIdx = parts.lastIndexOf("quotes");
  return {
    lineId: lineIdx >= 0 ? parts[lineIdx + 1] : null,
    quoteId: qIdx >= 0 ? parts[qIdx + 1] : null,
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();

  const __internalAuth = authenticateInternalCaller(req);
  if (!__internalAuth.ok) return res.status(__internalAuth.status).json({ error: __internalAuth.error });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const { quoteId } = getIds(req);
  if (!quoteId) return res.status(400).json({ error: "Missing quote id" });

  if (req.method === "PUT") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const updates = {};
    for (const f of EDITABLE) {
      if (body && Object.prototype.hasOwnProperty.call(body, f)) updates[f] = body[f];
    }
    if (updates.quoted_cost != null) updates.quoted_cost = Number(updates.quoted_cost);
    if (updates.status && !["pending","received","selected","rejected","expired"].includes(updates.status)) {
      return res.status(400).json({ error: "invalid status" });
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: "No editable fields in body" });

    const { data, error } = await admin.from("costing_line_vendors")
      .update(updates).eq("id", quoteId).select("*").maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Quote not found" });
    return res.status(200).json(data);
  }

  if (req.method === "DELETE") {
    const { error } = await admin.from("costing_line_vendors").delete().eq("id", quoteId);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(204).end();
  }

  return res.status(405).json({ error: "Method not allowed" });
}
