// api/internal/analytics/early-payment
//
// GET — early-payment analytics for an entity.
//   ?entity_id=<uuid>            required (or X-Entity-ID header)
//   ?period_start=<YYYY-MM-DD>   default: Jan 1 of current year
//   ?period_end=<YYYY-MM-DD>     default: today
//   ?source=stored|live          default: auto (stored if present, live fallback)
//
// Reads from early_payment_analytics (populated monthly by the cron).
// Falls back to live computation when no stored row matches the period.

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
  const periodEnd = url.searchParams.get("period_end")
    || today.toISOString().slice(0, 10);
  const source = url.searchParams.get("source") || "auto";

  if (source !== "live") {
    const { data: stored } = await admin
      .from("early_payment_analytics")
      .select("*")
      .eq("entity_id", entityId)
      .eq("period_start", periodStart)
      .eq("period_end", periodEnd)
      .maybeSingle();
    if (stored) {
      const acceptanceRate = stored.total_offers_made > 0
        ? (Number(stored.total_offers_accepted) / Number(stored.total_offers_made)) * 100
        : 0;
      return res.status(200).json({
        entity_id: stored.entity_id,
        period_start: stored.period_start,
        period_end: stored.period_end,
        total_offers_made: Number(stored.total_offers_made),
        total_offers_accepted: Number(stored.total_offers_accepted),
        total_discount_captured: Number(stored.total_discount_captured),
        total_early_payment_amount: Number(stored.total_early_payment_amount),
        avg_discount_pct: Number(stored.avg_discount_pct || 0),
        annualized_return_pct: Number(stored.annualized_return_pct || 0),
        acceptance_rate_pct: Math.round(acceptanceRate * 100) / 100,
        generated_at: stored.generated_at,
        source: "stored",
      });
    }
    if (source === "stored") return res.status(404).json({ error: "No stored rollup for period" });
  }

  const live = await computeAnalytics(admin, { entityId, periodStart, periodEnd });
  return res.status(200).json({ ...live, source: "live" });
}
