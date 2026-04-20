// api/internal/tax/remittance-report
//
// GET — aggregated view for filing. Supports CSV export via ?format=csv.
//   ?period_start=<YYYY-MM-DD>&period_end=<YYYY-MM-DD>&jurisdiction=&tax_type=

import { createClient } from "@supabase/supabase-js";
import { aggregateRemittance } from "../../../_lib/tax.js";

export const config = { maxDuration: 15 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const from = url.searchParams.get("period_start");
  const to   = url.searchParams.get("period_end");
  const jurisdiction = url.searchParams.get("jurisdiction");
  const taxType = url.searchParams.get("tax_type");
  const format = url.searchParams.get("format") || "json";
  if (!from || !to) return res.status(400).json({ error: "period_start and period_end required" });

  let q = admin.from("tax_calculations")
    .select("jurisdiction, tax_type, taxable_amount, tax_amount, calculated_at")
    .gte("calculated_at", `${from}T00:00:00Z`)
    .lte("calculated_at", `${to}T23:59:59Z`);
  if (jurisdiction) q = q.eq("jurisdiction", jurisdiction);
  if (taxType) q = q.eq("tax_type", taxType);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  const summary = aggregateRemittance(data || []);
  const payload = { range: { from, to }, ...summary };

  if (format === "csv") {
    const header = "jurisdiction,tax_type,taxable,tax,count";
    const lines = summary.by_jurisdiction.map((r) => `${r.jurisdiction},${r.tax_type},${r.taxable},${r.tax},${r.count}`);
    const csv = [header, ...lines].join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="tax-remittance-${from}_${to}.csv"`);
    return res.status(200).send(csv);
  }

  return res.status(200).json(payload);
}
