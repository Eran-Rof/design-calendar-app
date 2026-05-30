// api/internal/costing/lines/:line_id/quotes
//
// GET  — list vendor quotes for a line (joined with vendor name)
// POST — create vendor quote
//   body: { vendor_id, quoted_cost, currency?, lead_time_days?, moq?,
//           quoted_date?, valid_until?, status?, notes? }

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../../../_lib/auth.js";

export const config = { maxDuration: 15 };

function getLineId(req) {
  if (req.query && req.query.line_id) return req.query.line_id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("lines");
  return idx >= 0 ? parts[idx + 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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
    const { data, error } = await admin.from("costing_line_vendors")
      .select("*, vendor:vendors(id, code, legal_name)")
      .eq("costing_line_id", lineId)
      .order("quoted_date", { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data || []);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const {
      vendor_id, quoted_cost, currency, lead_time_days, moq,
      quoted_date, valid_until, status, notes, entity_id,
    } = body || {};

    if (!vendor_id) return res.status(400).json({ error: "vendor_id is required" });
    if (quoted_cost == null || isNaN(Number(quoted_cost))) return res.status(400).json({ error: "quoted_cost is required" });
    if (status && !["pending","received","selected","rejected","expired"].includes(status)) {
      return res.status(400).json({ error: "invalid status" });
    }

    // Inherit entity_id from the parent line (current_entity_id() DEFAULT
    // returns NULL under service_role).
    const { data: parentLine } = await admin.from("costing_lines")
      .select("entity_id").eq("id", lineId).maybeSingle();
    if (!parentLine) return res.status(404).json({ error: "Line not found" });
    const insert = {
      entity_id: entity_id || parentLine.entity_id,
      costing_line_id: lineId,
      vendor_id,
      quoted_cost: Number(quoted_cost),
      currency: (currency || "USD").toUpperCase(),
      lead_time_days: lead_time_days != null ? Number(lead_time_days) : null,
      moq: moq != null ? Number(moq) : null,
      // quoted_date is NOT NULL on costing_line_vendors. Default to today
      // when the caller doesn't supply one (the grid's vendor-pick flow
      // doesn't ask the operator for a quote date).
      quoted_date: quoted_date || new Date().toISOString().slice(0, 10),
      valid_until: valid_until || null,
      status: status || "pending",
      notes: notes || null,
    };

    const { data, error } = await admin.from("costing_line_vendors").insert(insert).select("*").single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json(data);
  }

  return res.status(405).json({ error: "Method not allowed" });
}
