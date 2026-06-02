// api/cron/shopify-backfill.js
//
// Tangerine P11-4 — Shopify webhook-drop backfill cron.
//
// Runs every 6 hours (vercel.json: "0 */6 * * *"). Walks every active
// shopify_stores row, fetches orders updated/created in the last
// `sinceHoursAgo` hours via the Admin REST API, upserts shopify_orders +
// shopify_order_lines (same shape the webhook produces), and posts the AR
// JE for any row whose je_id is NULL.
//
// This is the safety net for the orders/create + orders/updated webhooks
// shipped in P11-2 — if a webhook drop or out-of-order delivery left a
// shopify_orders row unposted (or missing entirely), the next 6h cycle
// picks it up. The chosen lookback window (7h default) is intentionally
// 1h wider than the cron interval so adjacent cycles overlap and no
// order can fall through a gap.
//
// Auth:
//   - x-vercel-cron header set by Vercel for scheduled triggers.
//   - Authorization: Bearer <CRON_SECRET> for manual replay.
//   - If CRON_SECRET is unset (dev), allow through (matches the soft-warn
//     pattern used by the other Tangerine crons).

import { createClient } from "@supabase/supabase-js";
import { backfillShopifyOrders } from "../_lib/shopify/backfill-orders.js";

export const config = { maxDuration: 60 };

const DEFAULT_SINCE_HOURS = 7;

function isAuthorized(req) {
  if (req.headers && req.headers["x-vercel-cron"]) return true;
  const expected = process.env.CRON_SECRET;
  if (!expected) return true; // soft-open in dev
  const header = req.headers?.authorization || "";
  return typeof header === "string" && header === `Bearer ${expected}`;
}

function buildAdminClient() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-vercel-cron");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const adminClient = buildAdminClient();
  if (!adminClient) {
    return res.status(500).json({ error: "Server not configured" });
  }

  // Optional ?since_hours_ago override for ad-hoc replay.
  let sinceHoursAgo = DEFAULT_SINCE_HOURS;
  try {
    const url = new URL(req.url || "/", `http://${req.headers?.host || "localhost"}`);
    const param = url.searchParams.get("since_hours_ago");
    if (param != null && param !== "") {
      const n = Number(param);
      if (Number.isFinite(n) && n > 0) sinceHoursAgo = n;
    }
  } catch { /* fall back to default */ }

  try {
    const summary = await backfillShopifyOrders({
      adminClient,
      sinceHoursAgo,
    });
    return res.status(200).json({ ok: true, ...summary });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
