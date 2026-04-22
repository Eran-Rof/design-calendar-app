// api/internal/vendors/:id/preferred
//
// POST — mark a vendor as preferred for a category.
//   body: { category, rank?, notes?, set_by? }
//     rank defaults to 1 (primary). Call multiple times with different
//     ranks to register backup/tertiary vendors.
//
// Unique (vendor_id, category) — re-POSTing the same pair updates the
// existing row in place.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 10 };

function getVendorId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("vendors");
  return idx >= 0 ? parts[idx + 1] : null;
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

  const vendorId = getVendorId(req);
  if (!vendorId) return res.status(400).json({ error: "Missing vendor id" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  const { category, rank, notes, set_by } = body || {};
  if (!category || !String(category).trim()) return res.status(400).json({ error: "category is required" });
  const rankNum = rank == null ? 1 : Number(rank);
  if (!Number.isInteger(rankNum) || rankNum < 1) return res.status(400).json({ error: "rank must be a positive integer" });

  const { data: v } = await admin.from("vendors").select("id").eq("id", vendorId).maybeSingle();
  if (!v) return res.status(404).json({ error: "Vendor not found" });

  const { data: row, error } = await admin.from("preferred_vendors").upsert({
    vendor_id: vendorId,
    category: String(category).trim(),
    rank: rankNum,
    notes: notes ? String(notes).trim() : null,
    set_by: set_by || null,
    updated_at: new Date().toISOString(),
  }, { onConflict: "vendor_id,category" }).select("*").single();
  if (error) return res.status(500).json({ error: error.message });

  return res.status(201).json(row);
}
