// api/internal/users/me/preferences/favorites
//
// Cross-cutter T4-2 — Personalization: write the authenticated user's
// favorites list.
//
// PUT body: { keys: string[] }   (menu_keys, in operator-chosen order)
//
//   • Validates every entry against the MENU_KEY_SET registry — any
//     unknown key short-circuits with 400 (preserves the previous row
//     on validation failure; no partial writes).
//   • Upserts ONE row in user_preferences with key='favorites' and
//     value={keys:[...], v:1}. Uses the (user_id, entity_id, key) PK
//     conflict target.
//   • Returns the stored row so the client can confirm without a
//     follow-up GET.
//
// Auth — Bearer JWT, same pattern as the GET preferences handler.

import { createClient } from "@supabase/supabase-js";
import { resolveUserId } from "../../../../../_lib/auth.js";
import { isKnownMenuKey } from "../../../../../_lib/menuKeys.js";

export const config = { maxDuration: 10 };

const MAX_FAVORITES = 50; // sanity ceiling on the array length

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Auth-User-Id, X-Entity-ID");
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

/**
 * Pure validator for the favorites body. Exported so unit tests can hit it
 * without spinning up the supabase mock.
 *
 * @param {unknown} body
 * @returns {{data?: {keys: string[]}, error?: string}}
 */
export function validateFavoritesBody(body) {
  if (!body || typeof body !== "object") {
    return { error: "Body must be a JSON object" };
  }
  const { keys } = body;
  if (!Array.isArray(keys)) {
    return { error: "keys must be an array of menu_key strings" };
  }
  if (keys.length > MAX_FAVORITES) {
    return { error: `keys may contain at most ${MAX_FAVORITES} entries (got ${keys.length})` };
  }
  const seen = new Set();
  for (const k of keys) {
    if (typeof k !== "string" || k.length === 0) {
      return { error: "every entry in keys must be a non-empty string" };
    }
    if (seen.has(k)) {
      return { error: `duplicate menu_key in keys: ${k}` };
    }
    seen.add(k);
    if (!isKnownMenuKey(k)) {
      return { error: `unknown menu_key: ${k}` };
    }
  }
  return { data: { keys: [...keys] } };
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "PUT") {
    res.setHeader("Allow", "PUT");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const auth = await resolveUserId(req, admin);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }
  const v = validateFavoritesBody(body || {});
  if (v.error) return res.status(400).json({ error: v.error });

  const entityId = await resolveDefaultEntityId(admin);
  if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

  const row = {
    user_id: auth.authId,
    entity_id: entityId,
    key: "favorites",
    value: { keys: v.data.keys, v: 1 },
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await admin
    .from("user_preferences")
    .upsert(row, { onConflict: "user_id,entity_id,key" })
    .select("key, value")
    .single();
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ key: data?.key ?? "favorites", value: data?.value ?? row.value });
}
