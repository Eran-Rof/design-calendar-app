// api/internal/discount-offers/analytics
//
// GET — early-payment analytics for an entity (live roll-up from offers).
//   ?entity_id=<uuid>                 required
//   ?period_start=<YYYY-MM-DD>        default: Jan 1 of current year
//   ?period_end=<YYYY-MM-DD>          default: today
// Returns EarlyPaymentAnalytics-shaped payload.

import { createClient } from "@supabase/supabase-js";
import { computeAnalytics } from "../../../_lib/discount-offers.js";

export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const entityId = url.searchParams.get("entity_id") || req.headers["x-entity-id"];
  if (!entityId) return res.status(400).json({ error: "entity_id required" });
  const today = new Date();
  const periodStart = url.searchParams.get("period_start")
    || `${today.getUTCFullYear()}-01-01`;
  const periodEnd   = url.searchParams.get("period_end")
    || today.toISOString().slice(0, 10);

  const out = await computeAnalytics(admin, { entityId, periodStart, periodEnd });
  return res.status(200).json(out);
}
