// api/internal/bank-recon-runs/:id
//
// GET   — fetch a single recon-run row + joins.
// PATCH — update bank_statement_balance_cents and/or flip status='reconciled'.
//         Body: { bank_statement_balance_cents?: <int>, status?: 'in_progress'|'reconciled'|'flagged',
//                 notes?, actor_user_id? }
//         When bank_statement_balance_cents is set, recomputes
//         reconciled_diff_cents = gl_balance + uncleared - statement.
//         If flipping to 'reconciled', requires diff = 0 (else 409).
//
// Tangerine P6-6.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS_VALUES = ["in_progress", "reconciled", "flagged"];

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}
function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export function validatePatch(body) {
  if (body == null || typeof body !== "object") return { error: "Body must be an object" };
  const out = {};
  if (body.bank_statement_balance_cents != null) {
    const n = typeof body.bank_statement_balance_cents === "number"
      ? body.bank_statement_balance_cents
      : parseInt(body.bank_statement_balance_cents, 10);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      return { error: "bank_statement_balance_cents must be an integer" };
    }
    out.bank_statement_balance_cents = n;
  }
  if (body.status != null) {
    if (!STATUS_VALUES.includes(body.status)) {
      return { error: `status must be one of ${STATUS_VALUES.join(", ")}` };
    }
    out.status = body.status;
  }
  if (body.notes != null) {
    const n = String(body.notes).trim();
    if (n.length > 1000) return { error: "notes must be <= 1000 chars" };
    out.notes = n.length > 0 ? n : null;
  }
  if (body.actor_user_id != null && body.actor_user_id !== "") {
    if (!UUID_RE.test(String(body.actor_user_id))) return { error: "actor_user_id must be UUID" };
    out.actor_user_id = String(body.actor_user_id);
  }
  if (Object.keys(out).length === 0) return { error: "No fields to update" };
  return { data: out };
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: "Invalid id" });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    const { data, error } = await admin
      .from("bank_recon_runs")
      .select("*, bank_accounts(name, mask), gl_periods(fiscal_year, period_number, starts_on, ends_on)")
      .eq("id", id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Recon run not found" });
    return res.status(200).json(data);
  }

  if (req.method === "PATCH") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const v = validatePatch(body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    const { data: existing, error: gErr } = await admin
      .from("bank_recon_runs")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (gErr) return res.status(500).json({ error: gErr.message });
    if (!existing) return res.status(404).json({ error: "Recon run not found" });

    // Build the update payload. If statement balance changes, recompute diff.
    const update = {};
    if (v.data.bank_statement_balance_cents !== undefined) {
      update.bank_statement_balance_cents = v.data.bank_statement_balance_cents;
      const gl = Number(existing.gl_balance_cents || 0);
      const unc = Number(existing.uncleared_txn_cents || 0);
      update.reconciled_diff_cents = gl + unc - v.data.bank_statement_balance_cents;
    }
    if (v.data.notes !== undefined) update.notes = v.data.notes;

    // Reconcile transition rules:
    //   - to 'reconciled': diff must be 0 (use update.reconciled_diff_cents if set, else existing)
    if (v.data.status === "reconciled") {
      const diff = update.reconciled_diff_cents !== undefined
        ? update.reconciled_diff_cents
        : existing.reconciled_diff_cents;
      if (diff == null) {
        return res.status(409).json({
          error: "Cannot reconcile — no bank_statement_balance_cents on the run. Set it via PATCH first.",
        });
      }
      if (Math.abs(Number(diff)) > 1) {
        return res.status(409).json({
          error: `Cannot reconcile — diff is $${(Number(diff) / 100).toFixed(2)} (must be $0.00). Investigate unmatched transactions or correct the statement balance.`,
          reconciled_diff_cents: diff,
        });
      }
      update.status = "reconciled";
      update.reconciled_at = new Date().toISOString();
      if (v.data.actor_user_id) update.reconciled_by_user_id = v.data.actor_user_id;
    } else if (v.data.status != null) {
      update.status = v.data.status;
      if (v.data.status !== "reconciled") {
        update.reconciled_at = null;
        update.reconciled_by_user_id = null;
      }
    }

    const { data, error } = await admin
      .from("bank_recon_runs")
      .update(update)
      .eq("id", id)
      .select("*, bank_accounts(name, mask), gl_periods(fiscal_year, period_number, starts_on, ends_on)")
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  res.setHeader("Allow", "GET, PATCH");
  return res.status(405).json({ error: "Method not allowed" });
}
