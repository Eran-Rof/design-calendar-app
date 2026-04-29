// api/internal/tax/rules
//
// GET  — list rules (filterable by jurisdiction, tax_type, is_active).
// POST — create rule.
//   body: { entity_id, jurisdiction, tax_type, rate_pct, applies_to?,
//           threshold_amount?, vendor_type_exemptions?, effective_from, effective_to? }

import { createClient } from "@supabase/supabase-js";
import { TAX_TYPES } from "../../../../_lib/tax.js";
import { authenticateInternalCaller } from "../../../../_lib/auth.js";

export const config = { maxDuration: 10 };

const APPLIES_TO = ["goods", "services", "all"];

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Internal-API gate. See api/_lib/auth.js. Open until INTERNAL_API_TOKEN
  // is set (logs a warn on first call); 401 once configured.
  const __internalAuth = authenticateInternalCaller(req);
  if (!__internalAuth.ok) return res.status(__internalAuth.status).json({ error: __internalAuth.error });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const entityId = url.searchParams.get("entity_id") || req.headers["x-entity-id"];
    const jurisdiction = url.searchParams.get("jurisdiction");
    const taxType = url.searchParams.get("tax_type");
    const active = url.searchParams.get("is_active");
    let q = admin.from("tax_rules").select("*").order("created_at", { ascending: false });
    if (entityId) q = q.eq("entity_id", entityId);
    if (jurisdiction) q = q.eq("jurisdiction", jurisdiction);
    if (taxType) q = q.eq("tax_type", taxType);
    if (active !== null && active !== undefined && active !== "") q = q.eq("is_active", active === "true");
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ rows: data || [] });
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const errs = [];
    if (!body?.entity_id) errs.push("entity_id required");
    if (!body?.jurisdiction) errs.push("jurisdiction required");
    if (!TAX_TYPES.includes(body?.tax_type)) errs.push(`tax_type must be one of ${TAX_TYPES.join(", ")}`);
    const rate = Number(body?.rate_pct);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) errs.push("rate_pct must be 0..100");
    if (body?.applies_to && !APPLIES_TO.includes(body.applies_to)) errs.push(`applies_to must be one of ${APPLIES_TO.join(", ")}`);
    if (!body?.effective_from) errs.push("effective_from required");
    if (errs.length) return res.status(400).json({ error: errs.join("; ") });

    const { data, error } = await admin.from("tax_rules").insert({
      entity_id: body.entity_id,
      jurisdiction: String(body.jurisdiction).trim(),
      tax_type: body.tax_type,
      rate_pct: rate,
      applies_to: body.applies_to || "all",
      threshold_amount: body.threshold_amount != null && body.threshold_amount !== "" ? Number(body.threshold_amount) : null,
      vendor_type_exemptions: Array.isArray(body.vendor_type_exemptions) ? body.vendor_type_exemptions : [],
      is_active: body.is_active !== false,
      effective_from: body.effective_from,
      effective_to: body.effective_to || null,
    }).select("*").single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json(data);
  }

  return res.status(405).json({ error: "Method not allowed" });
}
