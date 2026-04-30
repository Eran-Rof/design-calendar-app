// api/ats-supply-sync.js — Vercel Node.js Serverless Function
//
// Chunked supply sync (paged via ?start= and ?limit=) backing the
// "Sync on-hand (ATS)" button in the planning workbench. Real work
// lives in api/_lib/planning-sync.js so the new POST
// /api/planning/sync-on-hand endpoint can run the same code path
// without forking.
//
// Source: app_data['ats_excel_data'] (the persisted ATS Excel snapshot).
// Writes: ip_inventory_snapshot (today's row per SKU) and, on the
// first chunk, a full rebuild of ip_open_sales_orders.

import { createClient } from "@supabase/supabase-js";
import { syncOnHandChunkFromAtsSnapshot } from "../_lib/planning-sync.js";

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: "Server not configured" });
  }
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const start = Math.max(parseInt(url.searchParams.get("start") || "0", 10), 0);
  const batchSize = Math.min(parseInt(url.searchParams.get("limit") || "2000", 10), 10000);

  const result = await syncOnHandChunkFromAtsSnapshot(admin, { start, limit: batchSize });
  return res.status(200).json(result);
}
