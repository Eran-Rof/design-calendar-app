// api/vendor/workspaces/:id/pins/:pin_id
//
// DELETE — vendor removes a pin on their own workspace.

import { createClient } from "@supabase/supabase-js";
import { authenticateVendor } from "../../../../../_lib/vendor-auth.js";
import { authorizeVendorAccess } from "../../../../../_lib/workspaces.js";

export const config = { maxDuration: 10 };

function getIds(req) {
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const wsIdx = parts.indexOf("workspaces");
  const pinsIdx = parts.lastIndexOf("pins");
  return {
    workspaceId: wsIdx >= 0 ? parts[wsIdx + 1] : null,
    pinId: pinsIdx > 0 && pinsIdx + 1 < parts.length ? parts[pinsIdx + 1] : null,
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "DELETE") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const authRes = await authenticateVendor(admin, req);
  if (!authRes.ok) return res.status(authRes.status || 401).json({ error: authRes.error });

  const { workspaceId, pinId } = getIds(req);
  const w = await authorizeVendorAccess(admin, workspaceId, authRes.auth.vendor_id);
  if (!w) return res.status(404).json({ error: "Workspace not found" });

  const { error } = await admin.from("workspace_pins")
    .delete().eq("id", pinId).eq("workspace_id", workspaceId);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true, id: pinId });
}
