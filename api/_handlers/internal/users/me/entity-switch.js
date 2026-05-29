// api/internal/users/me/entity-switch
//
// Tangerine P10-2b — Entity-switcher API: validate that the caller is a
// member of the requested entity. Membership-only at this stage; the
// dispatcher-side SET LOCAL app.current_entity_id wiring lands in P10-4
// alongside the X-Entity-ID header contract.
//
// PUT /api/internal/users/me/entity-switch
//   body: { entity_id: <uuid> }
//
//   • 401 — no Bearer token
//   • 400 — missing entity_id / unparseable body
//   • 403 — caller has no entity_users row for entity_id
//   • 200 — { entity_id, code, name, role } from the matched row
//
// Client contract: on a successful 200 the SPA stashes entity_id and starts
// echoing it back as `X-Entity-ID: <uuid>` on subsequent /api/internal/**
// requests. P10-4 wires the dispatcher to translate that header into a
// SET LOCAL so current_entity_id() returns the switched value.

import { createClient } from "@supabase/supabase-js";
import { authenticateCaller } from "../../../../_lib/auth.js";

export const config = { maxDuration: 10 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

/**
 * Pure validator for the switch body. Exported for unit tests.
 *
 * @param {unknown} body
 * @returns {{data?: {entity_id: string}, error?: string}}
 */
export function validateSwitchBody(body) {
  if (!body || typeof body !== "object") {
    return { error: "Body must be a JSON object" };
  }
  const { entity_id } = body;
  if (typeof entity_id !== "string" || entity_id.length === 0) {
    return { error: "entity_id is required" };
  }
  if (!UUID_RE.test(entity_id)) {
    return { error: "entity_id must be a uuid" };
  }
  return { data: { entity_id } };
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

  const auth = await authenticateCaller(req, admin);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }
  const v = validateSwitchBody(body || {});
  if (v.error) return res.status(400).json({ error: v.error });

  // Membership check — caller must have an entity_users row for the
  // target entity. 403 otherwise. Joins entities to return code+name
  // in the success payload (the SPA's switcher dropdown uses them).
  const { data, error } = await admin
    .from("entity_users")
    .select("entity_id, role, entities ( code, name )")
    .eq("auth_id", auth.authId)
    .eq("entity_id", v.data.entity_id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) {
    return res.status(403).json({ error: "Caller is not a member of the requested entity" });
  }

  const ent = data.entities || {};
  return res.status(200).json({
    entity_id: data.entity_id,
    code: ent.code ?? null,
    name: ent.name ?? "",
    role: data.role,
  });
}
