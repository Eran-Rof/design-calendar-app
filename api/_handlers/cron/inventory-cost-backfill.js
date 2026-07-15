// api/_handlers/cron/inventory-cost-backfill.js
//
// Daily (09:00 UTC): re-run the Inventory Aging cost back-fill so newly-received
// stock doesn't slowly re-accumulate as "Uncosted" in the report. Calls the
// idempotent inventory_cost_backfill() RPC (Tier 1 native-PO weighted-avg +
// Tier 2 style-sibling avg → ip_item_avg_cost, the report's cost fallback).
//
// READ-of-inventory / WRITE-only-to-ip_item_avg_cost: NO GL, on-hand, or
// inventory-layer mutation; fills only currently-uncosted items and never
// overwrites a real cost. Idempotent — a no-op day fills 0.

import { createClient } from "@supabase/supabase-js";
import { captureError } from "../../_lib/errorCapture.js";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !KEY) return res.status(500).json({ ok: false, error: "Supabase admin not configured" });
  const admin = createClient(SB_URL, KEY, { auth: { persistSession: false } });

  try {
    const { data: entity } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
    const { data, error } = await admin.rpc("inventory_cost_backfill", { p_entity_id: entity?.id || null });
    if (error) throw new Error(error.message);

    const summary = data || {};
    // Breadcrumb only when the job actually filled something, so the daily
    // digest shows newly-costed stock without noise on quiet days.
    const filled = Number(summary.tier1_filled || 0) + Number(summary.tier2_filled || 0);
    if (filled > 0) {
      await captureError({
        source: "cron",
        route: "/api/cron/inventory-cost-backfill",
        message: `Inventory cost back-fill: costed ${filled} item(s) (T1 ${summary.tier1_filled || 0} / T2 ${summary.tier2_filled || 0}); ${summary.remaining_uncosted_units || 0} units still uncosted`,
        context: { kind: "inventory-cost-backfill", ...summary },
      }).catch(() => {});
    }

    return res.status(200).json({ ok: true, ...summary });
  } catch (e) {
    await captureError({
      source: "cron",
      route: "/api/cron/inventory-cost-backfill",
      message: `Inventory cost back-fill failed: ${e?.message || String(e)}`,
      context: { kind: "inventory-cost-backfill" },
    }).catch(() => {});
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
