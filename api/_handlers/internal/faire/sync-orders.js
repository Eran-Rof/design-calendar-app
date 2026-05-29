// api/internal/faire/sync-orders
//
// Tangerine P12c-2 — Manual trigger for the Faire orders ingest. The nightly
// cron at /api/cron/faire-orders-nightly runs at 04:00 UTC; this handler
// gives the operator a "sync now" button in the Tangerine Faire Shops
// admin panel.
//
// POST /api/internal/faire/sync-orders
//   body: { faire_shop_id?: <uuid>, since?: <ISO timestamp> }
//
//   • faire_shop_id — if present, sync just that one shop. Otherwise iterate
//     all active shops (same as the cron).
//   • since         — override the auto-computed updated_at_min lookback.
//
// Returns the runFaireOrdersIngest summary verbatim.

import { createClient } from "@supabase/supabase-js";
import { runFaireOrdersIngest } from "../../../cron/faire-orders-nightly.js";

export const config = { maxDuration: 300 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

/**
 * Parse + validate the body. Exported for unit tests.
 */
export function validateBody(body) {
  if (body == null) return { data: { onlyShopId: null, sinceOverride: null } };
  if (typeof body !== "object") return { error: "Body must be a JSON object" };
  const out = { onlyShopId: null, sinceOverride: null };
  if (body.faire_shop_id != null) {
    if (typeof body.faire_shop_id !== "string" || !UUID_RE.test(body.faire_shop_id)) {
      return { error: "faire_shop_id must be a uuid" };
    }
    out.onlyShopId = body.faire_shop_id;
  }
  if (body.since != null) {
    if (typeof body.since !== "string" || body.since.length === 0) {
      return { error: "since must be an ISO timestamp string" };
    }
    out.sinceOverride = body.since;
  }
  return { data: out };
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: "Server not configured" });
  }
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }
  const v = validateBody(body || {});
  if (v.error) return res.status(400).json({ error: v.error });

  try {
    const out = await runFaireOrdersIngest(admin, {
      onlyShopId: v.data.onlyShopId,
      sinceOverride: v.data.sinceOverride,
    });
    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
