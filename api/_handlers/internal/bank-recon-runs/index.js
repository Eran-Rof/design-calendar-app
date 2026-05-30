// api/internal/bank-recon-runs
//
// GET — list bank_recon_runs for the default entity. Filters:
//   ?bank_account_id, ?period_id, ?status, ?limit (default 100)
// POST — create-or-get a recon run for (bank_account_id, period_id).
//   Body: { bank_account_id, period_id }
//   Idempotent — upserts on UNIQUE (bank_account_id, period_id).
//   Also calls bank_recon_compute() to populate gl_balance/uncleared.
//
// Tangerine P6-6.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 30 };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}
function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export function isUuid(v) { return typeof v === "string" && UUID_RE.test(v); }

export function validatePost(body) {
  if (body == null || typeof body !== "object") return { error: "Body must be an object" };
  if (!body.bank_account_id || !isUuid(body.bank_account_id)) {
    return { error: "bank_account_id (uuid) is required" };
  }
  if (!body.period_id || !isUuid(body.period_id)) {
    return { error: "period_id (uuid) is required" };
  }
  return { data: { bank_account_id: body.bank_account_id, period_id: body.period_id } };
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: entity } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  if (!entity) return res.status(500).json({ error: "Default entity (ROF) not found" });

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const ba = url.searchParams.get("bank_account_id");
    const period = url.searchParams.get("period_id");
    const status = url.searchParams.get("status");
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "100", 10) || 100, 500);

    if (ba && !isUuid(ba)) return res.status(400).json({ error: "bank_account_id must be UUID" });
    if (period && !isUuid(period)) return res.status(400).json({ error: "period_id must be UUID" });

    let q = admin
      .from("bank_recon_runs")
      .select(
        "*, bank_accounts(name, mask), gl_periods(fiscal_year, period_number, starts_on, ends_on)",
      )
      .eq("entity_id", entity.id)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (ba) q = q.eq("bank_account_id", ba);
    if (period) q = q.eq("period_id", period);
    if (status) q = q.eq("status", status);

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data || []);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const v = validatePost(body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    // Compute via RPC — also upserts the bank_recon_runs row.
    const { data: rpcOut, error: rpcErr } = await admin.rpc("bank_recon_compute", {
      p_bank_account_id: v.data.bank_account_id,
      p_period_id: v.data.period_id,
    });
    if (rpcErr) {
      const msg = rpcErr.message || "RPC failed";
      if (/entity_id mismatch|not found/.test(msg)) return res.status(409).json({ error: msg });
      return res.status(500).json({ error: msg });
    }

    // Return the full bank_recon_runs row with joins.
    const { data: row, error: rErr } = await admin
      .from("bank_recon_runs")
      .select("*, bank_accounts(name, mask), gl_periods(fiscal_year, period_number, starts_on, ends_on)")
      .eq("id", rpcOut.bank_recon_run_id)
      .maybeSingle();
    if (rErr) return res.status(500).json({ error: rErr.message });
    return res.status(200).json({ ...rpcOut, run: row });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
