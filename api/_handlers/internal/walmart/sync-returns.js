// api/internal/walmart/sync-returns
//
// Tangerine P12b-5 — Manual trigger for the Walmart returns sync.
//
// POST. Body: { walmart_seller_account_id, since? }
//   - walmart_seller_account_id  required, uuid of the seller account row
//   - since                      optional ISO timestamp; defaults to now-30d
//
// Delegates to runWalmartReturnsSync({ account_id, since }).
//
// Used by:
//   - the Walmart Status admin panel "Sync returns now" button
//   - operator-side ad-hoc backfill via curl

import { createClient } from "@supabase/supabase-js";
import { runWalmartReturnsSync } from "../../../_lib/marketplaces/walmart/sync-returns.js";

export const config = { maxDuration: 300 };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TS_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Entity-ID",
  );
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: "Invalid JSON" });
    }
  }
  const account_id = body?.walmart_seller_account_id;
  const since = body?.since ?? null;
  if (!account_id || typeof account_id !== "string" || !UUID_RE.test(account_id)) {
    return res
      .status(400)
      .json({ error: "walmart_seller_account_id (uuid) is required" });
  }
  if (since !== null && (typeof since !== "string" || !ISO_TS_RE.test(since))) {
    return res
      .status(400)
      .json({ error: "since must be an ISO 8601 timestamp" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  try {
    const out = await runWalmartReturnsSync(admin, { account_id, since });
    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    return res
      .status(500)
      .json({ error: e instanceof Error ? e.message : String(e) });
  }
}
