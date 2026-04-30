// api/tanda-pos-sync.js — Vercel Node.js Serverless Function
//
// Open-PO sync backing the "Sync open POs (TandA)" button in the
// planning workbench. Real work lives in api/_lib/planning-sync.js
// so the new POST /api/planning/sync-open-pos endpoint can run the
// same code path without forking.
//
// Source: tanda_pos table (PO WIP app's persisted Xoro payloads).
// Writes: ip_open_purchase_orders (one row per (po, style+color)).

import { createClient } from "@supabase/supabase-js";
import { syncOpenPosFromTandaPos } from "../_lib/planning-sync.js";

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

  const result = await syncOpenPosFromTandaPos(admin);
  return res.status(200).json(result);
}
