// api/cron/shopify-refunds-backfill.js
//
// Tangerine P11-6 — Shopify refunds backfill cron.
//
// Runs daily at 06:30 UTC (vercel.json: "30 6 * * *"). Walks every active
// shopify_stores row, lists recent orders' refunds via the Admin REST API,
// upserts shopify_refunds, and posts the AR credit memo (or voids the
// original AR invoice) via processShopifyRefund for any refund whose
// ar_credit_memo_id is NULL.
//
// Safety net for the refunds/create webhook (P11-6). The default lookback
// is 30 days so we catch slowly-emerging Shopify retries.
//
// Auth: same pattern as shopify-backfill (x-vercel-cron header OR Bearer
// CRON_SECRET; soft-open when CRON_SECRET unset).

import { createClient } from "@supabase/supabase-js";
import { backfillShopifyRefunds } from "../_lib/shopify/backfill-refunds.js";

export const config = { maxDuration: 60 };

const DEFAULT_SINCE_HOURS = 24 * 30;

function isAuthorized(req) {
  if (req.headers && req.headers["x-vercel-cron"]) return true;
  const expected = process.env.CRON_SECRET;
  if (!expected) return true;
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
    const summary = await backfillShopifyRefunds({
      adminClient,
      sinceHoursAgo,
    });
    return res.status(200).json({ ok: true, ...summary });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
