// api/internal/tax/rules/:id
//
// PUT — update rule (rate_pct, is_active, effective_to, threshold_amount, applies_to).

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../_lib/auth.js";

export const config = { maxDuration: 10 };

function getId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("rules");
  return idx >= 0 ? parts[idx + 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Internal-API gate. See api/_lib/auth.js. Open until INTERNAL_API_TOKEN
  // is set (logs a warn on first call); 401 once configured.
  const __internalAuth = authenticateInternalCaller(req);
  if (!__internalAuth.ok) return res.status(__internalAuth.status).json({ error: __internalAuth.error });
  if (req.method !== "PUT") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const id = getId(req);
  if (!id) return res.status(400).json({ error: "Missing rule id" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }

  const updates = {};
  if (body?.rate_pct !== undefined) {
    const n = Number(body.rate_pct);
    if (!Number.isFinite(n) || n < 0 || n > 100) return res.status(400).json({ error: "rate_pct must be 0..100" });
    updates.rate_pct = n;
  }
  if (body?.is_active !== undefined) updates.is_active = !!body.is_active;
  if (body?.effective_to !== undefined) updates.effective_to = body.effective_to || null;
  if (body?.threshold_amount !== undefined) updates.threshold_amount = body.threshold_amount === null || body.threshold_amount === "" ? null : Number(body.threshold_amount);
  if (body?.applies_to !== undefined) {
    if (!["goods", "services", "all"].includes(body.applies_to)) return res.status(400).json({ error: "invalid applies_to" });
    updates.applies_to = body.applies_to;
  }
  if (body?.vendor_type_exemptions !== undefined) {
    if (!Array.isArray(body.vendor_type_exemptions)) return res.status(400).json({ error: "vendor_type_exemptions must be an array" });
    updates.vendor_type_exemptions = body.vendor_type_exemptions;
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: "No updatable fields" });
  updates.updated_at = new Date().toISOString();

  const { error } = await admin.from("tax_rules").update(updates).eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true, id, ...updates });
}
