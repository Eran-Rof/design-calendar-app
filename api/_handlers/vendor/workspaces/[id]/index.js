// api/vendor/workspaces/:id
//
// GET — workspace detail (pins, tasks, messages). Vendor may only access
//       workspaces that belong to their vendor_id.

import { createClient } from "@supabase/supabase-js";
import { authenticateVendor } from "../../../../_lib/vendor-auth.js";
import { authorizeVendorAccess, resolvePinsBatch } from "../../../../_lib/workspaces.js";

export const config = { maxDuration: 15 };

function getId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("workspaces");
  return idx >= 0 ? parts[idx + 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const authRes = await authenticateVendor(admin, req);
  if (!authRes.ok) return res.status(authRes.status || 401).json({ error: authRes.error });

  const id = getId(req);
  if (!id) return res.status(400).json({ error: "Missing workspace id" });

  const w = await authorizeVendorAccess(admin, id, authRes.auth.vendor_id);
  if (!w) return res.status(404).json({ error: "Workspace not found" });

  const [{ data: rawPins }, { data: tasks }, { data: messages }] = await Promise.all([
    admin.from("workspace_pins").select("*").eq("workspace_id", id).order("created_at", { ascending: false }),
    admin.from("workspace_tasks").select("*").eq("workspace_id", id).order("created_at", { ascending: false }),
    admin.from("po_messages").select("*").eq("workspace_id", id).order("created_at", { ascending: true }),
  ]);
  const pins = await resolvePinsBatch(admin, rawPins || []);
  return res.status(200).json({ workspace: w, pins, tasks: tasks || [], messages: messages || [] });
}
