// api/internal/items
//
// GET — searchable item (ip_item_master) lookup for invoice line pickers.
//   Query: ?vendor_id=<uuid>  — scope to a vendor's items (AP invoice lines)
//          ?q=<text>          — ILIKE filter on sku_code / style_code / description
//          ?limit=<n>         — default 200, max 500
//   Returns: [{ id, sku_code, style_code, description, color, size }]
//   Active items only, ordered by sku_code.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const vendorId = (url.searchParams.get("vendor_id") || "").trim();
  const q = (url.searchParams.get("q") || "").trim();
  let limit = parseInt(url.searchParams.get("limit") || "200", 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 200;
  limit = Math.min(limit, 500);

  let query = admin
    .from("ip_item_master")
    .select("id, sku_code, style_code, description, color, size")
    .eq("active", true)
    .order("sku_code", { ascending: true })
    .limit(limit);

  if (vendorId && UUID_RE.test(vendorId)) query = query.eq("vendor_id", vendorId);
  if (q) {
    const esc = q.replace(/[,()]/g, " ");
    query = query.or(`sku_code.ilike.%${esc}%,style_code.ilike.%${esc}%,description.ilike.%${esc}%`);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json(data || []);
}
