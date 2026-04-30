// POST /api/planning/sync-open-pos — scriptable open-PO sync.
//
// Replaces the "Sync open POs (T&A)" button when driven by the
// daily-design-calendar-sync skill. Pulls every non-archived PO row
// from the PO WIP app's tanda_pos table into
// ip_open_purchase_orders so the planning grid sees current incoming
// supply.
//
//   curl -X POST -H "Authorization: Bearer $DESIGN_CALENDAR_API_TOKEN" \
//        https://design-calendar-app.vercel.app/api/planning/sync-open-pos
//
// Real work lives in api/_lib/planning-sync.js, shared with the
// /api/tanda-pos-sync endpoint that backs the UI button.

import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { syncOpenPosFromTandaPos } from "../../_lib/planning-sync.js";
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
    const r = await syncOpenPosFromTandaPos(admin);
    if (r.error) {
      return res.status(400).json({ error: r.error, details: r.details ?? null });
    }
    return res.status(200).json({
      upserted: r.inserted,
      auto_created_skus: r.auto_created_skus,
      cleaned: r.cleaned,
      pos_scanned: r.pos_scanned,
      errors: r.errors,
    });
  } catch (e) {
    console.error(`[planning/sync-open-pos ${requestId}] failed:`, e);
    return res.status(500).json({ error: "Sync failed", request_id: requestId });
  }
}
