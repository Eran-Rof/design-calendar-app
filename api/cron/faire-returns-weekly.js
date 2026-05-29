// api/cron/faire-returns-weekly
//
// Tangerine P12c-4 — Faire wholesale returns ingest cron.
//
// Faire returns are infrequent at the wholesale grain (most orders ship
// without issue). A weekly Monday 05:30 UTC cadence is enough to catch
// new RMA states while keeping API quota footprint low (we burn one
// /returns paginated walk per active faire_shops row per week).
//
// For each active faire_shops row:
//   1. Decrypt the static API key.
//   2. Walk listReturns pages with updated_at_min =
//      max(last_returns_sync_at, now - 30 days).
//   3. Upsert into faire_returns by (faire_shop_id, faire_return_id).
//   4. For postable states (REFUNDED-equivalent) with je_id NULL +
//      refund_amount_cents > 0, post the AR credit memo + warehouse
//      restock JE via the default poster (see sync-returns.js).
//   5. Update faire_shops.last_returns_sync_at (best-effort — column
//      may not exist on older schemas; non-fatal).
//
// Per-shop try/catch — one bad shop doesn't sink the rest. Schedule
// (vercel.json): 30 5 * * 1 (Mondays at 05:30 UTC).

import { createClient } from "@supabase/supabase-js";
import { isFaireConfigured } from "../_lib/marketplaces/faire/client.js";
import { runFaireReturnsIngest } from "../_lib/marketplaces/faire/sync-returns.js";

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: "Server not configured" });
  }
  if (!isFaireConfigured()) {
    return res.status(200).json({
      ok: true,
      skipped: "Faire not configured (FAIRE_TOKEN_ENC_KEY missing)",
    });
  }
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  let onlyShopId = null;
  let sinceOverride = null;
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    onlyShopId = url.searchParams.get("faire_shop_id");
    sinceOverride = url.searchParams.get("since");
  } catch { /* fall back to "all" */ }

  try {
    const out = await runFaireReturnsIngest(admin, { onlyShopId, sinceOverride });
    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
