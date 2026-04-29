// api/cron/early-payment-analytics
//
// Monthly early-payment analytics rollup. Runs on the 2nd of each month via
// vercel.json crons; computes prior-calendar-month rollups per entity from
// dynamic_discount_offers and upserts into early_payment_analytics.
//
// For each entity (limited to entities with offers in the period):
//   - Calls computeAnalytics() to derive offer/acceptance/discount totals.
//   - Upserts a row keyed by (entity_id, period_start, period_end).
//
// Idempotent: re-running for the same period overwrites the row via
// uq_epa_entity_period unique index.
//
// Auth: CRON_SECRET Bearer header. If unset, endpoint is open (for dry-runs).

import { createClient } from "@supabase/supabase-js";
import { computeAnalytics } from "../../_lib/discount-offers.js";

export const config = { maxDuration: 300 };

function previousMonth(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const expectedSecret = process.env.CRON_SECRET;
  if (expectedSecret && req.headers.authorization !== `Bearer ${expectedSecret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const overrideStart = url.searchParams.get("period_start");
  const overrideEnd = url.searchParams.get("period_end");
  const { start: periodStart, end: periodEnd } = overrideStart && overrideEnd
    ? { start: overrideStart, end: overrideEnd }
    : previousMonth();

  const result = {
    started_at: new Date().toISOString(),
    period_start: periodStart,
    period_end: periodEnd,
    entities_processed: 0,
    rows_written: 0,
    errors: [],
  };

  // Find every entity that had at least one offered_at in the period
  const { data: entityRows, error: entitiesErr } = await admin
    .from("dynamic_discount_offers")
    .select("entity_id")
    .gte("offered_at", new Date(periodStart + "T00:00:00Z").toISOString())
    .lte("offered_at", new Date(periodEnd + "T23:59:59.999Z").toISOString());

  if (entitiesErr) {
    result.errors.push({ stage: "list_entities", error: entitiesErr.message });
    result.finished_at = new Date().toISOString();
    return res.status(200).json(result);
  }

  const entityIds = [...new Set((entityRows || []).map((r) => r.entity_id).filter(Boolean))];
  result.entities_processed = entityIds.length;

  for (const entityId of entityIds) {
    try {
      const rollup = await computeAnalytics(admin, { entityId, periodStart, periodEnd });
      const row = {
        entity_id: rollup.entity_id,
        period_start: rollup.period_start,
        period_end: rollup.period_end,
        total_offers_made: rollup.total_offers_made,
        total_offers_accepted: rollup.total_offers_accepted,
        total_discount_captured: rollup.total_discount_captured,
        total_early_payment_amount: rollup.total_early_payment_amount,
        avg_discount_pct: rollup.avg_discount_pct,
        annualized_return_pct: rollup.annualized_return_pct,
        generated_at: rollup.generated_at,
      };
      const { error: upsertErr } = await admin
        .from("early_payment_analytics")
        .upsert(row, { onConflict: "entity_id,period_start,period_end" });
      if (upsertErr) {
        result.errors.push({ entity_id: entityId, error: upsertErr.message });
      } else {
        result.rows_written += 1;
      }
    } catch (err) {
      result.errors.push({ entity_id: entityId, error: err?.message || String(err) });
    }
  }

  result.finished_at = new Date().toISOString();
  return res.status(200).json(result);
}
