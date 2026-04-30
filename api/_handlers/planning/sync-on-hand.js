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
    return res.status(200).json({
      upserted: r.upserted,
      new_skus: r.new_skus,
      skipped: r.skipped,
      scanned: r.scanned,
      chunks: r.chunks,
      errors: r.errors,
    });
  } catch (e) {
    console.error(`[planning/sync-on-hand ${requestId}] failed:`, e);
    return res.status(500).json({ error: "Sync failed", request_id: requestId });
  }
}
