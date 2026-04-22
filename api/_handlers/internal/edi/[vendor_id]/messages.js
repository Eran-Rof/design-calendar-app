// api/internal/edi/:vendor_id/messages
//
// GET — EDI message history for a vendor with filters.
//   ?direction=inbound|outbound
//   ?transaction_set=850|855|856|810|820|997
//   ?status=received|processed|acknowledged|error
//   ?from=YYYY-MM-DD&to=YYYY-MM-DD
//   ?limit=100&offset=0
//
// Response: { rows, total, limit, offset }
// raw_content is included so internal can inspect envelopes; parsed_content
// is returned as-is.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

function getVendorId(req) {
  if (req.query && req.query.vendor_id) return req.query.vendor_id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("edi");
  return idx >= 0 ? parts[idx + 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const vendorId = getVendorId(req);
  if (!vendorId) return res.status(400).json({ error: "Missing vendor id" });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const direction = url.searchParams.get("direction");
  const transactionSet = url.searchParams.get("transaction_set");
  const status = url.searchParams.get("status");
  const fromDate = url.searchParams.get("from");
  const toDate = url.searchParams.get("to");
  const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 500);
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);

  let q = admin.from("edi_messages").select("*", { count: "exact" }).eq("vendor_id", vendorId);
  if (direction)      q = q.eq("direction", direction);
  if (transactionSet) q = q.eq("transaction_set", transactionSet);
  if (status)         q = q.eq("status", status);
  if (fromDate)       q = q.gte("created_at", fromDate);
  if (toDate)         q = q.lte("created_at", `${toDate}T23:59:59Z`);

  const { data, error, count } = await q
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ rows: data || [], total: count || 0, limit, offset });
}
