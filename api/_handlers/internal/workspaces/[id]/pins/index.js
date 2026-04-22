// api/internal/workspaces/:id/pins
//
// POST — add a pinned entity.
//   body: { entity_type, entity_id, label?, pinned_by }

import { createClient } from "@supabase/supabase-js";
import { validatePinInput, resolvePin } from "../../../../../_lib/workspaces.js";

export const config = { maxDuration: 10 };

function getWorkspaceId(req) {
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("pins");
  return idx > 0 ? parts[idx - 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const workspaceId = getWorkspaceId(req);
  if (!workspaceId) return res.status(400).json({ error: "Missing workspace id" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  const errs = validatePinInput(body);
  if (errs.length) return res.status(400).json({ error: errs.join("; ") });

  const resolved = await resolvePin(admin, body.entity_type, body.entity_id);
  if (!resolved) return res.status(404).json({ error: `${body.entity_type} ${body.entity_id} not found` });

  const { data, error } = await admin.from("workspace_pins").insert({
    workspace_id: workspaceId,
    entity_type: body.entity_type,
    entity_ref_id: body.entity_id,
    pinned_by_type: "internal",
    pinned_by: body.pinned_by || "internal",
    label: body.label || resolved.label,
  }).select("*").single();
  if (error) return res.status(500).json({ error: error.message });
  return res.status(201).json({ ...data, resolved });
}
