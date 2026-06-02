// api/internal/fba/sync-returns
//
// POST. Body: { fba_seller_account_id: <uuid>, since?: <iso timestamp> }
//
// Manual one-account trigger for the same logic the nightly cron drives.
// Used by the FBA admin panel "Sync returns now" button. Returns the same
// per-account sync summary shape as the cron.
//
// Tangerine P12a-6.

import { createClient } from "@supabase/supabase-js";
import { syncAccountReturns } from "../../../_lib/marketplaces/fba/sync-returns.js";

export const config = { maxDuration: 300 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export function validateBody(body) {
  if (body == null || typeof body !== "object") {
    return { error: "Request body must be an object" };
  }
  if (!body.fba_seller_account_id || !UUID_RE.test(String(body.fba_seller_account_id))) {
    return { error: "fba_seller_account_id (uuid) is required" };
  }
  const out = {
    fba_seller_account_id: String(body.fba_seller_account_id),
    since: null,
  };
  if (body.since != null && body.since !== "") {
    if (!ISO_RE.test(String(body.since))) {
      return { error: "since must be ISO 8601 timestamp" };
    }
    out.since = String(body.since);
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

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }
  const v = validateBody(body || {});
  if (v.error) return res.status(400).json({ error: v.error });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: acct, error } = await admin
    .from("fba_seller_accounts")
    .select("*")
    .eq("id", v.data.fba_seller_account_id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!acct) return res.status(404).json({ error: "fba_seller_account not found" });
  if (!acct.is_active) return res.status(409).json({ error: "account is not active" });

  try {
    const summary = await syncAccountReturns(admin, acct, { since: v.data.since });
    return res.status(200).json({ ok: true, ...summary });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      fba_seller_account_id: acct.id,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
