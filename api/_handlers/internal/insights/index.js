// api/internal/insights
//
// GET — list insights for an entity, excluding expired rows.
//   ?entity_id=<uuid>           required (or X-Entity-ID header)
//   ?type=<insight_type>        optional, filter
//   ?status=new|read|actioned|dismissed  optional
//   ?vendor_id=<uuid>           optional
//   ?limit=100&offset=0
//   Response: { rows, total, limit, offset }

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const entityId = url.searchParams.get("entity_id") || req.headers["x-entity-id"];
  if (!entityId) return res.status(400).json({ error: "entity_id query or X-Entity-ID header required" });

  const type     = url.searchParams.get("type");
  const status   = url.searchParams.get("status");
  const vendorId = url.searchParams.get("vendor_id");
  const limit    = Math.min(Number(url.searchParams.get("limit")) || 100, 500);
  const offset   = Math.max(Number(url.searchParams.get("offset")) || 0, 0);

  let q = admin.from("ai_insights")
    .select("*, vendor:vendors(id, name)", { count: "exact" })
    .eq("entity_id", entityId)
    .gt("expires_at", new Date().toISOString());
  if (type)     q = q.eq("type", type);
  if (status)   q = q.eq("status", status);
  if (vendorId) q = q.eq("vendor_id", vendorId);

  const { data, error, count } = await q
    .order("generated_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ rows: data || [], total: count || 0, limit, offset });
}
