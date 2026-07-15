// GET /api/internal/data-freshness
//
// Reports the age of each key data feed (on-hand, sales, POs, receipts) and
// which are stale. Lets the Shadow-Mirror status / Today page make "green" mean
// "fresh" instead of just "the last run didn't error".

import { createClient } from "@supabase/supabase-js";
import { fetchFeedFreshness } from "../../_lib/dataFreshness.js";

export const config = { maxDuration: 20 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  try {
    const result = await fetchFeedFreshness(admin);
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
