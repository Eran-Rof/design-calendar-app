// api/internal/users/me/preferences/drawer-collapsed
//
// Cross-cutter T4-7 — Personalization: write the authenticated user's
// favorites-drawer collapsed state.
//
// PUT body: { collapsed: boolean }
//
//   • Stores under key="drawer_collapsed", value={collapsed:boolean, v:1}.
//   • Upserts ONE row in user_preferences using the
//     (user_id, entity_id, key) PK conflict target — mirrors the
//     favorites + home-route handlers exactly.
//   • Returns the stored row.
//
// Auth — Bearer JWT, same pattern as the other personalization handlers.
// Designed to be a thin sibling to favorites.js / home-route.js so the
// `usePersonalization` cache can persist UI state with the same one-PUT
// optimistic-update plumbing.

import { createClient } from "@supabase/supabase-js";
import { resolveUserId } from "../../../../../_lib/auth.js";

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
 * Pure validator for the drawer-collapsed body. Exported so unit tests can
 * hit it without spinning up the supabase mock.
 *
 * @param {unknown} body
 * @returns {{data?: {collapsed: boolean}, error?: string}}
 */
export function validateDrawerCollapsedBody(body) {
  if (!body || typeof body !== "object") {
    return { error: "Body must be a JSON object" };
  }
  const { collapsed } = body;
  if (typeof collapsed !== "boolean") {
    return { error: "collapsed must be a boolean" };
  }
  return { data: { collapsed } };
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
  const v = validateDrawerCollapsedBody(body || {});
  if (v.error) return res.status(400).json({ error: v.error });

  const entityId = await resolveDefaultEntityId(admin);
  if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

  const row = {
    user_id: auth.authId,
    entity_id: entityId,
    key: "drawer_collapsed",
    value: { collapsed: v.data.collapsed, v: 1 },
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await admin
    .from("user_preferences")
    .upsert(row, { onConflict: "user_id,entity_id,key" })
    .select("key, value")
    .single();
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ key: data?.key ?? "drawer_collapsed", value: data?.value ?? row.value });
}
