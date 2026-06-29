// api/internal/build-orders/_shared.js
//
// Shared helpers for the manufacturing build-order handlers (client, entity,
// GL account resolvers). Helper file (underscore-prefixed) — imported, never routed.

import { createClient } from "@supabase/supabase-js";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function corsHeaders(res, methods) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", `${methods}, OPTIONS`);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

export function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export async function resolveDefaultEntityId(admin) {
  const { data } = await admin.from("entities").select("id, default_ap_account_id").eq("code", "ROF").maybeSingle();
  return data || null;
}

export async function accountByCode(admin, entityId, code) {
  const { data } = await admin
    .from("gl_accounts").select("id, code, name, is_postable, status")
    .eq("entity_id", entityId).eq("code", code).maybeSingle();
  return data && data.is_postable && data.status === "active" ? data : null;
}

// Finished-style inventory asset account — code 1300 postable, else name ILIKE
// 'inventory%' top-level (mirrors inventory-adjustments resolveInventoryAccount).
export async function resolveFinishedInventoryAccount(admin, entityId) {
  const direct = await accountByCode(admin, entityId, "1300");
  if (direct) return direct;
  const { data } = await admin
    .from("gl_accounts").select("id, code, name, is_postable, status")
    .eq("entity_id", entityId).eq("is_postable", true).is("parent_account_id", null)
    .ilike("name", "inventory%").order("code", { ascending: true }).limit(1).maybeSingle();
  return data || null;
}

export async function resolveApAccount(admin, entity) {
  if (entity?.default_ap_account_id) {
    const { data } = await admin.from("gl_accounts").select("id, code, name, is_postable, status").eq("id", entity.default_ap_account_id).maybeSingle();
    if (data && data.is_postable && data.status === "active") return data;
  }
  return accountByCode(admin, entity.id, "2000");
}

export const todayISO = () => new Date().toISOString().slice(0, 10);
