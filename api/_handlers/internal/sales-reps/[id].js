// api/internal/sales-reps/:id
//
// GET    — fetch one sales rep (with embedded tiers + assignments).
// PATCH  — update header (display_name, email, default_commission_pct,
//          payout_terms_days, employee_id, is_active).
// DELETE — soft-delete (sets is_active=false). Hard delete is intentionally
//          not exposed via this endpoint; reps are FK-referenced by
//          commission_accruals/payouts.
//
// Tangerine P7-6 (arch §4.4).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
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

  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: rep, error: fetchErr } = await admin
    .from("sales_reps")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (fetchErr) return res.status(500).json({ error: fetchErr.message });
  if (!rep) return res.status(404).json({ error: "Sales rep not found" });

  if (req.method === "GET") {
    const { data: tiers } = await admin
      .from("sales_rep_commission_tiers")
      .select("id, sales_rep_id, threshold_cents, rate_pct, effective_from, effective_to, created_at")
      .eq("sales_rep_id", id)
      .order("threshold_cents", { ascending: true });

    const { data: assignments } = await admin
      .from("customer_sales_rep_assignments")
      .select(
        "id, customer_id, sales_rep_id, share_pct, effective_from, effective_to, created_at, " +
        "customers(id, code, name)",
      )
      .eq("sales_rep_id", id)
      .order("created_at", { ascending: false });

    return res.status(200).json({
      ...rep,
      tiers: tiers || [],
      assignments: assignments || [],
    });
  }

  if (req.method === "PATCH") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    const v = validatePatch(body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    if (Object.keys(v.data).length === 0) {
      return res.status(200).json(rep);
    }

    const { data: updated, error: upErr } = await admin
      .from("sales_reps")
      .update(v.data)
      .eq("id", id)
      .select()
      .single();
    if (upErr) return res.status(500).json({ error: upErr.message });
    return res.status(200).json(updated);
  }

  if (req.method === "DELETE") {
    // Soft-delete only.
    const { data: updated, error: upErr } = await admin
      .from("sales_reps")
      .update({ is_active: false })
      .eq("id", id)
      .select()
      .single();
    if (upErr) return res.status(500).json({ error: upErr.message });
    return res.status(200).json(updated);
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

// ────────────────────────────────────────────────────────────────────────
// Validation — exported for unit tests.
// ────────────────────────────────────────────────────────────────────────

export function validatePatch(body) {
  // Server-controlled / locked columns.
  const LOCKED = ["id", "entity_id", "created_at", "updated_at", "created_by_user_id"];
  for (const k of LOCKED) {
    if (k in body) return { error: `${k} is not patchable here` };
  }

  const out = {};

  if ("display_name" in body) {
    const s = typeof body.display_name === "string" ? body.display_name.trim() : "";
    if (!s) return { error: "display_name must be non-empty" };
    if (s.length > 200) return { error: "display_name must be ≤ 200 chars" };
    out.display_name = s;
  }
  if ("email" in body) {
    if (body.email == null || body.email === "") {
      out.email = null;
    } else {
      const s = String(body.email).trim();
      if (s.length > 320) return { error: "email must be ≤ 320 chars" };
      out.email = s;
    }
  }
  if ("default_commission_pct" in body) {
    const n = Number(body.default_commission_pct);
    if (!Number.isFinite(n)) return { error: "default_commission_pct must be a number" };
    if (n < 0 || n > 100) return { error: "default_commission_pct must be between 0 and 100" };
    out.default_commission_pct = n;
  }
  if ("payout_terms_days" in body) {
    const n = Number(body.payout_terms_days);
    if (!Number.isInteger(n) || n < 0) {
      return { error: "payout_terms_days must be a non-negative integer" };
    }
    out.payout_terms_days = n;
  }
  if ("employee_id" in body) {
    if (body.employee_id == null || body.employee_id === "") {
      out.employee_id = null;
    } else if (!UUID_RE.test(body.employee_id)) {
      return { error: "employee_id must be a uuid or null" };
    } else {
      out.employee_id = body.employee_id;
    }
  }
  if ("is_active" in body) {
    out.is_active = Boolean(body.is_active);
  }

  return { data: out };
}
