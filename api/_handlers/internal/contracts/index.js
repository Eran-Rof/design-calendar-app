// api/internal/contracts
//
// GET — list all contracts with filters.
//   ?status= ?contract_type= ?vendor_id= ?expiring_within_days=
//   Each row includes vendor name and latest_version_number; contracts
//   whose end_date is within 30 days are flagged (expiring_soon=true).
//
// POST — create a new contract.
//   body: { vendor_id, title, description, contract_type, start_date,
//           end_date, value?, currency?, internal_owner, file_url,
//           file_name, file_size_bytes?, file_mime_type? }
//   Inserts contracts (status='sent') + contract_versions (v1, internal).
//   Fires contract_sent to the vendor's primary user.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const status = url.searchParams.get("status");
    const contractType = url.searchParams.get("contract_type");
    const vendorId = url.searchParams.get("vendor_id");
    const expiringWithinDaysRaw = url.searchParams.get("expiring_within_days");

    let query = admin
      .from("contracts")
      .select("*, vendor:vendors(id, name)")
      .order("created_at", { ascending: false });
    if (status)       query = query.eq("status", status);
    if (contractType) query = query.eq("contract_type", contractType);
    if (vendorId)     query = query.eq("vendor_id", vendorId);
    if (expiringWithinDaysRaw) {
      const n = Number(expiringWithinDaysRaw);
      if (Number.isFinite(n) && n >= 0) {
        const today = new Date().toISOString().slice(0, 10);
        const cutoff = new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
        query = query.gte("end_date", today).lte("end_date", cutoff);
      }
    }

    const { data: contracts, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    // Latest version per contract
    const ids = (contracts || []).map((c) => c.id);
    const latestByContract = new Map();
    if (ids.length) {
      const { data: versions } = await admin
        .from("contract_versions").select("contract_id, version_number").in("contract_id", ids);
      for (const v of versions || []) {
        const cur = latestByContract.get(v.contract_id) || 0;
        if (v.version_number > cur) latestByContract.set(v.contract_id, v.version_number);
      }
    }

    const now = new Date();
    const in30 = new Date(now.getTime() + 30 * 86_400_000);
    const rows = (contracts || []).map((c) => {
      let expiring_soon = false;
      if (c.end_date && c.status === "signed") {
        const end = new Date(c.end_date + "T00:00:00");
        if (end > now && end < in30) expiring_soon = true;
      }
      return { ...c, latest_version_number: latestByContract.get(c.id) || 0, expiring_soon };
    });
    return res.status(200).json(rows);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const {
      vendor_id, title, description, contract_type,
      start_date, end_date, value, currency, internal_owner, notes,
      file_url, file_name, file_size_bytes, file_mime_type, uploaded_by_internal_id,
    } = body || {};

    if (!vendor_id || !title || !contract_type || !file_url) {
      return res.status(400).json({ error: "vendor_id, title, contract_type, and file_url are required" });
    }
    if (!["master_services", "nda", "sow", "amendment"].includes(contract_type)) {
      return res.status(400).json({ error: "Invalid contract_type" });
    }
    if (file_mime_type && !/^application\/pdf/i.test(file_mime_type)) {
      return res.status(400).json({ error: "Contract file must be a PDF" });
    }
    if (file_size_bytes && Number(file_size_bytes) > 20 * 1024 * 1024) {
      return res.status(400).json({ error: "File exceeds 20MB limit" });
    }

    const { data: vendor } = await admin.from("vendors").select("id, name").eq("id", vendor_id).maybeSingle();
    if (!vendor) return res.status(404).json({ error: "Vendor not found" });

    const { data: contract, error: cErr } = await admin.from("contracts").insert({
      vendor_id,
      title: String(title).trim(),
      description: description || null,
      contract_type,
      status: "sent",
      start_date: start_date || null,
      end_date: end_date || null,
      value: value != null ? Number(value) : null,
      currency: (currency || "USD").toUpperCase(),
      file_url,
      internal_owner: internal_owner || null,
      notes: notes || null,
    }).select("*").single();
    if (cErr) return res.status(500).json({ error: cErr.message });

    const { error: vErr } = await admin.from("contract_versions").insert({
      contract_id: contract.id,
      version_number: 1,
      file_url,
      notes: "Initial version",
      uploaded_by_type: "internal",
      uploaded_by_internal_id: uploaded_by_internal_id || internal_owner || "internal",
    });
    if (vErr) return res.status(200).json({ ...contract, version_error: vErr.message });

    // Notify vendor primary user
    try {
      const origin = `https://${req.headers.host}`;
      await fetch(`${origin}/api/send-notification`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_type: "contract_sent",
          title: `New contract ready for review: ${contract.title}`,
          body: `${vendor.name}, a new ${contract_type.replace(/_/g, " ")} is ready for your review and signature.`,
          link: "/vendor/contracts",
          metadata: { contract_id: contract.id, vendor_id },
          recipient: { vendor_id },
          dedupe_key: `contract_sent_${contract.id}_v1`,
          email: true,
        }),
      }).catch(() => {});
    } catch { /* non-blocking */ }

    return res.status(201).json(contract);
  }

  return res.status(405).json({ error: "Method not allowed" });
}
