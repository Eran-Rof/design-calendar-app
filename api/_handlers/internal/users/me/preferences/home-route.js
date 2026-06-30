// api/internal/users/me/preferences/home-route
//
// Cross-cutter T4-2 — Personalization: write the authenticated user's
// auto-landing destination.
//
// PUT body: { menu_key: string }
//
//   • Validates the menu_key against MENU_KEY_SET (400 on unknown).
//   • Upserts ONE row in user_preferences with key='home_route' and
//     value={menu_key, v:1}. The route is intentionally NOT stored —
//     menu_keys are stable, routes are not. The favorites drawer + Settings
//     resolve the route on read via MENU_KEY_BY_KEY[menu_key].
//   • Returns the stored row.
//
// Auth — Bearer JWT, same pattern as the other personalization handlers.

import { createClient } from "@supabase/supabase-js";
import { resolveUserId } from "../../../../../_lib/auth.js";
import { isKnownMenuKey } from "../../../../../_lib/menuKeys.js";

export const config = { maxDuration: 10 };

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
 * Pure validator for the home-route body. Exported so unit tests can hit it
 * without spinning up the supabase mock.
 *
 * @param {unknown} body
 * @returns {{data?: {menu_key: string}, error?: string}}
 */
export function validateHomeRouteBody(body) {
  if (!body || typeof body !== "object") {
    return { error: "Body must be a JSON object" };
  }
  const { menu_key } = body;
  if (typeof menu_key !== "string" || menu_key.length === 0) {
    return { error: "menu_key must be a non-empty string" };
  }
  if (!isKnownMenuKey(menu_key)) {
    return { error: `unknown menu_key: ${menu_key}` };
  }
  return { data: { menu_key } };
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
  const v = validateHomeRouteBody(body || {});
  if (v.error) return res.status(400).json({ error: v.error });

  const entityId = await resolveDefaultEntityId(admin);
  if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

  const row = {
    user_id: auth.authId,
    entity_id: entityId,
    key: "home_route",
    value: { menu_key: v.data.menu_key, v: 1 },
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await admin
    .from("user_preferences")
    .upsert(row, { onConflict: "user_id,entity_id,key" })
    .select("key, value")
    .single();
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ key: data?.key ?? "home_route", value: data?.value ?? row.value });
}
