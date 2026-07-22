// POST /api/planning/sync-receipts — scriptable historical-receipts sync.
//
// Flattens the received portion of every PO line in the PO WIP app's
// tanda_pos table into ip_receipts_history, so the planning grid's
// "Hist Recv" column shows historical receipts. Runs alongside the
// open-PO sync in the nightly (both read the same tanda_pos source).
// No Xoro calls — a pure DB transform.
//
//   curl -X POST -H "Authorization: Bearer $DESIGN_CALENDAR_API_TOKEN" \
//        https://design-calendar-app.vercel.app/api/planning/sync-receipts
//
// Real work lives in api/_lib/planning-sync.js (syncReceiptsFromTandaPos).

import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { syncReceiptsFromTandaPos } from "../../_lib/planning-sync.js";
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
    const r = await syncReceiptsFromTandaPos(admin);
    if (r.error) {
      return res.status(400).json({ error: r.error, details: r.details ?? null });
    }
    return res.status(200).json({
      upserted: r.inserted,
      cleaned: r.cleaned,
      pos_scanned: r.pos_scanned,
      real_date_rows: r.real_date_rows,
      proxy_date_rows: r.proxy_date_rows,
      skipped_no_receipts: r.skipped_no_receipts,
      skipped_no_date: r.skipped_no_date,
      skipped_no_sku: r.skipped_no_sku,
      errors: r.errors,
    });
  } catch (e) {
    console.error(`[planning/sync-receipts ${requestId}] failed:`, e);
    return res.status(500).json({ error: "Sync failed", request_id: requestId });
  }
}
