// api/internal/fx/rates
//
// GET — latest rate per (from_currency, to_currency) pair.
//   ?from=&to= optional filters.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 10 };

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
  const from = url.searchParams.get("from");
  const to   = url.searchParams.get("to");

  let q = admin.from("currency_rates").select("*").order("snapshotted_at", { ascending: false });
  if (from) q = q.eq("from_currency", from);
  if (to)   q = q.eq("to_currency", to);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  // Collapse to latest per pair
  const latest = {};
  for (const r of data || []) {
    const key = `${r.from_currency}|${r.to_currency}`;
    if (!(key in latest)) latest[key] = r;
  }
  return res.status(200).json({ rows: Object.values(latest) });
}
