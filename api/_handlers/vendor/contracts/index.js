// api/vendor/contracts/index.js
//
// GET — list all contracts for the caller's vendor with latest version
//       number. Response rows:
//   { id, title, contract_type, status, start_date, end_date, value,
//     currency, signed_at, latest_version_number, created_at }

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 30 };

async function resolveVendor(admin, authHeader) {
  const jwt = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!jwt) return null;
  try {
    const { data, error } = await admin.auth.getUser(jwt);
    if (error || !data?.user) return null;
    const { data: vu } = await admin
      .from("vendor_users").select("id, vendor_id, display_name")
      .eq("auth_id", data.user.id).maybeSingle();
    if (!vu) return null;
    return { ...vu, auth_id: data.user.id, email: data.user.email };
  } catch { return null; }
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

  const { data: contracts, error } = await admin
    .from("contracts")
    .select("id, title, description, contract_type, status, start_date, end_date, value, currency, signed_at, created_at")
    .eq("vendor_id", caller.vendor_id)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  // Fetch latest version per contract
  const ids = (contracts || []).map((c) => c.id);
  let latestByContract = new Map();
  if (ids.length) {
    const { data: versions } = await admin
      .from("contract_versions")
      .select("contract_id, version_number")
      .in("contract_id", ids);
    for (const v of versions || []) {
      const cur = latestByContract.get(v.contract_id) || 0;
      if (v.version_number > cur) latestByContract.set(v.contract_id, v.version_number);
    }
  }

  const rows = (contracts || []).map((c) => ({
    ...c,
    latest_version_number: latestByContract.get(c.id) || 0,
  }));
  return res.status(200).json(rows);
}
