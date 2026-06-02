// api/internal/fba/mirror-inventory
//
// POST. Body: { fba_seller_account_id?: <uuid> }
//
// Manual trigger for the same FBA inventory mirror logic the nightly cron
// drives. Two modes:
//   - body.fba_seller_account_id provided → mirror that one account only.
//   - body empty (or no fba_seller_account_id) → mirror every active
//     fba_seller_accounts row (operator "force refresh now" button).
//
// Tangerine P12a-5.

import { createClient } from "@supabase/supabase-js";
import {
  mirrorAccountInventory,
  mirrorFbaInventory,
} from "../../../_lib/marketplaces/fba/mirror-inventory.js";

export const config = { maxDuration: 300 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  // Body is optional — empty body is allowed (= all accounts).
  if (body == null) return { data: { fba_seller_account_id: null } };
  if (typeof body !== "object") {
    return { error: "Request body must be an object" };
  }
  const raw = body.fba_seller_account_id;
  if (raw == null || raw === "") {
    return { data: { fba_seller_account_id: null } };
  }
  if (!UUID_RE.test(String(raw))) {
    return { error: "fba_seller_account_id must be a uuid" };
  }
  return { data: { fba_seller_account_id: String(raw) } };
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
  const v = validateBody(body == null ? {} : body);
  if (v.error) return res.status(400).json({ error: v.error });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  // ── Single-account mode ───────────────────────────────────────────────
  if (v.data.fba_seller_account_id) {
    const { data: acct, error } = await admin
      .from("fba_seller_accounts")
      .select("*")
      .eq("id", v.data.fba_seller_account_id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!acct) return res.status(404).json({ error: "fba_seller_account not found" });
    if (!acct.is_active) return res.status(409).json({ error: "account is not active" });
    try {
      const summary = await mirrorAccountInventory(admin, acct);
      return res.status(200).json({ ok: true, ...summary });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        fba_seller_account_id: acct.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // ── All-accounts mode ─────────────────────────────────────────────────
  try {
    const out = await mirrorFbaInventory({ adminClient: admin });
    const okCount = out.accounts.filter((a) => a.ok).length;
    const errCount = out.accounts.length - okCount;
    return res.status(200).json({
      ok: true,
      ...out,
      ok_count: okCount,
      error_count: errCount,
    });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
