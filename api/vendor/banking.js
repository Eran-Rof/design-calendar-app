// api/vendor/banking
//
// GET  — banking records for the caller's vendor, with account number
//        masked (last4 only). Never returns ciphertext.
// POST — create a new banking record.
//        body: {
//          account_name, bank_name,
//          account_number, routing_number,
//          account_type: 'checking'|'savings'|'wire',
//          currency?: default 'USD'
//        }
// DELETE /api/vendor/banking?id=<uuid> — soft via setting verified=false is NOT possible; hard delete if not verified.

import { createClient } from "@supabase/supabase-js";
import { encryptFieldValue, last4 } from "../_lib/crypto.js";

export const config = { maxDuration: 15 };

async function resolveVendor(admin, authHeader) {
  const jwt = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!jwt) return null;
  try {
    const { data, error } = await admin.auth.getUser(jwt);
    if (error || !data?.user) return null;
    const { data: vu } = await admin.from("vendor_users").select("id, vendor_id, role").eq("auth_id", data.user.id).maybeSingle();
    return vu ? { ...vu, auth_id: data.user.id } : null;
  } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const caller = await resolveVendor(admin, req.headers.authorization);
  if (!caller) return res.status(401).json({ error: "Authentication required" });

  if (req.method === "GET") {
    const { data, error } = await admin
      .from("banking_details")
      .select("id, vendor_id, account_name, bank_name, account_number_last4, account_type, currency, verified, verified_at, created_at")
      .eq("vendor_id", caller.vendor_id)
      .order("created_at", { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data || []);
  }

  if (req.method === "POST") {
    // Admin/primary only
    if (caller.role !== "primary" && caller.role !== "admin") return res.status(403).json({ error: "Admin role required" });

    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const { account_name, bank_name, account_number, routing_number, account_type, currency } = body || {};
    if (!account_name || !bank_name || !account_number || !routing_number || !account_type)
      return res.status(400).json({ error: "account_name, bank_name, account_number, routing_number, account_type are required" });
    if (!["checking", "savings", "wire"].includes(account_type))
      return res.status(400).json({ error: "account_type must be checking, savings, or wire" });

    let an_enc, rn_enc;
    try {
      an_enc = encryptFieldValue(String(account_number).replace(/\s|-/g, ""));
      rn_enc = encryptFieldValue(String(routing_number).replace(/\s|-/g, ""));
    } catch (e) {
      return res.status(500).json({ error: `Encryption failed: ${e instanceof Error ? e.message : String(e)}` });
    }

    const { data, error } = await admin.from("banking_details").insert({
      vendor_id: caller.vendor_id,
      account_name: String(account_name).trim(),
      bank_name: String(bank_name).trim(),
      account_number_encrypted: an_enc,
      account_number_last4: last4(account_number),
      routing_number_encrypted: rn_enc,
      account_type,
      currency: (currency || "USD").toUpperCase(),
      verified: false,
    }).select("id, account_number_last4, bank_name, account_type, currency, verified, created_at").single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json(data);
  }

  if (req.method === "DELETE") {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const id = url.searchParams.get("id");
    if (!id) return res.status(400).json({ error: "id is required" });
    const { data: row } = await admin.from("banking_details").select("id, vendor_id, verified").eq("id", id).maybeSingle();
    if (!row || row.vendor_id !== caller.vendor_id) return res.status(404).json({ error: "Not found" });
    if (row.verified) return res.status(409).json({ error: "Cannot delete a verified record — contact internal support" });
    const { error } = await admin.from("banking_details").delete().eq("id", id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
