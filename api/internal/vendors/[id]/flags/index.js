// api/internal/vendors/:id/flags
//
// POST — create a new vendor_flag (status='open').
//   body: { type, severity?, reason, raised_by?, source? }

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

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
  const { type, severity, reason, raised_by, source, metadata } = body || {};

  if (!type || !["performance", "compliance", "financial_risk", "other"].includes(type))
    return res.status(400).json({ error: "type must be performance, compliance, financial_risk, or other" });
  if (severity && !["low", "medium", "high", "critical"].includes(severity))
    return res.status(400).json({ error: "severity must be low, medium, high, or critical" });
  if (!reason || !String(reason).trim()) return res.status(400).json({ error: "reason is required" });

  const { data: vendor } = await admin.from("vendors").select("id").eq("id", vendorId).maybeSingle();
  if (!vendor) return res.status(404).json({ error: "Vendor not found" });

  const { data: flag, error } = await admin.from("vendor_flags").insert({
    vendor_id: vendorId,
    type,
    severity: severity || "medium",
    reason: String(reason).trim(),
    status: "open",
    raised_by: raised_by || null,
    source: source || "manual",
    metadata: metadata || null,
  }).select("*").single();
  if (error) return res.status(500).json({ error: error.message });

  return res.status(201).json(flag);
}
