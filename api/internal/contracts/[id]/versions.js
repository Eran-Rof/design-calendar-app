// api/internal/contracts/:id/versions
//
// POST — upload a new version of an existing contract.
//   body: { file_url, file_name, file_size_bytes?, file_mime_type?,
//           notes?, uploaded_by_internal_id }
//   Creates a contract_versions row (next number).
//   Resets contract.status to 'sent' (vendor needs to re-review).
//   Fires contract_updated notification to the vendor.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 30 };

function getContractId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("versions");
  return idx > 0 ? parts[idx - 1] : null;
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

  const contractId = getContractId(req);
  if (!contractId) return res.status(400).json({ error: "Missing contract id" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  const { file_url, file_name, file_size_bytes, file_mime_type, notes, uploaded_by_internal_id } = body || {};

  if (!file_url) return res.status(400).json({ error: "file_url is required" });
  if (!uploaded_by_internal_id) return res.status(400).json({ error: "uploaded_by_internal_id is required" });
  if (file_mime_type && !/^application\/pdf/i.test(file_mime_type)) return res.status(400).json({ error: "Only PDF files are allowed" });
  if (file_size_bytes && Number(file_size_bytes) > 20 * 1024 * 1024) return res.status(400).json({ error: "File exceeds 20MB limit" });

  const { data: contract } = await admin
    .from("contracts").select("id, vendor_id, title").eq("id", contractId).maybeSingle();
  if (!contract) return res.status(404).json({ error: "Contract not found" });

  const { data: maxV } = await admin
    .from("contract_versions")
    .select("version_number")
    .eq("contract_id", contractId)
    .order("version_number", { ascending: false })
    .limit(1).maybeSingle();
  const nextVersion = (maxV?.version_number || 0) + 1;

  const { data: ver, error: vErr } = await admin.from("contract_versions").insert({
    contract_id: contractId,
    version_number: nextVersion,
    file_url,
    notes: notes ? String(notes).trim() : null,
    uploaded_by_type: "internal",
    uploaded_by_internal_id,
  }).select("*").single();
  if (vErr) return res.status(500).json({ error: vErr.message });

  // Reset status to 'sent' so the vendor reviews+re-signs
  const { error: cUpdateErr } = await admin.from("contracts").update({
    status: "sent",
    signed_file_url: null,
    signed_at: null,
    signed_by_vendor: null,
    updated_at: new Date().toISOString(),
    file_url,
  }).eq("id", contractId);
  if (cUpdateErr) return res.status(500).json({ error: "Version created but contract status reset failed", detail: cUpdateErr.message, version_id: ver.id });

  // Fire vendor notification
  try {
    const origin = `https://${req.headers.host}`;
    await fetch(`${origin}/api/send-notification`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_type: "contract_updated",
        title: `Contract updated: ${contract.title} (v${nextVersion})`,
        body: `A new version of ${contract.title} has been uploaded. Please review${notes ? `: ${String(notes).trim()}` : "."}`,
        link: "/vendor/contracts",
        metadata: { contract_id: contractId, vendor_id: contract.vendor_id, version_number: nextVersion },
        recipient: { vendor_id: contract.vendor_id },
        dedupe_key: `contract_updated_${contractId}_v${nextVersion}`,
        email: true,
      }),
    }).catch(() => {});
  } catch { /* non-blocking */ }

  return res.status(201).json(ver);
}
