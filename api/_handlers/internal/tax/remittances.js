// api/internal/tax/remittances
//
// GET  — list remittance records.
// POST — create remittance record after the tax has been filed/paid.
//   body: { entity_id, jurisdiction, tax_type, period_start, period_end, payment_reference? }
//   Amounts are rolled up from tax_calculations within the period.

import { createClient } from "@supabase/supabase-js";
import { TAX_TYPES, aggregateRemittance } from "../../../_lib/tax.js";

export const config = { maxDuration: 15 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
  if (req.method === "OPTIONS") return res.status(200).end();

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const entityId = url.searchParams.get("entity_id") || req.headers["x-entity-id"];
    let q = admin.from("tax_remittances").select("*").order("period_end", { ascending: false });
    if (entityId) q = q.eq("entity_id", entityId);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ rows: data || [] });
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const { entity_id, jurisdiction, tax_type, period_start, period_end, payment_reference } = body || {};
    if (!entity_id || !jurisdiction || !period_start || !period_end) return res.status(400).json({ error: "entity_id, jurisdiction, period_start, period_end required" });
    if (!TAX_TYPES.includes(tax_type)) return res.status(400).json({ error: `tax_type must be one of ${TAX_TYPES.join(", ")}` });

    // Compute totals from tax_calculations in range
    const { data: calcs } = await admin.from("tax_calculations")
      .select("jurisdiction, tax_type, taxable_amount, tax_amount")
      .eq("jurisdiction", jurisdiction).eq("tax_type", tax_type)
      .gte("calculated_at", `${period_start}T00:00:00Z`)
      .lte("calculated_at", `${period_end}T23:59:59Z`);
    const summary = aggregateRemittance(calcs || []);

    const { data, error } = await admin.from("tax_remittances").insert({
      entity_id, jurisdiction, tax_type, period_start, period_end,
      total_taxable_amount: summary.total_taxable,
      total_tax_amount: summary.total_tax,
      status: payment_reference ? "paid" : "filed",
      filed_at: new Date().toISOString(),
      payment_reference: payment_reference || null,
    }).select("*").single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json(data);
  }

  return res.status(405).json({ error: "Method not allowed" });
}
