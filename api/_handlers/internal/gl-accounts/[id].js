// api/internal/gl-accounts/[id]
//
// GET    — fetch a single account.
// PATCH  — update mutable fields. code, account_type, normal_balance, entity_id
//          are LOCKED post-creation (rejected with 400). Other fields editable.
// DELETE — hard-delete. Rejected (409) if any journal_entry_lines reference
//          the account — caller must set status='inactive' instead.
//
// Tangerine P1 Chunk 8a.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const STATUS_VALUES = ["active", "inactive"];

const MUTABLE_FIELDS = new Set([
  "name", "account_subtype", "parent_account_id", "is_postable",
  "is_control", "status", "description",
]);

// Fields that exist on the row but are LOCKED post-creation.
const LOCKED_FIELDS = new Set(["code", "account_type", "normal_balance", "entity_id"]);

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

export default async function handler(req, res, params) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const id = params?.id || req.query?.id;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    const { data, error } = await admin
      .from("gl_accounts")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Account not found" });
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
    if (Object.keys(v.data).length === 0) {
      return res.status(400).json({ error: "No mutable fields supplied" });
    }
    const { data, error } = await admin
      .from("gl_accounts")
      .update(v.data)
      .eq("id", id)
      .select()
      .single();
    if (error) {
      if (error.code === "PGRST116") return res.status(404).json({ error: "Account not found" });
      return res.status(500).json({ error: error.message });
    }
    return res.status(200).json(data);
  }

  if (req.method === "DELETE") {
    // Reject hard-delete when any posted JE line references the account.
    const { data: refRows, error: refErr } = await admin
      .from("journal_entry_lines")
      .select("id")
      .eq("account_id", id)
      .limit(1);
    if (refErr) return res.status(500).json({ error: refErr.message });
    if (refRows && refRows.length > 0) {
      return res.status(409).json({
        error: "Account has posted journal entry lines; mark it inactive via PATCH status='inactive' instead of deleting.",
      });
    }
    const { data, error } = await admin
      .from("gl_accounts")
      .delete()
      .eq("id", id)
      .select("id")
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Account not found" });
    return res.status(200).json({ deleted: true, id });
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

export function validatePatch(body) {
  for (const f of Object.keys(body)) {
    if (LOCKED_FIELDS.has(f)) {
      return { error: `${f} is locked post-creation and cannot be updated` };
    }
  }
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (!MUTABLE_FIELDS.has(k)) continue;
    out[k] = v;
  }
  if (out.status != null && !STATUS_VALUES.includes(out.status)) {
    return { error: `status must be one of ${STATUS_VALUES.join(", ")}` };
  }
  // Normalize empty strings to null for nullable text fields.
  for (const k of ["account_subtype", "parent_account_id", "description"]) {
    if (out[k] === "") out[k] = null;
  }
  return { data: out };
}
