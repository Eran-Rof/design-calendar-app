// POST /api/planning/sync-onhand-xoro — re-source the Xoro by-size on-hand
// (tangerine_size_onhand) into ip_inventory_snapshot as source='tangerine'.
//
// PR1 of the on-hand single-source-of-truth work
// (docs/tangerine/onhand-single-source-of-truth.md). ADDITIVE: it does not
// touch the legacy source='manual' (ATS) rows; the reader flip is a later PR.
//
//   curl -X POST -H "Authorization: Bearer $DESIGN_CALENDAR_API_TOKEN" \
//        https://design-calendar-app.vercel.app/api/planning/sync-onhand-xoro
//
// Real work lives in api/_lib/planning-sync.js (rollUpXoroOnHandToSnapshot).

import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { rollUpXoroOnHandToSnapshot } from "../../_lib/planning-sync.js";
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
    const r = await rollUpXoroOnHandToSnapshot(admin);
    if (r.error) {
      return res.status(400).json({ error: r.error, details: r.details ?? null });
    }
    return res.status(200).json({
      snapshot_date: r.snapshot_date,
      rows_read: r.rows_read,
      upserted: r.upserted,
      warehouses: r.warehouses,
      errors: r.errors,
    });
  } catch (e) {
    console.error(`[planning/sync-onhand-xoro ${requestId}] failed:`, e);
    return res.status(500).json({ error: "Sync failed", request_id: requestId });
  }
}
