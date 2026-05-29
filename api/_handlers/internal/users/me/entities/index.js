// api/internal/users/me/entities
//
// Tangerine P10-2b — Entity-switcher API: list every entity the caller has
// access to plus their effective default.
//
// GET /api/internal/users/me/entities
// → 200 {
//     entities: [{ id, code, name, role, is_default }, ...],
//     current_entity_id: <uuid|null>,
//   }
//
//   • Rows joined from entity_users (auth_id = caller) → entities.
//   • current_entity_id = the entity_users row flagged is_default=true.
//     Falls back to the first row when no default exists (so a freshly
//     provisioned multi-entity user still gets *some* effective entity
//     until they set a default). NULL when the user has no rows at all.
//   • The server-side effective entity_id for RLS/DEFAULT comes from
//     the SQL helper current_entity_id() (P10-2 migration); this endpoint
//     is the UI-facing read for the switcher dropdown.
//
// Auth — Supabase JWT in Authorization: Bearer …  (same pattern as
// /preferences). 401 otherwise.

import { createClient } from "@supabase/supabase-js";
import { authenticateCaller } from "../../../../../_lib/auth.js";

export const config = { maxDuration: 10 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

/**
 * Pure shaper for the entity-list response. Exported so tests can hit it
 * without rebuilding the whole supabase mock chain.
 *
 * @param {Array<{entity_id: string, role: string, is_default: boolean, entities: {id: string, code: string|null, name: string}}>} rows
 * @returns {{entities: Array<object>, current_entity_id: string|null}}
 */
export function shapeEntitiesPayload(rows) {
  const list = (rows || []).map((r) => {
    const ent = r.entities || {};
    return {
      id: ent.id ?? r.entity_id,
      code: ent.code ?? null,
      name: ent.name ?? "",
      role: r.role,
      is_default: !!r.is_default,
    };
  });
  let current = null;
  const def = list.find((e) => e.is_default);
  if (def) current = def.id;
  else if (list.length > 0) current = list[0].id;
  return { entities: list, current_entity_id: current };
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

  const auth = await authenticateCaller(req, admin);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  // PostgREST embedded resource: entity_users → entities. Service-role
  // bypasses RLS so we get every row the caller owns regardless of the
  // entity_users RLS policy state (which the P10 RLS audit may still be
  // tightening).
  const { data, error } = await admin
    .from("entity_users")
    .select("entity_id, role, is_default, entities ( id, code, name )")
    .eq("auth_id", auth.authId);
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json(shapeEntitiesPayload(data));
}
