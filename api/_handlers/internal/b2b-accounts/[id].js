// api/internal/b2b-accounts/[id]
//
// GET    — fetch a single b2b_accounts row.
// PATCH  — update mutable fields. entity_id, id, auth_user_id, last_login_at
//          are LOCKED (auth_user_id + last_login_at are portal/server-managed).
//          Mutable: customer_id, email, display_name, role, is_active,
//          can_place_orders.
// DELETE — hard-delete the account row.
//
// Tangerine P18-F — internal B2B admin.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES = new Set(["buyer", "approver", "admin"]);

const MUTABLE_FIELDS = new Set([
  "customer_id", "email", "display_name", "role", "is_active", "can_place_orders",
]);
const LOCKED_FIELDS = new Set(["id", "entity_id", "auth_user_id", "last_login_at"]);

const SELECT_COLS =
  "id, entity_id, customer_id, email, auth_user_id, display_name, role, is_active, can_place_orders, last_login_at, created_at, updated_at";

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

  // Per feedback_dispatcher_query_not_params: always read path params from req.query.
  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    const { data, error } = await admin
      .from("b2b_accounts")
      .select(SELECT_COLS)
      .eq("id", id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "B2B account not found" });
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
      .from("b2b_accounts")
      .update(v.data)
      .eq("id", id)
      .select(SELECT_COLS)
      .single();
    if (error) {
      if (error.code === "PGRST116") return res.status(404).json({ error: "B2B account not found" });
      if (error.code === "23505") return res.status(409).json({ error: "A B2B account with that email already exists." });
      if (error.code === "23503") return res.status(400).json({ error: "customer_id does not reference an existing customer." });
      return res.status(500).json({ error: error.message });
    }
    return res.status(200).json(data);
  }

  if (req.method === "DELETE") {
    const { data, error } = await admin
      .from("b2b_accounts")
      .delete()
      .eq("id", id)
      .select("id")
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "B2B account not found" });
    return res.status(200).json({ deleted: true, id });
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

export function validatePatch(body) {
  if (body == null || typeof body !== "object") {
    return { error: "Request body must be an object" };
  }
  for (const f of Object.keys(body)) {
    if (LOCKED_FIELDS.has(f)) {
      return { error: `${f} is locked and cannot be updated here (portal/server-managed)` };
    }
  }

  const out = {};
  for (const [k, val] of Object.entries(body)) {
    if (!MUTABLE_FIELDS.has(k)) continue;
    out[k] = val;
  }

  if ("customer_id" in out) {
    if (out.customer_id == null || String(out.customer_id).trim() === "") {
      return { error: "customer_id cannot be blanked" };
    }
    out.customer_id = String(out.customer_id).trim();
  }

  if ("email" in out) {
    const email = String(out.email || "").trim();
    if (!email) return { error: "email cannot be empty" };
    if (!EMAIL_RE.test(email)) return { error: "email is not a valid address" };
    out.email = email;
  }

  if ("display_name" in out) {
    out.display_name = out.display_name == null || String(out.display_name).trim() === ""
      ? null : String(out.display_name).trim();
  }

  if ("role" in out) {
    const role = String(out.role || "").trim().toLowerCase();
    if (!ROLES.has(role)) return { error: "role must be one of buyer, approver, admin" };
    out.role = role;
  }

  if ("is_active" in out && typeof out.is_active !== "boolean") {
    out.is_active = out.is_active === "true" || out.is_active === 1;
  }
  if ("can_place_orders" in out && typeof out.can_place_orders !== "boolean") {
    out.can_place_orders = out.can_place_orders === "true" || out.can_place_orders === 1;
  }

  return { data: out };
}
