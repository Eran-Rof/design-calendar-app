// api/internal/shopify/backfill
//
// Tangerine P11-4 — manual trigger for the Shopify backfill orchestrator.
//
// POST /api/internal/shopify/backfill
//   Body: { since_hours_ago?: number }  (default 7)
//
// Returns the same summary as the cron handler. Useful for catching up
// when the cron is paused or after onboarding a new store.
//
// Auth: gated by authenticateInternalCaller. Same gate as every other
// /api/internal/** handler — Bearer token or X-Internal-Token; soft-open
// when INTERNAL_API_TOKEN is unset (rollout pattern).

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../_lib/auth.js";
import { backfillShopifyOrders } from "../../../_lib/shopify/backfill-orders.js";

export const config = { maxDuration: 60 };

const DEFAULT_SINCE_HOURS = 7;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Internal-Token, X-Entity-ID",
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

  // Auth gate.
  const auth = authenticateInternalCaller(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }

  // Parse body.
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body && typeof body === "object" ? body : {};

  let sinceHoursAgo = DEFAULT_SINCE_HOURS;
  if (body.since_hours_ago != null) {
    const n = Number(body.since_hours_ago);
    if (!Number.isFinite(n) || n <= 0) {
      return res.status(400).json({
        error: "since_hours_ago must be a positive number",
      });
    }
    sinceHoursAgo = n;
  }

  const adminClient = client();
  if (!adminClient) {
    return res.status(500).json({ error: "Server not configured" });
  }

  try {
    const summary = await backfillShopifyOrders({
      adminClient,
      sinceHoursAgo,
    });
    return res.status(200).json({ ok: true, ...summary });
  } catch (e) {
    return res.status(500).json({
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
