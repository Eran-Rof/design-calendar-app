// api/internal/bank-accounts/:id
//
// PATCH — edit a bank_account row. Currently scoped to fields the
// reconciliation UI exposes:
//   - auto_post_fee_rules (JSONB array; full replace)
//   - is_active            (boolean)
//   - name                 (string, <=80)
//   - csv_column_mapping   (JSONB object; full replace)
//
// The Plaid-side columns (access token, cursor, account_id) are managed
// by the link/sync handlers and never accepted here.
//
// GET — return one bank_account by id (with joined gl_accounts label).
//       Convenience for the "Edit Rules" modal to refresh.
//
// Tangerine P6-7.

import { createClient } from "@supabase/supabase-js";
import { validateRulesArray } from "../../../_lib/bank-feeds/autoPostRules.js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Body must be an object" };
  }
  const out = {};

  if (Object.prototype.hasOwnProperty.call(body, "auto_post_fee_rules")) {
    const v = validateRulesArray(body.auto_post_fee_rules);
    if (v.error) return { error: v.error };
    out.auto_post_fee_rules = v.data;
  }
  if (Object.prototype.hasOwnProperty.call(body, "is_active")) {
    if (typeof body.is_active !== "boolean") return { error: "is_active must be boolean" };
    out.is_active = body.is_active;
  }
  if (Object.prototype.hasOwnProperty.call(body, "name")) {
    const s = String(body.name ?? "").trim();
    if (s.length === 0) return { error: "name cannot be empty" };
    if (s.length > 80) return { error: "name must be <= 80 chars" };
    out.name = s;
  }
  if (Object.prototype.hasOwnProperty.call(body, "csv_column_mapping")) {
    const m = body.csv_column_mapping;
    if (m == null) out.csv_column_mapping = null;
    else if (typeof m !== "object" || Array.isArray(m)) return { error: "csv_column_mapping must be an object" };
    else out.csv_column_mapping = m;
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
      .from("bank_accounts")
      .select(
        "id, entity_id, name, account_kind, institution_name, mask, " +
        "feed_source, last_synced_at, current_balance_cents, is_active, " +
        "gl_account_id, gl_accounts(code, name), auto_post_fee_rules, " +
        "csv_column_mapping, created_at, updated_at",
      )
      .eq("id", id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "bank_account not found" });
    return res.status(200).json(data);
  }

  if (req.method === "PATCH") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    const v = validatePatch(body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    const { data, error } = await admin
      .from("bank_accounts")
      .update({ ...v.data, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select(
        "id, name, account_kind, feed_source, is_active, " +
        "auto_post_fee_rules, csv_column_mapping, updated_at",
      )
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "bank_account not found" });
    return res.status(200).json(data);
  }

  res.setHeader("Allow", "GET, PATCH");
  return res.status(405).json({ error: "Method not allowed" });
}
