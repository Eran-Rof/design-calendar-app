// api/internal/b2b-accounts
//
// GET  — list B2B portal accounts for the default entity (ROF). By default
//        returns is_active=true rows only; ?include_inactive=true returns all.
//        Query:
//          ?q=<search>             — ilike match on email or display_name
//          ?include_inactive=true  — include inactive rows
// POST — pre-authorize a buyer. Body:
//          { customer_id (required, FK customers), email (required),
//            display_name?, role buyer|approver|admin (default buyer),
//            is_active (default true), can_place_orders (default true) }
//        auth_user_id / last_login_at are server/portal-managed and NOT
//        settable here — auth_user_id binds on first magic-link login.
//
// Tangerine P18-F — internal B2B admin. Mirrors the payment-terms /
// customer-master handler shape (resolveDefaultEntityId + ROF scope,
// service-role writes). These are INTERNAL staff panels, not the
// customer-facing /b2b portal.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const ROLES = new Set(["buyer", "approver", "admin"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

async function resolveDefaultEntityId(admin) {
  const { data, error } = await admin
    .from("entities")
    .select("id")
    .eq("code", "ROF")
    .maybeSingle();
  if (error || !data) return null;
  return data.id;
}

const SELECT_COLS =
  "id, entity_id, customer_id, email, auth_user_id, display_name, role, is_active, can_place_orders, last_login_at, created_at, updated_at";

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const entityId = await resolveDefaultEntityId(admin);
  if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const includeInactive = url.searchParams.get("include_inactive") === "true";
    const q = (url.searchParams.get("q") || "").trim();

    let query = admin
      .from("b2b_accounts")
      .select(SELECT_COLS)
      .eq("entity_id", entityId)
      .order("created_at", { ascending: false });

    if (!includeInactive) query = query.eq("is_active", true);
    if (q) {
      const esc = q.replace(/[,()]/g, " ");
      query = query.or(`email.ilike.%${esc}%,display_name.ilike.%${esc}%`);
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data || []);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    const v = validateInsert(body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    const { data, error } = await admin
      .from("b2b_accounts")
      .insert({ ...v.data, entity_id: entityId })
      .select(SELECT_COLS)
      .single();
    if (error) {
      if (error.code === "23505") {
        return res.status(409).json({ error: "A B2B account with that email already exists." });
      }
      if (error.code === "23503") {
        return res.status(400).json({ error: "customer_id does not reference an existing customer." });
      }
      return res.status(500).json({ error: error.message });
    }
    return res.status(201).json(data);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

export function validateInsert(body) {
  if (body == null || typeof body !== "object") {
    return { error: "Request body must be an object" };
  }
  if (!body.customer_id || !String(body.customer_id).trim()) {
    return { error: "customer_id is required" };
  }
  const email = String(body.email || "").trim();
  if (!email) return { error: "email is required" };
  if (!EMAIL_RE.test(email)) return { error: "email is not a valid address" };

  let role = "buyer";
  if (body.role != null && body.role !== "") {
    role = String(body.role).trim().toLowerCase();
    if (!ROLES.has(role)) return { error: "role must be one of buyer, approver, admin" };
  }

  const isActive = body.is_active == null ? true :
    typeof body.is_active === "boolean" ? body.is_active :
      body.is_active === "true" || body.is_active === 1;

  const canPlace = body.can_place_orders == null ? true :
    typeof body.can_place_orders === "boolean" ? body.can_place_orders :
      body.can_place_orders === "true" || body.can_place_orders === 1;

  const displayName = body.display_name == null || String(body.display_name).trim() === ""
    ? null : String(body.display_name).trim();

  return {
    data: {
      customer_id:      String(body.customer_id).trim(),
      email,
      display_name:     displayName,
      role,
      is_active:        isActive,
      can_place_orders: canPlace,
      // auth_user_id + last_login_at are portal/server-managed — never set here.
    },
  };
}
