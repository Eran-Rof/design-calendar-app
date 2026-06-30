// POST /api/planning/sync-on-hand — scriptable supply sync.
//
// Replaces the "Sync on-hand (ATS)" button when driven by the
// daily-design-calendar-sync skill. Pulls on-hand / on-SO from the
// persisted ATS Excel snapshot in app_data['ats_excel_data'] into
// ip_inventory_snapshot, walking through every chunk server-side so
// the caller doesn't have to manage pagination.
//
//   curl -X POST -H "Authorization: Bearer $DESIGN_CALENDAR_API_TOKEN" \
//        https://design-calendar-app.vercel.app/api/planning/sync-on-hand
//
// Real work lives in api/_lib/planning-sync.js, shared with the
// chunked /api/ats-supply-sync endpoint that backs the UI button.

import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { syncOnHandFromAtsSnapshot } from "../../_lib/planning-sync.js";
import { rebuildOnHandSync } from "../../_lib/inventory/onhand-sync.js";
import { authenticateDesignCalendarCaller } from "../../_lib/auth.js";

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const auth = authenticateDesignCalendarCaller(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const SB_URL = (process.env.VITE_SUPABASE_URL || "").trim();
  const SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!SB_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: "Server not configured" });
  }
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const requestId = randomUUID();
  try {
    const r = await syncOnHandFromAtsSnapshot(admin);
    if (r.error) {
      return res.status(400).json({ error: r.error, details: r.details ?? null });
    }

    // Phantom on-hand recurrence fix (Option A): after the authoritative ATS
    // snapshot lands, re-point Tangerine's synced on-hand layers at it so the
    // Inventory Matrix can't drift back into phantom on-hand. Env-gated so it's
    // inert until the operator opts in (financially material — see
    // api/_lib/inventory/onhand-sync.js for the manage/skip invariants):
    //   ONHAND_LAYER_SYNC=apply  → rebuild the layers
    //   ONHAND_LAYER_SYNC=report → dry-run, report only (no writes)
    //   unset                    → skip entirely (no behaviour change)
    let onhand_layer_sync = null;
    const mode = (process.env.ONHAND_LAYER_SYNC || "").trim().toLowerCase();
    if (mode === "apply" || mode === "report") {
      try {
        onhand_layer_sync = await rebuildOnHandSync(admin, { apply: mode === "apply" });
      } catch (e) {
        onhand_layer_sync = { error: String(e?.message || e) };
      }
    }

    return res.status(200).json({
      onhand_layer_sync,
      upserted: r.upserted,
      new_skus: r.new_skus,
      skipped: r.skipped,
      scanned: r.scanned,
      chunks: r.chunks,
      // SO promote counters (added 2026-05-13 after the "$4M instead
      // of $9M" SO promote bug). so_skipped_no_sku_id is the canary —
      // should always be 0 after planning-sync.js's SO-SKU expand+stub
      // runs cleanly. Non-zero means the lookup path silently dropped
      // SOs again — daily email + verify_ats_totals.py both watch this.
      so_lines_total: r.so_lines_total,
      so_lines_inserted: r.so_lines_inserted,
      so_lines_pruned: r.so_lines_pruned,
      so_skus_auto_created: r.so_skus_auto_created,
      so_skipped_no_sku: r.so_skipped_no_sku,
      so_skipped_no_sku_id: r.so_skipped_no_sku_id,
      so_customers_created: r.so_customers_created,
      errors: r.errors,
    });
  } catch (e) {
    console.error(`[planning/sync-on-hand ${requestId}] failed:`, e);
    return res.status(500).json({ error: "Sync failed", request_id: requestId });
  }
}
