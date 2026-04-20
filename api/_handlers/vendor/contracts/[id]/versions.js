// api/vendor/contracts/:id/versions
//
// GET — version history for a contract the caller owns. Includes signed
// URL-ready file_url (path) and uploader metadata. Ordered newest first.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

async function resolveVendor(admin, authHeader) {
  const jwt = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!jwt) return null;
  try {
    const { data, error } = await admin.auth.getUser(jwt);
    if (error || !data?.user) return null;
    const { data: vu } = await admin.from("vendor_users").select("id, vendor_id").eq("auth_id", data.user.id).maybeSingle();
    return vu ? { ...vu, auth_id: data.user.id } : null;
  } catch { return null; }
}

function getContractId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const versionsIdx = parts.lastIndexOf("versions");
  return versionsIdx > 0 ? parts[versionsIdx - 1] : null;
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

  const caller = await resolveVendor(admin, req.headers.authorization);
  if (!caller) return res.status(401).json({ error: "Authentication required" });

  const contractId = getContractId(req);
  if (!contractId) return res.status(400).json({ error: "Missing contract id" });

  // Verify ownership
  const { data: contract } = await admin
    .from("contracts").select("id").eq("id", contractId).eq("vendor_id", caller.vendor_id).maybeSingle();
  if (!contract) return res.status(404).json({ error: "Contract not found" });

  const { data: versions, error } = await admin
    .from("contract_versions")
    .select("*")
    .eq("contract_id", contractId)
    .order("version_number", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json(versions || []);
}
