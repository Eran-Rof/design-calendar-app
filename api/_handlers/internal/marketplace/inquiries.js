// api/internal/marketplace/inquiries
//
// GET — inquiries sent from an entity (or all if no filter).
//   ?entity_id=&status=

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../_lib/auth.js";

export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Internal-API gate. See api/_lib/auth.js. Open until INTERNAL_API_TOKEN
  // is set (logs a warn on first call); 401 once configured.
  const __internalAuth = authenticateInternalCaller(req);
  if (!__internalAuth.ok) return res.status(__internalAuth.status).json({ error: __internalAuth.error });
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const entityId = url.searchParams.get("entity_id") || req.headers["x-entity-id"];
  const status = url.searchParams.get("status");

  let q = admin.from("marketplace_inquiries")
    .select("*, listing:marketplace_listings(id, title, vendor_id)")
    .order("created_at", { ascending: false });
  if (entityId) q = q.eq("entity_id", entityId);
  if (status)   q = q.eq("status", status);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ rows: data || [] });
}
