// api/internal/users/me/preferences
//
// Cross-cutter T4-2 — Personalization: read the authenticated user's
// preferences map.
//
// GET → 200 { key: value, ... } across every row in user_preferences
//       for the authenticated user. Returns {} when the user has none.
//
// Auth — Supabase JWT in `Authorization: Bearer …` (same pattern as the
// vendor handlers). The handler resolves auth.uid() via getUser() and
// scopes the query to that uid. No cross-user reads possible: the user_id
// filter is enforced server-side, never derived from caller input.

import { createClient } from "@supabase/supabase-js";
import { resolveUserId } from "../../../../../_lib/auth.js";

export const config = { maxDuration: 10 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Auth-User-Id, X-Entity-ID");
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
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const auth = await resolveUserId(req, admin);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const { data, error } = await admin
    .from("user_preferences")
    .select("key, value")
    .eq("user_id", auth.authId);
  if (error) return res.status(500).json({ error: error.message });

  // Flatten rows into a { key: value } map. If the user has multiple rows
  // for the same key across entities (the table PK includes entity_id),
  // the LAST one wins — the current personalization UI is single-entity
  // anyway, and we expose entity-scoped prefs at a separate endpoint
  // once T4 grows multi-entity in P-13.
  const out = {};
  for (const row of data || []) out[row.key] = row.value;
  return res.status(200).json(out);
}
