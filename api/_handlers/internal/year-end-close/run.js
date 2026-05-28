// api/internal/year-end-close/run
//
// POST. Body: {
//   fiscal_year: <int>,
//   dry_run?:   boolean (default true — explicit operator opt-in for live run),
//   actor_user_id?: <uuid>
// }
//
// Calls the gl_post_year_end_close(p_entity_id, p_fiscal_year, p_dry_run)
// RPC for the default ROF entity and returns its jsonb payload. Operator
// uses dry_run=true first to preview the projected closing JE shape +
// net-income totals per basis; then re-runs with dry_run=false to commit.
//
// Once committed, the FY's 12 periods flip to `closed_with_closing_jes`
// (terminal — re-running errors). M28 notification fans out on success.
//
// Tangerine P5-6.

import { createClient } from "@supabase/supabase-js";
import { enqueue as enqueueNotification } from "../../../_lib/notifications/index.js";

export const config = { maxDuration: 60 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_FY = 2024;     // Xoro-era floor (P4-8 set posting_locked_through = 2024-07-31)
const MAX_FY = 2099;

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
  const fy = body.fiscal_year;
  if (fy == null) return { error: "fiscal_year is required" };
  const n = typeof fy === "number" ? fy : parseInt(fy, 10);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { error: "fiscal_year must be an integer" };
  }
  if (n < MIN_FY || n > MAX_FY) {
    return { error: `fiscal_year must be between ${MIN_FY} and ${MAX_FY}` };
  }
  const out = {
    fiscal_year: n,
    dry_run: body.dry_run !== false,  // default true
    actor_user_id: null,
  };
  if (body.actor_user_id != null && body.actor_user_id !== "") {
    if (!UUID_RE.test(String(body.actor_user_id))) {
      return { error: "actor_user_id must be a UUID" };
    }
    out.actor_user_id = String(body.actor_user_id);
  }
  if (body.dry_run != null && typeof body.dry_run !== "boolean") {
    return { error: "dry_run must be a boolean" };
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

  const { data: entity, error: eErr } = await admin
    .from("entities")
    .select("id, code, default_retained_earnings_account_id")
    .eq("code", "ROF")
    .maybeSingle();
  if (eErr) return res.status(500).json({ error: eErr.message });
  if (!entity) return res.status(500).json({ error: "Default entity (ROF) not found" });

  if (!entity.default_retained_earnings_account_id) {
    return res.status(400).json({
      error:
        "Entity ROF has no default_retained_earnings_account_id. " +
        "Set it via the Entities admin panel (or seed a gl_accounts row with code='3500' and account_type='equity' — P5-6 migration auto-wires that case).",
    });
  }

  const { data: rpcOut, error: rpcErr } = await admin.rpc("gl_post_year_end_close", {
    p_entity_id: entity.id,
    p_fiscal_year: v.data.fiscal_year,
    p_dry_run: v.data.dry_run,
  });
  if (rpcErr) {
    return res.status(400).json({ error: rpcErr.message });
  }

  // Live-run notification.
  if (!v.data.dry_run && rpcOut) {
    try {
      await enqueueNotification(admin, {
        entity_id: entity.id,
        kind: "gl_year_end_closed",
        severity: "alert",
        subject: `Fiscal Year ${v.data.fiscal_year} closed`,
        body:
          `Year-end close JE posted for FY ${v.data.fiscal_year}. ` +
          `Accrual JE: ${rpcOut.accrual_je_id || "—"}. ` +
          `Cash JE: ${rpcOut.cash_je_id || "—"}. ` +
          `All 12 periods are now in closed_with_closing_jes (terminal).`,
        context_table: "entities",
        context_id: entity.id,
        recipient_roles: ["admin", "accountant"],
        created_by_user_id: v.data.actor_user_id,
      });
    } catch { /* non-fatal */ }
  }

  return res.status(200).json(rpcOut);
}
